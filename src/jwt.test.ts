// The security tests. These are the ones that would actually stop a breach.
import { describe, it, expect } from "vitest";
import { issue, verify } from "./jwt.js";
import { ErrorCode } from "./errors.js";

const SECRET = "a-test-secret-that-is-long-enough";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("jwt", () => {
  it("round-trips the claims it was given", () => {
    const { token } = issue({ sub: "u1", name: "alice", admin: true }, SECRET, 60);
    const result = verify(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe("u1");
      expect(result.value.name).toBe("alice");
      expect(result.value.admin).toBe(true);
    }
  });

  it("is not encrypted - anyone holding it can read every claim", () => {
    const { token } = issue({ sub: "u1", name: "alice", admin: true }, SECRET, 60);
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(payload.name).toBe("alice");   // this is the point, not a bug
  });

  // THE attack. A library that reads `alg` out of the attacker-supplied header
  // and trusts it will accept this, and the attacker is now an admin.
  it("refuses the alg:none forgery", () => {
    const forged =
      b64({ alg: "none", typ: "JWT" }) + "." +
      b64({ sub: "u1", name: "alice", admin: true, iat: 0, exp: 9999999999 }) + ".";
    const result = verify(forged, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.BadToken);
  });

  it("refuses a tampered payload with a reused signature", () => {
    const { token } = issue({ sub: "u2", name: "bob", admin: false }, SECRET, 60);
    const signature = token.split(".")[2]!;
    const tampered =
      b64({ alg: "HS256", typ: "JWT" }) + "." +
      b64({ sub: "u2", name: "bob", admin: true, iat: 0, exp: 9999999999 }) + "." + signature;
    expect(verify(tampered, SECRET).ok).toBe(false);
  });

  it("refuses a token signed with a different secret", () => {
    const { token } = issue({ sub: "u1", name: "alice", admin: true }, "some-other-secret", 60);
    expect(verify(token, SECRET).ok).toBe(false);
  });

  it("refuses an expired token, and says so distinctly", () => {
    const { token } = issue({ sub: "u1", name: "alice", admin: true }, SECRET, -1);
    const result = verify(token, SECRET);
    expect(result.ok).toBe(false);
    // A distinct code: "expired" means log in again; "forged" means something else.
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.TokenExpired);
  });

  it.each(["", "not.a.token", "a.b", "a.b.c.d"])("refuses malformed %o", (bad) => {
    expect(verify(bad, SECRET).ok).toBe(false);
  });
});
