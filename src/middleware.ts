// Things that happen to a message before the handler sees it.
//
// The switch in handler.ts answers "what does this message mean". It should not
// also have to answer "is this person allowed to say it" and "have they said it
// forty times this second" - those are true of *every* message, and a rule that
// applies to everything belongs somewhere it is written once.
//
// A middleware wraps the next thing in the chain and may decline to call it:
//
//   rateLimit → requireAuth → handleMessage
//
// The first one to refuse stops the chain, and nothing downstream ever runs.

import { AuthError, ErrorCode, RateLimitError } from "./errors.js";
import { CATALOG, type ClientMessage, type ClientMessageType } from "./protocol.js";
import type { Sessions } from "./auth.js";
import type { ChatClient } from "./types.js";

export type Middleware = (
  client: ChatClient,
  message: ClientMessage,
  next: () => Promise<void>,
) => Promise<void>;

// Fold a list of middlewares into one.
//
// The `called` guard is not paranoia. A middleware that awaits `next()` twice
// runs the whole rest of the chain twice - including the handler, including the
// broadcast - and the symptom is every message being delivered in duplicate,
// intermittently, which is a genuinely horrible afternoon. Fail loudly instead.
export function chain(...middlewares: readonly Middleware[]): Middleware {
  return async (client, message, next) => {
    let lastCalled = -1;

    const run = async (index: number): Promise<void> => {
      if (index <= lastCalled) {
        throw new Error("middleware called next() more than once");
      }
      lastCalled = index;

      const middleware = middlewares[index];
      if (middleware === undefined) {
        await next();
        return;
      }
      await middleware(client, message, () => run(index + 1));
    };

    await run(0);
  };
}

// The messages you may send before you have proved who you are. Everything not
// on this list requires a session.
//
// `Set<ClientMessageType>`, not `Set<string>`. Rename a message in schemas.ts and
// this stops compiling - a door that quietly stops being locked because somebody
// renamed the thing behind it is exactly the bug worth making impossible.
const OPEN: ReadonlySet<ClientMessageType> = new Set<ClientMessageType>([
  "login",
  "auth",
  "help",
  "quit",
]);

export function requireAuth(sessions: Sessions): Middleware {
  return async (client, message, next) => {
    if (OPEN.has(message.type)) {
      await next();
      return;
    }

    // Sessions.get() returns undefined for an expired one, so there is no window
    // in which a stale session is still honoured.
    if (sessions.get(client.id) === undefined) {
      throw new AuthError(
        `Log in first, e.g. ${CATALOG.login.example}`,
        ErrorCode.Unauthenticated,
      );
    }

    await next();
  };
}

// A token bucket, per client.
//
// Chapter 15 bounded what a client could make the server *hold*. This bounds what
// a client can make the server *do*: a bucket of N tokens that refills at R per
// second, one token per message. Bursts are fine - you can paste a paragraph -
// and a sustained flood is not.
//
// The bucket lives on the client's own record and dies with the connection, so
// there is no map to sweep and nothing to leak.
export function rateLimit(capacity: number, perSecond: number): Middleware {
  const buckets = new WeakMap<ChatClient, { tokens: number; last: number }>();

  return async (client, _message, next) => {
    const now = Date.now();
    const bucket = buckets.get(client) ?? { tokens: capacity, last: now };

    // Refill by however long we waited, then spend one.
    const elapsed = (now - bucket.last) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * perSecond);
    bucket.last = now;

    if (bucket.tokens < 1) {
      buckets.set(client, bucket);
      throw new RateLimitError(`Slow down - ${perSecond} messages per second.`);
    }

    bucket.tokens -= 1;
    buckets.set(client, bucket);

    await next();
  };
}
