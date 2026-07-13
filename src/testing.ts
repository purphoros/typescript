// A client that is not attached to anything.
//
// This is Chapter 11's promise, collected. `MessageHandler` accepts a
// `ChatClient` - an interface - so a client that never touches a socket is
// indistinguishable, to the handler, from a browser tab.
//
// Note what it *extends*. `FakeClient` is a subclass of the real `BaseClient`, so
// it inherits the real state machine, the real `label`, the real transitions -
// everything from Chapter 16 that decides whether you may enter a room. Only the
// two methods that put bytes on a wire are replaced.
//
// That distinction is the whole difference between a useful test double and a
// useless one. Reimplement the logic in your fake and you are testing your fake.
// Fake only the *edge* - the socket - and everything above it is the code that
// actually ships.

import { BaseClient } from "./clients.js";
import { ConnectionState, type ServerMessage, type ServerMessageType } from "./protocol.js";
import { clientId } from "./types.js";

export class FakeClient extends BaseClient {
  // Every message the server tried to send this client, in order. A socket, if
  // you like, that only ever writes to an array.
  readonly outbox: ServerMessage[] = [];

  constructor(sequence = 1) {
    super(clientId(`f${sequence}`), "tcp", ConnectionState.Connected);
    this.markConnected();
  }

  send(message: ServerMessage): void {
    this.outbox.push(message);
  }

  end(message: ServerMessage): void {
    this.outbox.push(message);
    this.markClosing();
  }

  // Never behind, because there is no wire to be behind on.
  get backlog(): number {
    return 0;
  }

  protected destroy(): void {
    this.markClosed();
  }

  // --- Reading what happened ---------------------------------------------

  // The last message of a given type, or undefined. Tests should assert on what
  // the server *said*, not on how it said it - this is the whole vocabulary they
  // need.
  last<K extends ServerMessageType>(type: K): Extract<ServerMessage, { type: K }> | undefined {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const message = this.outbox[i];
      if (message?.type === type) {
        return message as Extract<ServerMessage, { type: K }>;
      }
    }
    return undefined;
  }

  all<K extends ServerMessageType>(type: K): Extract<ServerMessage, { type: K }>[] {
    return this.outbox.filter((m): m is Extract<ServerMessage, { type: K }> => m.type === type);
  }

  get errorCodes(): string[] {
    return this.all("error").map((m) => m.code);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
