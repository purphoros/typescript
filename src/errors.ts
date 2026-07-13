// Failure, as a first-class thing.
//
// Chapter 9 left two loose ends and admitted to both. decodeClientMessage
// returned `{ kind: "invalid"; reason: string }` - a discriminated union doing a
// job it was never quite the right shape for. And every failure inside
// handleMessage was a `fail(); return;` pair, repeated a dozen times, which is
// what a codebase looks like just before someone forgets the `return`.
//
// This module supplies both missing pieces, and the point of the chapter is
// knowing which to reach for.
//
//   Result<T, E>  - the failure is *expected*, and the caller is right there.
//                   Parsing a socket line. Validating a nickname. The failure is
//                   in the return type, so it cannot be ignored the way a
//                   try/catch can be forgotten.
//
//   throw         - the failure is expected but has to *travel*. A room lookup
//                   fails eight frames down inside a switch; there is exactly
//                   one thing to do about it, and it is done at the boundary.
//                   Threading a Result up through that would be pure ceremony.
//
// And a third case, the one that actually crashes servers: something nobody
// predicted. That is not modelled at all - it is caught, logged in full, and
// answered with a shrug that gives the client nothing to work with.

// --- Result --------------------------------------------------------------

// Either a value or an error, never both, and never neither. The caller has to
// look at `ok` before it can reach either field - that is the whole design.
export type Result<T, E = ChatError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// `Result<T, never>` is assignable to any `Result<T, E>`: the error arm cannot
// be constructed, which is exactly what "this one succeeded" means.
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// --- Error codes ---------------------------------------------------------

// Why something was refused. The code is for the program - a browser can switch
// on it - and the message that travels with it is for the human.
//
// This lives here rather than in protocol.ts because the errors are what carry
// it: protocol.ts imports this module, not the other way round. A cycle between
// the two would have each one half-initialised while the other was loading.
export enum ErrorCode {
  InvalidMessage = "invalid_message",
  Validation = "validation",
  UnknownRoom = "unknown_room",
  UnknownUser = "unknown_user",
  NotInRoom = "not_in_room",
  NotIdentified = "not_identified",
  NoSuchTarget = "no_such_target",
  NotPermitted = "not_permitted",
  Unauthenticated = "unauthenticated",
  BadCredentials = "bad_credentials",
  BadToken = "bad_token",
  TokenExpired = "token_expired",
  RateLimited = "rate_limited",
  Timeout = "timeout",
  Internal = "internal",
}

// --- Error classes -------------------------------------------------------

// Every error this server raises on purpose. Two things distinguish it from a
// bare Error: a machine-readable `code`, and an HTTP `status` - because the same
// failure has to be reportable down two very different wires. An unknown room is
// a `ServerMessage` with code "unknown_room" to a chat client and a 404 to curl,
// and it should not take two error types to say so.
export class ChatError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly status: number = 400,
  ) {
    super(message);
    // `new.target` is the constructor that was actually called with `new`, so a
    // NotFoundError gets name "NotFoundError" without every subclass repeating
    // itself.
    this.name = new.target.name;
  }
}

// The message did not survive decoding: not JSON, not an object, no `type`, an
// unknown `type`, or the right type with the wrong fields.
export class ProtocolError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.InvalidMessage, 400);
  }
}

// The message decoded, and then said something we will not accept - a nickname
// with a space in it, a limit of -3. Well-formed, still wrong.
export class ValidationError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.Validation, 422);
  }
}

// You asked for something that is not here: a room, a user, a person to whisper
// to. The code says which, because "not found" alone is not an answer.
export class NotFoundError extends ChatError {
  constructor(message: string, code: ErrorCode) {
    super(message, code, 404);
  }
}

// You are allowed to ask, and you are not allowed to have it.
export class PermissionError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.NotPermitted, 403);
  }
}

// Nothing is wrong with the request; it simply makes no sense right now. You
// cannot leave a room you are not in.
export class StateError extends ChatError {
  constructor(message: string, code: ErrorCode = ErrorCode.NotInRoom) {
    super(message, code, 409);
  }
}

// You are not who you say you are, or you have not said. 401, not 403: the
// difference is "I do not know who you are" versus "I know exactly who you are
// and the answer is still no", and conflating them is why so many APIs return
// 403 to a logged-out user and confuse everybody.
export class AuthError extends ChatError {
  constructor(message: string, code: ErrorCode = ErrorCode.Unauthenticated) {
    super(message, code, 401);
  }
}

// Too much, too fast.
export class RateLimitError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.RateLimited, 429);
  }
}

// We waited, and it did not come back. Note what this does *not* mean: the work
// is not cancelled and may still succeed - a Promise cannot be un-started. All
// this says is that we have stopped waiting, which is the only thing we ever had
// the power to do. See withTimeout in async.ts.
export class TimeoutError extends ChatError {
  constructor(message: string) {
    super(message, ErrorCode.Timeout, 504);
  }
}

// > **On Object.setPrototypeOf.** Most tutorials - and the first draft of this
// > chapter - put `Object.setPrototypeOf(this, ChatError.prototype)` in every
// > constructor, described as "required for instanceof to work". It is required,
// > but only when TypeScript is *downlevelling* classes: compile `class X extends
// > Error` to ES5 and the emitted function cannot set up the prototype chain the
// > way `new Error()` does, so `x instanceof X` comes back false. We target
// > ES2022 and emit real classes, where extending a built-in works exactly as
// > written. The line would be cargo cult. Change `target` in tsconfig.json to
// > "ES5" and you will need it back - which is a good reason to know why it is
// > there, and a bad reason to type it without knowing.

// --- Handling ------------------------------------------------------------

// What a client is allowed to be told.
export interface SafeError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly status: number;
}

// The `catch` clause hands you `unknown`, and it means it: JavaScript can throw
// a string, a number, null, a Symbol, anything at all. Narrow before you touch.
//
// Our own errors are deliberate. We wrote their messages knowing a stranger
// would read them, so they can be repeated verbatim. Anything else that reaches
// here is a bug in this server, and the client learns nothing from it - a stack
// trace or a file path handed to an attacker is a gift, and to everyone else it
// is noise.
export function toSafeError(thrown: unknown): SafeError {
  if (thrown instanceof ChatError) {
    return { code: thrown.code, message: thrown.message, status: thrown.status };
  }
  return { code: ErrorCode.Internal, message: "Internal server error", status: 500 };
}

// The whole truth, for the log, which is the one audience allowed to have it.
//
// `String(thrown)` and not `${thrown}`: interpolating a Symbol throws a
// TypeError, and an error handler that throws while handling an error is a very
// long evening.
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.stack ?? `${thrown.name}: ${thrown.message}`;
  }
  return `Non-Error thrown: ${String(thrown)}`;
}

// Somewhere between the socket and the log, `unknown` has to become an Error -
// the failure bus carries Errors, and `throw "nope"` is legal JavaScript.
export function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
