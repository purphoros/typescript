# Chapter 07 - WebSocket Fundamentals

HTTP is request-response. WebSocket is a persistent, bidirectional connection - either side can send messages at any time. This is what makes real-time chat possible.

## Why WebSockets Exist

HTTP has a fundamental limitation: the client sends a request, the server sends a response, done. If the server wants to push data to the client (a new chat message, a notification), it can't - there's no open connection to push through.

Workarounds like polling (client asks "any new messages?" every second) waste bandwidth and add latency. WebSocket solves this by keeping the connection open after the initial HTTP handshake:

```
HTTP (request-response):
  Client ──▶ Server  "GET /messages"
  Client ◀── Server  "here are messages"
  (connection closed)
  Client ──▶ Server  "any new messages?"   ← polling, wasteful
  Client ◀── Server  "nope"

WebSocket (persistent, bidirectional):
  Client ──▶ Server  "HTTP Upgrade to WebSocket"
  Client ◀── Server  "101 Switching Protocols"
  (connection stays open)
  Client ──▶ Server  "hello"          ← either side can send
  Client ◀── Server  "new message!"   ← at any time
  Client ◀── Server  "user joined"
  Client ──▶ Server  "goodbye"
  (connection closed when either side wants)
```

## The WebSocket Handshake

WebSocket starts as a normal HTTP request with an `Upgrade: websocket` header. The server responds with `101 Switching Protocols`, and the connection switches from HTTP to WebSocket. After that, both sides send binary frames (not HTTP text).

```
Client request:
  GET / HTTP/1.1
  Host: localhost:8080
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
  Sec-WebSocket-Version: 13

Server response:
  HTTP/1.1 101 Switching Protocols
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

> **Note**
>
> The `ws` library handles the handshake automatically. You never need to compute `Sec-WebSocket-Accept` yourself. Understanding the handshake helps when debugging connection issues or reading network logs.

## The ws Library

`ws` is the most popular WebSocket library for Node.js. It's fast, spec-compliant, and has excellent TypeScript types.

```bash
npm install ws
npm install --save-dev @types/ws
```

The simplest thing `ws` can do - and it is *not* what this chapter builds. Look at the port: this opens a second one, and the whole point of Chapter 6 was that the chat, the web page and the API all arrive on the same one. The real `src/index.ts` runs `ws` in `noServer` mode and hands it sockets we have already accepted and parsed ourselves; it is listed in full at the end of the chapter.

```typescript
import { WebSocketServer, WebSocket } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");

  ws.send("Welcome to the chat!");

  ws.on("message", (data: Buffer) => {
    const message = data.toString();
    console.log(`Received: ${message}`);
    ws.send(`Echo: ${message}`);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});

console.log("WebSocket server on ws://127.0.0.1:8080");
```

The API mirrors Chapter 5's TCP server - same event model, different protocol:

- `WebSocketServer` - listens for WebSocket connections (handles the HTTP upgrade).
- `ws.send(data)` - send a message to the client.
- `ws.on("message")` - receive a message from the client.
- `ws.on("close")` - connection closed.
- `wss.clients` - a Set of all connected WebSocket instances.

## Broadcasting to All Clients

```typescript
// Broadcast a message to every connected client
function broadcast(wss: WebSocketServer, message: string, exclude?: WebSocket): void {
  for (const client of wss.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

wss.on("connection", (ws) => {
  broadcast(wss, "A new user joined!", ws);

  ws.on("message", (data) => {
    const text = data.toString();
    broadcast(wss, text);  // send to everyone including sender
  });
});
```

`wss.clients` is a `Set<WebSocket>` containing every connected client. Check `readyState === WebSocket.OPEN` before sending - a client might be mid-disconnect.

## Testing WebSocket Connections

You can test with a browser console, a CLI tool, or a Node.js client:

```bash
# Install wscat - a CLI WebSocket client
npm install -g wscat

# Connect to your server
wscat -c ws://127.0.0.1:8080

# Type messages and press Enter
# Open multiple terminals with wscat to test broadcasting
```

```typescript
// Or from a browser console:
const ws = new WebSocket("ws://127.0.0.1:8080");
ws.onmessage = (event) => console.log("Server:", event.data);
ws.onopen = () => ws.send("Hello from browser!");
```

> **Tip**
>
> `wscat` is the WebSocket equivalent of `telnet` or `nc` for TCP. It's the fastest way to test a WebSocket server from the command line.

## Attaching ws to a Server You Already Have

`new WebSocketServer({ port: 8080 })` is the quick way in: `ws` opens the port, runs an HTTP server behind the scenes, and answers the upgrade itself. It is perfect when WebSocket is *all* you serve.

Our server is not in that position. It already owns port 8080 - Chapter 5 put a TCP chat protocol there, and Chapter 6 taught it HTTP. Handing that port to `ws` would evict both. So we use the other mode:

```typescript
// noServer: ws opens no port and listens for nothing. It only ever receives
// sockets we have already accepted, parsed, and decided to upgrade.
const wss = new WebSocketServer({ noServer: true });

// ...once our own parser has seen `Upgrade: websocket` on a request:
wss.handleUpgrade(request, socket, head, (ws) => {
  wss.emit("connection", ws, request);
});
```

`handleUpgrade` takes the raw socket, computes `Sec-WebSocket-Accept`, writes the `101`, and owns the connection from then on. Two details matter:

- **Detach your own listeners first.** The socket was yours a moment ago and your `data` handler is still attached. Leave it there and you will try to read WebSocket frames as chat text. Remove it before handing over.
- **Pass the leftover bytes as `head`.** A fast client can send its first WebSocket frame in the same packet as the handshake. Whatever is in your buffer after the request belongs to `ws`.

This is the arrangement every real Node server uses, because a WebSocket endpoint almost always sits beside HTTP routes on one port.

## Putting It Together

`ws` normally opens its own port. We do not want a second port - Chapter 6 went to some trouble to serve everything on one - so `ws` runs in `noServer` mode and we hand it sockets we have already accepted and parsed ourselves. The complete file is `src/index.ts` on the `chapter7` branch; here is the handoff.

In `noServer` mode `ws` listens to nothing. It only ever receives sockets we give it:

```typescript
// noServer: `ws` opens no port and does no listening. It only ever receives
// sockets we have already accepted, parsed, and decided to upgrade.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
  const client = new WsClient(ws, ++sequence, request.socket.remoteAddress ?? "unknown");
  welcome(client);
```

When a parsed HTTP request turns out to be a WebSocket upgrade, we detach our own listeners, rebuild a genuine `IncomingMessage` from the request we parsed by hand in Chapter 6, and let `ws` take the socket from there:

```typescript
        case "upgrade": {
          // The socket stops being ours. Detach every listener before handing
          // it over, or we would keep trying to read WebSocket frames as text.
          socket.off("data", onData);
          socket.off("close", onClose);
          socket.off("error", onError);
          clearTimeout(greeting);

          // A genuine IncomingMessage, built from the request we parsed by
          // hand in Chapter 6. No cast, no lie: `ws` gets what it expects.
          const request = new IncomingMessage(socket);
          request.method = outcome.request.method;
          request.url = outcome.request.path;
          request.httpVersion = "1.1";
          request.headers = Object.fromEntries(outcome.request.headers);

          emit({
            type: "system",
            text: `${conn.id} upgrading to WebSocket → 101 ${statusLine(101)}`,
            at: Date.now(),
          });

          // ws computes Sec-WebSocket-Accept, writes the 101, and owns the
          // socket from here on.
          wss.handleUpgrade(request, socket, outcome.head, (ws) => {
            wss.emit("connection", ws, request);
          });
          return;
        }
```

> **Tip**
>
> The complete, runnable file is `src/index.ts` on the `chapter7` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Start the server and connect with `wscat -c ws://127.0.0.1:8080`. Send messages and verify the echo.
2. Open two `wscat` terminals. Type in one - verify the message appears in the other (broadcasting).
3. Add `/nick`, `/who`, `/help`, and `/quit` commands.
4. Add a `/time` command and an `/uptime` command (how long the client has been connected).
5. Try connecting from a browser console with `new WebSocket("ws://127.0.0.1:8080")`. The same server handles both CLI and browser clients.

## What's Next

You have a working WebSocket chat server - persistent connections, real-time broadcasting, and commands. This is the core of our chat application.

In the next chapter, we learn **generics** - TypeScript's tool for writing flexible, reusable code. We'll build a typed event emitter that powers our chat server's internal messaging.

---

Source: <https://purphoros.com/howto/typescript/websocket>
