# Chapter 06 - Understanding HTTP

Parse raw HTTP from a TCP stream, build responses manually, serve HTML and JSON - then see how Node's built-in `http` module does the same thing for us.

## The Anatomy of HTTP

HTTP is a text protocol layered on TCP. Every request and response follows the same structure:

```
Request:
  METHOD PATH HTTP/1.1\r\n
  Header-Name: Header-Value\r\n
  \r\n
  optional body

Response:
  HTTP/1.1 STATUS REASON\r\n
  Header-Name: Header-Value\r\n
  \r\n
  body
```

Lines end with `\r\n` (CRLF). Headers end with a blank line (`\r\n\r\n`). The body follows.

## Parsing Raw HTTP from TCP

We build on Chapter 5's TCP server. Instead of echoing text, we parse HTTP requests and send proper HTTP responses:

```typescript
interface HttpRequest {
  method: string;
  path: string;
  headers: Map<string, string>;
  body: string | undefined;
}

function parseRequest(raw: string): HttpRequest | null {
  const lines = raw.split("\r\n");
  const [method, path] = (lines[0] ?? "").split(" ");
  if (!method || !path) return null;

  const headers = new Map<string, string>();
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === "") break; // blank line = end of headers
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
      const value = lines[i].slice(colonIdx + 1).trim();
      headers.set(key, value);
    }
  }

  const body = lines.slice(i + 1).join("\r\n") || undefined;
  return { method, path, headers, body };
}
```

> **Warning**
>
> `parseRequest` assumes the whole request arrived in one piece. It won't have. TCP is a byte stream, not a message queue: one `data` event may carry half the headers, or the headers and only part of the body, or two requests at once. A parser that reads whatever happened to turn up will work on localhost and fail in the real world.
>
> The fix is to buffer. Keep the received bytes per connection, wait until you have seen `\r\n\r\n` (end of headers), read `Content-Length` to learn how many body bytes to expect, and only parse once they have all arrived. The full listing below does exactly that - which is also why the buffer is a `Buffer` and not a `string`: `Content-Length` is counted in bytes, and slicing a string would cut multi-byte characters in half.

## Building HTTP Responses

```typescript
interface HttpResponse {
  status: number;
  reason: string;
  headers: Record<string, string>;
  body: string;
}

function serializeResponse(res: HttpResponse): string {
  let output = `HTTP/1.1 ${res.status} ${res.reason}\r\n`;
  output += `Content-Length: ${Buffer.byteLength(res.body)}\r\n`;
  output += "Connection: close\r\n";
  for (const [key, value] of Object.entries(res.headers)) {
    output += `${key}: ${value}\r\n`;
  }
  output += "\r\n";
  output += res.body;
  return output;
}
```

`Buffer.byteLength(body)` is important - it counts bytes, not characters. A UTF-8 emoji like 🎉 is 4 bytes but 1 character. `Content-Length` must be in bytes.

## Serving HTML and JSON

```typescript
function handleRequest(req: HttpRequest): HttpResponse {
  switch (req.path) {
    case "/":
      return {
        status: 200, reason: "OK",
        headers: { "Content-Type": "text/html" },
        body: "<h1>Hello from TypeScript!</h1>",
      };
    case "/api/status":
      return {
        status: 200, reason: "OK",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running", uptime: process.uptime() }),
      };
    default:
      return {
        status: 404, reason: "Not Found",
        headers: { "Content-Type": "text/html" },
        body: `<h1>404</h1><p>${req.path} not found</p>`,
      };
  }
}
```

## Comparing with Node's http Module

Node.js has a built-in `http` module that does all the parsing and serialization for you:

```typescript
import http from "node:http";

const server = http.createServer((req, res) => {
  // req.method, req.url, req.headers - already parsed
  // res.writeHead(), res.end() - builds the response

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Hello!</h1>");
  } else {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<h1>404</h1>");
  }
});

server.listen(8080);
```

The `http` module parses the request line, headers, and body for you. `res.writeHead()` and `res.end()` serialize the response. In production, you'd use this (or a framework like Express/Hono) instead of raw TCP parsing.

We built it by hand to understand the protocol. The rest of this guide uses WebSockets (Chapter 7+), which sit on top of HTTP for the initial handshake.

> **Note**
>
> Our chat server will use the `ws` library for WebSockets (Chapter 7), which handles the HTTP upgrade handshake internally. But understanding raw HTTP helps when debugging, reading headers, and building the REST API alongside WebSocket (Chapter 22).

## Putting It Together

The whole chapter comes down to one decision: when a socket connects, is the peer speaking HTTP or chat? We answer it by looking at the first line. The complete file is `src/index.ts` on the `chapter6` branch; here is the part that multiplexes one port between two protocols.

`sniff` peeks at the first complete line and matches it against the shape of an HTTP request line. Anything else is a chat client:

```typescript
// Look at the first complete line. Undefined means it has not arrived yet.
function sniff(conn: Connection): Protocol | undefined {
  const newline = conn.pending.indexOf(0x0a);
  if (newline === -1) {
    return undefined;
  }
  const firstLine = conn.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  return HTTP_REQUEST_LINE.test(firstLine) ? "http" : "chat";
}
```

And the connection handler uses it. A browser or `curl` sends its request at once; a person at a terminal sends nothing until they type - so a short timeout assumes a human and greets them:

```typescript
const server = net.createServer((socket) => {
  const conn = new Connection(socket, ++sequence);
  emit({ type: "system", text: `${conn.id} connected from ${conn.address}`, at: Date.now() });

  // A browser or curl sends its request immediately, so we can read it and
  // know. A person at a terminal sends nothing until they type - so if the
  // line never comes, assume a human and greet them.
  const greeting = setTimeout(() => {
    if (conn.mode === "unknown") {
      startChat(conn);
    }
  }, GREETING_DELAY_MS);

  socket.on("data", (chunk: Buffer) => {
    conn.append(chunk);

    if (conn.mode === "unknown") {
      const detected = sniff(conn);
      if (detected === undefined) {
        return; // not even one line yet
      }
      clearTimeout(greeting);
      if (detected === "http") {
        conn.becomes("http");
      } else {
        startChat(conn);
      }
    }

    if (conn.mode === "http") {
      drainHttp(conn);
      return;
    }

    for (const line of conn.takeLines()) {
      const text = parseInput(line);
      if (text.length > 0) {
        handleLine(conn, text);
      }
```

> **Tip**
>
> The complete, runnable file is `src/index.ts` on the `chapter6` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Run the server and test with `curl http://127.0.0.1:8080/`. Check that you see HTML. Try `curl -i` to see headers.
2. Hit `/api/status` and verify you get JSON with the server uptime.
3. Add a `/api/rooms` endpoint that returns a JSON array of room names.
4. Add a `POST /api/echo` endpoint that reads the request body and echoes it back as JSON.
5. Open in a browser - you'll see the HTML rendered. Check the network tab to see the full HTTP exchange.

## What's Next

You now understand HTTP at the protocol level - parsing requests, building responses, Content-Length, Content-Type, and status codes.

In the next chapter, we move to **WebSockets** - the protocol that enables real-time bidirectional communication. HTTP is request-response; WebSocket is a persistent connection where either side can send messages at any time.

---

Source: <https://purphoros.com/howto/typescript/http>
