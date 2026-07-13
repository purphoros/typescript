// The event bus, and everything that listens to it.
//
// Chapter 8 built this and made the argument: handleMessage announces what
// happened, and independent listeners log it, remember it, and broadcast it.
// Splitting the file makes that argument visible. The handler imports the bus to
// *emit*; nothing in this module is imported by the handler at all. The three
// listeners below could be deleted and handler.ts would still compile.

import { TypedEmitter } from "./events.js";
import { asError, describeThrown } from "./errors.js";
import type { Fields, Logger } from "./logger.js";
import { assertNever, type RoomName, type ServerMessage, type Timestamp, type UserId } from "./protocol.js";
import { summarize } from "./views.js";
import type { MessageStore } from "./store.js";
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
  | { type: "rename"; from: UserId; to: UserId; at: Timestamp }
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
  rename: (client: ChatClient, from: UserId, to: UserId) => void;
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
    case "rename":  return `${event.from} is now known as ${event.to}`;
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

// Build a bus and subscribe everything that cares. The registry and the history
// are parameters rather than imports, which is what lets Chapter 19 build a bus
// over a throwaway registry and assert on what it broadcast.
export function createBus(registry: Registry, messages: MessageStore, logger: Logger): Bus {
  const bus: Bus = new TypedEmitter<ServerEvents>();

  // Listener 1: the log.
  //
  // Every line now carries *fields* as well as a sentence. `formatEvent` is still
  // here and still produces the human sentence - it is the `msg` - but the room,
  // the user and the code travel alongside it as data. That is the difference
  // between a log you read and a log you can query: `msg` is for the person,
  // everything after it is for the machine, and six months from now the machine
  // is the one doing the looking.
  const log = (event: ChatEvent, fields: Fields = {}): void => {
    logger.info(formatEvent(event), fields);
  };

  bus.on("connect", (client) =>
    logger.info(`${client.id} connected`, { client: client.id, transport: client.transport }));
  bus.on("disconnect", (client, remaining) =>
    logger.info(`${client.label} disconnected`, { client: client.id, user: client.label, remaining }));
  bus.on("join", (client, room) =>
    log({ type: "join", user: client.label, room, at: Date.now() }, { client: client.id, user: client.label, room }));
  bus.on("leave", (client, room) =>
    log({ type: "leave", user: client.label, room, at: Date.now() }, { client: client.id, user: client.label, room }));

  // A chat message is logged at DEBUG, not INFO, and that is a decision rather
  // than a detail. In production this is the highest-volume event on the server,
  // and it is also the one thing a chat server exists to keep private. `--log-level
  // info` means the operator sees who joined what and nothing they said.
  bus.on("message", (message) =>
    logger.debug(formatEvent({ type: "message", user: message.sender, room: message.room, text: message.text, at: message.at }),
      { user: message.sender, room: message.room, bytes: message.text.length }));

  // The log records *that* a whisper happened. It does not record what it said -
  // and now it cannot, because the text is not passed.
  bus.on("whisper", (from, to) =>
    logger.info(`${from.label} whispered to ${to.label}`, { from: from.label, to: to.label }));
  bus.on("kick", (by, target, reason) =>
    logger.warn(`${by.label} kicked ${target.label}`, { by: by.label, target: target.label, reason }));
  bus.on("rename", (_client, from, to) =>
    logger.info(`${from} is now known as ${to}`, { from, to }));
  bus.on("request", (method, path, status) =>
    logger.info(`${method} ${path} → ${status}`, { method, path, status, reason: statusLine(status) }));
  bus.on("upgrade", (id) =>
    logger.info(`${id} upgrading to WebSocket`, { client: id, status: 101 }));
  bus.on("notice", (text) => logger.info(text));

  // The log is the one audience allowed the whole truth: the stack, not the
  // sanitised sentence the client was given. And it is an *error*, which means it
  // is what an alert fires on.
  bus.on("failure", (source, error) =>
    logger.error(`${source} failed`, { source, error: describeThrown(error) }));

  // Listener 2: the room's memory. Messages are kept so a late joiner can catch
  // up without anyone waiting for a disk.
  bus.on("message", (message) => {
    registry.rooms.get(message.room)?.remember(message);
  });

  // Listener 2b: the archive. And this is the most instructive line in the
  // chapter, so it is worth being slow about.
  //
  // A listener's signature is `(message: ChatMessage) => void`. It returns
  // nothing, and the emitter that calls it is synchronous - it cannot await, it
  // has no idea what a Promise is, and it will not wait for one. But an `async`
  // listener is still assignable here, because `Promise<void>` is assignable to
  // `void`. TypeScript allows it deliberately, and it is the single easiest way
  // to lose data in Node:
  //
  //     bus.on("message", async (m) => { await history.append(m); });   // NO
  //
  // That compiles. It even works, right up until the write fails - and then
  // nobody is holding the Promise, the rejection is unhandled, and Node kills
  // the process. The main.ts net catches it and exits, which is correct and is
  // also your chat server going down because one disk write failed.
  //
  // So the listener stays synchronous and owns its own failure. `void` says the
  // Promise is deliberately not awaited, and `.catch` is the promise that
  // nothing escapes. Fire-and-forget is a legitimate choice - a chat message is
  // delivered whether or not it was archived - but it is only legitimate when
  // the forgetting is *explicit*.
  bus.on("message", (message) => {
    void messages
      .append(summarize(message))
      .catch((thrown: unknown) => bus.emit("failure", `archive ${message.room}`, asError(thrown)));
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
  // The room sees the new name; the client already got its own confirmation.
  bus.on("rename", (client, from, to) => {
    const room = client.room;
    if (room !== undefined) {
      registry.broadcast(room, { type: "system", text: `${from} is now known as ${to}` }, client);
    }
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
