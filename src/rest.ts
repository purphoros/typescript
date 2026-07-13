// The HTTP API, and the hole that was in it.
//
// The endpoints grew one at a time, whenever a chapter needed to show something.
// /api/status in Chapter 6, /api/rooms in Chapter 9, /api/crash in Chapter 10,
// /api/health in Chapter 15. They are not an API; they are a pile of endpoints.
//
// And every single one of them was public. Chapter 17 shut the door on the chat
// protocol - sessions, tokens, a requireAuth middleware, the lot - and left this
// wide open:
//
//     curl http://localhost:8080/api/history      # 200. Every message. Every room.
//
// That is not an oversight in Chapter 17, it is the *shape* of Chapter 17: auth
// was built as a middleware over ClientMessage, and HTTP is not a ClientMessage.
// **Authentication that is bolted onto one protocol is not authentication, it is a
// habit.** The policy has to live somewhere both can reach.

import { resume, type Sessions, type Session } from "./auth.js";
import { issue } from "./jwt.js";
import { AuthError, ErrorCode, NotFoundError, PermissionError } from "./errors.js";
import { COMMANDS, type MessageSummary } from "./protocol.js";
import { chatPage } from "./page.js";
import { Router } from "./router.js";
import { ChatMessage } from "./model.js";
import { describeClient, describeRoom } from "./views.js";
import { isAdmin } from "./types.js";
import { html, json, type HttpRequest, type HttpResponse } from "./http.js";
import type { Bus } from "./bus.js";
import type { ServerConfig } from "./config.js";
import type { Accounts } from "./auth.js";
import type { Registry } from "./state.js";
import type { MessageStore } from "./store.js";
import type { Metrics, Runtime } from "./runtime.js";

// How many messages a page of history may contain, whatever the caller asks for.
const MAX_PAGE = 100;
const DEFAULT_PAGE = 20;

export interface RestDeps {
  readonly registry: Registry;
  readonly bus: Bus;
  readonly messages: MessageStore;
  readonly accounts: Accounts;
  readonly sessions: Sessions;
  readonly runtime: Runtime;
  readonly metrics: Metrics;
  readonly config: ServerConfig;
}

// A response with headers of its own. `json()` is fine for the ordinary case and
// useless the moment you need a `Location` or an `ETag`.
function jsonWith(status: number, headers: Record<string, string>, payload: unknown): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload, null, 2),
  };
}

// `?limit=20&before=1783925502000` - a query string, which is also untrusted
// input, and which nobody validated for nineteen chapters because nothing used it.
function query(path: string): URLSearchParams {
  const mark = path.indexOf("?");
  return new URLSearchParams(mark === -1 ? "" : path.slice(mark + 1));
}

function intParam(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, max);
}

export class Rest {
  // Two routers, and the split is the point.
  //
  // `Router<void>` hands its handlers nothing. `Router<Session>` hands its handlers
  // a session - which means an authenticated handler **cannot forget to check for
  // one**, because it could not have been called without one. The check is not a
  // line of code somebody has to remember to write at the top of every function.
  // It is the type of the argument.
  //
  // This is the same move as Chapter 16's state machine: make the bad state
  // unrepresentable, rather than validating against it in twelve places.
  private readonly open: Router<void>;
  private readonly secure: Router<Session>;

  constructor(private readonly deps: RestDeps) {
    this.open = this.publicRoutes();
    this.secure = this.authenticatedRoutes();
  }

  // Everything a stranger may have. Note how short it is - and note that
  // /api/health is on it deliberately: a load balancer cannot log in, and a
  // liveness probe that needs a credential is a liveness probe that will fail at
  // the worst possible moment.
  private publicRoutes(): Router<void> {
    const { registry, runtime, metrics, accounts, config } = this.deps;

    return new Router<void>()
      .on("GET", "/", () => html(200, chatPage(registry.clients.size, registry.rooms.size)))

      .on("GET", "/api/health", () => {
        const snapshot = runtime.snapshot();
        runtime.reset();
        return json(200, {
          ...snapshot,
          clients: registry.clients.size,
          rooms: registry.rooms.size,
          backlogBytes: [...registry.clients.values()].reduce((sum, c) => sum + c.backlog, 0),
          operations: metrics.snapshot(),
        });
      })

      // The protocol describes itself, and it is not a secret. A client has to be
      // able to learn how to talk to us before it can log in.
      .on("GET", "/api/protocol", () => json(200, { clientMessages: COMMANDS }))

      // The one door in. Password in, token out - the same two-step as the chat
      // protocol, and the same function underneath it.
      .on("POST", "/api/login", async (req) => {
        let body: unknown;
        try {
          body = JSON.parse(req.body ?? "");
        } catch {
          return json(400, { error: "Expected a JSON body.", code: ErrorCode.InvalidMessage });
        }

        const { name, password } = (body ?? {}) as { name?: unknown; password?: unknown };
        if (typeof name !== "string" || typeof password !== "string") {
          return json(400, { error: "Expected { name, password }.", code: ErrorCode.InvalidMessage });
        }

        const attempt = await accounts.login(name, password);
        if (!attempt.ok) {
          // 401, and the *same* opaque message as the chat side. An HTTP endpoint
          // that distinguishes "no such user" from "wrong password" is an account
          // enumeration oracle with a REST interface.
          return jsonWith(401, { "WWW-Authenticate": "Bearer" }, {
            error: attempt.error.message,
            code: attempt.error.code,
          });
        }

        const user = attempt.value.user;
        const issued = issue(
          { sub: user.id, name: user.name, admin: isAdmin(user) },
          config.jwtSecret,
          config.tokenTtlSeconds,
        );

        return json(200, { token: issued.token, expiresAt: issued.expiresAt, user: user.name });
      });
  }

  // Everything else. Every handler here is *given* a Session.
  private authenticatedRoutes(): Router<Session> {
    const { registry, messages, bus } = this.deps;

    return new Router<Session>()
      .on("GET", "/api/users/me", (_req, _params, session) =>
        json(200, {
          name: session.user.name,
          admin: isAdmin(session.user),
          expiresAt: session.expiresAt,
        }))

      .on("GET", "/api/rooms", () => json(200, [...registry.rooms.values()].map(describeRoom)))

      .on("GET", "/api/rooms/:room", (_req, params) =>
        json(200, describeRoom(registry.requireRoomNamed(params.room))))

      .on("GET", "/api/rooms/:room/members", (_req, params) => {
        const room = registry.requireRoomNamed(params.room);
        return json(200, registry.membersOf(room).map(describeClient));
      })

      // A page of history. A *cursor*, not an offset - see store.ts.
      //
      // The `next` link is built from the oldest message we are returning, so a
      // client pages backwards through time without ever computing anything. When
      // there is no more history there is no `next`, which is how a client knows
      // to stop without guessing.
      .on("GET", "/api/rooms/:room/messages", async (req, params) => {
        const room = registry.requireRoomNamed(params.room);
        const q = query(req.path);
        const limit = intParam(q, "limit", DEFAULT_PAGE, MAX_PAGE);
        const beforeRaw = q.get("before");
        const before = beforeRaw !== null && Number.isFinite(Number(beforeRaw))
          ? Number(beforeRaw)
          : undefined;

        const page: MessageSummary[] = await messages.page(room.name, limit, before);
        const oldest = page[0];

        return json(200, {
          room: room.name,
          messages: page,
          next: page.length === limit && oldest !== undefined
            ? `/api/rooms/${room.name}/messages?limit=${limit}&before=${oldest.at}`
            : null,
        });
      })

      .on("GET", "/api/rooms/:room/search", async (req, params) => {
        const room = registry.requireRoomNamed(params.room);
        const q = query(req.path);
        const text = q.get("q");
        if (text === null || text.length === 0) {
          return json(400, { error: "Expected ?q=", code: ErrorCode.Validation });
        }
        const hits = await messages.search(room.name, text.slice(0, 200), MAX_PAGE);
        return json(200, { room: room.name, query: text, messages: hits });
      })

      // Post a message over HTTP, and watch it appear in everybody's chat window.
      //
      // This is the nicest thing in the chapter and it took no new code at all. It
      // emits on the same bus the WebSocket handler emits on, so the same three
      // listeners run: the log, the archive, and the broadcast. A curl in a
      // terminal lands in a browser tab, because Chapter 8 decoupled *what
      // happened* from *everyone who cares*, and this is just one more thing that
      // happened.
      .on("POST", "/api/rooms/:room/messages", (req, params, session) => {
        const room = registry.requireRoomNamed(params.room);

        let body: unknown;
        try {
          body = JSON.parse(req.body ?? "");
        } catch {
          return json(400, { error: "Expected a JSON body.", code: ErrorCode.InvalidMessage });
        }
        const { text } = (body ?? {}) as { text?: unknown };
        if (typeof text !== "string" || text.length === 0 || text.length > 1000) {
          return json(422, { error: "Expected { text } of 1-1000 characters.", code: ErrorCode.Validation });
        }

        const message = new ChatMessage(session.user.name, text, room.name);
        bus.emit("message", message);

        // 201 Created, and a Location header pointing at what was made. This is
        // the difference between an API and a pile of POST endpoints: the client
        // is told *where the thing now is*, rather than having to work it out.
        return jsonWith(
          201,
          { Location: `/api/rooms/${room.name}/messages?before=${message.at + 1}&limit=1` },
          { sender: message.sender, text: message.text, room: message.room, at: message.at },
        );
      })

      // Kick, over HTTP. 403 rather than 401: we know exactly who you are, and the
      // answer is still no.
      //
      // Chapter 17 made the point and it is worth making again - the admin flag
      // comes from `session.user`, which came from the *account*, not from the
      // token the client is holding.
      .on("DELETE", "/api/rooms/:room/members/:user", (_req, params, session) => {
        if (!isAdmin(session.user)) {
          throw new PermissionError("Only admins may remove members.");
        }
        const room = registry.requireRoomNamed(params.room);
        const target = registry.membersOf(room).find((c) => c.label === params.user);
        if (target === undefined) {
          throw new NotFoundError(`${params.user} is not in ${room.name}.`, ErrorCode.NoSuchTarget);
        }
        bus.emit("kick", target, target, "removed by an admin over the API");

        // 204: it worked, and there is nothing to say about it. A body here would
        // be an invention.
        return { status: 204, headers: {}, body: "" };
      })

      // Deliberately broken, and still here, because Chapter 10's boundary is
      // still the thing standing between a bug and a dead process. It is behind
      // auth now - a stranger should not be able to make the server throw on
      // demand, even harmlessly.
      .on("GET", "/api/crash", () => {
        throw new Error("the kind of bug you did not see coming");
      });
  }

  // Dispatch, and the auth gate.
  //
  // Public first. If nothing public matched, the route requires a session - and
  // *then* we look for a token. That order matters: it means an unauthenticated
  // request to a path that does not exist gets a 404, not a 401. Telling a
  // stranger "that path exists, you just cannot see it" is a small leak, and it is
  // free not to make it.
  async handle(req: HttpRequest): Promise<HttpResponse> {
    // The path may carry a query string; routes match on the path alone.
    const path = req.path.split("?")[0] ?? req.path;

    const publicRoute = this.open.match(req.method, path);
    if (publicRoute !== undefined) {
      return await publicRoute.handler(req, publicRoute.params, undefined as void);
    }

    const secureRoute = this.secure.match(req.method, path);
    if (secureRoute === undefined) {
      const allowed = [...this.open.methodsFor(path), ...this.secure.methodsFor(path)];
      if (allowed.length > 0) {
        return {
          status: 405,
          headers: { "Content-Type": "application/json", Allow: allowed.join(", ") },
          body: JSON.stringify({ error: `Use ${allowed.join(" or ")}`, path }, null, 2),
        };
      }
      return json(404, { error: "Not Found", path });
    }

    const session = await this.authenticate(req);
    return await secureRoute.handler(req, secureRoute.params, session);
  }

  // `Authorization: Bearer <token>`, and nothing else.
  //
  // Not a cookie. A cookie is sent by the browser *automatically*, on every
  // request, including ones triggered by another website - which is what CSRF is,
  // and which is a whole problem we simply do not have as long as the credential
  // has to be attached deliberately. Chapter 24 comes back to this.
  private async authenticate(req: HttpRequest): Promise<Session> {
    const header = req.headers.get("authorization");
    const token = header?.match(/^Bearer (.+)$/i)?.[1];

    if (token === undefined) {
      throw new AuthError("Send an Authorization: Bearer <token> header.", ErrorCode.Unauthenticated);
    }

    // The same function the chat protocol's `auth` message uses. One policy, two
    // protocols - which is the thing that was missing.
    const session = await resume(this.deps.accounts, token, this.deps.config.jwtSecret);
    if (!session.ok) {
      throw session.error;
    }
    return session.value;
  }
}
