import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStorage } from "./sqlite.js";
import { FileHistory } from "./history.js";
import { Metrics } from "./runtime.js";
import { Logger } from "./logger.js";
import { rm } from "node:fs/promises";
import type { MessageStore } from "./store.js";

const quiet = new Logger({ level: "error", format: "json", write: () => {} });
const msg = (text: string, room = "general", at = Date.now()) => ({ room, sender: "alice", text, at });

describe("SqliteStorage", () => {
  let storage: SqliteStorage;
  beforeEach(async () => {
    storage = new SqliteStorage(":memory:", new Metrics(), quiet);
    await storage.messages.open();
  });
  afterEach(() => storage.close());

  it("round-trips a message", async () => {
    await storage.messages.append(msg("hello", "general", 1000));
    const recent = await storage.messages.recent("general", 10);
    expect(recent).toEqual([{ room: "general", sender: "alice", text: "hello", at: 1000 }]);
  });

  it("returns the last N, oldest first, and only from that room", async () => {
    for (let i = 0; i < 10; i++) await storage.messages.append(msg(`m${i}`, "general", 1000 + i));
    await storage.messages.append(msg("elsewhere", "random", 9999));
    const recent = await storage.messages.recent("general", 3);
    expect(recent.map((m) => m.text)).toEqual(["m7", "m8", "m9"]);
  });

  // The reason a bound parameter is not optional.
  it("cannot be SQL-injected through the search query", async () => {
    await storage.messages.append(msg("hello", "general", 1));

    const evil = "%'; DROP TABLE messages; --";
    const hits = await storage.messages.search("general", evil, 10);
    expect(hits).toEqual([]);            // it is a search string, not syntax

    // And the table is still there, which is the whole point.
    expect(await storage.messages.recent("general", 10)).toHaveLength(1);
  });

  // Not a security bug - a correctness one, and the same shape: a value being
  // read as syntax.
  it("treats LIKE wildcards in a query as literal characters", async () => {
    await storage.messages.append(msg("100% done", "general", 1));
    await storage.messages.append(msg("nothing to do with it", "general", 2));
    const hits = await storage.messages.search("general", "100%", 10);
    expect(hits.map((m) => m.text)).toEqual(["100% done"]);   // not both
  });

  it("migrates once and is idempotent on reopen", async () => {
    // A second open() over the same in-memory handle must not re-run migrations
    // or it would fail on "table already exists".
    await expect(storage.messages.open()).resolves.not.toThrow();
  });

  it("stores and reads back an admin account with its permissions", async () => {
    await storage.accounts.save({
      user: { id: "u1", name: "alice", joinedAt: 42, adminLevel: 2, permissions: ["kick", "ban"] },
      passwordHash: "scrypt$x$y",
    });
    const found = await storage.accounts.find("alice");
    expect(found?.user).toMatchObject({ name: "alice", adminLevel: 2, permissions: ["kick", "ban"] });
    expect(await storage.accounts.find("nobody")).toBeUndefined();
  });
});

// The port is only real if two implementations satisfy it. Run the same
// expectations against both, and neither knows the difference.
describe.each<[string, () => Promise<MessageStore>]>([
  ["sqlite", async () => {
    const s = new SqliteStorage(":memory:", new Metrics(), quiet);
    await s.messages.open();
    return s.messages;
  }],
  ["file", async () => {
    await rm("data-test-store", { recursive: true, force: true });
    const f = new FileHistory("data-test-store", new Metrics());
    await f.open();
    return f;
  }],
])("MessageStore contract: %s", (_name, make) => {
  let store: MessageStore;
  beforeEach(async () => { store = await make(); });
  afterEach(async () => {
    await store.close();
    await rm("data-test-store", { recursive: true, force: true });
  });

  it("appends and reads back in order", async () => {
    await store.append(msg("one", "general", 1));
    await store.append(msg("two", "general", 2));
    await store.flush();
    expect((await store.recent("general", 10)).map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("finds text", async () => {
    await store.append(msg("the deploy went fine", "general", 1));
    await store.append(msg("lunch?", "general", 2));
    await store.flush();
    expect((await store.search("general", "deploy", 10)).map((m) => m.text)).toEqual(["the deploy went fine"]);
  });

  it("returns nothing for a room nobody has spoken in", async () => {
    expect(await store.recent("empty", 10)).toEqual([]);
  });
});
