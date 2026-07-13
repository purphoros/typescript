// The event bus, and everything that listens to it.
//
// Chapter 8 built this and made the argument: handleMessage announces what
// happened, and independent listeners log it, remember it, and broadcast it.
// Splitting the file makes that argument visible. The handler imports the bus to
// *emit*; nothing in this module is imported by the handler at all. The three
// listeners below could be deleted and handler.ts would still compile.

import { TypedEmitter } from "./events.js";
import { describeThrown } from "./errors.js";
import { assertNever, type RoomName, type ServerMessage, type Timestamp, type UserId } from "./protocol.js";
import type { ChatMessage } from "./model.js";
import type { Registry } from "./state.js";
import type { ChatClient } from "./types.js";

// What the server writes to its own console. This is *not* ServerMessage: the
// log records things no client is ever told - an HTTP request, a socket error, a
// protocol violation - and deliberately omits things clients do see, like the
// text of a private whisper. Two audiences, two unions.
export type ChatEvent =
  | { type: "message"; user: UserId; room: RoomName; text: string; at: Timestamp }
  | { type: "whisper"; from: UserId; to: UserId; at: Timestamp }
  | { type: "join"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "leave"; user: UserId; room: RoomName; at: Timestamp }
  | { type: "kick"; by: UserId; target: UserId; reason: string; at: Timestamp }
  | { type: "system"; text: string; at: Timestamp };

// The bus's contract: event name → the handler that listens for it. Every emit
// and every on() in the program is checked against this map. Misspell an event,
// or pass a room where a client belongs, and it does not compile.
//
// This must be a `type`, not an `interface`. An interface has no implicit index
// signature, so it does not satisfy EventMap's `Record<string, ...>` constraint,
// and TypedEmitter<ServerEvents> fails with TS2344. A type alias does. It is a
// one-word difference and an unhelpful error message.
export type ServerEvents = {
  connect: (client: ChatClient) => void;
  disconnect: (client: ChatClient, remaining: number) => void;
  join: (client: ChatClient, room: RoomName) => void;
  leave: (client: ChatClient, room: RoomName) => void;
  message: (message: ChatMessage) => void;
  whisper: (from: ChatClient, to: ChatClient, text: string) => void;
  kick: (by: ChatClient, target: ChatClient, reason: string) => void;
  request: (method: string, path: string, status: number) => void;
  upgrade: (id: string) => void;
  notice: (text: string) => void;
  failure: (source: string, error: Error) => void;
};

export type Bus = TypedEmitter<ServerEvents>;

// Extract<> narrows a union to the one variant matching a shape - see Chapter 9.
// Naming it saves repeating the whisper's five fields in the listener below.
type Whisper = Extract<ServerMessage, { type: "whisper" }>;

// Narrowing by discriminant: each branch sees only that variant's fields. Add a
// ChatEvent variant and assertNever names the one you have not handled.
export function formatEvent(event: ChatEvent): string {
  switch (event.type) {
    case "message": return `[${event.room}] ${event.user}: ${event.text}`;
    case "whisper": return `${event.from} → ${event.to} (private)`;
    case "join":    return `→ ${event.user} joined ${event.room}`;
    case "leave":   return `← ${event.user} left ${event.room}`;
    case "kick":    return `⚡ ${event.by} kicked ${event.target}: ${event.reason}`;
    case "system":  return `[SYSTEM] ${event.text}`;
    default:        return assertNever(event);
  }
}

// The reason phrase for an HTTP status code - the text after the number on a
// response's first line. The log wants it; so does http.ts.
export function statusLine(code: number): string {
  switch (code) {
    case 101: return "Switching Protocols";
    case 200: return "OK";
    case 201: return "Created";
    case 204: return "No Content";
    case 301: return "Moved Permanently";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 409: return "Conflict";
    case 422: return "Unprocessable Content";
    case 500: return "Internal Server Error";
    default:  return "Unknown";
  }
}

// Build a bus and subscribe everything that cares. The registry is a parameter
// rather than an import, which is what lets Chapter 19 build a bus over a
// throwaway registry and assert on what it broadcast.
export function createBus(registry: Registry): Bus {
  const bus: Bus = new TypedEmitter<ServerEvents>();
  const log = (event: ChatEvent): void => console.log(formatEvent(event));

  // Listener 1: the log. Every event becomes a ChatEvent record and is printed.
  bus.on("connect", (client) =>
    log({ type: "system", text: `${client.id} connected [${client.transport}]`, at: Date.now() }));
  bus.on("disconnect", (client, remaining) =>
    log({ type: "system", text: `${client.label} disconnected (${remaining} remaining)`, at: Date.now() }));
  bus.on("join", (client, room) =>
    log({ type: "join", user: client.label, room, at: Date.now() }));
  bus.on("leave", (client, room) =>
    log({ type: "leave", user: client.label, room, at: Date.now() }));
  bus.on("message", (message) =>
    log({ type: "message", user: message.sender, room: message.room, text: message.text, at: message.at }));
  // The log records *that* a whisper happened. It does not record what it said.
  bus.on("whisper", (from, to) =>
    log({ type: "whisper", from: from.label, to: to.label, at: Date.now() }));
  bus.on("kick", (by, target, reason) =>
    log({ type: "kick", by: by.label, target: target.label, reason, at: Date.now() }));
  bus.on("request", (method, path, status) =>
    log({ type: "system", text: `${method} ${path} → ${status} ${statusLine(status)}`, at: Date.now() }));
  bus.on("upgrade", (id) =>
    log({ type: "system", text: `${id} upgrading to WebSocket → 101 ${statusLine(101)}`, at: Date.now() }));
  bus.on("notice", (text) =>
    log({ type: "system", text, at: Date.now() }));
  // The log is the one audience allowed the whole truth: the stack, not the
  // sanitised sentence the client was given.
  bus.on("failure", (source, error) =>
    log({ type: "system", text: `${source} failed - ${describeThrown(error)}`, at: Date.now() }));

  // Listener 2: the room's memory. Messages are kept so a late joiner can catch up.
  bus.on("message", (message) => {
    registry.rooms.get(message.room)?.remember(message);
  });

  // Listener 3: the wire. This is what actually delivers chat to other people.
  bus.on("message", (message) => {
    registry.broadcast(message.room, {
      type: "chat",
      sender: message.sender,
      text: message.text,
      room: message.room,
      at: message.at,
    });
  });
  bus.on("whisper", (from, to, text) => {
    const delivered: Whisper = {
      type: "whisper",
      from: from.label,
      to: to.label,
      text,
      at: Date.now(),
    };
    to.send(delivered);
    from.send(delivered); // the sender sees their own whisper land
  });
  bus.on("join", (client, room) => {
    registry.broadcast(
      room,
      { type: "joined", user: client.label, room, members: registry.rooms.get(room)?.memberCount ?? 0 },
      client,
    );
  });
  bus.on("leave", (client, room) => {
    registry.broadcast(room, { type: "left", user: client.label, room }, client);
  });
  bus.on("kick", (by, target, reason) => {
    const room = target.room;
    if (room !== undefined) {
      registry.broadcast(
        room,
        { type: "system", text: `${target.label} was kicked by ${by.label}: ${reason}` },
        target,
      );
    }
    target.end({ type: "kicked", by: by.label, reason });
  });

  return bus;
}
