// HTTP, parsed by hand, on the same port as everything else.
//
// Chapter 6 wrote all of this; splitting it out is what finally shows how little
// of it the chat server ever needed to know. The one thing this module and
// handler.ts genuinely share is the error boundary - and they share it by both
// calling toSafeError, not by importing each other.

import { asError, ChatError, toSafeError } from "./errors.js";
import { statusLine, type Bus } from "./bus.js";
import { securityHeaders } from "./security.js";
import type { Rest } from "./rest.js";
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
    // On *every* response, not just the HTML one.
    //
    // A JSON error page is still a page a browser will render if you point it at
    // one, and `nosniff` matters most precisely where the content type is
    // something an attacker would like the browser to guess about.
    ...securityHeaders(),
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
  // The routes moved to rest.ts. What is left here is what this module was always
  // actually about: turning bytes into an HttpRequest and an HttpResponse back
  // into bytes. Parsing is not routing, and for six chapters they lived in one
  // file because there was not enough of either to notice.
  constructor(
    private readonly rest: Rest,
    private readonly bus: Bus,
  ) {}

  private async route(req: HttpRequest): Promise<HttpResponse> {
    return await this.rest.handle(req);
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

      // A 401 without WWW-Authenticate is not a 401, it is a 401-shaped noise. The
      // header is what tells the client *how* to authenticate - and it is the
      // difference between `curl --user` working and a human reading your source.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (safe.status === 401) {
        headers["WWW-Authenticate"] = "Bearer";
      }

      return {
        status: safe.status,
        headers,
        body: JSON.stringify({ error: safe.message, code: safe.code }, null, 2),
      };
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
