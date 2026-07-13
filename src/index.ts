// The barrel: the public API of this package, in one place.
//
// A barrel re-exports what consumers are meant to use, so they write
//
//   import { ChatServer, ChatError } from "chat-server";
//
// instead of reaching into `chat-server/dist/server.js` and taking whatever they
// find. It is the difference between a package with a front door and a package
// with a hole in the wall: everything not listed here is internal, and can be
// renamed on a Tuesday without breaking anybody.
//
// A barrel must have no side effects. Importing this file must not open a port,
// read a file, or print anything - a consumer who only wants the `ClientMessage`
// type has not asked for a running server, and would be entitled to be surprised
// by one. That is why the entry point is `main.ts` and this is not: those are two
// different jobs, and one file cannot do both honestly. `npm start` runs
// main.js; `import "chat-server"` gets you this, and nothing happens.
//
// Note `export type` on the type-only lines. It tells the compiler these vanish
// at runtime rather than becoming a `require` of a module that exports no such
// value - which matters the moment anyone turns on `isolatedModules`.

export { ChatServer } from "./server.js";
export { Registry } from "./state.js";
export { MessageHandler } from "./handler.js";
export { HttpService } from "./http.js";
export { ChatRoom, ChatMessage } from "./model.js";
export { FileHistory } from "./history.js";
export { Serializer, withTimeout, delay } from "./async.js";
export { BaseClient, TcpClient, WsClient } from "./clients.js";
export { TypedEmitter, RingBuffer, pluck } from "./events.js";
export { createBus, formatEvent, statusLine } from "./bus.js";
export { configure, resolvePort, DEFAULTS } from "./config.js";
export { isAdmin } from "./types.js";
export { chatPage } from "./page.js";
export { Router } from "./router.js";
export { ClientMessageSchema, PortSchema } from "./schemas.js";

export {
  ChatError,
  ProtocolError,
  ValidationError,
  NotFoundError,
  PermissionError,
  StateError,
  TimeoutError,
  ErrorCode,
  ok,
  err,
  toSafeError,
  describeThrown,
  asError,
} from "./errors.js";

export {
  ConnectionState,
  CATALOG,
  COMMANDS,
  assertNever,
  decodeClientMessage,
  encodeServerMessage,
  describeState,
  parsePort,
} from "./protocol.js";

export type { Result, SafeError } from "./errors.js";
export type { ServerConfig } from "./config.js";
export type { Bus, ChatEvent, ServerEvents } from "./bus.js";
export type { HttpRequest, HttpResponse, HttpOutcome } from "./http.js";
export type { PathParams, RouteHandler, HttpMethod } from "./router.js";
export type {
  ChatClient,
  Identifiable,
  Serializable,
  User,
  AdminUser,
  Message,
  PeerKind,
  Host,
  Port,
} from "./types.js";
export type {
  ClientMessage,
  ClientMessageType,
  ServerMessage,
  ServerMessageType,
  DecodedMessage,
  CommandInfo,
  MessageSummary,
  RoomSummary,
  UserSummary,
  RoomName,
  UserId,
  Timestamp,
  Transport,
} from "./protocol.js";
