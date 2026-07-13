# Chapter 05 - Your First TCP Server

Time to write real networking code. We'll create a TCP server with Node.js, accept connections, read data, and send responses - all using the event-driven model.

## Node.js net Module - Creating a TCP Server

Node.js has a built-in `net` module for low-level TCP networking. No external packages needed. It provides `net.createServer()` which returns a server that listens for incoming TCP connections:

The smallest server that works. This is the *idea*, not the file - `src/index.ts` on this branch is the finished chat server, listed in full at the end of the chapter.

```typescript
import net from "node:net";

const server = net.createServer((socket) => {
  console.log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);

  socket.write("Welcome to the chat server!\n");

  socket.on("data", (data) => {
    const message = data.toString().trim();
    console.log(`Received: ${message}`);
    socket.write(`Echo: ${message}\n`);
  });

  socket.on("close", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (err) => {
    console.error(`Socket error: ${err.message}`);
  });
});

server.listen(8080, "127.0.0.1", () => {
  console.log("Server listening on 127.0.0.1:8080");
});
```

Key concepts:

- `net.createServer(callback)` - the callback fires for each new connection, receiving a `socket` object.
- `socket` is a duplex stream - you can read from it AND write to it. It represents one TCP connection.
- `socket.write(data)` - sends data to the client.
- `server.listen(port, host, callback)` - starts listening. The callback fires when the server is ready.

## The Event-Driven Model

Node.js doesn't spawn a thread per connection. Instead, it uses an **event loop** - a single thread that waits for events and calls your callbacks when they fire. Your code never blocks waiting for a socket; you register a callback and the loop invokes it once the data has actually arrived.

The `socket.on(event, callback)` pattern registers listeners for different events:

#### socket.on("data", callback)

Fires when the client sends data. The callback receives a `Buffer` - raw bytes. Call `.toString()` to get a string.

#### socket.on("close", callback)

Fires when the connection closes (client disconnects or socket is destroyed).

#### socket.on("error", callback)

Fires on errors (connection reset, timeout, etc.). Always handle this - unhandled socket errors crash the process.

> **Note**
>
> Your JavaScript runs on *one* thread. The event loop handles I/O without blocking it - while one client's data is still in flight, the loop is free to process another client's events, so a thousand idle connections cost almost nothing. The catch is the flip side: because there is only one thread, any callback that does heavy CPU work holds the loop and stalls *every* other client until it returns. Node.js is superb for I/O-heavy workloads like chat servers, and a poor fit for CPU-heavy ones.

## Reading Data and Writing Responses

```typescript
socket.on("data", (data: Buffer) => {
  // data is a Buffer - raw bytes from the client
  // .toString() converts to a string (UTF-8 by default)
  const message = data.toString().trim();

  // Write back to the client
  socket.write(`You said: ${message}\n`);

  // Check for special commands
  if (message === "/quit") {
    socket.write("Goodbye!\n");
    socket.end();  // close the connection gracefully
  }
});
```

Key details:

- `data` is a `Buffer` - Node.js's type for raw binary data, a fixed-length sequence of bytes. It is not a string until you decode it.
- `.toString()` converts bytes to a UTF-8 string.
- `.trim()` removes whitespace and newlines from the ends (clients send `\r\n` or `\n` after each line).
- `socket.end()` gracefully closes the connection - sends remaining data then closes.
- `socket.destroy()` immediately closes without flushing - use for error recovery.

## Testing with telnet and nc

Start the server, then connect from another terminal:

```bash
# Start the server
npx tsx src/index.ts

# In another terminal - connect with telnet
telnet 127.0.0.1 8080

# Or with netcat
nc 127.0.0.1 8080

# Type messages and press Enter - you'll see the echo response
# Type /quit to disconnect
```

Try opening multiple connections in different terminals - the server handles them all concurrently via the event loop, no threads needed.

> **Tip**
>
> Every connection gets its own `socket` object. The server callback runs once per connection. Inside the callback, you set up event handlers for that specific socket. Multiple clients are served concurrently - Node.js's event loop interleaves their events automatically.

## Putting It Together

Chapters 1-4 built the vocabulary - the domain types, the interfaces, the `ChatRoom` and `ChatMessage` classes. This chapter drives them with a real socket. Rather than reprint the whole file, here are the two pieces this chapter adds; the complete version is `src/index.ts` on the `chapter5` branch, and both blocks below are slices of it.

A `Connection` wraps one socket. It gives every client an id, tracks its state and identity, and turns "write a line" into "write bytes and a newline" - so the rest of the server never touches a raw socket:

```typescript
class Connection implements Identifiable {
  readonly id: string;
  readonly address: string;
  readonly connectedAt: Timestamp;

  private state: ConnectionState = "connecting";
  private identity?: User;
  private currentRoom?: RoomName;

  constructor(private readonly socket: net.Socket, sequence: number) {
    this.id = `c${sequence}`;
    this.address = `${socket.remoteAddress}:${socket.remotePort}`;
    this.connectedAt = Date.now();
    this.state = "connected";
  }

  get status(): ConnectionState {
    return this.state;
  }

  get user(): User | undefined {
    return this.identity;
  }

  get room(): RoomName | undefined {
    return this.currentRoom;
  }

  // Who this connection is, for logging: the chosen nick, else the socket id.
  get label(): string {
    return this.identity?.name ?? this.id;
  }

  // How long this client has been connected, in milliseconds.
  get uptime(): number {
    return Date.now() - this.connectedAt;
  }

  send(line: string): void {
    this.socket.write(`${line}\n`);
  }
```

And the server itself: `net.createServer` hands us one socket per client, and the three events - `data`, `close`, `error` - are the whole event-driven model:

```typescript
const server = net.createServer((socket) => {
  const conn = new Connection(socket, ++sequence);
  clients.set(conn.id, conn);

  emit({ type: "system", text: `${conn.id} connected from ${conn.address}`, at: Date.now() });
  conn.send(`Welcome! You are ${conn.id}. Type /help for commands.`);

  // `data` is a Buffer - raw bytes. A single chunk may hold several lines, or
  // half of one; splitting on newline is enough until Chapter 15 does framing.
  socket.on("data", (data: Buffer) => {
    for (const raw of data.toString().split("\n")) {
      const line = parseInput(raw);
      if (line.length > 0) {
        handleLine(conn, line);
      }
    }
  });

  socket.on("close", () => {
    const room = conn.room;
    if (room !== undefined) {
      rooms.get(room)?.leave(conn.label);
    }
    conn.markClosed();
    clients.delete(conn.id);
    emit({ type: "system", text: `${conn.label} disconnected (${clients.size} remaining)`, at: Date.now() });
  });

  // Always handle this. An unhandled socket error takes the whole process down.
  socket.on("error", (err: Error) => {
    emit({ type: "system", text: `${conn.id} error: ${err.message}`, at: Date.now() });
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  }
  throw err;
});

// Ctrl-C: stop accepting connections, hang up on everyone, then exit.
process.on("SIGINT", () => {
  emit({ type: "system", text: "Shutting down", at: Date.now() });
  for (const conn of clients.values()) {
    conn.end("Server shutting down.");
  }
  server.close(() => process.exit(0));
});
```

`socket.on("error")` is not optional: an unhandled socket error takes the whole process down. And one `data` chunk is raw bytes that may hold several lines or half of one - splitting on the newline is enough here; Chapter 15 does proper framing.

> **Tip**
>
> The complete, runnable file is `src/index.ts` on the `chapter5` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Exercise

1. Run the server and connect with `telnet` or `nc`. Send messages and verify the echo response.
2. Open multiple connections from different terminals. Verify each gets a unique client ID and they all work concurrently.
3. Add a `/time` command that responds with the current timestamp.
4. Add a `/uptime` command that shows how long the client has been connected (use `Date.now() - client.connectedAt`).
5. Type `/who` from multiple clients and verify the count matches the number of connected terminals.

## What's Next

You have a working TCP server that accepts multiple connections, reads data, sends responses, and tracks clients. The event-driven model handles concurrency without threads.

In the next chapter, we'll understand HTTP by building a minimal HTTP server on top of TCP - parsing requests and building responses by hand before we move to WebSockets.

---

Source: <https://purphoros.com/howto/typescript/tcp-server>
