// A JSON Web Token, built by hand.
//
// > **Use a library in production.** `jose` and `jsonwebtoken` are audited, and
// > they handle key rotation, JWKS, the other algorithms, and the mistakes you
// > have not thought of yet. This file exists so that when you *do* import one,
// > you know exactly what it is doing on your behalf - and so that the two
// > attacks below stop being trivia and become things you have personally
// > defended against.
//
// A JWT is three base64url strings joined by dots, and it is worth knowing that
// the first two are not encrypted, merely *encoded*:
//
//   eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiJ1MSIsIm5hbWUiOiJhbGljZSJ9 . 4x8Kf...
//   └── header ─────────┘   └── payload ──────────────────────┘   └ signature
//
// Anyone holding a token can read every claim in it. Base64 is not a lock, it is
// an envelope. Never put in a JWT anything you would not write on a postcard -
// the signature proves the postcard was not altered, and does nothing whatever to
// stop it being read.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { err, ok, AuthError, ErrorCode, type ChatError, type Result } from "./errors.js";

// The claims we care about. `sub`, `iat` and `exp` are the standard names - a
// token that uses them can be read by any other JWT tool, which is the entire
// reason to use a standard rather than inventing an envelope.
export const JwtPayloadSchema = z.object({
  sub: z.string().min(1),        // subject: who this is
  name: z.string().min(1),
  admin: z.boolean(),
  iat: z.number().int(),         // issued at, in SECONDS
  exp: z.number().int(),         // expires at, in SECONDS
});

export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

// JWT counts in seconds. JavaScript counts in milliseconds. This is one of the
// most reliable bugs in the ecosystem - a token that expires in 1970, or in
// 48,000 years - so the conversion happens in exactly two places, both here.
const seconds = (ms: number): number => Math.floor(ms / 1000);

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function issue(
  claims: Pick<JwtPayload, "sub" | "name" | "admin">,
  secret: string,
  ttlSeconds: number,
): { token: string; expiresAt: number } {
  const issuedAt = seconds(Date.now());
  const expiresAt = issuedAt + ttlSeconds;

  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ ...claims, iat: issuedAt, exp: expiresAt }));
  const body = `${header}.${payload}`;

  return { token: `${body}.${sign(body, secret)}`, expiresAt: expiresAt * 1000 };
}

// Compare two signatures without leaking, through timing, how much of one you
// got right.
//
// `a === b` on strings short-circuits at the first differing character. That is a
// side channel: an attacker who can measure how long the comparison took learns
// whether the first byte was correct, then the second, and can walk a valid
// signature out of you one byte at a time. It sounds far-fetched over a network
// and it has been done.
//
// `timingSafeEqual` always compares every byte. It requires equal lengths, so the
// length check is separate - and that is fine here, because an HMAC-SHA256
// signature is always exactly 43 base64url characters, so the length reveals
// nothing an attacker did not already know.
function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function verify(token: string, secret: string): Result<JwtPayload, ChatError> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return err(new AuthError("Malformed token.", ErrorCode.BadToken));
  }

  const [header, payload, signature] = parts as [string, string, string];

  // Attack one: `alg: "none"`.
  //
  // The header is supplied by whoever sent the token, and early JWT libraries
  // did the obvious, catastrophic thing: they read `alg` out of it and used
  // *that* algorithm to verify. Send `{"alg":"none"}` with an empty signature and
  // a library that trusts the header will happily agree that the unsigned token
  // is valid - and you have just let an attacker mint an admin.
  //
  // The header must never decide how the header is checked. We know what we
  // issued. Anything else is a forgery attempt, and is treated as one.
  let algorithm: unknown;
  try {
    algorithm = (JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown }).alg;
  } catch {
    return err(new AuthError("Malformed token.", ErrorCode.BadToken));
  }
  if (algorithm !== "HS256") {
    return err(new AuthError("Unsupported token algorithm.", ErrorCode.BadToken));
  }

  // Attack two: the signature. Checked before the payload is even parsed, and in
  // constant time.
  if (!equalsConstantTime(signature, sign(`${header}.${payload}`, secret))) {
    return err(new AuthError("Bad token signature.", ErrorCode.BadToken));
  }

  // The signature is good, so the payload is one *we* wrote - but "we wrote it"
  // is not "it is the shape we expect". A token issued by an older version of
  // this server, signed with the same secret, is authentic and may be missing a
  // field. Chapter 14's rule does not stop applying because the data is signed.
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return err(new AuthError("Malformed token.", ErrorCode.BadToken));
  }

  const parsed = JwtPayloadSchema.safeParse(claims);
  if (!parsed.success) {
    return err(new AuthError("Token is missing required claims.", ErrorCode.BadToken));
  }

  if (parsed.data.exp <= seconds(Date.now())) {
    // A distinct code, on purpose: "your token expired" means *log in again*,
    // and "your token is a forgery" means something else entirely. A client that
    // cannot tell them apart cannot do the right thing about either.
    return err(new AuthError("Token expired. Log in again.", ErrorCode.TokenExpired));
  }

  return ok(parsed.data);
}
