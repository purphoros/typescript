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

import { z } from "zod";
import { ClientMessageSchema, PortSchema } from "./schemas.js";
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

// Everything a client is allowed to say - and this type is no longer written
// down anywhere. It is *read out of the schema*.
//
// z.infer is the whole chapter in one line. schemas.ts describes the messages
// once; the runtime check and the compile-time type are both derived from that
// one description, so they cannot disagree. Add a field to a variant in
// schemas.ts and it appears here, in every switch, in the browser page's mental
// model, and in the validator, simultaneously - because they are all the same
// statement.
//
// What this replaces: a 12-arm union declared by hand, plus a 60-line DECODERS
// map that checked it field by field, plus the standing obligation to keep those
// two in step forever.
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// The name of a variant: "chat" | "whisper" | "join" | ... Indexing a union by a
// key it shares gives the union of that key's types. Still true, still derived,
// and now derived from something that is itself derived.
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
export type DecodedMessage = Result<ClientMessage, ChatError>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Zod tells us *what* went wrong. Chapter 10 drew a line that is worth keeping,
// so this decides which of the two things it was.
//
//   ProtocolError    "I could not read you."  The shape is wrong: a missing
//                    field, a number where a string goes, a `type` nobody has
//                    heard of, a key that should not be there.
//
//   ValidationError  "I read you, and no."  The shape is right and the content
//                    is not: a nickname with a space in it, a 4,000-character
//                    message, a history limit of -3.
//
// The distinction is not pedantry. One means the client's *code* is broken and a
// developer needs to look at it; the other means the client's *user* typed
// something we will not accept, and they can simply try again. They deserve
// different codes because they have different audiences - which is exactly the
// argument ErrorCode was invented for.
const STRUCTURAL: ReadonlySet<string> = new Set([
  "invalid_type",            // wrong primitive, or a field that is not there
  "invalid_union",           // no variant matched - usually an unknown `type`
  "invalid_value",           // a literal that is not the literal
  "invalid_key",
  "unrecognized_keys",       // a field we have never heard of, e.g. "txet"
]);

// One Zod issue, as a sentence. `path` is how Zod says *where*: ["text"] means
// the text field, [] means the message as a whole.
function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

function toChatError(error: z.ZodError, value: unknown): ChatError {
  const detail = error.issues.map(describeIssue).join("; ");

  // If the client told us which message it *meant*, show it the shape it should
  // have sent. CATALOG is keyed by every variant, so this cannot go stale.
  const type = isRecord(value) && typeof value.type === "string" ? value.type : undefined;
  const hint =
    type !== undefined && Object.hasOwn(CATALOG, type)
      ? ` Expected ${CATALOG[type as ClientMessageType].example}`
      : "";

  const structural = error.issues.some((issue) => STRUCTURAL.has(issue.code));
  const message = `${detail}.${hint}`;

  return structural ? new ProtocolError(message) : new ValidationError(message);
}

// One line off a socket becomes a ClientMessage, or an explanation of why it
// could not. Everything downstream of here works with a value the compiler
// trusts, because this is the one place that earned that trust.
//
// Note what safeParse returns: not the object that arrived, but a *new* one built
// from the fields it verified. That was the whole argument against `as
// ClientMessage` in Chapter 9, and it is why a schema is a validator rather than
// a very detailed assertion.
export function decodeClientMessage(raw: string): DecodedMessage {
  let value: unknown;
  try {
    // Still the only throwing call in the module, and still not ours.
    value = JSON.parse(raw);
  } catch {
    return err(new ProtocolError(`expected JSON, e.g. ${CATALOG.chat.example}`));
  }

  const parsed = ClientMessageSchema.safeParse(value);
  if (!parsed.success) {
    return err(toChatError(parsed.error, value));
  }
  return ok(parsed.data);
}

// --- Validation ----------------------------------------------------------

// `validateNickname` used to live here: a regex, applied by the handler, three
// modules away from the type that described the field it constrained. It is gone.
// The rule is on the field now, in schemas.ts, where a nickname is defined - so
// nothing can accept a nickname without also enforcing what one is.

// The port comes off the command line, which is to say from a human, which is to
// say it is wrong sometimes. The caller is handed the failure and decides out loud.
export function parsePort(input: string): Result<number, ChatError> {
  const parsed = PortSchema.safeParse(input);
  if (!parsed.success) {
    return err(new ValidationError(`"${input}" is not a port: expected 1-65535.`));
  }
  return ok(parsed.data);
}

// --- Encoding ------------------------------------------------------------

// The only way a ServerMessage reaches a socket. It takes a ServerMessage and
// nothing else, so the server cannot send a shape the client has never heard of.
export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
