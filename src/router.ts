// A router that knows what is in its own URLs.
//
// http.ts has been matching routes with a chain of string comparisons and, for
// the one route with a parameter in it, a hand-rolled regex:
//
//     const named = /^\/api\/rooms\/([^/]+)$/.exec(req.path);
//     if (named?.[1] !== undefined && req.method === "GET") {
//       const room = registry.requireRoomNamed(decodeURIComponent(named[1]));
//
// Everything about `named[1]` is a promise the compiler cannot check. Rename the
// capture group, add a second parameter, mistype the index, and the type system
// has nothing to say - `named[1]` is `string | undefined` no matter what the
// regex actually contains.
//
// The route pattern already *says* what its parameters are. `/api/rooms/:room`
// has one, and it is called `room`. This module makes the compiler read that
// sentence: give it the pattern as a literal type and it computes the parameter
// object, so `params.room` is a string and `params.rooom` does not compile.
//
// Three features, and it takes all three:
//
//   template literal types  - take a string type apart
//   conditional types + infer - recurse through it, capturing as you go
//   mapped types            - turn what you captured into an object type

import type { HttpRequest, HttpResponse } from "./http.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

// --- The type-level parser -----------------------------------------------

// Split a path into its segments, at the type level.
//
//   Segments<"/api/rooms/:room">  =  "" | "api" | "rooms" | ":room"
//
// `infer` is a capture. The pattern `${infer Head}/${infer Tail}` says: if this
// string type has a slash in it, call the part before it Head and the part after
// it Tail. Then recurse on Tail. When there is no slash left, the whole thing is
// the last segment and the recursion stops.
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

// --- The router ----------------------------------------------------------

// A handler for one route. `P` is the *literal* pattern, which is what lets
// PathParams<P> compute anything at all - pass a `string` and you get `{}`.
export type RouteHandler<P extends string> = (
  request: HttpRequest,
  params: PathParams<P>,
) => HttpResponse | Promise<HttpResponse>;

// How the handler is stored once its pattern has been forgotten.
//
// The runtime matcher can only produce a `Record<string, string>` - it is
// splitting a string that arrived over a socket, and it learns the keys as it
// goes. The handler, meanwhile, demands `{ readonly room: string }`. And those
// do not line up:
//
//   error TS2322: Type 'Record<string, string>' is missing the following
//     properties from type 'PathParams<"/api/rooms/:room">': room
//
// which surprised me, and is correct. An index signature says *if* a key is
// there its value is a string. It is not proof that `room` is there. TypeScript
// is refusing an unsound assignment, and it is right to.
//
// So `on()` below contains one assertion, and it is worth being exact about what
// makes it safe - because "I know better than the compiler" is how people end up
// with `undefined` in production.
//
// The invariant is that **the same pattern string produces both sides**. `on()`
// takes the literal `"/api/rooms/:room"` and computes the handler's parameter
// type from it. `match()` takes that same stored pattern and populates the
// params object from it, key for key. The two cannot drift, because there is
// only one pattern and it is the source of both.
//
// That is the trade a typed library makes: the unsafety is concentrated into one
// audited line *inside* the router, and every call site outside it is checked.
// The regex it replaces had the opposite arrangement - no assertion anywhere,
// and `named[1]` unverified at every call site that touched it. One assertion
// you can point at beats twenty you cannot.
type StoredHandler = (
  request: HttpRequest,
  params: Record<string, string>,
) => HttpResponse | Promise<HttpResponse>;

interface Route {
  readonly method: HttpMethod;
  readonly segments: readonly string[];
  readonly handler: StoredHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  // Generic over `P`, and `P extends string` with no default is what makes
  // TypeScript infer the *literal* "/api/rooms/:room" rather than widening it to
  // `string`. Widen it and PathParams<string> is `{}`, the parameters vanish, and
  // the whole exercise quietly stops working while still compiling.
  on<P extends string>(method: HttpMethod, pattern: P, handler: RouteHandler<P>): this {
    this.routes.push({
      method,
      segments: pattern.split("/"),
      // The one assertion in this module. See StoredHandler above for the
      // invariant that makes it safe - and note that it is *here*, once, in code
      // nobody has to touch again, rather than at every route that wanted a
      // parameter.
      handler: handler as StoredHandler,
    });
    return this;
  }

  // Does this route's shape fit this path, and if so what were the parameters?
  //
  // Runtime matching, which the types cannot do for us: this is the part that has
  // to look at an actual string that arrived over a socket. The types described
  // the *shape*; only this can say whether a given string has it.
  private capture(route: Route, parts: readonly string[]): Record<string, string> | undefined {
    if (route.segments.length !== parts.length) {
      return undefined;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i] ?? "";
      const part = parts[i] ?? "";

      if (segment.startsWith(":")) {
        if (part.length === 0) {
          return undefined; // ":room" must match *something*
        }
        // Percent-decoding happens here, once, rather than at every call site
        // that remembered to think about it.
        params[segment.slice(1)] = decodeURIComponent(part);
        continue;
      }

      if (segment !== part) {
        return undefined;
      }
    }

    return params;
  }

  // Returns undefined when nothing matched. What to do about that is the
  // caller's decision, not the router's - and it is not always a 404. See below.
  match(method: string, path: string): { handler: StoredHandler; params: Record<string, string> } | undefined {
    const parts = path.split("/");

    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }
      const params = this.capture(route, parts);
      if (params !== undefined) {
        return { handler: route.handler, params };
      }
    }

    return undefined;
  }

  // Which methods *would* have matched this path?
  //
  // Empty means the path is unknown, and that is a 404. Non-empty, but without
  // the verb that was asked for, means the path exists and the verb does not -
  // and that is a 405 with an `Allow` header, which is a different answer to a
  // different question. HTTP has always drawn this line; the if-chain this
  // replaces drew it by hand for `/api/echo` and nowhere else, which is the
  // usual fate of a rule that lives in one branch instead of in the structure.
  methodsFor(path: string): HttpMethod[] {
    const parts = path.split("/");
    const allowed = new Set<HttpMethod>();

    for (const route of this.routes) {
      if (this.capture(route, parts) !== undefined) {
        allowed.add(route.method);
      }
    }

    return [...allowed];
  }
}
