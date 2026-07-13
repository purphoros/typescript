// The server: sockets, protocol sniffing, the WebSocket upgrade, and the
// lifecycle of the whole thing.
//
// This is the only module that knows a network exists. Everything below it -
// the handler, the registry, the rooms, the protocol - could be lifted into a
// program with no sockets at all and would not notice.
//
// It is a class, and that is the point of the chapter as much as the file split
// is. Chapters 5-10 kept the rooms, the clients and the sequence counter in
// module-level `const`s, which is a singleton nobody decided to write. You find
// out you wrote one the first time you want two - and Chapter 19 wants two
// hundred, one per test.

import net from "node:net";
import { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { Serializer } from "./async.js";
import { GREETING_DELAY_MS, address, type ServerConfig } from "./config.js";
import { asError, ErrorCode } from "./errors.js";
import { assertNever, CATALOG, ConnectionState } from "./protocol.js";
import { createBus, type Bus } from "./bus.js";
import { FileHistory } from "./history.js";
import { HttpService, HTTP_REQUEST_LINE } from "./http.js";
import { MessageHandler } from "./handler.js";
import { ChatMessage } from "./model.js";
import { Accounts, Sessions } from "./auth.js";
import { Registry } from "./state.js";
import { Metrics, Runtime } from "./runtime.js";
import { TcpClient, WsClient } from "./clients.js";
import type { PeerKind } from "./types.js";

export class ChatServer {
  readonly registry: Registry;
  readonly bus: Bus;
  readonly history: FileHistory;
  readonly runtime = new Runtime();
  readonly sessions = new Sessions();
  readonly metrics = new Metrics();

  // Populated in load(), because hashing passwords is deliberately slow and a
  // constructor cannot await. See Accounts.seedDefaults.
  readonly accounts = new Accounts(this.metrics);
  private readonly handler: MessageHandler;
  private readonly http: HttpService;
  private readonly wss: WebSocketServer;
  private readonly server: net.Server;

  constructor(readonly config: ServerConfig) {
    this.registry = new Registry(config);
    this.history = new FileHistory(config.dataDir, this.metrics);
    this.bus = createBus(this.registry, this.history);
    this.handler = new MessageHandler(
      this.registry,
      this.bus,
      this.history,
      this.accounts,
      this.sessions,
      config,
    );
    this.http = new HttpService(this.registry, this.bus, this.history, this.runtime, this.metrics);

    // noServer: `ws` opens no port and does no listening. It only ever receives
    // sockets we have already accepted, parsed, and decided to upgrade.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      this.acceptWebSocket(ws, request);
    });

    this.server = net.createServer((socket) => this.acceptTcp(socket));
    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${this.config.port} is already in use.`);
        process.exit(1);
      }
      throw err;
    });
  }

  // Rehydrate every room from disk, before a single client can connect.
  //
  // Promise.allSettled, and the choice matters. Promise.all fails fast: one
  // corrupt `dev.jsonl` and the whole server refuses to start, taking `general`
  // and `random` down with it over a room nobody was using. That is a worse
  // outcome than starting with an empty `dev` and saying so out loud.
  //
  // allSettled is the combinator for "do all of these, tell me how each went,
  // and do not editorialise" - it never rejects, so the caller has to look at
  // every result and decide. Which is exactly the decision being made here.
  async load(): Promise<void> {
    await this.history.open();

    // Hashing passwords with scrypt costs real milliseconds - on purpose. Doing
    // it here, once, means no user ever waits for it during a login.
    await this.accounts.seedDefaults();

    const rooms = [...this.registry.rooms.values()];
    const results = await Promise.allSettled(
      rooms.map((room) => this.history.recent(room.name, this.config.historyLimit)),
    );

    results.forEach((result, index) => {
      const room = rooms[index];
      if (room === undefined) {
        return;
      }
      if (result.status === "rejected") {
        // Best effort. This room starts empty, and the operator finds out why.
        this.bus.emit("failure", `load ${room.name}`, asError(result.reason));
        return;
      }
      for (const message of result.value) {
        room.remember(ChatMessage.restore(message));
      }
      if (result.value.length > 0) {
        this.bus.emit("notice", `${room.name}: recovered ${result.value.length} message(s) from disk`);
      }
    });
  }

  listen(onReady: () => void): void {
    this.server.listen(this.config.port, this.config.host, onReady);
  }

  // Stop accepting connections, hang up on everyone, wait for the disk, then
  // hand back.
  //
  // The `await` on flush() is the entire reason this is async. Chapter 11's
  // shutdown called process.exit() as soon as the socket closed - and a queued
  // append that had not reached the disk yet simply died with the process.
  // "Durable" means the write finished, and finishing takes time, and you have
  // to wait for it. This is what waiting looks like.
  async shutdown(): Promise<void> {
    this.bus.emit("notice", "Shutting down");
    for (const client of this.registry.clients.values()) {
      client.end({ type: "system", text: "Server shutting down." });
    }

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.history.flush();
    this.runtime.stop();
    this.bus.emit("notice", "History flushed. Goodbye.");
  }

  get url(): string {
    return address(this.config.host, this.config.port);
  }

  // --- WebSocket ---------------------------------------------------------

  private acceptWebSocket(ws: WebSocket, request: IncomingMessage): void {
    const client = new WsClient(
      ws,
      this.registry.nextSequence(),
      request.socket.remoteAddress ?? "unknown",
    );
    client.markConnected();
    this.handler.welcome(client);

    // `ws` reassembles frames, so a message arrives whole: one frame, one JSON
    // object. No buffering here - that work was only ever needed because raw TCP
    // has no message boundaries.
    //
    // But ordering is still ours to keep. `ws.on("message")` is a synchronous
    // callback that cannot await, so without this queue two frames arriving back
    // to back would both start handleLine and race - and a client that sent
    // {"join"} and then {"chat"} could be told it is not in a room.
    const queue = new Serializer();

    ws.on("message", (data: Buffer) => {
      const text = data.toString("utf8").trim();
      if (text.length === 0) {
        return;
      }
      // `void` says the Promise is deliberately not awaited; `.catch` says
      // nothing escapes. handleLine already handles everything it can, so this
      // only fires if sending the error message itself failed - which is exactly
      // the case that would otherwise be an unhandled rejection.
      void queue
        .run(() => this.handler.handleLine(client, text))
        .catch((thrown: unknown) => this.bus.emit("failure", client.id, asError(thrown)));
    });

    ws.on("close", () => {
      client.markClosed();
      const dropped = client.dropReason;
      if (dropped !== undefined) {
        this.bus.emit("notice", `${client.label} dropped: ${dropped}`);
      }
      this.handler.farewell(client);
    });

    ws.on("error", (err: Error) => {
      this.bus.emit("failure", client.id, err);
    });
  }

  // --- Raw TCP -----------------------------------------------------------

  // Look at the first complete line. Undefined means it has not arrived yet.
  private sniff(conn: TcpClient): PeerKind | undefined {
    const newline = conn.pending.indexOf(0x0a);
    if (newline === -1) {
      return undefined;
    }
    const firstLine = conn.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
    return HTTP_REQUEST_LINE.test(firstLine) ? "http" : "chat";
  }

  // Runs once per connection. Everything inside it belongs to that one client;
  // the event loop interleaves them all on a single thread.
  private acceptTcp(socket: net.Socket): void {
    const conn = new TcpClient(socket, this.registry.nextSequence());

    // Everything downstream of here can now await, and that turns out to be a
    // problem this connection has to solve for itself.
    //
    // `socket.on("data")` is a synchronous callback. It cannot await, and Node
    // will happily fire it again while the previous one is still suspended at an
    // `await` - so two chunks arriving back to back would both be reading and
    // consuming the *same* buffer, concurrently, and a half-parsed HTTP request
    // would be read twice.
    //
    // The queue restores what a synchronous `for` loop used to give for free:
    // chunk two is not looked at until chunk one is completely dealt with.
    const queue = new Serializer();

    // A browser or curl sends its request immediately, so we can read it and
    // know. A person at a terminal sends nothing until they type - so if the
    // line never comes, assume a human and greet them.
    const greeting = setTimeout(() => {
      if (conn.mode === "unknown") {
        conn.becomes("chat");
        conn.markConnected();
        this.handler.welcome(conn);
      }
    }, GREETING_DELAY_MS);

    const detach = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };

    // Buffer first, synchronously - the bytes must be captured before anything
    // yields - then queue the work that may wait.
    const onData = (chunk: Buffer): void => {
      // We may already have hung up on this client - and the socket will still
      // deliver whatever was in flight when we did. Without this, a client that
      // overran its buffer gets dropped once and *reported* every time another
      // packet lands, which is how one bad client becomes fifty log lines.
      if (conn.status === ConnectionState.Closing || conn.status === ConnectionState.Disconnected) {
        return;
      }

      if (!conn.append(chunk)) {
        // A quarter of a megabyte without a single newline. Whatever it is doing,
        // it is not chatting, and we are the one holding the bytes.
        this.bus.emit("notice", `${conn.id} dropped: sent 256KB with no complete message`);
        conn.end({
          type: "error",
          code: ErrorCode.InvalidMessage,
          message: "Message too large. One JSON object per line.",
        });
        return;
      }
      void queue
        .run(() => this.process(conn, socket, greeting, detach))
        .catch((thrown: unknown) => this.bus.emit("failure", conn.id, asError(thrown)));
    };

    const onClose = (): void => {
      clearTimeout(greeting);
      conn.markClosed();
      // If we hung up on them rather than the other way round, say why. A slow
      // client that vanishes without explanation is how you spend an afternoon
      // reading the wrong logs.
      const dropped = conn.dropReason;
      if (dropped !== undefined) {
        this.bus.emit("notice", `${conn.label} dropped: ${dropped}`);
      }
      if (conn.mode === "chat") {
        this.handler.farewell(conn);
      }
    };

    // Always handle this. An unhandled socket error takes the whole process down.
    const onError = (err: Error): void => {
      this.bus.emit("failure", conn.id, asError(err));
    };

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
  }

  // Whatever is in the buffer, dealt with completely. Runs one at a time per
  // connection - see the Serializer above.
  private async process(
    conn: TcpClient,
    socket: net.Socket,
    greeting: NodeJS.Timeout,
    detach: () => void,
  ): Promise<void> {
    if (conn.mode === "unknown") {
      const detected = this.sniff(conn);
      if (detected === undefined) {
        return; // not even one line yet
      }
      clearTimeout(greeting);
      conn.becomes(detected);
      if (detected === "chat") {
        conn.markConnected();
        this.handler.welcome(conn);
      }
    }

    if (conn.mode === "http") {
      const outcome = await this.http.read(conn);
      switch (outcome.kind) {
        case "incomplete":
        case "handled":
          return;

        case "upgrade": {
          // The socket stops being ours. Detach every listener before handing it
          // over, or we would keep trying to read WebSocket frames as text.
          detach();
          clearTimeout(greeting);

          // A genuine IncomingMessage, built from the request we parsed by hand
          // in Chapter 6. No cast, no lie: `ws` gets what it expects.
          const request = new IncomingMessage(socket);
          request.method = outcome.request.method;
          request.url = outcome.request.path;
          request.httpVersion = "1.1";
          request.headers = Object.fromEntries(outcome.request.headers);

          this.bus.emit("upgrade", conn.id);

          // ws computes Sec-WebSocket-Accept, writes the 101, and owns the
          // socket from here on.
          this.wss.handleUpgrade(request, socket, outcome.head, (ws) => {
            this.wss.emit("connection", ws, request);
          });
          return;
        }

        default:
          return assertNever(outcome);
      }
    }

    // One line, one JSON object. The framing from Chapter 5 is what makes that
    // sentence true.
    //
    // `await` inside the loop, and deliberately so: these are messages from one
    // client, in the order that client sent them, and running them concurrently
    // would be reordering somebody's conversation. This is the case where
    // sequential is not a missed optimisation - it is the requirement.
    for (const line of conn.takeLines()) {
      const text = line.trim();
      if (text.length > 0) {
        await this.handler.handleLine(conn, text);
      }
    }
  }

  // What to print once it is up. The server knows its own address; index.ts
  // should not have to reconstruct it.
  banner(): string[] {
    return [
      `Chat server listening on ${this.url}`,
      `Rooms: ${this.registry.roomNames.join(", ")}`,
      "",
      "Clients speak JSON - one object per line over TCP, one per frame over WebSocket:",
      `  ${CATALOG.join.example}`,
      `  ${CATALOG.chat.example}`,
      "",
      `Chat:    nc ${this.config.host} ${this.config.port}`,
      `HTTP:    curl http://${this.url}/api/protocol`,
      `Browser: http://${this.url}/`,
      `WebSock: wscat -c ws://${this.url}`,
    ];
  }
}
