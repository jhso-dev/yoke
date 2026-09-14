// AWS Signature Version 4, over node:crypto and nothing else.
//
// Here rather than from an SDK for the reason SPEC "Tech stack" gives about install weight:
// `@aws-sdk/client-dynamodb` is 16 MB across 7 packages, paid by every yoke install for a ledger most
// deployments never configure. The OpenSearch adapter is plain REST for the same reason, and DynamoDB's
// wire protocol is plain REST too — a JSON POST with an `X-Amz-Target` header. Signing it is the only
// part that is not obvious, and it is a specification, not a moving target.
//
// Verified byte-for-byte against `@aws-sdk/signature-v4` before shipping; `sigv4.test.ts` pins the
// signatures that comparison produced, so a change here that drifts from the SDK fails.
//
// ceiling: credentials come from the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
// `AWS_SESSION_TOKEN`) and nowhere else — no IMDS, no SSO, no profile files, no web-identity. That
// covers a developer, CI, Lambda and anything with an exported key; an EC2 instance role or an EKS
// service account needs a token fetched first. Add IMDSv2 (two requests, no new dependency) when a
// deployment needs it.

import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256 = (data: string): string =>
  createHash("sha256").update(data, "utf8").digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986, which is stricter than encodeURIComponent about these four. */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20260914T011500Z` and its `20260914` date half. */
export function amzDate(now: Date): { long: string; short: string } {
  const long = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { long, short: long.slice(0, 8) };
}

/**
 * Sign one request, returning the headers to send WITH it — the caller's own headers plus
 * `x-amz-date`, `authorization`, and `x-amz-security-token` when the credentials are temporary.
 *
 * Every header passed in is signed. That is stricter than required and it is the safe direction: an
 * unsigned header is one an intermediary can change without the signature noticing.
 */
export function signRequest(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}): Record<string, string> {
  const { long, short } = amzDate(opts.now);
  const headers: Record<string, string> = {
    ...opts.headers,
    host: opts.url.host,
    "x-amz-date": long,
    ...(opts.credentials.sessionToken
      ? { "x-amz-security-token": opts.credentials.sessionToken }
      : {}),
  };

  // Canonical headers: lowercase names, collapsed values, sorted by name.
  const canonicalNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const byLower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const canonicalHeaders = canonicalNames
    .map((n) => `${n}:${String(byLower.get(n)).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = canonicalNames.join(";");

  // Sorted by key, then by value for repeated keys — the ordering the spec requires.
  const query = [...opts.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) =>
      a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    opts.url.pathname || "/",
    query,
    canonicalHeaders,
    signedHeaders,
    sha256(opts.body),
  ].join("\n");

  const scope = `${short}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [ALGORITHM, long, scope, sha256(canonicalRequest)].join(
    "\n",
  );

  const signature = hmac(
    hmac(
      hmac(
        hmac(
          hmac(`AWS4${opts.credentials.secretAccessKey}`, short),
          opts.region,
        ),
        opts.service,
      ),
      "aws4_request",
    ),
    stringToSign,
  ).toString("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${opts.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
