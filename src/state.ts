// Who is here, what rooms exist, and who is allowed to be whom.
//
// Chapters 5-10 kept all of this in module-level `const`s at the top of a
// thousand-line file: `const rooms = new Map()`, `const clients = new Map()`,
// `let sequence = 0`. It worked because there was one server and one file, and
// those two facts held hands.
//
// They stop holding hands the moment you want a second server - which you will,
// in Chapter 19, once per test. A `Registry` you construct is a `Registry` you
// can construct twice, and throw away, and construct again with three rooms and
// no users. Module-level mutable state is a singleton you did not decide to
// write, and tests are where you find out you wrote one.

import { NotFoundError, ErrorCode, StateError } from "./errors.js";
import { CATALOG, type RoomName, type ServerMessage } from "./protocol.js";
import { ChatRoom } from "./model.js";
import { pluck } from "./events.js";
import type { ServerConfig } from "./config.js";
import type { AdminUser, ChatClient, User } from "./types.js";

export class Registry {
  readonly rooms = new Map<RoomName, ChatRoom>();

  // Every live chat client, TCP or WebSocket alike. HTTP requests come and go
  // within a single exchange and are never listed here.
  readonly clients = new Map<string, ChatClient>();

  // Users the server already knows about. Chapter 17 replaces this with real
  // authentication; for now a "nick" message simply claims an identity.
  readonly knownUsers = new Map<string, User | AdminUser>([
    ["alice", { id: "u1", name: "alice", joinedAt: Date.now(), adminLevel: 2, permissions: ["kick", "ban", "mute"] }],
    ["bob", { id: "u2", name: "bob", joinedAt: Date.now() }],
  ]);

  private sequence = 0;

  constructor(config: ServerConfig) {
    for (const name of config.rooms) {
      this.rooms.set(name, new ChatRoom(name, config.historyLimit));
    }
  }

  // Connection ids are handed out from here because there is exactly one counter
  // per server, and it belongs to the thing that knows how many there are.
  nextSequence(): number {
    return ++this.sequence;
  }

  add(client: ChatClient): void {
    this.clients.set(client.id, client);
  }

  remove(client: ChatClient): void {
    this.clients.delete(client.id);
  }

  get roomNames(): string[] {
    return pluck([...this.rooms.values()], "name");
  }

  // Send to everyone in a room, optionally skipping one client (usually the
  // sender). Transport is irrelevant here: a message typed into nc lands in a
  // browser, and vice versa, because both are just ChatClients being handed a
  // ServerMessage that each knows how to put on its own wire.
  broadcast(room: RoomName, message: ServerMessage, except?: ChatClient): void {
    for (const client of this.clients.values()) {
      if (client.room === room && client !== except) {
        client.send(message);
      }
    }
  }

  // --- Lookups that refuse to fail quietly -------------------------------
  //
  // Each of these throws a ChatError rather than returning undefined, because
  // there is exactly one thing every caller would do with the undefined, and it
  // happens at the boundary. See Chapter 10.

  // A room by name, or a 404 with the list of rooms that do exist.
  requireRoomNamed(name: RoomName): ChatRoom {
    const room = this.rooms.get(name);
    if (room === undefined) {
      throw new NotFoundError(
        `No such room "${name}". Try: ${this.roomNames.join(", ")}`,
        ErrorCode.UnknownRoom,
      );
    }
    return room;
  }

  // The room this client is in, or the reason it is not in one.
  requireRoom(client: ChatClient): ChatRoom {
    const name = client.room;
    if (name === undefined) {
      throw new StateError(`Join a room first, e.g. ${CATALOG.join.example}`);
    }
    const room = this.rooms.get(name);
    if (room === undefined) {
      // The client thinks it is somewhere that does not exist. That is our bug,
      // not theirs - so it is not a ChatError, and the boundary will treat it as
      // exactly what it is.
      throw new Error(`invariant: ${client.id} is in unknown room "${name}"`);
    }
    return room;
  }

  // Find a client by the name it goes by. Whisper and kick both need this, and
  // neither can do anything useful when the person is not here.
  requireClient(label: string): ChatClient {
    for (const client of this.clients.values()) {
      if (client.label === label) {
        return client;
      }
    }
    throw new NotFoundError(`Nobody here is called "${label}".`, ErrorCode.NoSuchTarget);
  }
}
