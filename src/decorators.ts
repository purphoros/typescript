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
