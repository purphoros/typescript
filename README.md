# Chapter 01 - Hello, TypeScript

Installing the toolchain, creating your first project, and understanding how TypeScript compiles to JavaScript.

> **Note**
>
> This guide teaches TypeScript to people who can already program in another language. It assumes you are comfortable using a terminal and understand basic ideas like variables, functions, and loops. It does not teach programming from scratch - if you are completely new to programming, learn the basics of JavaScript first, then come back here.

## Installing the Toolchain

TypeScript runs on Node.js. You need two things: the Node.js runtime (which includes `npm`, the package manager) and the TypeScript compiler (`tsc`). We'll also install `tsx`, a tool that compiles and runs TypeScript files in one step - no separate build needed during development.

Install Node.js from [nodejs.org](https://nodejs.org) (LTS version). Verify it's installed:

```bash
node --version    # v22.x or later
npm --version     # 10.x or later
```

Now create a project directory and initialize it:

```bash
mkdir chat-server
cd chat-server
npm init -y
```

`npm init -y` creates a `package.json` with defaults. This is your project manifest - it tracks dependencies, scripts, and metadata. Think of it like Rust's `Cargo.toml`.

Install TypeScript and tsx as dev dependencies:

```bash
npm install --save-dev typescript tsx @types/node
```

Three packages:

- `typescript` - the compiler (`tsc`). Checks types and compiles `.ts` files to `.js`.
- `tsx` - runs TypeScript directly. No compile step needed during development. Like `cargo run` for Rust.
- `@types/node` - type definitions for Node.js APIs (filesystem, networking, etc.). Without these, TypeScript doesn't know about `process`, `Buffer`, or any Node.js built-ins.

> **Warning**
>
> Installing `@types/node` is necessary but not sufficient. Current TypeScript does not pick the package up automatically - you must also list it in `tsconfig.json` under `"types": ["node"]`, which we do below. Skip that and `process` fails to compile with `TS2591: Cannot find name 'process'` even though the types are sitting in `node_modules`.

> **Tip**
>
> `--save-dev` (or `-D`) installs packages as development dependencies. They're needed for building but not for running in production. The compiled JavaScript doesn't need the TypeScript compiler.

## Understanding tsconfig.json

Create a `tsconfig.json` - the TypeScript compiler configuration. This file controls how TypeScript checks and compiles your code:

```bash
npx tsc --init
```

This generates a `tsconfig.json` with many commented-out options. Here's what matters for our project:

`tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

Key settings:

- `target: "ES2022"` - compile to modern JavaScript. Determines which JS features are available in the output.
- `module: "Node16"` - use Node.js's module system. Supports both CommonJS (`require`) and ES modules (`import`).
- `strict: true` - enables all strict type checking. This is the most important setting. It catches bugs that loose mode ignores: implicit `any`, null safety, and more. Always keep this on.
- `types: ["node"]` - loads the Node.js global declarations from `@types/node`. Without this, `process`, `Buffer`, and `setTimeout` are unknown to the compiler even though the package is installed, and any use of them fails with `TS2591: Cannot find name 'process'`. You don't need it for the first program, but every chapter from Chapter 5 onward touches Node's built-ins.
- `outDir: "dist"` - compiled JavaScript goes here. Source TypeScript stays in `src/`.
- `rootDir: "src"` - tells the compiler where to find source files. The directory structure under `src/` is mirrored in `dist/`.

> **Warning**
>
> Never turn off `strict`. It's the reason TypeScript exists. Without strict mode, TypeScript is just JavaScript with optional annotations - you lose most of the safety guarantees. Every example in this guide assumes strict mode is on.

## Your First Program

Create a `src` directory and your first TypeScript file:

```bash
mkdir src
```

`src/index.ts`

```typescript
const name: string = "TypeScript";
const port: number = 8080;

console.log(`Starting chat server...`);
console.log(`Server: ${name} on port ${port}`);
```

A few things to notice:

- `const name: string` - a type annotation. The `: string` after the variable name declares its type. TypeScript checks that only strings are assigned to it.
- `const port: number` - numbers in TypeScript are always 64-bit floats (like JavaScript). No `i32`, `u16` distinction like Rust.
- ``Template ${literals}`` - backtick strings with `${expr}` interpolation. Like Rust's `format!` but built into the string syntax.
- `console.log` - prints to stdout. The TypeScript equivalent of Rust's `println!`.

## Compiling and Running

There are two ways to run TypeScript: compile first then run the JavaScript, or use `tsx` to do both at once.

### Option 1: tsx (development)

```bash
npx tsx src/index.ts
```

`tsx` compiles and runs in one step. No `dist/` directory created. This is what you use during development - fast feedback, no build step. Like `cargo run`.

### Option 2: tsc + node (production)

```bash
npx tsc
node dist/index.js
```

`tsc` compiles all `.ts` files in `src/` to `.js` files in `dist/`. Then `node` runs the JavaScript. This is what you use for production - the compiled JS doesn't need TypeScript at runtime.

> **Note**
>
> TypeScript is erased at runtime. Type annotations, interfaces, and generics exist only during compilation - the output JavaScript has no trace of them. This means TypeScript has zero runtime overhead. The types are a development-time safety net, not a runtime cost.

## A Tour of Commands

Add these scripts to `package.json`:

`package.json (scripts section)`

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  }
}
```

### npm run dev

Runs with `tsx watch` - compiles, runs, and **watches for changes**. Every time you save a file, it restarts automatically. Your main development loop.

### npm run build

Compiles TypeScript to JavaScript in `dist/`. Type checks everything. Fails if there are type errors.

### npm start

Runs the compiled JavaScript. For production - no TypeScript tooling needed at runtime.

### npm run typecheck

Type-checks without producing output (`--noEmit`). Fast way to verify your code has no type errors. Like `cargo check`.

## Project Structure

Here's what your project looks like now:

```
chat-server/
├── package.json        ← project manifest (like Cargo.toml)
├── package-lock.json   ← pinned dependency versions (like Cargo.lock)
├── tsconfig.json       ← TypeScript compiler config
├── node_modules/       ← installed dependencies (auto-managed by npm)
├── src/
│   └── index.ts        ← your TypeScript source code
└── dist/               ← compiled JavaScript (created by tsc)
```

> **Tip**
>
> Add `node_modules/` and `dist/` to your `.gitignore`. `node_modules` is recreated by `npm install`. `dist` is recreated by `npm run build`. Neither belongs in version control.

## Exercise

1. Run `npx tsx src/index.ts` and verify you see the output.
2. Run `npx tsc` and find the compiled JavaScript in `dist/index.js`. Open it - notice the type annotations are gone. Run it with `node dist/index.js`.
3. Try assigning a number to the `name` variable. Read the compiler error - TypeScript tells you exactly what's wrong.
4. Run `npm run typecheck` to verify your code without compiling. Try introducing a type error and see it caught.
5. Set up `npm run dev` with `tsx watch`. Edit your file and watch it restart automatically.

## What's Next

You have a working TypeScript project with a compiler, a runner, and a type checker. The toolchain is in place and you know how to build, run, and check code.

In the next chapter, we'll cover the language fundamentals - variables, types, functions, and control flow - the building blocks you'll need before we start writing any networking code.

---

Source: <https://purphoros.com/howto/typescript/hello-typescript>
