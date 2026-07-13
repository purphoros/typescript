// The wire protocol.
//
// Chapters 5-8 spoke a stringly-typed language. A client typed "/join general",
// the server split on whitespace and hoped for the best. Nothing in the type
// system knew what a client was allowed to say, or what it might hear back -
// and neither did the browser page, which simply dumped whatever arrived into a
// <div> and called it a user interface.
//
// This module is the contract. `ClientMessage` is everything a client may send;
// `ServerMessage` is everything the server may send back. Both are discriminated
// unions: every variant carries a literal `type` field, and that one field is
// enough for the compiler to hand each switch branch exactly the fields that
// variant has - and to refuse the ones it does not.
//
// The payoff is exhaustiveness. Add a variant and every switch that forgot it
// stops compiling. `assertNever` is what turns "I forgot one" into a build error
// instead of an `undefined` at three in the morning.

import {
  err,
  ok,
  ProtocolError,
  ValidationError,
  type ChatError,
  type ErrorCode,
  type Result,
} from "./errors.js";

// --- Shared vocabulary ---------------------------------------------------

export type UserId = string;
export type RoomName = string;
export type Timestamp = number;

// How a client is attached. The chat logic does not care; it is reported to
// other clients purely so a browser can show who is on telnet.
export type Transport = "tcp" | "ws";

// --- Enums ---------------------------------------------------------------

// A string enum: each member has an explicit string value, so a state that
// escapes onto the wire or into a log reads as "connected", not as 1.
//
// These are the four states a connection *on this server* actually passes
// through. Note what is missing: "reconnecting". A server never reconnects - it
// is sat still, being connected *to*. Reconnection is something the far end
// does, and you can watch the browser page in page.ts do exactly that. Putting
// a state in this enum that no server-side connection can ever be in would mean
// every exhaustive switch below has to handle a case that cannot happen.
export enum ConnectionState {
  // Accepted, but we do not yet know what kind of peer this is. Raw TCP only:
  // the sniffing from Chapter 6 happens in this state.
  Connecting = "connecting",
  Connected = "connected",
  // end() has been called; the socket is draining what we wrote before it goes.
  Closing = "closing",
  Disconnected = "disconnected",
}

// `ErrorCode` used to live here. Chapter 10 moved it into errors.ts, where the
// error classes that carry it live: protocol.ts imports errors.ts, and if
// errors.ts imported back the two modules would take turns being half-loaded.
// Dependencies point one way, and Chapter 11 made that the organising principle
// of the whole tree: errors ← protocol ← types ← model ← state ← handler.

// > A `const enum` is inlined at compile time: `Direction.Up` becomes the string
// > "UP" and no object is emitted at all. It is tempting, and it is a trap in a
// > project like this one. Inlining needs the compiler to see across files, so
// > `const enum` is an error under `isolatedModules`, and every tool that
// > transpiles file-by-file - esbuild, swc, and therefore `tsx`, which runs this
// > server - either rejects it or silently treats it as a regular enum. Reach
// > for a plain string enum, or a literal union, and let the bundler do its job.

// --- Client → Server -----------------------------------------------------

// Everything a client is allowed to say. Anything else is a protocol error.
export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "whisper"; to: UserId; text: string }
  | { type: "join"; room: RoomName }
  | { type: "leave" }
  | { type: "nick"; name: string }
  | { type: "who" }
  | { type: "rooms" }
  | { type: "history"; limit?: number }
  | { type: "kick"; target: UserId; reason: string }
  | { type: "status" }
  | { type: "help" }
  | { type: "quit" };

// The name of a variant: "chat" | "whisper" | "join" | ... Indexing a union by a
// key it shares gives the union of that key's types, which here is the set of
// every legal discriminant. Nothing has to list them a second time.
export type ClientMessageType = ClientMessage["type"];

// --- Server → Client -----------------------------------------------------

export interface UserSummary {
  readonly id: string;
  readonly label: UserId;
  readonly transport: Transport;
  readonly room: RoomName | null;
  readonly admin: boolean;
}

export interface RoomSummary {
  readonly name: RoomName;
  readonly members: number;
  readonly messages: number;
}

// A message as it appears on the wire. The ChatMessage class in model.ts has an
// id, a replyTo and a serialize() method; none of that is anyone else's
// business, so the wire shape is its own type rather than the class.
export interface MessageSummary {
  readonly sender: UserId;
  readonly text: string;
  readonly room: RoomName;
  readonly at: Timestamp;
}

export interface CommandInfo {
  readonly type: ClientMessageType;
  readonly example: string;
  readonly description: string;
}

// Everything the server is allowed to say. A client that handles all of these
// handles the whole protocol - there is no thirteenth thing it might be sent.
export type ServerMessage =
  | { type: "welcome"; id: string; transport: Transport; text: string }
  | { type: "system"; text: string }
  | { type: "chat"; sender: UserId; text: string; room: RoomName; at: Timestamp }
  | { type: "whisper"; from: UserId; to: UserId; text: string; at: Timestamp }
  | { type: "joined"; user: UserId; room: RoomName; members: number }
  | { type: "left"; user: UserId; room: RoomName }
  | { type: "userList"; users: readonly UserSummary[] }
  | { type: "roomList"; rooms: readonly RoomSummary[] }
  | { type: "history"; room: RoomName; messages: readonly MessageSummary[] }
  | { type: "commands"; commands: readonly CommandInfo[] }
  | { type: "kicked"; by: UserId; reason: string }
  | { type: "error"; code: ErrorCode; message: string };

export type ServerMessageType = ServerMessage["type"];

// --- Exhaustiveness ------------------------------------------------------

// Once every variant of a union has been handled, what is left is `never` - the
// type with no values. So a call that still typechecks here is proof that the
// switch above it is complete, and a call that does not is the compiler naming
// the variant you forgot.
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}

// Exhaustive over the enum, not a union of object types - the same technique
// works on both. Delete a case and this stops compiling.
export function describeState(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connecting:
      return "handshake in progress";
    case ConnectionState.Connected:
      return "ready to send and receive";
    case ConnectionState.Closing:
      return "closing, flushing what is left";
    case ConnectionState.Disconnected:
      return "socket closed";
    default:
      return assertNever(state);
  }
}

// --- The catalog ---------------------------------------------------------

// `Record<ClientMessageType, CommandInfo>` demands a key for *every* variant.
// Add one to ClientMessage without documenting it here and the object literal
// stops compiling - the help text cannot fall out of date with the protocol,
// because the compiler will not let it.
export const CATALOG: Record<ClientMessageType, CommandInfo> = {
  chat: {
    type: "chat",
    example: '{"type":"chat","text":"hello everyone"}',
    description: "Say something to your room",
  },
  whisper: {
    type: "whisper",
    example: '{"type":"whisper","to":"bob","text":"just between us"}',
    description: "Send a private message to one user",
  },
  join: {
    type: "join",
    example: '{"type":"join","room":"general"}',
    description: "Join a room, leaving whichever room you are in",
  },
  leave: {
    type: "leave",
    example: '{"type":"leave"}',
    description: "Leave your current room",
  },
  nick: {
    type: "nick",
    example: '{"type":"nick","name":"alice"}',
    description: "Claim an identity",
  },
  who: {
    type: "who",
    example: '{"type":"who"}',
    description: "List everyone connected",
  },
  rooms: {
    type: "rooms",
    example: '{"type":"rooms"}',
    description: "List the rooms and how busy they are",
  },
  history: {
    type: "history",
    example: '{"type":"history","limit":10}',
    description: "Replay recent messages from your room",
  },
  kick: {
    type: "kick",
    example: '{"type":"kick","target":"bob","reason":"spam"}',
    description: "Disconnect a user (admins only)",
  },
  status: {
    type: "status",
    example: '{"type":"status"}',
    description: "Report your connection state and how long you have been here",
  },
  help: {
    type: "help",
    example: '{"type":"help"}',
    description: "List every message the server understands",
  },
  quit: {
    type: "quit",
    example: '{"type":"quit"}',
    description: "Disconnect",
  },
};

export const COMMANDS: readonly CommandInfo[] = Object.values(CATALOG);

// --- Decoding ------------------------------------------------------------

// Decoding fails constantly and on purpose - anyone can type anything into `nc`
// - so it is the textbook case for a Result. The failure is in the return type,
// which means no caller can reach the message without first admitting there
// might not be one.
//
// Chapter 9 returned a hand-rolled `{ kind: "ok" } | { kind: "invalid" }` union
// here. It was the same idea wearing a worse name; `Result<T, E>` is that union,
// generic, and it composes with everything else that can fail.
export type DecodedMessage = Result<ClientMessage, ProtocolError>;

// Raw JSON: keys we have not checked, values we know nothing about. `unknown`
// rather than `any`, so nothing can be used before it has been proven.
type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// `Extract<ClientMessage, { type: K }>` picks the one variant whose discriminant
// is K, so a decoder for "join" can only return a join message - it could not
// accidentally build a chat one. Returning null means "the type was right, the
// fields were not".
type Decoder<K extends ClientMessageType> = (fields: Fields) => Extract<ClientMessage, { type: K }> | null;

// One decoder per variant, and the mapped type insists on all of them.
type DecoderMap = { [K in ClientMessageType]: Decoder<K> };

// Each decoder *rebuilds* the message from fields it has checked rather than
// waving the parsed JSON through with `as ClientMessage`. A cast there would be
// a lie: JSON.parse returns whatever was on the socket, and asserting it has the
// right shape does not make it so. This is the difference between a type that is
// true and a type that is merely claimed.
const DECODERS: DecoderMap = {
  chat: (f) => (isString(f.text) ? { type: "chat", text: f.text } : null),
  whisper: (f) =>
    isString(f.to) && isString(f.text) ? { type: "whisper", to: f.to, text: f.text } : null,
  join: (f) => (isString(f.room) ? { type: "join", room: f.room } : null),
  leave: () => ({ type: "leave" }),
  nick: (f) => (isString(f.name) ? { type: "nick", name: f.name } : null),
  who: () => ({ type: "who" }),
  rooms: () => ({ type: "rooms" }),
  history: (f) => {
    if (f.limit === undefined) {
      return { type: "history" };
    }
    // A limit that is a string, or NaN, or -3, is not a limit.
    if (typeof f.limit !== "number" || !Number.isInteger(f.limit) || f.limit <= 0) {
      return null;
    }
    return { type: "history", limit: f.limit };
  },
  kick: (f) =>
    isString(f.target) && isString(f.reason) ? { type: "kick", target: f.target, reason: f.reason } : null,
  status: () => ({ type: "status" }),
  help: () => ({ type: "help" }),
  quit: () => ({ type: "quit" }),
};

const KNOWN_TYPES = Object.keys(DECODERS).join(", ");

function invalid(reason: string): DecodedMessage {
  return err(new ProtocolError(reason));
}

// One line off a socket becomes a ClientMessage, or an explanation of why it
// could not. Everything downstream of here works with a value the compiler
// trusts, because this is the one place that earned that trust.
//
// Note that this function does not throw, and is not `try`-ed by its caller
// except around JSON.parse - the one thing here that throws is someone else's
// code. Failure is a value all the way out.
export function decodeClientMessage(raw: string): DecodedMessage {
  let value: unknown;
  try {
    // The only throwing call in the module, and it is not ours. Catching it
    // right here is what lets everything below return a Result instead.
    value = JSON.parse(raw);
  } catch {
    return invalid(`expected JSON, e.g. ${CATALOG.chat.example}`);
  }

  if (!isRecord(value)) {
    return invalid("expected a JSON object");
  }

  const type = value.type;
  if (!isString(type)) {
    return invalid('every message needs a "type" field');
  }

  // hasOwn, not `in`: "toString" is *in* every object, and dispatching on it
  // would hand us Object.prototype.toString to call as a decoder.
  if (!Object.hasOwn(DECODERS, type)) {
    return invalid(`unknown message type "${type}". Known types: ${KNOWN_TYPES}`);
  }

  // Widen on the way out. Each decoder in the map returns its *own* variant -
  // that is the point of the map - but once the key is only known to be some
  // ClientMessageType, the thing it returns is only known to be some
  // ClientMessage. Annotating the plain function type says exactly that, and is
  // the last of the narrowing: everything past here is typed.
  const decode: (fields: Fields) => ClientMessage | null = DECODERS[type as ClientMessageType];
  const message = decode(value);
  if (message === null) {
    return invalid(`malformed "${type}" message. Expected ${CATALOG[type as ClientMessageType].example}`);
  }

  return ok(message);
}

// --- Validation ----------------------------------------------------------

// A nickname is well-formed JSON and still not acceptable. That is the
// difference between a ProtocolError and a ValidationError, and it is worth
// keeping straight: one means "I could not read you", the other "I read you, and
// no".
const NICKNAME = /^[a-z0-9_-]{1,20}$/i;

export function validateNickname(raw: string): Result<string, ChatError> {
  if (!NICKNAME.test(raw)) {
    return err(
      new ValidationError(
        `"${raw}" is not a usable name: 1-20 characters, letters, digits, _ or - only.`,
      ),
    );
  }
  return ok(raw);
}

// The port comes off the command line, which is to say from a human, which is to
// say it is wrong sometimes. Chapter 9 quietly swapped in the default and said
// nothing - a bad argument that behaves exactly like no argument is how you lose
// an afternoon. Now the caller is handed the failure and decides out loud.
export function parsePort(input: string): Result<number, ChatError> {
  const port = Number.parseInt(input, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    return err(new ValidationError(`"${input}" is not a port: expected 1-65535.`));
  }
  return ok(port);
}

// --- Encoding ------------------------------------------------------------

// The only way a ServerMessage reaches a socket. It takes a ServerMessage and
// nothing else, so the server cannot send a shape the client has never heard of.
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
