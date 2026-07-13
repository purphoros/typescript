# Chapter 13 - Advanced Types

Mapped types, conditional types, template literals, and `infer` - the type-level programming tools that power TypeScript's most sophisticated patterns.

You have been using them since Chapter 9 without being told. This chapter names them, and then spends one route proving they earn their keep - and one dispatch table proving they sometimes cannot.

## Mapped Types

A mapped type transforms every property of an existing type. `{ [K in keyof T]: NewType }` iterates over the keys of `T` and produces a new type:

```typescript
// Make all properties optional (this is how Partial<T> works)
type MyPartial<T> = {
  [K in keyof T]?: T[K];
};

// Make all properties readonly (this is how Readonly<T> works)
type MyReadonly<T> = {
  readonly [K in keyof T]: T[K];
};
```

That is the whole mechanism, and you have already leaned on it twice. `CATALOG` in `protocol.ts` is a `Record<ClientMessageType, CommandInfo>` - a mapped type over the discriminants of a union - which is why forgetting to document a new message type is a compile error at the object literal rather than a gap in the help text. `DECODERS` is `{ [K in ClientMessageType]: Decoder<K> }`, which is the same trick with a twist: the *value* type depends on the key.

> **Note**
>
> This is how TypeScript's own utilities are built. `Partial<T>`, `Required<T>`, `Readonly<T>`, `Record<K, V>`, `Pick<T, K>` - all mapped types, none of them magic. You can read their definitions in `lib.es5.d.ts`, and they are each about three lines long.

## Conditional Types and `infer`

```typescript
// T extends U ? X : Y - a ternary at the type level
type IsString<T> = T extends string ? true : false;

// `infer` is a capture: it names a type found inside a pattern
type ElementOf<T> = T extends (infer E)[] ? E : never;

type C = ElementOf<string[]>;   // string
type D = ElementOf<boolean>;    // never (not an array)

// This is how ReturnType<T> works
type MyReturnType<T> = T extends (...args: never[]) => infer R ? R : never;
```

`infer R` says: *match this shape, and wherever `R` appears, remember what was actually there.* It is pattern matching, and like all pattern matching it either fits or it does not - the `: never` branch is what "does not fit" looks like.

`never` in a union vanishes: `"a" | never` is just `"a"`. That is not a curiosity, it is the mechanism the next section runs on.

## Template Literal Types

```typescript
type HandlerName = `handle${Capitalize<"chat" | "join">}`;
// "handleChat" | "handleJoin"

type ApiRoute = `/api/${"rooms" | "status"}`;
// "/api/rooms" | "/api/status"
```

Strings you can compute with. And, crucially, strings you can **take apart** - combine a template literal pattern with `infer` and you have a parser that runs in the type checker.

## Applying It: A Router That Reads Its Own URLs

Here is the code this chapter deletes. It is from `http.ts`, and it is the only route with a parameter in it:

```typescript
const named = /^\/api\/rooms\/([^/]+)$/.exec(req.path);
if (named?.[1] !== undefined && req.method === "GET") {
  const room = registry.requireRoomNamed(decodeURIComponent(named[1]));
  ...
}
```

Everything about `named[1]` is a promise the compiler cannot check. It is `string | undefined` regardless of what the regex actually contains. Add a second parameter, renumber the groups, mistype the index - the type system has nothing to say about any of it.

But the route pattern *already says* what its parameters are. `/api/rooms/:room` has one, and it is called `room`. So make the compiler read that sentence:

```typescript
// "/api/rooms/:room"  →  "" | "api" | "rooms" | ":room"
type Segments<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? Head | Segments<Tail>
  : P;

// ":room" → "room";  "rooms" → never  (and never vanishes from the union)
type ParamName<S extends string> = S extends `:${infer Name}` ? Name : never;

// and the mapped type that turns the surviving names into an object
export type PathParams<P extends string> = {
  readonly [K in ParamName<Segments<P>>]: string;
};
```

All three features, doing one job:

```typescript
PathParams<"/api/rooms/:room">                  // { readonly room: string }
PathParams<"/api/rooms/:room/messages/:id">     // { readonly room: string; readonly id: string }
PathParams<"/api/status">                       // {}
```

The no-parameter case needed no special handling. A union of `never` *is* `never`, and mapping over `never` produces no keys. It falls out.

Now the route:

```typescript
.on("GET", "/api/rooms/:room", async (_req, params) => {
  const room = registry.requireRoomNamed(params.room);
  return json(200, { ...describeRoom(room), recent: await history.recent(room.name, 10) });
})
```

`params.room` is a `string` because the *pattern* says so. And a typo is not a 3am `undefined`:

```
error TS2551: Property 'rooom' does not exist on type
  'PathParams<"/api/rooms/:room">'. Did you mean 'room'?
```

> **Tip**
>
> `on<P extends string>(method, pattern: P, ...)` - the generic with no default is what makes TypeScript infer the *literal* `"/api/rooms/:room"` rather than widening it to `string`. Widen it and `PathParams<string>` is `{}`: the parameters silently vanish, everything still compiles, and the feature is gone. When a type-level trick "stops working for no reason", this is almost always why.

### One assertion, and why it is honest

Inside the router, the stored handler must accept `Record<string, string>` - the matcher is splitting a string that arrived over a socket, and it learns the keys as it goes. The handler demands `{ readonly room: string }`. Those do not line up, and I was surprised:

```
error TS2322: Type 'Record<string, string>' is missing the following
  properties from type 'PathParams<"/api/rooms/:room">': room
```

Which is **correct**. An index signature says *if* a key is present its value is a string. It is not proof that `room` is present. TypeScript is refusing an unsound assignment, and it is right to.

So `Router.on()` contains exactly one `as`, and it is safe for a reason you can state: **the same pattern string produces both sides.** `on()` computes the handler's parameter type from the literal; `match()` populates the params object from that same stored pattern, key for key. They cannot drift, because there is only one pattern and it is the source of both.

That is the bargain a typed library makes. The unsafety is concentrated into one audited line *inside* the router, and every call site outside it is checked. The regex had the opposite arrangement: no assertion anywhere, and an unverified `named[1]` at every call site that touched it. **One assertion you can point at beats twenty you cannot.**

## Where Mapped Types Cannot Help

The chapter's own worked example is a handler map - dispatch the message to `handleChat`, `handleJoin`, and so on, each receiving its own narrowed variant. It is the obvious next move after the decoder map, and this server does not do it. Here is why, because the reason is the most useful thing in the chapter.

Both maps look identical:

```typescript
// A - the decoder map, in protocol.ts today. Compiles.
type Decoder<K extends ClientMessageType> = (f: Fields) => Extract<ClientMessage, { type: K }> | null;
const DECODERS: { [K in ClientMessageType]: Decoder<K> } = { ... };

// B - the handler map. Does not.
type Handler<K extends ClientMessageType> = (msg: Extract<ClientMessage, { type: K }>) => void;
const HANDLERS: { [K in ClientMessageType]: Handler<K> } = { ... };

function dispatch(msg: ClientMessage) {
  HANDLERS[msg.type](msg);
}
```

```
error TS2345: Argument of type 'ClientMessage' is not assignable to parameter of type 'never'.
  The intersection '{ type: "chat"; ... } & { type: "join"; ... } & { type: "leave"; }'
  was reduced to 'never' because property 'type' has conflicting types in some constituents.
```

Indexing with a *union* key gives a union of functions. To call it, TypeScript must find an argument acceptable to **all** of them - so it intersects the parameter types, and a chat message that is also a join message is nothing at all. `never`.

The decoder map escapes this because **its parameter does not vary with the key.** Every decoder takes the same `Fields`; only the *return* changes. Returns are covariant, so widening on the way out is sound, and one honest annotation does it:

```typescript
const decode: (fields: Fields) => ClientMessage | null = DECODERS[type as ClientMessageType];
```

A handler's parameter *does* vary with the key, and parameters are contravariant. There is no sound widening. Every workaround is an assertion - and unlike the router's, this one buys nothing, because `handleMessage`'s `switch` is **already** exhaustive, already narrows correctly, and needs no `as` at all.

> **Warning**
>
> This is the trap of type-level programming: the tools are strong enough that you can force almost anything, and forcing it means asserting it. The question is never "can I express this in the type system?" It is "does expressing it this way remove more lies than it adds?" For the router: yes, decisively. For the dispatch table: no. So the `switch` stays, and `assertNever` keeps guarding it.
>
> (The underlying limitation is real and long-standing - correlated union types, TypeScript issue #30581. You are not missing a trick.)

## Putting It Together

The whole chapter earns one thing: a router that reads its own URL patterns. `src/router.ts` on the `chapter13` branch has the runtime matcher too; here is the type-level half.

A type-level parser: `Segments` splits the path, `ParamName` keeps only the `:name` parts, and `PathParams` maps them to an object - all in the type checker:

```typescript
type Segments<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? Head | Segments<Tail>
  : P;

// A segment beginning with ":" is a parameter, and its name is the rest.
// Everything else contributes `never`, which vanishes from a union - so the
// literal segments simply fall away and only the names survive.
//
//   ParamName<":room">  =  "room"
//   ParamName<"rooms">  =  never
type ParamName<S extends string> = S extends `:${infer Name}` ? Name : never;

// And the mapped type that turns those names into an object.
//
//   PathParams<"/api/rooms/:room">           =  { readonly room: string }
//   PathParams<"/api/rooms/:room/msg/:id">   =  { readonly room: string; readonly id: string }
//   PathParams<"/api/status">                =  {}
//
// A route with no parameters gets `{}`, because a union of `never` is `never`
// and mapping over `never` produces no keys at all. Nothing had to special-case
// it; it falls out.
export type PathParams<P extends string> = {
  readonly [K in ParamName<Segments<P>>]: string;
};
```

> **Tip**
>
> The complete, runnable file is `src/router.ts` on the `chapter13` branch. You are not meant to paste it wholesale - build your own as you follow along, and use the reference to check yourself.

## Try It

```bash
npm run build && npm start
```

```bash
curl -i http://127.0.0.1:8080/api/rooms/general    # 200 - params.room = "general"
curl -i http://127.0.0.1:8080/api/rooms/nowhere    # 404 - the room, not the route
curl -i "http://127.0.0.1:8080/api/rooms/a%20b"    # decoded once, in the router
curl -i -X GET http://127.0.0.1:8080/api/echo      # 405, Allow: POST
curl -i http://127.0.0.1:8080/api/nonsense         # 404
```

That 405 is new, and nobody wrote it. The old code had a hand-rolled `if (req.method !== "POST") return json(405, ...)` inside the `/api/echo` branch - and nowhere else, because it was a rule living in a branch instead of in the structure. `methodsFor(path)` asks the table which verbs *would* have matched, and the difference between "no such path" and "no such verb on this path" stops being something you remember and starts being something you get.

Then break it on purpose, which is the only way to feel the point:

```typescript
.on("GET", "/api/rooms/:room", async (_req, params) => {
  const room = registry.requireRoomNamed(params.rooom);   // one letter
```

```
error TS2551: Property 'rooom' does not exist on type 'PathParams<"/api/rooms/:room">'.
  Did you mean 'room'?
```

## Exercise

1. Add `.on("GET", "/api/rooms/:room/messages/:id", ...)`. You get `params.room` and `params.id` and you write no parsing code. Now ask for `params.messageId` and read the error.
2. Change `on<P extends string>` to `on(method: HttpMethod, pattern: string, ...)`. Everything still compiles, and every `params.room` is now an error - or worse, `{}` silently. Explain what `P` was doing.
3. Write `type Reverse<S extends string>` that reverses a string type using template literals and `infer`. Then stop and ask what it is for. (This is the exercise that teaches restraint.)
4. Try to build the `HANDLERS` dispatch map from the section above. Get the `never` error. Now make it compile with an `as`, and write down what you have promised the compiler and who checks it.
5. `PathParams<"/api/rooms/:room">` gives `{ readonly room: string }`. Every param is a `string`. Design (do not necessarily build) a `:id{number}` syntax where the parameter type is inferred as `number`. What has to change, and what would you have to validate at runtime that the types cannot?

## What's Next

The compiler now reads route patterns. It reads message unions. It reads event maps. In each case the type is derived from one source of truth, and drift is a build error rather than a bug report.

But there is a hole in the middle of all of it, and Chapter 9 admitted to it at the time. `decodeClientMessage` hand-checks every field of every variant - `isString(f.text)`, `isString(f.room)` - one line per property, written by a human, kept in step with `ClientMessage` by nothing but diligence. The types and the validator agree today because someone made sure. Next: **JSON and validation**, where a schema becomes the single source of both.

---

Source: <https://purphoros.com/howto/typescript/advanced-types>
