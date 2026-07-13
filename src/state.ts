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
import type { AdminUser, ChatClient, ClientId, User } from "./types.js";

export class Registry {
  readonly rooms = new Map<RoomName, ChatRoom>();

  // Every live chat client, TCP or WebSocket alike. HTTP requests come and go
  // within a single exchange and are never listed here.
  readonly clients = new Map<ClientId, ChatClient>();

  // Users the server already knows about. Chapter 17 replaces this with real
  // authentication; for now a "nick" message simply claims an identity.
  readonly knownUsers = new Map<string, User | AdminUser>([
    ["alice", { id: "u1", name: "alice", joinedAt: Date.now(), adminLevel: 2, permissions: ["kick", "ban", "mute"] }],
    ["bob", { id: "u2", name: "bob", joinedAt: Date.now() }],
  ]);

  private sequence = 0;

  constructor(private readonly config: ServerConfig) {
    for (const name of config.rooms) {
      this.rooms.set(name, new ChatRoom(name, config.historyLimit));
    }
  }

  // The rooms that exist because the operator said so. They stay even when empty
  // - `general` with nobody in it is still where people go to find each other.
  private isPermanent(name: RoomName): boolean {
    return this.config.rooms.includes(name);
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

  // Join a room that does not exist and it comes into being. That is what a chat
  // server is for, and it is also - unbounded - how somebody fills your heap with
  // ten million empty rooms, so it is bounded.
  //
  // The name is already known to be safe: the schema (Chapter 14) allows only
  // lowercase letters, digits and hyphens, up to 32 characters. Which is why this
  // function can create a *file* named after it without a second thought.
  getOrCreateRoom(name: RoomName): ChatRoom {
    const existing = this.rooms.get(name);
    if (existing !== undefined) {
      return existing;
    }
    if (this.rooms.size >= this.config.maxRooms) {
      throw new StateError(
        `This server holds ${this.config.maxRooms} rooms and they are all taken.`,
        ErrorCode.NotPermitted,
      );
    }
    const room = new ChatRoom(name, this.config.historyLimit);
    this.rooms.set(name, room);
    return room;
  }

  // The last person out turns off the lights.
  //
  // Returns true if the room was actually removed, so the caller can say so. The
  // permanent rooms survive: an empty `general` is not litter, it is a lobby.
  //
  // Note what is *not* deleted: the room's history file. Rooms are cheap and
  // conversations are not. Walk back into #standup a week later and it is still
  // there - the room object is a handle, not the archive.
  reapIfEmpty(name: RoomName): boolean {
    const room = this.rooms.get(name);
    if (room === undefined || !room.isEmpty || this.isPermanent(name)) {
      return false;
    }
    this.rooms.delete(name);
    return true;
  }

  // Who is actually in a room, as clients rather than ids.
  //
  // The room holds ids because ids do not change. Anything that wants a *name*
  // comes through here, and gets the name as it is right now - which is the whole
  // reason the two are different types.
  membersOf(room: ChatRoom): ChatClient[] {
    const members: ChatClient[] = [];
    for (const id of room.memberIds) {
      const client = this.clients.get(id);
      if (client !== undefined) {
        members.push(client);
      }
    }
    return members;
  }

  // A room by name, or a 404 with the list of rooms that do exist. Used by HTTP,
  // where asking about a room must not conjure one.
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
