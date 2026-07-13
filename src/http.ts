// HTTP, parsed by hand, on the same port as everything else.
//
// Chapter 6 wrote all of this; splitting it out is what finally shows how little
// of it the chat server ever needed to know. The one thing this module and
// handler.ts genuinely share is the error boundary - and they share it by both
// calling toSafeError, not by importing each other.

import { asError, ChatError, toSafeError } from "./errors.js";
import { statusLine, type Bus } from "./bus.js";
import { COMMANDS, type MessageSummary } from "./protocol.js";
import { chatPage } from "./page.js";
import { describeRoom, summarize } from "./views.js";
import type { MessageStore } from "./store.js";
import type { Metrics, Runtime } from "./runtime.js";
import type { Registry } from "./state.js";
import { Router } from "./router.js";
import type { TcpClient } from "./clients.js";

// One parsed HTTP request. Header names are lowercased: HTTP header names are
// case-insensitive, so `Content-Length` and `content-length` must not differ.
export interface HttpRequest {
  method: string;
  path: string;
  version: string;
  headers: Map<string, string>;
  body: string | undefined;
}

// `Record<K, V>` is an object with keys of one type and values of another -
// here, header name to header value.
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// What reading the buffer produced. A discriminated union: the caller switches
// on `kind` and the compiler hands it exactly the right fields.
export type HttpOutcome =
  | { kind: "incomplete" }                                       // still arriving
  | { kind: "handled" }                                          // answered, closing
  | { kind: "upgrade"; request: HttpRequest; head: Buffer };     // hand off to ws

// `GET /path HTTP/1.1` - the shape of an HTTP request's first line. Anything
// else on the wire is a chat client. A JSON object never matches this, so the
// sniffing survives the protocol change untouched.
export const HTTP_REQUEST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \S+ HTTP\/1\.[01]$/;

const CRLF = "\r\n";
const HEADERS_END = "\r\n\r\n";

// Split the head of a request into a method, a path, and headers. Returns null
// if the request line is malformed - a 400, not a crash.
export function parseRequest(head: string, body: string | undefined): HttpRequest | null {
  const lines = head.split(CRLF);
  const requestLine = lines[0] ?? "";
  const [method, path, version] = requestLine.split(" ");

  if (method === undefined || path === undefined || version === undefined) {
    return null;
  }

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      // Header names are case-insensitive; normalise so lookups always hit.
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
  }

  return { method, path, version, headers, body };
}

// Content-Length counts BYTES, not characters. One emoji is a single character
// but four bytes in UTF-8; get this wrong and the client hangs waiting for the
// rest of a body that already arrived.
export function serializeResponse(res: HttpResponse): string {
  const headers: Record<string, string> = {
    "Content-Length": String(Buffer.byteLength(res.body)),
    Connection: "close",
    ...res.headers,
  };

  let out = `HTTP/1.1 ${res.status} ${statusLine(res.status)}${CRLF}`;
  for (const [name, value] of Object.entries(headers)) {
    out += `${name}: ${value}${CRLF}`;
  }
  return out + CRLF + res.body;
}

export function json(status: number, payload: unknown): HttpResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload, null, 2),
  };
}

export function html(status: number, body: string): HttpResponse {
  return { status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
}

// This is the whole handshake, as far as we are concerned: a GET that says it
// wants to become a WebSocket. `ws` validates the key and version for us.
export function isWebSocketUpgrade(req: HttpRequest): boolean {
  return (
    req.method === "GET" &&
    req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    (req.headers.get("connection")?.toLowerCase().includes("upgrade") ?? false)
  );
}

export class HttpService {
  private readonly router: Router;

  constructor(
    private readonly registry: Registry,
    private readonly bus: Bus,
    private readonly messages: MessageStore,
    private readonly runtime: Runtime,
    private readonly metrics: Metrics,
  ) {
    this.router = this.buildRoutes();
  }

  // The server's own state, served over HTTP. The chat rooms and the web page
  // are the same rooms - one process, three protocols.
  //
  // Chapter 12 wrote this as a chain of `if (req.path === "..." && req.method
  // === "GET")`, with one hand-rolled regex for the room route and a `named[1]`
  // that the compiler had no opinion about. The routes are a table now, and the
  // parameters are typed - `params.room` is a string because the *pattern* says
  // so, and `params.rooom` does not compile.
  //
  // These handlers may throw, and do: requireRoomNamed raises the very same
  // NotFoundError the chat side raises. The boundary below turns it into a 404.
  private buildRoutes(): Router {
    const { registry, messages: store, runtime, metrics } = this;

    return new Router()
      .on("GET", "/", () => html(200, chatPage(registry.clients.size, registry.rooms.size)))

      .on("GET", "/api/status", () =>
        json(200, {
          status: "running",
          uptime: process.uptime(),
          clients: registry.clients.size,
          rooms: registry.rooms.size,
        }))

      // What the process itself is doing. The interesting number is
      // eventLoopMeanMs: Node runs one thread, so if that climbs, everything is
      // slow for everyone and no amount of `async` will help.
      .on("GET", "/api/health", () => {
        const snapshot = runtime.snapshot();
        runtime.reset();
        return json(200, {
          ...snapshot,
          clients: registry.clients.size,
          rooms: registry.rooms.size,
          // The one number that says whether we are leaking a slow client's
          // unsent mail into our own heap. See MAX_BACKLOG_BYTES in clients.ts.
          backlogBytes: [...registry.clients.values()].reduce((sum, c) => sum + c.backlog, 0),
          // Gathered by @timed. Chapter 15 could tell you the loop was blocked;
          // this tells you by what.
          operations: metrics.snapshot(),
        });
      })

      // The protocol, served from the protocol. CATALOG is a Record keyed by
      // every ClientMessage variant, so this endpoint cannot describe a message
      // the server does not accept, nor omit one it does.
      .on("GET", "/api/protocol", () => json(200, { clientMessages: COMMANDS }))

      .on("GET", "/api/rooms", () => json(200, [...registry.rooms.values()].map(describeRoom)))

      // The route that earns the chapter.
      //
      // `params.room` is a `string`, and it is a string because the pattern
      // "/api/rooms/:room" says it is - PathParams read the name out of the
      // literal type. There is no regex, no capture group, no `[1]`, and nothing
      // to keep in sync. Rename the parameter in the pattern and this line stops
      // compiling, which is exactly what should happen.
      .on("GET", "/api/rooms/:room", async (_req, params) => {
        const room = registry.requireRoomNamed(params.room);
        return json(200, { ...describeRoom(room), recent: await store.recent(room.name, 10) });
      })

      // Every room's archive, read concurrently.
      //
      // Promise.all is the point here. The sequential version - `for (const room
      // of rooms) { out.push(await read(room)) }` - reads the files one after
      // another and takes as long as all of them added up, for no reason: none
      // depends on any other. It fails fast, and here that is correct: this
      // endpoint promises the whole archive, and two thirds of an archive is not
      // a smaller success, it is a wrong answer delivered confidently.
      .on("GET", "/api/history", async () => {
        const perRoom = await Promise.all(
          [...registry.rooms.keys()].map((room) => store.recent(room, 10)),
        );
        const recent: MessageSummary[] = perRoom.flat();
        return json(200, recent);
      })

      // Deliberately broken, and left in on purpose: the only honest way to show
      // what the boundary does with a failure nobody planned for. curl it and you
      // get a 500 saying "Internal server error" and absolutely nothing else. The
      // stack goes to the log, where the person who can fix it is looking.
      .on("GET", "/api/crash", () => {
        throw new Error("the kind of bug you did not see coming");
      })

      .on("POST", "/api/echo", (req) =>
        json(200, { echo: req.body ?? "", bytes: Buffer.byteLength(req.body ?? "") }));
  }

  private async route(req: HttpRequest): Promise<HttpResponse> {
    const matched = this.router.match(req.method, req.path);
    if (matched !== undefined) {
      return await matched.handler(req, matched.params);
    }

    // No handler. But "no handler" has two causes, and they are not the same
    // answer: a path nobody has ever heard of is a 404, and a path that exists
    // with a verb it does not accept is a 405 - and the client is entitled to be
    // told which verbs it *should* have used.
    const allowed = this.router.methodsFor(req.path);
    if (allowed.length > 0) {
      return {
        status: 405,
        headers: { "Content-Type": "application/json", Allow: allowed.join(", ") },
        body: JSON.stringify({ error: `Use ${allowed.join(" or ")}`, path: req.path }, null, 2),
      };
    }

    return json(404, { error: "Not Found", path: req.path });
  }

  // The HTTP boundary, and it is the chat boundary wearing different clothes.
  // route() throws the very same ChatErrors handleMessage does; the only
  // difference is that here the ChatError's `status` becomes the status line,
  // where over there its `code` became a ServerMessage.
  private async respond(request: HttpRequest | null): Promise<HttpResponse> {
    try {
      // `await` here is not decoration. Drop it and `route` returns a Promise
      // that this try/catch cannot see into - a rejection would sail straight
      // past the catch and out through the process's unhandledRejection net.
      // "return await" inside a try is one of the few places the redundant-
      // looking await is doing essential work.
      return request === null ? json(400, { error: "Bad Request" }) : await this.route(request);
    } catch (thrown: unknown) {
      const safe = toSafeError(thrown);
      if (!(thrown instanceof ChatError)) {
        this.bus.emit(
          "failure",
          `${request?.method ?? "?"} ${request?.path ?? "?"}`,
          asError(thrown),
        );
      }
      return json(safe.status, { error: safe.message, code: safe.code });
    }
  }

  // Consume as much of the buffer as forms a complete request. Either the
  // request is still arriving, or it has been answered, or it wants to become a
  // WebSocket and the caller must hand the socket over.
  async read(conn: TcpClient): Promise<HttpOutcome> {
    const buffered = conn.pending;
    const headerEnd = buffered.indexOf(HEADERS_END);
    if (headerEnd === -1) {
      return { kind: "incomplete" }; // headers still in flight
    }

    const head = buffered.subarray(0, headerEnd).toString("utf8");
    const bodyStart = headerEnd + HEADERS_END.length;

    // Peek at Content-Length before parsing properly: we may not have the body.
    const lengthHeader = /^content-length:\s*(\d+)/im.exec(head);
    const contentLength = lengthHeader?.[1] !== undefined ? parseInt(lengthHeader[1], 10) : 0;

    if (buffered.length < bodyStart + contentLength) {
      return { kind: "incomplete" }; // body still in flight
    }

    const body = contentLength > 0
      ? buffered.subarray(bodyStart, bodyStart + contentLength).toString("utf8")
      : undefined;

    const request = parseRequest(head, body);

    if (request !== null && isWebSocketUpgrade(request)) {
      // Anything after the request is the start of the WebSocket stream. It
      // belongs to `ws`, not to us.
      const leftover = buffered.subarray(bodyStart + contentLength);
      conn.consume(buffered.length);
      return { kind: "upgrade", request, head: leftover };
    }

    conn.consume(bodyStart + contentLength);

    const response = await this.respond(request);
    this.bus.emit("request", request?.method ?? "?", request?.path ?? "?", response.status);

    conn.write(serializeResponse(response));
    conn.close(); // we said Connection: close, so honour it
    return { kind: "handled" };
  }
}
