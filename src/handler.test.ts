// The chat rules, driven with no socket, no port, and no waiting.
//
// This is Chapter 11's promise collected. Every test in this file runs the code
// that actually ships - the real handler, the real state machine, the real
// registry - against a client whose only unusual property is that it writes to an
// array instead of a wire.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { MessageHandler } from "./handler.js";
import { Registry } from "./state.js";
import { createBus } from "./bus.js";
import { FileHistory } from "./history.js";
import { Accounts, Sessions } from "./auth.js";
import { Metrics } from "./runtime.js";
import { configure, DEFAULTS } from "./config.js";
import { FakeClient } from "./testing.js";
import { ErrorCode } from "./errors.js";

const DATA = "data-test-handler";

async function build() {
  const config = configure(DEFAULTS, { dataDir: DATA, historyLimit: 10 });
  const registry = new Registry(config);
  const metrics = new Metrics();
  const history = new FileHistory(config.dataDir, metrics);
  await history.open();
  const accounts = new Accounts(metrics);
  await accounts.seedDefaults();
  const sessions = new Sessions();
  const bus = createBus(registry, history);
  const handler = new MessageHandler(registry, bus, history, accounts, sessions, config);
  return { handler, registry, sessions, config };
}

// Drive the client the way a socket would: one JSON line at a time.
const say = (h: MessageHandler, c: FakeClient, m: unknown) => h.handleLine(c, JSON.stringify(m));

// What ChatServer does on accept(). A client the handler has not been introduced
// to is not in the registry - so it receives no broadcasts and cannot be
// whispered to, which is exactly right and exactly what the first draft of this
// file forgot.
function arrive(h: MessageHandler, sequence: number): FakeClient {
  const client = new FakeClient(sequence);
  h.welcome(client);
  client.clear();
  return client;
}

async function loggedIn(h: MessageHandler, c: FakeClient, name: string, password: string) {
  await say(h, c, { type: "login", name, password });
  const token = c.last("token");
  if (token === undefined) throw new Error("no token issued");
  await say(h, c, { type: "auth", token: token.token });
}

describe("MessageHandler", () => {
  let ctx: Awaited<ReturnType<typeof build>>;

  // Clean up *before* as well as after.
  //
  // afterEach alone is not enough, and this bit me: a previous run that was
  // interrupted leaves data-test-handler/ on disk, the next run's first test
  // reads a room with history already in it, and the failure has nothing to do
  // with the change you just made. A test that depends on the last run having
  // exited cleanly is a test that will fail on somebody else's machine.
  beforeEach(async () => {
    await rm(DATA, { recursive: true, force: true });
    ctx = await build();
  });
  afterEach(async () => { await rm(DATA, { recursive: true, force: true }); });

  it("refuses everything before you have proved who you are", async () => {
    const { handler } = ctx;
    const alice = arrive(handler, 1);
    await say(handler, alice, { type: "join", room: "general" });
    await say(handler, alice, { type: "chat", text: "let me in" });
    expect(alice.errorCodes).toEqual([ErrorCode.Unauthenticated, ErrorCode.Unauthenticated]);
  });

  it("logs in, joins, and chats", async () => {
    const { handler } = ctx;
    const alice = arrive(handler, 1);
    await loggedIn(handler, alice, "alice", "correct-horse");
    expect(alice.last("authenticated")?.admin).toBe(true);

    await say(handler, alice, { type: "join", room: "general" });
    expect(alice.last("joined")?.room).toBe("general");
  });

  it("gives the same answer for a wrong password and an unknown user", async () => {
    const { handler } = ctx;
    const a = arrive(handler, 1);
    const b = arrive(handler, 2);
    await say(handler, a, { type: "login", name: "alice", password: "wrong" });
    await say(handler, b, { type: "login", name: "mallory", password: "wrong" });
    expect(a.last("error")?.message).toBe(b.last("error")?.message);
    expect(a.last("error")?.code).toBe(ErrorCode.BadCredentials);
  });

  // -------------------------------------------------------------------
  // REGRESSION: the membership leak (Chapter 16).
  //
  // Rooms used to store membership under client.label - a nickname, which
  // changes. Join, rename, leave, and the room kept a member who was not there,
  // permanently. This is the test that would have caught it in Chapter 5.
  // -------------------------------------------------------------------
  it("does not leak room membership when a client renames", async () => {
    const { handler, registry } = ctx;
    const client = arrive(handler, 1);

    await loggedIn(handler, client, "bob", "hunter2");
    await say(handler, client, { type: "join", room: "general" });
    expect(registry.rooms.get("general")?.memberCount).toBe(1);

    // Rename to a different account, in place. The id does not change.
    await loggedIn(handler, client, "alice", "correct-horse");
    expect(registry.rooms.get("general")?.memberCount).toBe(1);   // not 2

    await say(handler, client, { type: "leave" });
    expect(registry.rooms.get("general")?.memberCount).toBe(0);   // not 1
  });

  it("delivers a message from one client to another", async () => {
    const { handler } = ctx;
    const alice = arrive(handler, 1);
    const bob = arrive(handler, 2);
    await loggedIn(handler, alice, "alice", "correct-horse");
    await loggedIn(handler, bob, "bob", "hunter2");
    await say(handler, alice, { type: "join", room: "general" });
    await say(handler, bob, { type: "join", room: "general" });
    bob.clear();

    await say(handler, alice, { type: "chat", text: "hello everyone" });

    const heard = bob.last("chat");
    expect(heard?.sender).toBe("alice");
    expect(heard?.text).toBe("hello everyone");
  });

  it("lets an admin kick, and refuses everyone else", async () => {
    const { handler } = ctx;
    const alice = arrive(handler, 1);   // admin
    const bob = arrive(handler, 2);     // not
    await loggedIn(handler, alice, "alice", "correct-horse");
    await loggedIn(handler, bob, "bob", "hunter2");
    await say(handler, alice, { type: "join", room: "general" });
    await say(handler, bob, { type: "join", room: "general" });

    await say(handler, bob, { type: "kick", target: "alice", reason: "no" });
    expect(bob.last("error")?.code).toBe(ErrorCode.NotPermitted);

    await say(handler, alice, { type: "kick", target: "bob", reason: "spam" });
    expect(bob.last("kicked")?.by).toBe("alice");
  });

  it("rate-limits a flood", async () => {
    const { handler } = ctx;
    const alice = arrive(handler, 1);
    await loggedIn(handler, alice, "alice", "correct-horse");
    await say(handler, alice, { type: "join", room: "general" });
    alice.clear();

    for (let i = 0; i < 40; i++) await say(handler, alice, { type: "chat", text: `flood ${i}` });

    expect(alice.errorCodes.filter((c) => c === ErrorCode.RateLimited).length).toBeGreaterThan(0);
  });

  it("creates a room on demand and reaps it when the last person leaves", async () => {
    const { handler, registry } = ctx;
    const alice = arrive(handler, 1);
    await loggedIn(handler, alice, "alice", "correct-horse");

    expect(registry.rooms.has("standup")).toBe(false);
    await say(handler, alice, { type: "join", room: "standup" });
    expect(registry.rooms.has("standup")).toBe(true);

    await say(handler, alice, { type: "leave" });
    expect(registry.rooms.has("standup")).toBe(false);   // reaped
    expect(registry.rooms.has("general")).toBe(true);    // permanent: kept
  });
});
