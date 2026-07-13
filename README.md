# Learning TypeScript

## Building a Real-Time Chat Server

A hands-on guide to learning TypeScript by incrementally building a WebSocket-based chat server. Each chapter introduces new language concepts through practical features - starting from a raw TCP connection and ending with a fully tested, real-time chat system with rooms, authentication, and message history.

## Contents

| # | Chapter | Topic |
|---|---------|-------|
| 01 | [Hello, TypeScript](https://github.com/purphoros/typescript/blob/chapter1/README.md) | Installing the toolchain, first project, how TypeScript compiles to JavaScript |
| 02 | [TypeScript Fundamentals](https://github.com/purphoros/typescript/blob/chapter2/README.md) | Variables, functions, primitives, type annotations |
| 03 | [The Type System](https://github.com/purphoros/typescript/blob/chapter3/README.md) | Structural typing, inference, narrowing |
| 04 | [Interfaces, Objects & Classes](https://github.com/purphoros/typescript/blob/chapter4/README.md) | Object shapes, access modifiers, inheritance |
| 05 | [Your First TCP Server](https://github.com/purphoros/typescript/blob/chapter5/README.md) | Raw sockets with the `net` module |
| 06 | [Understanding HTTP](https://github.com/purphoros/typescript/blob/chapter6/README.md) | Requests, responses, and the HTTP server |
| 07 | [WebSocket Fundamentals](https://github.com/purphoros/typescript/blob/chapter7/README.md) | The upgrade handshake and framing |
| 08 | [Generics](https://github.com/purphoros/typescript/blob/chapter8/README.md) | Reusable, type-safe abstractions |
| 09 | [Enums & Discriminated Unions](https://github.com/purphoros/typescript/blob/chapter9/README.md) | Modeling message protocols |
| 10 | [Error Handling](https://github.com/purphoros/typescript/blob/chapter10/README.md) | Errors, results, and failure modes |
| 11 | [Modules & Project Structure](https://github.com/purphoros/typescript/blob/chapter11/README.md) | Imports, exports, organizing the codebase |
| 12 | [Async/Await & Promises](https://github.com/purphoros/typescript/blob/chapter12/README.md) | Asynchronous control flow |
| 13 | [Advanced Types](https://github.com/purphoros/typescript/blob/chapter13/README.md) | Mapped, conditional, and utility types |
| 14 | [JSON & Validation](https://github.com/purphoros/typescript/blob/chapter14/README.md) | Parsing and validating untrusted input |
| 15 | [The Node.js Runtime](https://github.com/purphoros/typescript/blob/chapter15/README.md) | Event loop, streams, buffers |
| 16 | [Chat Server Core](https://github.com/purphoros/typescript/blob/chapter16/README.md) | Rooms, clients, and broadcast |
| 17 | [Authentication & Sessions](https://github.com/purphoros/typescript/blob/chapter17/README.md) | Identity and session handling |
| 18 | [Decorators & Metadata](https://github.com/purphoros/typescript/blob/chapter18/README.md) | Decorators and reflection |
| 19 | [Testing](https://github.com/purphoros/typescript/blob/chapter19/README.md) | Unit and integration tests |
| 20 | [Logging, Config & CLI](https://github.com/purphoros/typescript/blob/chapter20/README.md) | Structured logging, config precedence, a real CLI with `parseArgs` |
| 21 | [Database Persistence](https://github.com/purphoros/typescript/blob/chapter21/README.md) | SQLite, migrations, indexes, transactions, bound parameters |
| 22 | [REST API](https://github.com/purphoros/typescript/blob/chapter22/README.md) | Bearer auth on HTTP, cursor pagination, status codes that mean things |
| 23 | [Real-Time Features](https://github.com/purphoros/typescript/blob/chapter23/README.md) | Heartbeats, presence, typing indicators, and reaping the dead |
| 24 | [Security & Hardening](https://github.com/purphoros/typescript/blob/chapter24/README.md) | Cross-site WebSocket hijacking, CSP, connection limits |
| 25 | [Packaging & Deployment](https://github.com/purphoros/typescript/blob/chapter25/README.md) | Multi-stage Docker, non-root, CI, and what npm was about to publish |

Each chapter lives on its own branch, built on the one before it - `chapter1` through `chapter25` - so you can check one out and run exactly the code that chapter describes. The chapter text is that branch's `README.md`.

Chapters 20-25 have not been published upstream. They were written for this repository from the chapter titles; the code is real and verified, and each says so at the top.

---

Source: [purphoros.com/howto/typescript](https://purphoros.com/howto/typescript) - by Benjamin C. Tehan.
