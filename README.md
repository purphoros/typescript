# Chapter 18 - Decorators & Metadata

Add behaviour to classes and methods declaratively. Decorators are TypeScript's metaprogramming tool - the machinery behind NestJS, Angular and TypeORM.

This chapter's own advice, further down, is that our chat server wants **middleware**, not decorators. That advice is correct, and this chapter takes it: the Chapter 17 chain stays exactly where it is. What follows is decorators used for the one thing they are genuinely better at - and an honest account of what they cost.

## Standard decorators, not the ones in most tutorials

Nearly every decorator tutorial - including this chapter's first listing - shows you this:

```typescript
function log(target: any, key: string, descriptor: PropertyDescriptor) {
  const original = descriptor.value;
  descriptor.value = function (...args: any[]) { ... };
}
```

That is the **legacy** decorator. It requires `"experimentalDecorators": true`, it is built on a TC39 proposal that was **abandoned**, and it has `any` in it twice - which Chapter 3 had opinions about.

TypeScript 5.0 ships the **standard** decorator: Stage 3, on its way into JavaScript itself, **no compiler flag**, and properly typed.

```typescript
function logged<T, A extends unknown[], R>(
  original: (this: T, ...args: A) => R,
  context: ClassMethodDecoratorContext<T, (this: T, ...args: A) => R>,
): (this: T, ...args: A) => R {
  return function (this: T, ...args: A): R {
    console.log(`-> ${String(context.name)}(${args.join(", ")})`);
    const result = original.apply(this, args);
    console.log(`<- ${String(context.name)} returned ${String(result)}`);
    return result;
  };
}

class Calculator {
  @logged
  add(a: number, b: number): number { return a + b; }
}
```

A decorator is just a **function that receives the method and returns a replacement**. No `descriptor`, no mutation, no `any` - and the compiler now checks that the decorator is applied to a method whose shape it can actually handle.

> **Note**
>
> `context.name` is the method's own name, supplied by the runtime. That is the whole "metadata" story for our purposes, and it matters more than it looks: rename the method and the metric renames itself. No stringly-typed duplication to drift.
>
> This project's `tsconfig.json` has **no** `experimentalDecorators`, and both `tsc` and `tsx` (esbuild) run the above as written. Verify it yourself before you take my word for it - esbuild's support for standard decorators is newer than its support for the legacy ones, and a tutorial from 2022 will tell you it does not work.

## Where they actually earn their keep here

Chapter 15 gave the server the ability to notice that it was slow. It gave it **no way at all to notice what was slow.**

That is a cross-cutting concern attached to specific methods - which is precisely the criterion this chapter names for reaching for a decorator. So:

```typescript
@timed("history")
append(message: MessageSummary): Promise<void> { ... }

@timed("history")
async read(room: RoomName): Promise<MessageSummary[]> { ... }

@timed("accounts")
async login(name: string, password: string): Promise<Result<Account, ChatError>> { ... }
```

Three lines. Nothing inside `FileHistory` or `Accounts` learned what a metric is, and `/api/health` grew a section:

```json
"operations": {
  "history.read":   { "count": 4, "failures": 0, "meanMs": 0.25,  "maxMs": 0.39 },
  "history.append": { "count": 5, "failures": 0, "meanMs": 1.36,  "maxMs": 1.42 },
  "accounts.login": { "count": 2, "failures": 0, "meanMs": 28.46, "maxMs": 28.85 }
}
```

That `28.46ms` is scrypt being slow **on purpose**. Which means this number is now a security tripwire: if `accounts.login.meanMs` ever drops toward zero, somebody has "optimised" the password hash and the passwords are no longer safe.

## The bug in almost every hand-rolled @timed

```typescript
const started = performance.now();
const result = original.apply(this, args);
this.metrics.record(label, performance.now() - started, true);   // WRONG
return result;
```

If the method is `async`, **it has not finished**. It has handed back a Promise, and that subtraction measures how long it took to *start* - which is approximately zero and completely useless. This is the single most common bug in decorators people write themselves, and its symptom is beautiful sub-millisecond timings for operations that take a second.

So: if you got a Promise, measure when it **settles**.

```typescript
if (result instanceof Promise) {
  const measured = result.then(
    (value: unknown) => { this.metrics.record(label, elapsed(), true);  return value; },
    (thrown: unknown) => { this.metrics.record(label, elapsed(), false); throw thrown; },
  );
  return measured as R;
}
```

The `as R` is the one assertion in the file. Inside that branch we have *proved* `R` is a Promise - but TypeScript cannot narrow a generic type **parameter** from an `instanceof` on its value; `R` is still `R`. The cast restates what the branch just established. (Chapter 13's bargain, one more time: one line you can point at.)

## The awkward truth nobody mentions

**A decorator runs at class-definition time, when no instance exists.** It cannot be handed a dependency.

That leaves three options: reach for a global (and Chapter 11 spent a chapter arguing against exactly that), take the dependency as an argument (at which point it is not really a decorator), or **require the instance to carry it**.

We require the instance to carry it, and we make the compiler enforce it:

```typescript
export interface Measured {
  readonly metrics: Metrics;
}

export function timed<T extends Measured, A extends unknown[], R>(subject: string) { ... }
```

Put `@timed` on a class with no `metrics` field and it does not compile. The dependency is still injected - `new FileHistory(config.dataDir, this.metrics)` - the decorator simply reads it off `this`.

That is a real constraint, and it is worth saying plainly: **a decorator is coupled to the shape of the thing it decorates.** Middleware is not. That is most of the argument between them.

## The failure a decorator cannot see

Look again at the output above:

```
"accounts.login": { "count": 2, "failures": 0, ... }
```

**One of those two logins was wrong.** The password was `"wrong"`, the server refused it, and the decorator recorded a success.

It is not a bug in the decorator. `login()` returns a `Result<Account, ChatError>` - Chapter 10's whole point was that an *expected* failure is a **value**, not an exception. So the method returned normally, carrying a failure inside it, and `@timed` - which watches for throws - saw a function that worked.

Two good decisions, meeting, and producing a wrong number.

This is what cross-cutting abstractions cost: `@timed` knows about *methods*, and it does not know about *your* idea of failure. To count those, it would have to be taught what a `Result` is - and now it is not a general-purpose decorator any more, it is a `Result`-aware decorator, and the seam has leaked. There is no clever fix. There is only knowing.

## Decorators vs Middleware

| | Decorators | Middleware |
|---|---|---|
| Attached to | a specific method, at definition time | a pipeline, at runtime |
| Order | fixed by source position | a list you can reorder |
| Dependencies | must come off `this` or a global | passed in, ordinarily |
| Composes over | one class's methods | anything with the same signature |
| Knows about | the method's shape | the message's shape |

The Chapter 17 chain - `rateLimit → requireAuth → handler` - stays. It processes a **stream of messages**, its behaviour is independent of any class, and the order is an argument we wanted to be able to have at runtime. Rewriting it as decorators would fix its order at source position, couple every check to the handler class, and buy nothing.

`@timed` goes on methods, because it is *about* methods.

> **Tip**
>
> The honest test: **can this behaviour be reordered, or turned off, at runtime?** If yes, it is middleware. If it is inherent to the method - "this method is the one that touches the disk, and touching the disk is worth timing" - it is a decorator. If you find yourself building a registry so that decorators can be composed and reordered, you have written middleware with worse error messages.

## Putting It Together

`src/decorators.ts`

```typescript
// Decorators, and an honest account of where they belong.
//
// This chapter's own advice - and it is right - is that our chat server wants
// *middleware*, not decorators. Chapter 17 built a chain, `rateLimit →
// requireAuth → handler`, and it is the correct shape: we process a stream of
// messages, the behaviour is independent of any class, and the order has to be
// changeable at runtime. None of that is what a decorator is for, and rewriting
// it as one would be a downgrade with better branding.
//
// So this file does not replace the middleware. It does the thing decorators are
// genuinely good at, which the chapter names precisely: **cross-cutting behaviour
// attached to a specific method**.
//
// Chapter 15 gave the server the ability to notice it was slow. It gave it no
// way at all to notice *what* was slow. `@timed` wraps the handful of operations
// that can actually take time - scrypt, by design; the disk, by nature - and
// nothing about FileHistory or Accounts had to learn what a metric is.

import { performance } from "node:perf_hooks";
import type { Metrics } from "./runtime.js";

// --- Standard decorators, not legacy ones --------------------------------
//
// Nearly every decorator tutorial you will find - including this chapter's own
// first listing - shows you this:
//
//     function log(target: any, key: string, descriptor: PropertyDescriptor)
//
// That is the **legacy** decorator, it requires `"experimentalDecorators": true`
// in tsconfig, and it is built on a TC39 proposal that was abandoned. It also
// has `any` in it twice, which Chapter 3 had opinions about.
//
// TypeScript 5.0 ships the **standard** decorator - Stage 3, on its way into
// JavaScript itself, no compiler flag required, and properly typed. That is what
// this file uses. It reads a little stranger and it is worth it: the signature
// below has no `any` anywhere, and the compiler checks that a decorator is
// applied to a method whose shape it can actually handle.

// What a class must provide before it may be @timed.
//
// This is the awkward truth about decorators, and the chapter does not mention
// it: a decorator runs at *class definition* time, when no instance exists, so it
// cannot be handed a dependency. It has three options - reach for a global, take
// the dependency as an argument (and then it is not really a decorator), or
// require the instance to carry it.
//
// We require the instance to carry it. `T extends Measured` is the compiler
// enforcing that: put `@timed` on a class with no `metrics` field and it does not
// compile. The dependency is still injected - Chapter 11's rule holds, no
// singletons - the decorator simply reads it off `this`.
export interface Measured {
  readonly metrics: Metrics;
}

export function timed<T extends Measured, A extends unknown[], R>(subject: string) {
  return function decorate(
    original: (this: T, ...args: A) => R,
    context: ClassMethodDecoratorContext<T, (this: T, ...args: A) => R>,
  ): (this: T, ...args: A) => R {
    // `context.name` is the method's own name, supplied by the runtime. No
    // stringly-typed duplication: rename the method and the metric renames itself.
    const label = `${subject}.${String(context.name)}`;

    return function timedMethod(this: T, ...args: A): R {
      const started = performance.now();
      const elapsed = (): number => performance.now() - started;

      let result: R;
      try {
        result = original.apply(this, args);
      } catch (thrown: unknown) {
        // Threw synchronously.
        this.metrics.record(label, elapsed(), false);
        throw thrown;
      }

      // And here is the part every decorator tutorial quietly skips.
      //
      // If the method is `async`, it has not finished - it has handed back a
      // Promise, and `elapsed()` right now would measure how long it took to
      // *start*, which is approximately zero and completely useless. Almost every
      // hand-rolled @timed decorator in the wild has this bug, and it reports
      // beautiful sub-millisecond timings for operations that take a second.
      //
      // So: if we got a Promise, measure when it settles.
      if (result instanceof Promise) {
        const measured = result.then(
          (value: unknown) => {
            this.metrics.record(label, elapsed(), true);
            return value;
          },
          (thrown: unknown) => {
            this.metrics.record(label, elapsed(), false);
            throw thrown;
          },
        );
        // The one assertion. `R` is known to be a Promise inside this branch, but
        // TypeScript cannot narrow a *generic* type parameter by an instanceof on
        // its value - R is still R. The cast restates what the branch just proved.
        return measured as R;
      }

      this.metrics.record(label, elapsed(), true);
      return result;
    };
  };
}
```

## Try It

```bash
npm run build && npm start
```

```json
{"type":"login","name":"alice","password":"correct-horse"}
{"type":"auth","token":"..."}
{"type":"join","room":"general"}
{"type":"chat","text":"hello"}
```

```bash
curl -s http://127.0.0.1:8080/api/health | jq .operations
```

Then break the decorator on purpose. Delete the `instanceof Promise` branch, restart, and watch `history.append` report `0.01ms` for a disk write. That is the number you would have shipped, and the dashboard would have looked wonderful.

## Exercise

1. Delete the `result instanceof Promise` branch and compare `/api/health` before and after. Which of the two numbers would you have believed?
2. `@timed` reports `failures: 0` for a rejected login, because `login()` returns a `Result`. Fix it. Now ask whether `@timed` is still a general-purpose decorator, and what you gave up.
3. Write `@retry(3)` for `FileHistory.append`. Then work out how it interacts with the `Serializer` (Chapter 12) that guarantees ordering - does a retried write still land in the right place?
4. Put `@timed` on a class with no `metrics` field. Read the error. That is `T extends Measured` doing its job.
5. Reimplement `requireAuth` from Chapter 17 as a decorator on `handleMessage`. You will need the session store - which is on the instance, so it works. Now try to reorder it relative to `rateLimit` without editing the source. That is the whole chapter in one exercise.

## What's Next

Every chapter of this tutorial has ended with me running the server, opening `nc`, typing JSON at it, and reading what came back. That worked, and it does not scale, and - as Chapter 17 exercise 2 pointed out - it would never have caught a timing side channel anyway.

Chapter 11 promised this. `MessageHandler` takes a `ChatClient`, which is an interface; `Registry` is a class you can construct; the whole chat rule set can be driven by a fake client that pushes onto an array. We have been building toward being able to test this thing without a socket for eight chapters.

Next: **testing** - and collecting on that promise.

---

Source: <https://purphoros.com/howto/typescript/decorators>
