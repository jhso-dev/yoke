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

import { afterAll, describe, expect, it } from "vitest";
import { describeAuditPort } from "../../ports/audit-conformance.js";
import { DynamoAudit, dynamoAuditFromUrl } from "./index.js";
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

suite("audit ledger (live DynamoDB)", () => {
  describeAuditPort("dynamodb", async () => {
    const table = `yoketest_${Date.now()}_${++n}`;
    made.push(table);
    return new DynamoAudit(
      dynamoAuditFromUrl(`dynamodb://us-east-1/${table}`, LOCAL_ENV),
    );
  });
});
