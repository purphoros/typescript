// A typed event emitter.
//
// Node's own EventEmitter is stringly-typed: `emit("mesage", x)` compiles, and
// so does `emit("message")` with no arguments at all. You find out at runtime,
// if you ever find out. Generics fix that: the emitter is parameterised by a
// map of event name → handler signature, and both `on` and `emit` are checked
// against it.

// The constraint every event map must satisfy: names to handler functions.
//
// The parameters are `never[]` rather than `any[]` on purpose. `any` would
// switch off checking for anyone who writes a handler; `never[]` accepts every
// concrete signature (parameters are contravariant, and `never` is assignable
// to anything) while still refusing a non-function. It is the one-line way to
// say "some function, I don't care which" without reaching for `any`.
export type EventMap = Record<string, (...args: never[]) => void>;

// A listener as stored internally: we have deliberately forgotten its exact
// signature, because a single Set holds all listeners for one event name.
type StoredListener = (...args: never[]) => void;

export class TypedEmitter<T extends EventMap> {
  private readonly listeners = new Map<keyof T, Set<StoredListener>>();

  // `K extends keyof T` ties the handler to the event: pass "message" and the
  // compiler demands exactly T["message"], with its parameter names and types.
  on<K extends keyof T>(event: K, listener: T[K]): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off<K extends keyof T>(event: K, listener: T[K]): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  // Fires once, then unsubscribes itself.
  once<K extends keyof T>(event: K, listener: T[K]): this {
    const wrapper = ((...args: Parameters<T[K]>): void => {
      this.off(event, wrapper);
      listener(...(args as Parameters<T[K]> & never[]));
    }) as T[K];
    return this.on(event, wrapper);
  }

  // `Parameters<T[K]>` extracts the argument tuple of the handler. If the map
  // says `message: (msg: ChatMessage) => void`, then emit("message", ...) will
  // accept exactly one ChatMessage - no more, no fewer, no other type.
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
    const set = this.listeners.get(event);
    if (set === undefined || set.size === 0) {
      return false;
    }
    // Copy first: a listener may unsubscribe itself (see `once`) while we are
    // iterating, and mutating a Set mid-iteration is how you skip a listener.
    //
    // The cast is the one place the types are re-asserted. It is safe by
    // construction: `on` only ever admits a T[K] under this key, so everything
    // in this Set takes exactly these arguments. The narrowing is real, it is
    // just not something the compiler can track through a heterogeneous Map.
    for (const listener of [...set]) {
      (listener as (...a: Parameters<T[K]>) => void)(...args);
    }
    return true;
  }

  listenerCount(event: keyof T): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: keyof T): this {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
    return this;
  }
}

// A fixed-capacity buffer: pushing past the limit drops the oldest item.
//
// Generic because the container has no opinion about its contents - the rooms
// use it for messages, but nothing here knows what a message is.
export class RingBuffer<T> {
  private items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  // The last `count` items, oldest first.
  recent(count: number = this.capacity): readonly T[] {
    return this.items.slice(-count);
  }

  get size(): number {
    return this.items.length;
  }

  get last(): T | undefined {
    return this.items[this.items.length - 1];
  }
}

// Pull one property out of every item. `K extends keyof T` means the key must
// actually exist on T, and the return type follows: pluck(rooms, "name") gives
// string[], and pluck(rooms, "nmae") does not compile.
export function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}
