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

import { HISTORY_ON_JOIN, type ServerConfig } from "./config.js";
import { asError, ChatError, NotFoundError, PermissionError, toSafeError, ErrorCode } from "./errors.js";
import { authenticate, resume, type Accounts, type Sessions } from "./auth.js";
import { chain, rateLimit, requireAuth, type Middleware } from "./middleware.js";
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
  private readonly pipeline: Middleware;

  // Everything arrives as a constructor argument rather than an import. That one
  // change is what makes this class a unit: give it a different registry and it
  // manages a different world, which is precisely what a test wants to do.
  constructor(
    private readonly registry: Registry,
    private readonly bus: Bus,
    private readonly history: FileHistory,
    private readonly accounts: Accounts,
    private readonly sessions: Sessions,
    private readonly config: ServerConfig,
  ) {
    // Order matters, and it is an argument about cost.
    //
    // rateLimit first, because it is the cheapest check in the building - one
    // subtraction - and refusing a flood should not require us to first do the
    // expensive thing. Put auth first and a flood of unauthenticated messages
    // makes the server do a map lookup per message before declining; put
    // rateLimit first and it does arithmetic.
    //
    // Then requireAuth. Then, only then, the handler.
    this.pipeline = chain(rateLimit(20, 10), requireAuth(this.sessions));
  }

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
      // The message goes through the chain, and the chain decides whether the
      // handler ever sees it. A middleware that refuses simply throws - and the
      // catch below, which has been here since Chapter 10, turns it into an
      // error message without knowing or caring that middleware exists.
      const message = decoded.value;
      await this.pipeline(client, message, () => this.handleMessage(client, message));
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

      case "login": {
        // The only place in the server that ever sees a password.
        //
        // Note that this does NOT log you in. It hands back a token, and the
        // client presents that token with `auth`. Two steps, deliberately: the
        // password is used once and forgotten, and everything afterwards -
        // including reconnecting tomorrow - happens with a credential that can
        // expire on its own.
        const result = await authenticate(
          this.accounts,
          message.name,
          message.password,
          this.config.jwtSecret,
          this.config.tokenTtlSeconds,
        );
        if (!result.ok) {
          // The log knows it was `alice` who failed. The client is told only
          // "wrong name or password" - see Accounts.login.
          bus.emit("notice", `failed login for "${message.name}" from ${client.id}`);
          throw result.error;
        }
        client.send({ type: "token", token: result.value.token, expiresAt: result.value.expiresAt });
        return;
      }

      case "auth": {
        const session = resume(this.accounts, message.token, this.config.jwtSecret);
        if (!session.ok) {
          throw session.error;
        }

        const before = client.label;
        this.sessions.establish(client.id, session.value);
        client.identifyAs(session.value.user);

        const user = session.value.user;
        client.send({
          type: "authenticated",
          user: user.name,
          admin: isAdmin(user),
          expiresAt: session.value.expiresAt,
        });

        if (client.room !== undefined && before !== user.name) {
          bus.emit("rename", client, before, user.name);
        }
        return;
      }

      case "logout": {
        // Leave the room first - the state machine will not let a client be in
        // one without an identity, and we are about to take the identity away.
        const room = client.room;
        if (room !== undefined) {
          registry.rooms.get(room)?.leave(client.id);
          client.exitRoom();
          bus.emit("leave", client, room);
          this.reap(room);
        }
        this.sessions.revoke(client.id);
        client.forget();
        client.send({ type: "system", text: "Logged out." });
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
