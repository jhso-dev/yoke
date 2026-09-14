// audit-dynamodb — the audit ledger on DynamoDB, over plain REST (see sigv4.ts for why no SDK).
//
// Reached by `YOKE_AUDIT_URL=dynamodb://<table>` or `dynamodb://<region>/<table>`; credentials and
// region come from the standard AWS environment variables. It implements AuditPort and nothing else:
// knowledge stays wherever the knowledge store is, which is the whole point of the trail having its
// own address.
//
// One table, three item shapes, chosen so that every read this port owes is a Query or a BatchGet on
// the primary key — never a Scan, and never an aggregation over the log:
//
//   trail     pk = T#<ns>            sk = <epoch ms, padded>#<ulid>   the append-only rows
//   delivery  pk = D#<ns>#<actor>    sk = <anchor>#<entity id>        n, last_at — what a reader holds
//   counter   pk = C#<ns>            sk = <entity id>                 n — how often agents were fed it
//
// The trail's sort key is a PADDED EPOCH, not the `at` string: DynamoDB compares sort keys
// byte-lexicographically, and `at` is stored in more than one ISO spelling (`Z` sorts after `.`), so
// a range over the raw string would drop rows inside the bound's own second. The original `at` rides
// on the item unchanged; the key is derived from it.
//
// The counter item exists because consumption asks for up to a page of ids at once. Keyed by entity
// it would be one Query per id — a thousand round trips for one review screen; keyed this way it is
// BatchGetItem in chunks of 100.
//
// ceiling: a delivery of N records costs 1 + 2N writes, and they are not one transaction —
// TransactWriteItems caps at 100 items, which a large briefing would exceed, and the failure mode of
// a partial write here is a count that is low, not a trail that lies. The trail row goes LAST, so a
// crash mid-write leaves counters ahead of the log rather than a logged delivery nobody counted.

import { monotonicFactory } from "ulid";
import type {
  AuditEvent,
  AuditPort,
  AuditQuery,
  Delivered,
} from "../../ports/audit.js";
import { type AwsCredentials, signRequest } from "./sigv4.js";

type Env = Record<string, string | undefined>;

/** DynamoDB's JSON, which types every scalar. Only the three shapes this adapter writes. */
type Attr = { S: string } | { N: string };
type Item = Record<string, Attr>;

const s = (v: string): Attr => ({ S: v });
const str = (a: Attr | undefined): string => (a && "S" in a ? a.S : "");
const num = (a: Attr | undefined): number => (a && "N" in a ? Number(a.N) : 0);

/** The trail's sort-key prefix: the instant as a padded epoch, so a byte range IS a time range.
 *
 * 15 digits covers every instant up to the year 33658. An unparseable or pre-epoch `at` clamps to 0,
 * which puts the row at the start of the trail rather than dropping it — the ledger's job is to keep
 * what it was handed. */
const stamp = (at: string): string => {
  const ms = Date.parse(at);
  return String(Number.isFinite(ms) ? Math.max(0, ms) : 0).padStart(15, "0");
};

const ULID = monotonicFactory();

const nsKey = (ns?: string | null): string => ns ?? "";

export interface DynamoAuditOptions {
  table: string;
  region: string;
  credentials: AwsCredentials;
  /** Override for DynamoDB Local, or a VPC endpoint. Default: the public regional endpoint. */
  endpoint?: string;
  /** Injectable for the test; the product passes nothing. */
  now?: () => Date;
}

/**
 * `dynamodb://<table>` or `dynamodb://<region>/<table>`, plus the standard AWS environment.
 *
 * Refusing when a region or a key is missing, rather than defaulting: a ledger that silently signs
 * with nothing reaches the wrong account or none, and the operator finds out when they go looking for
 * an audit trail that was never written.
 */
export function dynamoAuditFromUrl(url: string, env: Env): DynamoAuditOptions {
  const rest = url.slice("dynamodb://".length);
  const parts = rest.split("/").filter(Boolean);
  const [region, table] =
    parts.length > 1
      ? [parts[0], parts[1]]
      : [
          env.YOKE_AUDIT_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
          parts[0],
        ];
  if (!table)
    throw new Error(
      "YOKE_AUDIT_URL: name the table — dynamodb://<table> or dynamodb://<region>/<table>",
    );
  if (!region)
    throw new Error(
      `YOKE_AUDIT_URL=dynamodb://${table} names no region: set AWS_REGION, or write ` +
        "dynamodb://<region>/<table>",
    );
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey)
    throw new Error(
      "the dynamodb ledger needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment " +
        "(AWS_SESSION_TOKEN too, for temporary credentials). Instance and pod roles are not read — " +
        "see the ceiling in adapters/audit-dynamodb/sigv4.ts",
    );
  return {
    table,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    },
    ...(env.YOKE_AUDIT_ENDPOINT ? { endpoint: env.YOKE_AUDIT_ENDPOINT } : {}),
  };
}

export class DynamoAudit implements AuditPort {
  private readonly url: URL;
  private readonly now: () => Date;

  constructor(private readonly opts: DynamoAuditOptions) {
    this.url = new URL(
      opts.endpoint ?? `https://dynamodb.${opts.region}.amazonaws.com/`,
    );
    this.now = opts.now ?? (() => new Date());
  }

  /** One signed POST. DynamoDB's whole API is this call with a different target and body. */
  private async call<R>(target: string, body: unknown): Promise<R> {
    const payload = JSON.stringify(body);
    const res = await fetch(this.url, {
      method: "POST",
      headers: signRequest({
        method: "POST",
        url: this.url,
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `DynamoDB_20120810.${target}`,
        },
        body: payload,
        region: this.opts.region,
        service: "dynamodb",
        credentials: this.opts.credentials,
        now: this.now(),
      }),
      body: payload,
    });
    const text = await res.text();
    if (!res.ok) {
      // `__type` is `com.amazonaws...#ConditionalCheckFailedException`; the short name is what a
      // caller branches on and what an operator can search for.
      let type = "";
      let message = text;
      try {
        const b = JSON.parse(text) as { __type?: string; message?: string };
        type = (b.__type ?? "").split("#").pop() ?? "";
        message = b.message ?? text;
      } catch {
        // A non-JSON body (a proxy's error page) is reported as it arrived.
      }
      throw Object.assign(
        new Error(`dynamodb ${target}: ${type || res.status} ${message}`),
        { awsType: type },
      );
    }
    return JSON.parse(text) as R;
  }

  /** Create the table if it is not there, and wait for it — the same thing every other adapter's
   * `init()` does with its schema. An existing table is left exactly as it is, so an operator who
   * provisioned capacity, a TTL or a backup policy keeps them. */
  async init(): Promise<void> {
    try {
      const d = await this.call<{ Table?: { TableStatus?: string } }>(
        "DescribeTable",
        { TableName: this.opts.table },
      );
      if (d.Table?.TableStatus === "ACTIVE") return;
    } catch (e) {
      if ((e as { awsType?: string }).awsType !== "ResourceNotFoundException")
        throw e;
      await this.call("CreateTable", {
        TableName: this.opts.table,
        // On-demand, so there is no capacity to plan and nothing to throttle. An operator who wants
        // the perpetual free tier's 25/25 provisioned units switches the table over; yoke only ever
        // creates one that is missing.
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      });
    }
    // CreateTable returns before the table is usable, and so does a table someone else is creating.
    for (let i = 0; i < 60; i++) {
      const d = await this.call<{ Table?: { TableStatus?: string } }>(
        "DescribeTable",
        { TableName: this.opts.table },
      );
      if (d.Table?.TableStatus === "ACTIVE") return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `dynamodb: ${this.opts.table} did not become ACTIVE within 30s`,
    );
  }

  async logAudit(event: AuditEvent): Promise<void> {
    const ns = nsKey(event.ns);
    const ids = event.ids?.length ? [...new Set(event.ids)] : [];
    // Counters first, the trail row last: interrupted, that leaves a count with no row rather than a
    // row the count does not know about. Neither is good; only one of them makes the trail lie.
    if (ids.length > 0) {
      const anchor = event.anchor ?? "";
      const at = event.asOf ? undefined : event.at;
      await Promise.all(
        ids.flatMap((id) => [
          this.call("UpdateItem", {
            TableName: this.opts.table,
            Key: { pk: s(`C#${ns}`), sk: s(id) },
            UpdateExpression: "ADD #n :one",
            ExpressionAttributeNames: { "#n": "n" },
            ExpressionAttributeValues: { ":one": { N: "1" } },
          }),
          this.bumpDelivery(ns, event.actor, anchor, id, at),
        ]),
      );
    }
    await this.call("PutItem", {
      TableName: this.opts.table,
      Item: {
        pk: s(`T#${ns}`),
        sk: s(`${stamp(event.at)}#${ULID()}`),
        actor: s(event.actor),
        action: s(event.action),
        detail: s(event.detail),
        at: s(event.at),
        ...(ns ? { ns: s(ns) } : {}),
      } satisfies Item,
    });
  }

  /** Count the delivery, and move the reader's clock only if this delivery is the latest one.
   *
   * Two shapes rather than one because a condition guards the whole update: the count must land
   * whatever the clock does. The ordinary case is one request — the second only runs when a delivery
   * arrives out of order, which is the case `at` being caller-supplied makes possible. */
  private async bumpDelivery(
    ns: string,
    actor: string,
    anchor: string,
    id: string,
    at: string | undefined,
  ): Promise<void> {
    const Key = { pk: s(`D#${ns}#${actor}`), sk: s(`${anchor}#${id}`) };
    const count = {
      TableName: this.opts.table,
      Key,
      UpdateExpression: "ADD #n :one SET entity_id = :id, anchor = :anchor",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: {
        ":one": { N: "1" },
        ":id": s(id),
        ":anchor": s(anchor),
      },
    };
    // An as-of delivery handed a version that is not current, so it never touches the clock.
    if (at === undefined) {
      await this.call("UpdateItem", count);
      return;
    }
    try {
      await this.call("UpdateItem", {
        ...count,
        UpdateExpression: `${count.UpdateExpression}, last_at = :at, last_ms = :ms`,
        ExpressionAttributeValues: {
          ...count.ExpressionAttributeValues,
          ":at": s(at),
          ":ms": { N: String(Date.parse(at) || 0) },
        },
        ConditionExpression: "attribute_not_exists(last_ms) OR last_ms < :ms",
      });
    } catch (e) {
      if (
        (e as { awsType?: string }).awsType !==
        "ConditionalCheckFailedException"
      )
        throw e;
      // A later delivery already set the clock. The count still has to land.
      await this.call("UpdateItem", count);
    }
  }

  async listAudit(q: AuditQuery = {}): Promise<AuditEvent[]> {
    const ns = nsKey(q.ns);
    // Both bounds inclusive. The upper bound's suffix is above every ULID, so the whole millisecond
    // is included; the lower bound's is below every one, so none of it is lost.
    const lo = `${stamp(q.since ?? "1970-01-01T00:00:00Z")}#`;
    const hi = `${stamp(q.until ?? "9999-12-31T23:59:59Z")}#￿`;
    const rows: Item[] = [];
    let start: Item | undefined;
    do {
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>(
        "Query",
        {
          TableName: this.opts.table,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
          ExpressionAttributeValues: {
            ":pk": s(`T#${ns}`),
            ":lo": s(lo),
            ":hi": s(hi),
          },
          // With a limit, read from the NEW end and reverse — that is what "the most recent N,
          // oldest-first" means, and it is the difference between reading N rows and reading all of
          // them.
          ScanIndexForward: q.limit === undefined,
          ...(q.limit === undefined ? {} : { Limit: q.limit - rows.length }),
          ...(start ? { ExclusiveStartKey: start } : {}),
        },
      );
      rows.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start && (q.limit === undefined || rows.length < q.limit));

    const events = rows.map((r) => {
      const ev: AuditEvent = {
        actor: str(r.actor),
        action: str(r.action),
        detail: str(r.detail),
        at: str(r.at),
      };
      // The default namespace leaves the field absent, matching how entity rows carry ns.
      if (r.ns) ev.ns = str(r.ns);
      return ev;
    });
    return q.limit === undefined ? events : events.reverse();
  }

  async consumption(q: {
    ns?: string | null;
    ids: string[];
  }): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const ids = [...new Set(q.ids)];
    if (ids.length === 0) return counts;
    const pk = `C#${nsKey(q.ns)}`;
    // BatchGetItem takes 100 keys per call and may return fewer than asked for; UnprocessedKeys is
    // how it says so, and ignoring it would silently under-count a busy table.
    for (let i = 0; i < ids.length; i += 100) {
      let keys = ids.slice(i, i + 100).map((id) => ({ pk: s(pk), sk: s(id) }));
      while (keys.length > 0) {
        const r = await this.call<{
          Responses?: Record<string, Item[]>;
          UnprocessedKeys?: Record<string, { Keys?: Item[] }>;
        }>("BatchGetItem", {
          RequestItems: { [this.opts.table]: { Keys: keys } },
        });
        for (const item of r.Responses?.[this.opts.table] ?? []) {
          const n = num(item.n);
          if (n > 0) counts.set(str(item.sk), n);
        }
        keys = (r.UnprocessedKeys?.[this.opts.table]?.Keys ?? []) as Array<{
          pk: Attr;
          sk: Attr;
        }>;
      }
    }
    return counts;
  }

  async delivered(q: {
    ns?: string | null;
    actor: string;
    anchor: string;
  }): Promise<Delivered> {
    const lastHanded = new Map<string, string>();
    const anchored: Delivered["anchored"] = { ids: new Set() };
    let start: Item | undefined;
    do {
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>(
        "Query",
        {
          TableName: this.opts.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: {
            ":pk": s(`D#${nsKey(q.ns)}#${q.actor}`),
          },
          ...(start ? { ExclusiveStartKey: start } : {}),
        },
      );
      for (const item of page.Items ?? []) {
        const at = item.last_at ? str(item.last_at) : "";
        // No clock means every delivery of it was as-of: counted, but not held.
        if (!at) continue;
        const id = str(item.entity_id);
        const seen = lastHanded.get(id);
        // By instant, not by string order: `at` is stored in more than one ISO spelling.
        if (seen === undefined || Date.parse(at) > Date.parse(seen))
          lastHanded.set(id, at);
        if (str(item.anchor) !== q.anchor) continue;
        anchored.ids.add(id);
        if (
          anchored.last === undefined ||
          Date.parse(at) > Date.parse(anchored.last)
        )
          anchored.last = at;
      }
      start = page.LastEvaluatedKey;
    } while (start);
    return { lastHanded, anchored };
  }

  close(): void {
    // fetch holds nothing open.
  }
}
