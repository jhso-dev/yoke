// audit-dynamodb tests — against a REAL DynamoDB, skipped when none is reachable.
//
// No fake carries this suite, for the same reason the opensearch and postgres suites have none: the
// behaviour under test is the ENGINE's. Whether a BETWEEN on a byte-ordered sort key selects the rows
// a time range means, whether `ADD` on a missing item creates it at 1, whether a conditional update
// that fails leaves the item untouched — a fake would encode this adapter's beliefs about all three
// and prove none of them. DynamoDB Local runs the real engine:
//
//   docker run -d --rm --name yoke-ddb -p 8100:8000 amazon/dynamodb-local
//   YOKE_TEST_DYNAMODB_ENDPOINT=http://localhost:8100 npm test
//
// Isolation is per TABLE: each case gets its own `yoketest_*` table and deletes it after. Nothing
// this suite does not own is touched.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { describeAuditPort } from "../../ports/audit-conformance.js";
import {
  DynamoAudit,
  type DynamoAuditOptions,
  dynamoAuditFromUrl,
} from "./index.js";
import { signRequest } from "./sigv4.js";

const ENDPOINT = process.env.YOKE_TEST_DYNAMODB_ENDPOINT;
const suite = ENDPOINT ? describe : describe.skip;

// DynamoDB Local accepts any credentials and verifies no signature; the signer's correctness is
// `sigv4.test.ts`'s job, against the AWS SDK.
const LOCAL_ENV = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_REGION: "us-east-1",
  YOKE_AUDIT_ENDPOINT: ENDPOINT,
};

let n = 0;
const made: string[] = [];

/** DeleteTable, signed by hand — the adapter has no drop and should not grow one for a test. */
afterAll(async () => {
  if (!ENDPOINT) return;
  const url = new URL(ENDPOINT);
  await Promise.all(
    made.map((TableName) => {
      const body = JSON.stringify({ TableName });
      return fetch(url, {
        method: "POST",
        headers: signRequest({
          method: "POST",
          url,
          headers: {
            "content-type": "application/x-amz-json-1.0",
            "x-amz-target": "DynamoDB_20120810.DeleteTable",
          },
          body,
          region: "us-east-1",
          service: "dynamodb",
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
          now: new Date(),
        }),
        body,
      });
    }),
  );
});

// NOT gated on a server: parsing the address is this adapter's own logic, and a live table cannot
// check it better than this can.
describe("dynamodb:// addresses", () => {
  const env = { AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
  it("takes the region from the URL, or from the environment", () => {
    expect(
      dynamoAuditFromUrl("dynamodb://ap-northeast-2/yoke_audit", env),
    ).toMatchObject({ region: "ap-northeast-2", table: "yoke_audit" });
    expect(
      dynamoAuditFromUrl("dynamodb://yoke_audit", {
        ...env,
        AWS_REGION: "eu-west-1",
      }),
    ).toMatchObject({ region: "eu-west-1", table: "yoke_audit" });
  });

  it("carries a session token when the credentials are temporary", () => {
    expect(
      dynamoAuditFromUrl("dynamodb://us-east-1/t", {
        ...env,
        AWS_SESSION_TOKEN: "tok",
      }).credentials,
    ).toEqual({ accessKeyId: "k", secretAccessKey: "s", sessionToken: "tok" });
  });

  // Every one of these would otherwise be found out by an audit trail that was never written.
  it("refuses what it cannot sign or address, naming what to set", () => {
    expect(() => dynamoAuditFromUrl("dynamodb://t", env)).toThrow(/AWS_REGION/);
    expect(() => dynamoAuditFromUrl("dynamodb://", env)).toThrow(
      /name the table/,
    );
    expect(() =>
      dynamoAuditFromUrl("dynamodb://us-east-1/t", { AWS_REGION: "us-east-1" }),
    ).toThrow(/AWS_ACCESS_KEY_ID/);
  });
});

// NOT gated on a server either: DynamoDB Local never throttles, so the one condition this ladder
// exists for cannot be produced against it. The fault is the SERVICE's reply, and a stubbed fetch is
// the only place a test can hand the adapter one.
describe("retry and write fan-out", () => {
  afterEach(() => vi.unstubAllGlobals());

  const audit = (over: Partial<DynamoAuditOptions> = {}) =>
    new DynamoAudit({
      table: "t",
      region: "us-east-1",
      credentials: { accessKeyId: "k", secretAccessKey: "s" },
      endpoint: "http://ddb.test/",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sleep: async () => {},
      ...over,
    });

  const ok = () => new Response("{}", { status: 200 });
  const aws = (status: number, type: string) =>
    new Response(
      JSON.stringify({
        __type: `com.amazonaws.dynamodb.v20120810#${type}`,
        message: "from the service",
      }),
      { status },
    );

  const read = {
    actor: "a",
    action: "read",
    detail: "d",
    at: "2026-01-01T00:00:00.000Z",
  } as const;

  it("retries a dead socket and a throttle, re-signing the same call each time", async () => {
    const sent: Array<Record<string, string>> = [];
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      bodies.push(String(init.body));
      // What fetch does when the request never reached the service.
      if (sent.length === 1) throw new TypeError("fetch failed");
      return sent.length === 2
        ? aws(400, "ProvisionedThroughputExceededException")
        : ok();
    });
    vi.stubGlobal("fetch", fetchMock);

    await audit().logAudit(read);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The retry is the SAME request: same operation, same bytes, and signed on every attempt.
    expect(new Set(sent.map((h) => h["x-amz-target"]))).toEqual(
      new Set(["DynamoDB_20120810.PutItem"]),
    );
    expect(new Set(bodies).size).toBe(1);
    for (const h of sent) {
      expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=k\//);
      expect(h["x-amz-date"]).toBe("20260101T000000Z");
    }
  });

  it("throws a failed condition on the first try — it is an answer, not a fault", async () => {
    const fetchMock = vi.fn(async () =>
      aws(400, "ConditionalCheckFailedException"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(audit().logAudit(read)).rejects.toThrow(
      /ConditionalCheckFailedException/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the fault and the attempt count when the budget runs out", async () => {
    const fetchMock = vi.fn(async () => aws(500, "InternalServerError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(audit({ maxAttempts: 3 }).logAudit(read)).rejects.toThrow(
      /gave up after 3 attempts — InternalServerError/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("holds at most 8 writes in flight, and the trail row goes last", async () => {
    let inFlight = 0;
    let peak = 0;
    const targets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        targets.push((init.headers as Record<string, string>)["x-amz-target"]);
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return ok();
      }),
    );

    const ids = Array.from({ length: 30 }, (_, i) => `e${i}`);
    await audit().logAudit({ ...read, action: "inject", ids });

    // 3 writes per record, then the trail row: 91 requests, never more than 8 of them at once.
    expect(targets).toHaveLength(91);
    expect(peak).toBe(8);
    expect(targets.at(-1)).toBe("DynamoDB_20120810.PutItem");
    expect(
      targets.slice(0, -1).every((t) => t === "DynamoDB_20120810.UpdateItem"),
    ).toBe(true);
  });
});

suite("audit ledger (live DynamoDB)", () => {
  describeAuditPort("dynamodb", async () => {
    const table = `yoketest_${Date.now()}_${++n}`;
    made.push(table);
    return new DynamoAudit(
      dynamoAuditFromUrl(`dynamodb://us-east-1/${table}`, LOCAL_ENV),
    );
  });
});
