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

// Anyone the server can talk to, however they got here.
//
// This interface is the seam the whole program is built on. `handler.ts` accepts
// a ChatClient and has no idea whether it is a telnet session or a browser tab;
// it never imports `clients.ts` at all. That is what makes the handler testable
// without a socket - Chapter 19 will hand it a fake, and the handler will not be
// able to tell.
export interface ChatClient extends Identifiable {
  readonly transport: Transport;
  readonly connectedAt: Timestamp;
  readonly label: string;
  readonly uptime: number;
  readonly status: ConnectionState;
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
