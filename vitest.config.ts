import { defineConfig } from "vitest/config";

export default defineConfig({
  // This file exists because of Chapter 18, and the reason is worth knowing.
  //
  // Vitest transforms TypeScript with esbuild, whose default target is `esnext`.
  // `esnext` is assumed to support decorators *natively*, so esbuild helpfully
  // leaves `@timed` exactly where it found it. Node 22 does not support
  // decorators natively. The emitted JavaScript therefore contains a literal
  // `@timed`, and the entire suite dies with:
  //
  //     SyntaxError: Invalid or unexpected token
  //
  // - no file, no line, no clue. It took bisecting the import graph to find that
  // the offending token was a feature we deliberately added one chapter ago.
  //
  // Naming a target that does *not* have decorators tells esbuild to compile them
  // away, which is what `tsc` has been doing for `npm run build` all along. The
  // build and the tests now agree about what the language is - and *that* is the
  // actual lesson: your test runner does not necessarily compile your code the
  // same way your compiler does.
  esbuild: { target: "es2022" },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
