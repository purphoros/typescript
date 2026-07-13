// The domain, and nothing else.
//
// This module is the bottom of the graph: it imports types from protocol.ts and
// declares no behaviour at all. That is deliberate. Everything in the server
// ends up depending on `ChatClient`, so if this file ever needed to import
// `state.ts` or `bus.ts` to say what a client *is*, the whole graph would knot.
//
// A good rule, and the one this restructure follows: the further down the import
// graph a module sits, the less it may know. types.ts knows the least of all.

import type { ConnectionState, RoomName, ServerMessage, Timestamp, Transport, UserId } from "./protocol.js";

export type Host = string;
export type Port = number;

// A client id, and it is *not* a string.
//
// This is the second half of Chapter 16's bug fix, and the more important half.
// Changing rooms to store ids rather than labels fixed the leak - and it fixed
// nothing structurally, because `room.join(client.label)` still compiled
// perfectly. Both are `string`. TypeScript is structural: it compares shapes, and
// a nickname and an id have the same shape. The type system watched me write the
// bug and said nothing, twice.
//
// A *brand* gives a type a name the compiler will insist on. `ClientId` is a
// string with an impossible extra property - impossible because `unique symbol`
// keys cannot be forged - so no plain string is assignable to it, and every
// `room.join(someLabel)` in the codebase becomes a compile error. Which is
// exactly what should have happened the first time.
//
// It costs one assertion, in `clientId()` below, at the single point where an id
// is minted. That is the Chapter 13 bargain again: one line you can audit,
// buying a rule the compiler enforces everywhere else.
declare const ClientIdBrand: unique symbol;
export type ClientId = string & { readonly [ClientIdBrand]: true };

// The only way to make one. Called once, in clients.ts, at accept().
export function clientId(raw: string): ClientId {
  return raw as ClientId;
}

// What the peer on a raw socket turned out to be. "unknown" until the first
// complete line arrives and we can look at it.
export type PeerKind = "unknown" | "chat" | "http";

export interface Identifiable {
  readonly id: string;
}

export interface Serializable {
  serialize(): string;
}

export interface User extends Identifiable {
  name: string;
  joinedAt: Timestamp;
}

// An admin IS-A user with more besides. Structural typing means an AdminUser can
// be passed anywhere a User is expected, with no `implements` needed.
export interface AdminUser extends User {
  adminLevel: number;
  permissions: string[];
}

export interface Message extends Identifiable {
  sender: UserId;
  text: string;
  room: RoomName;
  replyTo?: string;   // optional: string | undefined
  editedAt?: Timestamp;
}

// Where a client is in the conversation.
//
// This is *not* ConnectionState. That one is about the socket - connecting,
// connected, closing, closed - and it is the transport's business. This is about
// the chat: who you are, and where you are standing. A socket can be perfectly
// healthy while its owner has said nothing and gone nowhere.
//
// Three states, and the union is the point. Chapter 15's client held two
// independent optionals:
//
//     protected identity?: User;
//     protected currentRoom?: RoomName;
//
// Two optionals are four combinations, and only three of them mean anything. The
// fourth - in a room, but nobody - was reachable, and it was the bug: rooms
// stored membership under `client.label`, which is the *nickname*, which changes.
// Join as `c1`, then take the name `alice`, then leave: the room removes "alice"
// and keeps "c1" forever. A room with one member and nobody in it.
//
// A union cannot hold that. You are in a room only in the `chatting` state, and
// `chatting` carries the user with it - there is no way to be one without the
// other, because there is no such value.
export type ClientState =
  | { readonly status: "anonymous" }
  | { readonly status: "identified"; readonly user: User }
  | { readonly status: "chatting"; readonly user: User; readonly room: RoomName };

// Anyone the server can talk to, however they got here.
//
// This interface is the seam the whole program is built on. `handler.ts` accepts
// a ChatClient and has no idea whether it is a telnet session or a browser tab;
// it never imports `clients.ts` at all. That is what makes the handler testable
// without a socket - Chapter 19 will hand it a fake, and the handler will not be
// able to tell.
export interface ChatClient extends Identifiable {
  // Narrower than Identifiable's `string`. A ChatRoom will accept one of these
  // and nothing else.
  readonly id: ClientId;
  readonly transport: Transport;
  readonly connectedAt: Timestamp;
  readonly label: string;
  readonly uptime: number;
  readonly status: ConnectionState;
  // Where this client is in the conversation. `user` and `room` are *derived*
  // from it - they are not two more things that can drift.
  readonly state: ClientState;
  readonly user: User | undefined;
  readonly room: RoomName | undefined;
  // Bytes written to this client that the far end has not taken yet. A number
  // the runtime has always known and nobody ever asked for. See Chapter 15.
  readonly backlog: number;
  readonly dropReason: string | undefined;
  send(message: ServerMessage): void;
  end(message: ServerMessage): void;
  identifyAs(user: User): void;
  enterRoom(name: RoomName): void;
  exitRoom(): void;
}

// A custom type guard. AdminUser is the only variant carrying `adminLevel`, so
// the `in` check is enough to narrow - no discriminant field required.
export function isAdmin(user: User): user is AdminUser {
  return "adminLevel" in user;
}
