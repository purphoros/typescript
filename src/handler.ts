// What the server does when somebody says something.
//
// Read the imports. There is no `node:net` here, no `ws`, no Buffer, no socket
// of any kind. This module takes a `ChatClient` - an interface - and a string,
// and that is the entire contact it has with the outside world. It could not
// open a connection if it wanted to.
//
// That is not tidiness, it is the payoff. Chapter 19 tests every rule in this
// file by handing it a ChatClient that pushes messages onto an array, and the
// handler cannot tell the difference. You do not test a chat rule by opening a
// TCP port, and if you have to, the rule is in the wrong file.

import { HISTORY_ON_JOIN } from "./config.js";
import { asError, ChatError, NotFoundError, PermissionError, toSafeError, ErrorCode } from "./errors.js";
import {
  assertNever,
  CATALOG,
  COMMANDS,
  decodeClientMessage,
  describeState,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import { ChatMessage, type ChatRoom } from "./model.js";
import { isAdmin, type ChatClient } from "./types.js";
import { describeClient, describeRoom, summarize } from "./views.js";
import type { Bus } from "./bus.js";
import type { FileHistory } from "./history.js";
import type { Registry } from "./state.js";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// One error, rendered for a chat client. Whether it was thrown or returned, and
// whether it was ours or a surprise, it leaves as the same ServerMessage.
export function toErrorMessage(thrown: unknown): ServerMessage {
  const safe = toSafeError(thrown);
  return { type: "error", code: safe.code, message: safe.message };
}

export class MessageHandler {
  // The registry, the bus and the history arrive as constructor arguments rather
  // than imports. That one change is what makes this class a unit: give it a
  // different registry and it manages a different world, which is precisely what
  // a test wants to do.
  constructor(
    private readonly registry: Registry,
    private readonly bus: Bus,
    private readonly history: FileHistory,
  ) {}

  // The error boundary. Every line from every client, on either transport,
  // passes through exactly here, and nothing thrown below it escapes.
  //
  // It is `async` now, and the try/catch did not have to change one character.
  // That is the actual gift of async/await, and it is easy to walk past: an
  // `await` that rejects throws at the await, so the same `catch` that has been
  // handling synchronous failures since Chapter 10 handles a disk that is on
  // fire. Compare the `.then().catch()` version, where the error path is a
  // different mechanism in a different place from the success path.
  //
  // Three outcomes, and they are genuinely different:
  //
  //   the message decoded   → handle it
  //   it did not decode     → a Result said so. Tell them why.
  //   something threw       → if it is ours, it was deliberate and safe to
  //                           repeat. If not, it is a bug: log the stack, and
  //                           tell them nothing.
  async handleLine(client: ChatClient, line: string): Promise<void> {
    try {
      const decoded = decodeClientMessage(line);
      if (!decoded.ok) {
        client.send(toErrorMessage(decoded.error));
        return;
      }
      await this.handleMessage(client, decoded.value);
    } catch (thrown: unknown) {
      if (!(thrown instanceof ChatError)) {
        this.bus.emit("failure", client.label, asError(thrown));
      }
      client.send(toErrorMessage(thrown));
    }
  }

  // Everything a client needs when it arrives, whatever transport brought it.
  welcome(client: ChatClient): void {
    this.registry.add(client);
    this.bus.emit("connect", client);
    client.send({
      type: "welcome",
      id: client.id,
      transport: client.transport,
      text: `Welcome. You are ${client.id}. Send ${CATALOG.help.example} to see what I understand.`,
    });
  }

  // ...and everything it needs when it leaves.
  farewell(client: ChatClient): void {
    const room = client.room;
    if (room !== undefined) {
      // By id. A label is a nickname and a nickname changes; see ClientId.
      this.registry.rooms.get(room)?.leave(client.id);
      this.bus.emit("leave", client, room);
      this.reap(room);
    }
    this.registry.remove(client);
    this.bus.emit("disconnect", client, this.registry.clients.size);
  }

  // A room nobody is in stops existing - unless it is one of the permanent ones.
  private reap(room: string): void {
    if (this.registry.reapIfEmpty(room)) {
      this.bus.emit("notice", `#${room} is empty and has been closed`);
    }
  }

  // Show a client what it missed, from memory. Nobody waits for a disk to join a
  // room - this is the hot path, and it is synchronous on purpose.
  private replay(client: ChatClient, room: ChatRoom, count: number): void {
    client.send({
      type: "history",
      room: room.name,
      messages: room.recent(count).map(summarize),
    });
  }

  // One message from one client.
  //
  // Every failure leaves by throwing a ChatError, and the boundary above turns
  // it into exactly one thing: an error message to this client. The happy path
  // is the only path here. And assertNever at the bottom is the guarantee that
  // every ClientMessage variant is handled - add a thirteenth and this stops
  // compiling.
  private async handleMessage(client: ChatClient, message: ClientMessage): Promise<void> {
    const { registry, bus } = this;

    switch (message.type) {
      case "help":
        client.send({ type: "commands", commands: COMMANDS });
        return;

      case "who": {
        // In a room? Then "who" means who is in here with you - resolved through
        // the registry, because the room only knows ids. Not in a room? Then it
        // means everybody on the server.
        const room = client.room !== undefined ? registry.rooms.get(client.room) : undefined;
        const people = room !== undefined
          ? registry.membersOf(room)
          : [...registry.clients.values()];
        client.send({ type: "userList", users: people.map(describeClient) });
        return;
      }

      case "rooms":
        client.send({ type: "roomList", rooms: [...registry.rooms.values()].map(describeRoom) });
        return;

      case "history": {
        // The one place in the whole server that waits.
        //
        // Join replay comes from the RingBuffer - fast, in memory, no I/O. But
        // an explicit history request may ask for more than memory holds, so it
        // reads the archive. That is the entire justification for this chapter
        // existing: the deep query is on a disk, and a disk takes time.
        //
        // If this throws - a bad disk, a permissions error, a timeout - the
        // `await` rethrows it into handleLine's catch, which is the same catch
        // that has been handling synchronous failures since Chapter 10. Nothing
        // about the error path had to be rebuilt for async.
        const room = registry.requireRoom(client);
        const limit = message.limit ?? room.messageCount;
        const messages = await this.history.recent(room.name, limit);
        client.send({ type: "history", room: room.name, messages });
        return;
      }

      case "nick": {
        // `message.name` is already known to be a well-formed nickname - 1-20
        // characters, letters, digits, _ or - - because the schema said so before
        // this function was ever called. Chapter 10 checked that here, with
        // validateNickname; the check has not disappeared, it has moved to the
        // field it constrains, which is the only place it can never be forgotten.
        //
        // What is left is the one question a schema cannot answer: is there a
        // person by that name? A ValidationError means the name is not a name.
        // This is a NotFoundError, and it means the name is fine and nobody has it.
        const user = registry.knownUsers.get(message.name);
        if (user === undefined) {
          throw new NotFoundError(
            `Unknown user "${message.name}". Try: ${[...registry.knownUsers.keys()].join(", ")}`,
            ErrorCode.UnknownUser,
          );
        }
        // Who they were a moment ago - before identifyAs overwrites it. A rename
        // is only interesting if the name actually changed *and* somebody was
        // there to see it.
        const before = client.label;

        client.identifyAs(user);

        const role = isAdmin(user) ? ` You are an admin (level ${user.adminLevel}).` : "";
        client.send({ type: "system", text: `You are now ${user.name}.${role}` });

        // The room membership does not have to be touched. It is keyed by id, and
        // the id did not change - which is the entire point of Chapter 16, visible
        // in the code that is *not* here.
        if (client.room !== undefined && before !== user.name) {
          bus.emit("rename", client, before, user.name);
        }
        return;
      }

      case "join": {
        // Rooms come into existence by being walked into. `getOrCreateRoom`
        // rather than `requireRoomNamed` - the HTTP side still uses the latter,
        // because asking *about* a room should never conjure one.
        const room = registry.getOrCreateRoom(message.room);

        const previous = client.room;
        if (previous !== undefined) {
          registry.rooms.get(previous)?.leave(client.id);
          client.exitRoom();
          bus.emit("leave", client, previous);
          this.reap(previous);
        }

        // enterRoom throws if this client has not said who it is. That rule is in
        // the state machine, not here: `chatting` carries a user, so a client in a
        // room without a name is not a case we forgot to check - it is a value
        // that cannot be constructed.
        client.enterRoom(room.name);
        room.join(client.id);

        client.send({ type: "joined", user: client.label, room: room.name, members: room.memberCount });
        this.replay(client, room, HISTORY_ON_JOIN);
        bus.emit("join", client, room.name);
        return;
      }

      case "leave": {
        const room = registry.requireRoom(client);
        room.leave(client.id);
        client.exitRoom();
        client.send({ type: "left", user: client.label, room: room.name });
        bus.emit("leave", client, room.name);
        this.reap(room.name);
        return;
      }

      case "chat": {
        const room = registry.requireRoom(client);
        // Announce it. The log, the room's history, and the broadcast are all
        // listeners in bus.ts - this method does not know they exist.
        bus.emit("message", new ChatMessage(client.label, message.text, room.name));
        return;
      }

      case "whisper": {
        const target = registry.requireClient(message.to);
        bus.emit("whisper", client, target, message.text);
        return;
      }

      case "kick": {
        const user = client.user;
        // Two things must be true, and the type guard proves the second: you
        // must have said who you are, and who you are must be an admin.
        if (user === undefined || !isAdmin(user)) {
          throw new PermissionError("Only admins may kick. Identify yourself first.");
        }
        const target = registry.requireClient(message.target);
        if (target === client) {
          throw new PermissionError("You cannot kick yourself.");
        }
        bus.emit("kick", client, target, message.reason);
        return;
      }

      case "status":
        client.send({
          type: "system",
          text:
            `${client.id} [${client.transport}]: ${describeState(client.status)}. ` +
            `Connected for ${formatDuration(client.uptime)}. ` +
            `Server time ${new Date().toISOString()}.`,
        });
        return;

      case "quit":
        client.end({ type: "system", text: "Goodbye!" });
        return;

      default:
        return assertNever(message);
    }
  }
}
