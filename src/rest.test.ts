import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Rest } from "./rest.js";
import { Registry } from "./state.js";
import { createBus } from "./bus.js";
import { SqliteStorage } from "./sqlite.js";
import { Accounts, Sessions } from "./auth.js";
import { Metrics, Runtime } from "./runtime.js";
import { Logger } from "./logger.js";
import { configure, DEFAULTS } from "./config.js";
import { ErrorCode } from "./errors.js";
import { toSafeError } from "./errors.js";
import type { HttpRequest, HttpResponse } from "./http.js";

const quiet = new Logger({ level: "error", format: "json", write: () => {} });

async function build() {
  const config = configure(DEFAULTS, {});
  const registry = new Registry(config);
  const metrics = new Metrics();
  const storage = new SqliteStorage(":memory:", metrics, quiet);
  await storage.messages.open();
  const accounts = new Accounts(storage.accounts, metrics);
  await accounts.seedDefaults();
  const sessions = new Sessions();
  const bus = createBus(registry, storage.messages, quiet);
  const runtime = new Runtime();
  const rest = new Rest({ registry, bus, messages: storage.messages, accounts, sessions, runtime, metrics, config });
  return { rest, storage, runtime, registry };
}

// The boundary in http.ts turns a thrown ChatError into a response. Tests drive
// Rest directly, so they have to do the same - and doing it here, once, is what
// keeps every test below asserting on *status codes* rather than on exceptions.
async function call(rest: Rest, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<HttpResponse> {
  const headers = new Map<string, string>();
  if (opts.token !== undefined) headers.set("authorization", `Bearer ${opts.token}`);
  const req: HttpRequest = {
    method, path, version: "1.1", headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  try {
    return await rest.handle(req);
  } catch (thrown: unknown) {
    const safe = toSafeError(thrown);
    return { status: safe.status, headers: {}, body: JSON.stringify({ error: safe.message, code: safe.code }) };
  }
}

const parse = (res: HttpResponse) => JSON.parse(res.body);

describe("Rest", () => {
  let ctx: Awaited<ReturnType<typeof build>>;
  let token: string;

  beforeEach(async () => {
    ctx = await build();
    const res = await call(ctx.rest, "POST", "/api/login", { body: { name: "alice", password: "correct-horse" } });
    token = parse(res).token;
  });
  afterEach(async () => { ctx.runtime.stop(); await ctx.storage.messages.close(); });

  // The hole Chapter 17 left: HTTP had no auth at all.
  it("refuses every private route without a token", async () => {
    for (const path of ["/api/rooms", "/api/users/me", "/api/rooms/general/messages"]) {
      const res = await call(ctx.rest, "GET", path);
      expect(res.status, path).toBe(401);
      expect(parse(res).code).toBe(ErrorCode.Unauthenticated);
    }
  });

  it("404s an unknown path even without a token, rather than 401", async () => {
    // "That path exists, you just cannot see it" is a small leak, and it is free
    // not to make it.
    expect((await call(ctx.rest, "GET", "/api/secrets")).status).toBe(404);
  });

  it("leaves the public routes public - a load balancer cannot log in", async () => {
    expect((await call(ctx.rest, "GET", "/api/health")).status).toBe(200);
    expect((await call(ctx.rest, "GET", "/api/protocol")).status).toBe(200);
  });

  it("refuses a wrong password with 401 and an opaque message", async () => {
    const res = await call(ctx.rest, "POST", "/api/login", { body: { name: "alice", password: "nope" } });
    expect(res.status).toBe(401);
    expect(parse(res).error).toBe("Wrong name or password.");
  });

  it("refuses a forged token", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = b64({ alg: "none" }) + "." + b64({ sub: "u1", name: "alice", admin: true, iat: 0, exp: 9e9 }) + ".";
    const res = await call(ctx.rest, "GET", "/api/users/me", { token: forged });
    expect(res.status).toBe(401);
  });

  it("lets a real token through", async () => {
    const res = await call(ctx.rest, "GET", "/api/users/me", { token });
    expect(res.status).toBe(200);
    expect(parse(res)).toMatchObject({ name: "alice", admin: true });
  });

  it("creates a message with 201 and a Location", async () => {
    const res = await call(ctx.rest, "POST", "/api/rooms/general/messages", { token, body: { text: "hello" } });
    expect(res.status).toBe(201);
    expect(res.headers.Location).toContain("/api/rooms/general/messages");
    expect(parse(res)).toMatchObject({ sender: "alice", text: "hello", room: "general" });
  });

  it("rejects a message that breaks the size limit with 422, not 400", async () => {
    const res = await call(ctx.rest, "POST", "/api/rooms/general/messages", { token, body: { text: "x".repeat(1001) } });
    expect(res.status).toBe(422);   // well-formed, and still no
  });

  // A cursor, not an offset. Page 2 must not repeat or skip a row just because
  // somebody said something while you were reading page 1.
  it("pages backwards through history with a cursor", async () => {
    for (let i = 0; i < 25; i++) {
      await ctx.storage.messages.append({ room: "general", sender: "alice", text: `m${i}`, at: 1000 + i });
    }

    const first = parse(await call(ctx.rest, "GET", "/api/rooms/general/messages?limit=10", { token }));
    expect(first.messages.map((m: { text: string }) => m.text)).toEqual(
      ["m15","m16","m17","m18","m19","m20","m21","m22","m23","m24"],
    );
    expect(first.next).toContain("before=1015");

    const second = parse(await call(ctx.rest, "GET", first.next, { token }));
    expect(second.messages.map((m: { text: string }) => m.text)).toEqual(
      ["m5","m6","m7","m8","m9","m10","m11","m12","m13","m14"],
    );

    // A new message arriving now must NOT shift the next page - which is exactly
    // what OFFSET would have done.
    await ctx.storage.messages.append({ room: "general", sender: "bob", text: "brand new", at: 99999 });
    const third = parse(await call(ctx.rest, "GET", second.next, { token }));
    expect(third.messages.map((m: { text: string }) => m.text)).toEqual(["m0","m1","m2","m3","m4"]);
    expect(third.next).toBeNull();   // no more history: the client knows to stop
  });

  it("searches", async () => {
    await ctx.storage.messages.append({ room: "general", sender: "alice", text: "the deploy went fine", at: 1 });
    await ctx.storage.messages.append({ room: "general", sender: "alice", text: "lunch?", at: 2 });
    const res = parse(await call(ctx.rest, "GET", "/api/rooms/general/search?q=deploy", { token }));
    expect(res.messages.map((m: { text: string }) => m.text)).toEqual(["the deploy went fine"]);
  });

  it("405s a known path with the wrong verb, and says which verbs work", async () => {
    const res = await call(ctx.rest, "DELETE", "/api/rooms", { token });
    expect(res.status).toBe(405);
    expect(res.headers.Allow).toContain("GET");
  });
});
