// The signatures here were produced by signing the same requests with `@aws-sdk/signature-v4`, the
// reference implementation, and asserting byte equality with ours. The SDK is not a dependency of
// this project (SPEC "Tech stack" — 16 MB for a ledger most deployments never configure), so what
// ships is the comparison's RESULT: a drift in our signer changes these strings and fails here.
//
// The three cases are the three things that are easy to get wrong: the ordinary path, temporary
// credentials (the session token is a signed header, not a passenger), and a URL with a non-default
// port and a repeated query key (host carries the port; query sorts by key then value).

import { describe, expect, it } from "vitest";
import { amzDate, signRequest } from "./sigv4.js";

const creds = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2026-09-14T01:15:00.000Z");

describe("sigv4", () => {
  it("stamps the instant the way AWS spells it", () => {
    expect(amzDate(now)).toEqual({
      long: "20260914T011500Z",
      short: "20260914",
    });
  });

  it("signs a DynamoDB call the way the AWS SDK signs it", () => {
    const h = signRequest({
      method: "POST",
      url: new URL("https://dynamodb.ap-northeast-2.amazonaws.com/"),
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "DynamoDB_20120810.PutItem",
      },
      body: JSON.stringify({
        TableName: "yoke_audit",
        Item: { pk: { S: "T#" } },
      }),
      region: "ap-northeast-2",
      service: "dynamodb",
      credentials: creds,
      now,
    });
    expect(h["x-amz-date"]).toBe("20260914T011500Z");
    expect(h.host).toBe("dynamodb.ap-northeast-2.amazonaws.com");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260914/ap-northeast-2/dynamodb/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-target, " +
        "Signature=44aba31090483f31e0fd995ece1afba425bb9716875de828a204ccc3a516556e",
    );
  });

  it("signs the session token in, rather than sending it alongside", () => {
    const h = signRequest({
      method: "POST",
      url: new URL("https://dynamodb.us-east-1.amazonaws.com/"),
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "DynamoDB_20120810.Query",
      },
      body: '{"TableName":"t"}',
      region: "us-east-1",
      service: "dynamodb",
      credentials: {
        ...creds,
        sessionToken: "FQoDYXdzEPT//////////wEaDDEXAMPLETOKEN",
      },
      now,
    });
    expect(h["x-amz-security-token"]).toBe(
      "FQoDYXdzEPT//////////wEaDDEXAMPLETOKEN",
    );
    expect(h.authorization).toContain("x-amz-security-token");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260914/us-east-1/dynamodb/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, " +
        "Signature=8c906ee8698b4c41d8d7fc8df52efe461d1464eefd71ae40fefe6cb59f528b8d",
    );
  });

  it("carries the port in host, and sorts a repeated query key by value", () => {
    const h = signRequest({
      method: "POST",
      url: new URL("http://localhost:8100/?b=2&a=1&a=%20x"),
      headers: { "content-type": "application/x-amz-json-1.0" },
      body: "{}",
      region: "us-east-1",
      service: "dynamodb",
      credentials: creds,
      now,
    });
    expect(h.host).toBe("localhost:8100");
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260914/us-east-1/dynamodb/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=4b112dc8834218cad1c244694c9f7be5863d704818aff0bb29c7c2e7a349f3cd",
    );
  });
});
