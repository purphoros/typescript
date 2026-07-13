# Chapter 22 - REST API

The HTTP endpoints grew one at a time, whenever a chapter needed to show something. `/api/status` in Chapter 6. `/api/rooms` in Chapter 9. `/api/crash` in Chapter 10. `/api/health` in Chapter 15.

They are not an API. They are a pile of endpoints. And every single one of them was public:

```bash
curl http://localhost:8080/api/history
```
```
200. Every message. Every room. No credential of any kind.
```

Chapter 17 shut the door on the chat protocol - sessions, tokens, a `requireAuth` middleware, the whole thing - and left this wide open. **That is not an oversight in Chapter 17; it is the shape of Chapter 17.** Auth was built as a middleware over `ClientMessage`, and an HTTP request is not a `ClientMessage`.

Authentication that is bolted onto one protocol is not authentication. It is a habit.

## Make the check impossible to forget

The obvious fix is a line at the top of every handler:

```typescript
.on("GET", "/api/rooms", (req) => {
  const session = requireSession(req);     // ...and if somebody forgets this line?
  return json(200, ...);
})
```

That works, and it works for exactly as long as everybody remembers. So instead the **router carries a context type**, and there are two of them:

```typescript
private readonly open: Router<void>;
private readonly secure: Router<Session>;
```

A `Router<void>` hands its handlers nothing. A `Router<Session>` **hands its handlers a session**:

```typescript
.on("GET", "/api/users/me", (_req, _params, session) =>
  json(200, { name: session.user.name, admin: isAdmin(session.user) }))
```

An authenticated handler cannot forget to check for a session, because it **could not have been called without one**. The check is not a line of code somebody has to remember to write. It is the type of the argument.

This is the same move as Chapter 16's state machine, and Chapter 9's `assertNever`, and Chapter 10's `Result`: **make the bad state unrepresentable, rather than validating against it in twelve places and hoping.**

```typescript
export type RouteHandler<P extends string, C> = (
  request: HttpRequest,
  params: PathParams<P>,
  context: C,
) => HttpResponse | Promise<HttpResponse>;
```

The router from Chapter 13 needed one extra type parameter. That is all.

## One policy, two protocols

```typescript
private async authenticate(req: HttpRequest): Promise<Session> {
  const header = req.headers.get("authorization");
  const token = header?.match(/^Bearer (.+)$/i)?.[1];

  if (token === undefined) {
    throw new AuthError("Send an Authorization: Bearer <token> header.", ErrorCode.Unauthenticated);
  }

  // The same function the chat protocol's `auth` message uses.
  const session = await resume(this.deps.accounts, token, this.deps.config.jwtSecret);
  if (!session.ok) throw session.error;
  return session.value;
}
```

`resume()` is Chapter 17's, unchanged. The `alg:none` forgery is refused here for the same reason it is refused there - because it is the *same code*, not because somebody remembered to write the check twice.

> **Tip**
>
> **A Bearer token, not a cookie.** A cookie is sent by the browser *automatically*, on every request, **including ones triggered by another website** - which is precisely what CSRF is. A credential that must be attached deliberately is a credential that cannot be used against you by a page you did not visit. That is a whole class of vulnerability we simply do not have. (Chapter 24 comes back to this, because the WebSocket upgrade has the same problem and we have not fixed it yet.)

## Order matters, and it leaks if you get it wrong

```typescript
const publicRoute = this.open.match(req.method, path);
if (publicRoute !== undefined) return await publicRoute.handler(req, publicRoute.params, undefined as void);

const secureRoute = this.secure.match(req.method, path);
if (secureRoute === undefined) {
  // ...405 or 404
}

const session = await this.authenticate(req);   // only now
```

Look at where `authenticate` is: **after** we know the route exists.

Do it the other way round and an unauthenticated request to `/api/secrets` gets a `401` - which tells a stranger *that the path exists and they simply cannot see it*. Do it this way and it gets a `404`, which tells them nothing.

```
  GET /api/rooms    (no token) -> 401
  GET /api/secrets  (no token) -> 404
```

It is a small leak. It is also free not to make it.

## Status codes are an interface

| | |
|---|---|
| **201** + `Location` | you made a thing, and here is where it now lives |
| **204** | it worked, and there is nothing to say |
| **401** + `WWW-Authenticate` | I do not know who you are |
| **403** | I know exactly who you are, and the answer is still no |
| **404** | there is no such thing |
| **405** + `Allow` | there is such a thing, and not by that verb |
| **422** | I understood you perfectly, and no |

The 400/422 line is the one people skip, and it is Chapter 10's distinction wearing an HTTP hat: `{"text": 123}` is a **400** (I could not read you), and `{"text": "<1001 characters>"}` is a **422** (I read you, and no).

And a `401` without `WWW-Authenticate` is not a 401, it is a 401-shaped noise. The header is what tells a client *how* to authenticate:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

## Pagination: a cursor, not an offset

```typescript
page(room: RoomName, limit: number, before?: number): Promise<MessageSummary[]>;
```

`LIMIT 20 OFFSET 40` looks equivalent, and is not. **Messages arrive while somebody is reading.** Every new row shifts the old ones down, so page 3 shows you two messages you already saw on page 2 - and if a row is deleted, page 3 skips one entirely.

A cursor says *"before this moment"*, and a moment does not move:

```sql
WHERE room = ? AND at < ? ORDER BY at DESC LIMIT ?
```

It walks the same `(room, at)` index from Chapter 21, so **page 40 costs exactly what page 1 did** - which `OFFSET` cannot promise, because `OFFSET` has to count past every row it is skipping.

The server builds the next link so the client never computes anything:

```json
{
  "room": "general",
  "messages": [ ... ],
  "next": "/api/rooms/general/messages?limit=10&before=1015"
}
```

And when there is no more history, `next` is `null` - which is how a client knows to stop without guessing.

The test asserts the property that matters:

```typescript
// A new message arriving now must NOT shift the next page - which is exactly
// what OFFSET would have done.
await store.append({ room: "general", sender: "bob", text: "brand new", at: 99999 });
const third = parse(await call(rest, "GET", second.next, { token }));
expect(third.messages.map((m) => m.text)).toEqual(["m0","m1","m2","m3","m4"]);
```

## The nicest thing in the chapter took no new code

```typescript
.on("POST", "/api/rooms/:room/messages", (req, params, session) => {
  const room = registry.requireRoomNamed(params.room);
  // ...validate...
  const message = new ChatMessage(session.user.name, text, room.name);
  bus.emit("message", message);
  return jsonWith(201, { Location: ... }, { ... });
})
```

`bus.emit("message", ...)` - that is it. The same three listeners run that have run since Chapter 8: the log, the archive, and the broadcast.

So a `curl` in a terminal appears **instantly** in a browser's chat window:

```
  bob is sitting in #general over WebSocket, waiting...
  a curl POST /api/rooms/general/messages happened; bob (WebSocket) received:
    {"type":"chat","sender":"alice","text":"hello from a REST call","room":"general","at":1783958804307}
```

Nothing was written to make that work. Chapter 8 decoupled *what happened* from *everyone who cares about it*, and a REST POST is just one more thing that happened. **That is what the abstraction was for, and this is the invoice being paid four hundred pages later.**

## And http.ts got smaller

Routing moved out to `rest.ts`. What is left in `http.ts` is what that module was always actually about: turning bytes into an `HttpRequest`, and an `HttpResponse` back into bytes.

Parsing is not routing. For six chapters they lived in one file because there was not enough of either to notice.

## Putting It Together

`src/rest.ts` closes the hole: the HTTP API had no auth at all. It is on the `chapter22` branch.

Two routers, and the split is the point. A `Router<Session>` hands each handler a session - so an authenticated handler cannot forget to check for one, because it could not have been called without one:

```typescript
  private readonly open: Router<void>;
  private readonly secure: Router<Session>;

  constructor(private readonly deps: RestDeps) {
    this.open = this.publicRoutes();
    this.secure = this.authenticatedRoutes();
  }
```

And the gate. The Bearer token is verified by the same `resume` the chat protocol uses - one policy, two protocols:

```typescript
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
```

> **Tip**
>
> The complete, runnable file is `src/rest.ts` on the `chapter22` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
```

```bash
# The hole is closed.
curl -i localhost:8080/api/rooms
#   401 Unauthorized
#   WWW-Authenticate: Bearer

# A path that does not exist tells you nothing.
curl -i localhost:8080/api/secrets       # 404, not 401

# Log in.
TOKEN=$(curl -s -X POST -d '{"name":"alice","password":"correct-horse"}' \
  localhost:8080/api/login | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/users/me
#   { "name": "alice", "admin": true, ... }

# Post a message, and watch it land in an open browser tab.
curl -i -H "Authorization: Bearer $TOKEN" \
  -d '{"text":"hello from a REST call"}' \
  localhost:8080/api/rooms/general/messages
#   201 Created
#   Location: /api/rooms/general/messages?before=...&limit=1

# Page backwards through history.
curl -s -H "Authorization: Bearer $TOKEN" \
  "localhost:8080/api/rooms/general/messages?limit=5" | jq '{next, count: (.messages|length)}'
```

## Exercise

1. Move `authenticate()` to the top of `handle()`, before the route lookup. Now `curl /api/secrets` returns 401. Explain, to somebody who does not think it matters, exactly what you just told an attacker.
2. Register a handler on `this.secure` that ignores its `session` argument. Now try to register one on `this.open` that *uses* a session. Read the error. That is the chapter.
3. Implement `GET /api/rooms/:room/messages` with `OFFSET` instead of a cursor. Then write a test that posts a message between page 1 and page 2, and watch it fail.
4. Add `ETag` and `If-None-Match` to `GET /api/rooms/:room`, returning `304 Not Modified`. What do you hash, and what happens when a member joins?
5. `POST /api/rooms/:room/messages` is not rate-limited - Chapter 17's `rateLimit` middleware is on the *chat* pipeline. Fix it, and notice that you are about to write the same "one policy, two protocols" fix a second time.

## What's Next

The API has auth that cannot be forgotten, status codes that mean things, pagination that does not lie, and a POST that lands in everybody's chat window.

The chat itself, though, has not moved since Chapter 16. There is no way to tell that somebody is typing, no way to know who is actually *there* rather than merely connected, and a client whose network drops leaves a ghost sitting in the room forever, because nothing ever checks.

Next: **real-time features.**

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/rest-api>
