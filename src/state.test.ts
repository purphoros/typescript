// Rooms and the registry - no sockets, no server, no waiting.
import { describe, it, expect } from "vitest";
import { Registry } from "./state.js";
import { ChatRoom, ChatMessage } from "./model.js";
import { configure, DEFAULTS } from "./config.js";
import { clientId } from "./types.js";
import { ErrorCode, ChatError } from "./errors.js";

const build = () => new Registry(configure(DEFAULTS, { maxRooms: 6 }));

describe("ChatRoom", () => {
  it("tracks membership by id", () => {
    const room = new ChatRoom("general", 10);
    const a = clientId("c1");
    room.join(a);
    expect(room.memberCount).toBe(1);
    expect(room.hasMember(a)).toBe(true);
    expect(room.leave(a)).toBe(true);
    expect(room.isEmpty).toBe(true);
  });

  it("keeps only the last N messages in memory", () => {
    const room = new ChatRoom("general", 3);
    for (let i = 0; i < 10; i++) room.remember(new ChatMessage("alice", `m${i}`, "general"));
    expect(room.messageCount).toBe(3);
    expect(room.recent(3).map((m) => m.text)).toEqual(["m7", "m8", "m9"]);
  });

  // REGRESSION (Chapter 12): load() used to rebuild rooms with `new
  // ChatMessage(...)`, whose constructor stamps Date.now() - so every restart
  // relabelled the entire archive with the boot time. The file was right and
  // everything the server said about it was wrong.
  it("restores a message with its ORIGINAL timestamp", () => {
    const then = 1_600_000_000_000;
    const restored = ChatMessage.restore({ sender: "alice", text: "old", room: "general", at: then });
    expect(restored.at).toBe(then);
    expect(restored.at).not.toBe(Date.now());
  });
});

describe("Registry", () => {
  it("creates a room by being walked into", () => {
    const r = build();
    expect(r.rooms.has("standup")).toBe(false);
    r.getOrCreateRoom("standup");
    expect(r.rooms.has("standup")).toBe(true);
  });

  it("bounds how many rooms a stranger can create", () => {
    const r = build();   // maxRooms 6, 3 permanent
    r.getOrCreateRoom("a");
    r.getOrCreateRoom("b");
    r.getOrCreateRoom("c");
    expect(() => r.getOrCreateRoom("d")).toThrow(ChatError);
    try { r.getOrCreateRoom("d"); } catch (e) { expect((e as ChatError).code).toBe(ErrorCode.NotPermitted); }
  });

  it("reaps an empty created room but keeps the permanent ones", () => {
    const r = build();
    r.getOrCreateRoom("standup");
    expect(r.reapIfEmpty("standup")).toBe(true);
    expect(r.reapIfEmpty("general")).toBe(false);   // a lobby, not litter
  });

  it("does not reap a room somebody is in", () => {
    const r = build();
    r.getOrCreateRoom("standup").join(clientId("c1"));
    expect(r.reapIfEmpty("standup")).toBe(false);
  });

  it("404s a room that does not exist rather than conjuring one", () => {
    const r = build();
    expect(() => r.requireRoomNamed("ghost")).toThrow(ChatError);
    expect(r.rooms.has("ghost")).toBe(false);   // asking did not create it
  });
});
