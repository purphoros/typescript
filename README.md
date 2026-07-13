# Chapter 25 - Packaging & Deployment

Everything between `npm run build` and a machine somebody else can reach.

## What this repository was about to publish

```
  119 files, 610kB unpacked
    .ts source (incl. 11 tests):  55
    .claude/ settings:            1
    build tooling + configs:      6
```

Fifty-five TypeScript files - the entire source tree, tests and all - that nobody consuming this package can run. My editor's local settings. The Dockerfile, the CI workflow, both tsconfigs. All of it, to npm, forever - because `npm publish` ships **everything not excluded**, and nobody had ever told it what to exclude.

An **allow-list**, not a deny-list:

```json
"files": [
  "dist/**/*.js",
  "dist/**/*.d.ts",
  "!dist/**/*.test.*",
  "README.md"
]
```

```
  68 files, 297kB unpacked
    test files: 0
    .claude:    0
```

The distinction matters more than the numbers. A deny-list is a promise to think of everything in advance, forever, including the file you will add next March. An allow-list is a promise to think of what you meant - and the failure mode of forgetting is that something is *missing*, which you find out immediately, rather than *present*, which you find out from a security researcher.

## Two configs, because a test is code

Excluding tests from `tsconfig.json` stops 33 `.test.js` files landing in `dist/`. It also, silently, stops them being typechecked - and **code that does not typecheck is code that is lying to you.**

```json
// tsconfig.check.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

`tsconfig.json` builds what ships. `tsconfig.check.json` checks everything and emits nothing, and it is what `npm run typecheck` actually runs. Proof that it works, obtained by breaking it on purpose:

```
src/security.test.ts(91,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

## One command, four gates

```json
"verify": "npm run typecheck && npm run test && npm run build",
"prepublishOnly": "npm run verify"
```

In that order, because that is the order they get *cheaper to fix* in. And `prepublishOnly` is npm's own hook: **a broken build cannot be published by accident, because the accident is the thing it exists to prevent.**

## The container

```dockerfile
FROM node:22-slim AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
RUN npm run verify
RUN npm ci --omit=dev

FROM node:22-slim AS run
USER node
COPY --from=build --chown=node:node /app/dist ./dist
```

Four things in there are load-bearing.

**The manifest is copied before the source.** This is not tidiness, it is the layer cache. Docker reuses a layer when its inputs have not changed - so copying `src/` in *before* `npm ci` means every one-character edit re-downloads every dependency. Copy the manifest, install, *then* copy the source, and a typo re-runs the last two steps instead of the four-minute one.

**`npm ci`, not `npm install`.** `ci` installs exactly the lockfile - the same bytes, every machine, forever - and fails loudly if `package.json` and the lockfile disagree. `install` is allowed to *resolve*, which means a build that worked this morning may quietly pick up a new patch release this afternoon. **A reproducible build is not reproducible if it is allowed to go shopping.**

**`npm run verify` runs inside the image.** It is tempting to build the artefact in CI and copy it in - and then the thing you tested is not the thing you shipped. The container is the unit. Test the unit.

**`USER node`.** The `node` user ships with the image and is *not used by default*, which is a choice Docker made and you should not accept. A process that does not need to write to `/etc` should not be able to - and "did not need to" is not a defence available to a process running as uid 0. It also means the container cannot install packages, cannot bind below port 1024, and cannot chown its way out of trouble: all things a chat server has no business doing and an attacker very much does.

And the second stage has **no compiler and no package manager.** An attacker with code execution in a container that has both has a workshop. One with neither has a JavaScript runtime and a chat server, and has to bring their own tools through a door we are watching.

### `0.0.0.0`, not `127.0.0.1`

```dockerfile
ENV HOST=0.0.0.0
```

Inside a container, `127.0.0.1` means *this container*. A port published to the host connects to nothing at all, and this is the single most common reason a containerised server appears to start perfectly and then refuses every connection.

Chapter 20 made this an environment variable so it could be changed without touching code. Here is that decision being cashed.

## Folklore I had written down before I checked it

The Dockerfile says `CMD ["node", "dist/main.js"]`, not `npm start`, and I wrote a confident paragraph explaining why: **npm does not forward SIGTERM**, so a container running `npm start` never runs its shutdown handler, silently loses whatever is in the write queue, and is SIGKILLed ten seconds later.

Chapter 12 built a shutdown that flushes to disk. Chapter 15 wired it to SIGTERM specifically so it would survive a deploy. So I tested it, because I wanted to watch it fail:

```bash
$ npm start &
$ kill -TERM <the npm pid>

{"level":"info","msg":"Shutting down"}
{"level":"info","msg":"History flushed. Goodbye."}
```

**It forwarded the signal.** npm 10 does this. The shutdown ran, the database flushed, nothing was lost. The folklore is out of date, and I had written the comment before I checked - which is exactly the habit this tutorial has spent twenty-five chapters arguing against.

The exec form is still right, for smaller and duller reasons: one process instead of three, faster start, PID 1 is the thing you want to be PID 1, and it does not depend on an npm version's signal handling staying correct forever.

But **check your own folklore.** Some of it has expired.

## The warning that broke the log format

Running the container's exact environment turned up something no test would have:

```
(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time
{"level":"info","time":"...","msg":"listening",...}
```

`node:sqlite` prints that on **every boot**, and it is the first line the process emits. Chapter 20 went to some trouble to make the logs one-JSON-object-per-line, and line one is not JSON. A log pipeline that assumes it is will drop it, or mangle the next one, or fall over.

```dockerfile
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
```

**Not `--no-warnings`.** That would also silence the deprecation notice telling you an API you depend on is going away, which is a warning you *want* shouted at you. Silence the one you have read and understood. Keep the ones you have not.

## The health check is a liveness check

```dockerfile
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1))"
```

It asks whether the event loop is turning. It does **not** ask whether the database is happy, and that is deliberate.

A health check that fails when a downstream dependency is down will take a perfectly healthy server out of rotation because *something else* broke - and then the load balancer will send its traffic to the remaining servers, which will also fail their checks, and you will have converted a degraded dependency into a total outage. **A liveness check answers "should you restart me", not "is everything fine".**

## .dockerignore, and the two entries that matter

```
.env
.git
```

**`.env`** would be baked into an image layer forever. Deleting it in a later `RUN` does not remove it - layers are immutable, and anybody with the image can read it back out. There is no un-committing a secret into a container image.

**`.git`** is the entire history of the repository, including every secret anybody has ever committed and then removed. Shipping it is how a rotated key gets un-rotated.

## What I did not verify, and will not pretend I did

**Docker is not available in the environment I built this in. I have not built this image, and I have not run it.**

That is an unusual thing to admit at the end of a tutorial whose entire method has been *run it and see*. It is also the only honest thing to write, and the alternative - a chapter that says "and it works!" about something I did not execute - would undo whatever the previous twenty-four chapters were worth.

What I *did* verify is everything the container depends on, by running it directly:

| | |
|---|---|
| `npm run verify` - the `RUN` step in the build stage | ✓ passes |
| `dist/main.js` exists and is the `CMD` target | ✓ |
| the exact `HEALTHCHECK` command | ✓ exits 0 |
| `HOST=0.0.0.0` binds and answers | ✓ 200 |
| `DATA_DIR` - the volume mount point - is honoured | ✓ `chat.db` written there |
| `LOG_FORMAT=json` produces parseable line 1 | ✓ (after the warning fix) |
| `NODE_ENV=production` with no `JWT_SECRET` refuses to start | ✓ exit 1 |
| SIGTERM flushes the database before exit | ✓ "History flushed. Goodbye." |
| the published package contains no tests, docs, or settings | ✓ 68 files |

The Dockerfile is a **hypothesis** built out of verified parts. Run `docker build .` and find out. If it is wrong, it will be wrong in a way that takes ninety seconds to fix - and you will know, which is the whole point.

## Putting It Together

`Dockerfile`

```dockerfile
# A container that ships what runs, and nothing else.
#
# Two stages. The first one has TypeScript, vitest, the source, the tests, and
# every devDependency; the second one has none of it. What crosses between them is
# `dist/` and the production node_modules, and nothing else can - not because we
# remembered to delete it, but because it was never in the final image to delete.
#
# The security argument is the whole point. An attacker who gets code execution in
# a container with a compiler and a package manager has a workshop. One with
# neither has a JavaScript runtime and a chat server, and has to bring their own
# tools through a door we are watching.

# --- build ---------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# package.json and the lockfile first, *before* the source.
#
# This is not tidiness, it is the layer cache. Docker reuses a layer when its
# inputs have not changed, so copying the source in before installing means every
# one-character edit re-downloads every dependency. Copy the manifest, install,
# and then copy the source, and a change to a .ts file re-runs the last two steps
# and not the four-minute one.
COPY package.json package-lock.json ./

# `npm ci`, not `npm install`. `ci` installs exactly the lockfile - the same bytes
# every time, on every machine, forever - and fails loudly if package.json and the
# lockfile disagree. `install` is allowed to *resolve*, which means a build that
# worked this morning may quietly pick up a new patch release this afternoon, and
# a reproducible build is not reproducible if it is allowed to shop.
RUN npm ci

COPY tsconfig.json tsconfig.check.json ./
COPY src ./src

# Typecheck, test, build. In the image.
#
# It is tempting to build the artefact in CI and copy it in - and then the thing
# you tested is not the thing you shipped. The container is the unit; test the
# unit.
RUN npm run verify

# Now throw away everything that is not needed to run. `--omit=dev` re-resolves
# node_modules with the devDependencies left out: no TypeScript, no vitest, no
# esbuild.
RUN npm ci --omit=dev

# --- run -----------------------------------------------------------------
FROM node:22-slim AS run

# Not root.
#
# The `node` user ships with the image and it is not used by default, which is a
# choice Docker made and you should not accept. A process that does not need to
# write to /etc should not be able to, and "did not need to" is not a defence
# available to a process running as uid 0.
#
# It also means the container cannot install packages, cannot bind to a port below
# 1024, and cannot chown its way out of trouble - all of which are things a chat
# server has no business doing and an attacker very much does.
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production

# Logs go to stdout, as JSON, because `defaultFormat()` sees that stdout is not a
# TTY and decides for itself. Chapter 20 built that so nobody would have to
# remember this line - and here is the line not being needed.
ENV LOG_FORMAT=json

# The data directory is a volume. A container is *cattle* - you kill it and start
# another - and anything you care about that lives inside its filesystem dies with
# it. The SQLite file must be somewhere that outlives the container that wrote it.
ENV DATA_DIR=/home/node/app/data
VOLUME ["/home/node/app/data"]

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

# 0.0.0.0, not 127.0.0.1.
#
# Inside a container, 127.0.0.1 means "this container", and a port published to
# the host will connect to nothing at all. It is the single most common reason a
# containerised server appears to start perfectly and refuse every connection.
ENV HOST=0.0.0.0
ENV PORT=8080

# The health check the load balancer will use, and the one Chapter 15 built.
#
# It is a *liveness* check: it asks whether the event loop is turning, not whether
# the database is happy. A health check that fails when a downstream dependency is
# down will take a perfectly healthy server out of rotation because something else
# broke, and then the retries will take out the rest of them.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# `node dist/main.js`, not `npm start` - and the usual reason given for this is
# now wrong, which is worth more than the advice.
#
# The folklore says npm does not forward SIGTERM, so a container running
# `npm start` never runs its shutdown handler, silently loses whatever was in the
# write queue, and gets SIGKILLed ten seconds later. That *was* true. I tested it,
# because Chapter 12 built a shutdown that flushes to disk and Chapter 15 wired it
# to SIGTERM precisely so it would survive a deploy, and I wanted to watch it work:
#
#     $ npm start &        $ kill -TERM <npm>
#     {"level":"info","msg":"Shutting down"}
#     {"level":"info","msg":"History flushed. Goodbye."}
#
# npm 10 forwards the signal. The shutdown ran. The folklore is out of date, and I
# had written the comment before I checked, which is exactly the habit this tutorial
# has spent twenty-five chapters arguing against.
#
# The exec form is still right, for smaller and duller reasons: it is one process
# instead of three, it starts faster, PID 1 is the thing you actually want to be
# PID 1, and it does not depend on an npm version's signal handling being correct
# forever. But *check your own folklore*. Some of it expired.
#
# --disable-warning=ExperimentalWarning, and only that one.
#
# node:sqlite prints an ExperimentalWarning on every boot, to stderr, and it is the
# first line the process emits. Chapter 20 went to some trouble to make the logs
# machine-parseable - one JSON object per line - and then line one is
# `(node:1) ExperimentalWarning: SQLite is an experimental feature`, which is not
# JSON, and a log pipeline that assumes it is will drop or mangle it.
#
# Not `--no-warnings`. That would also silence the deprecation notice telling you
# an API you depend on is going away, which is a warning you want to be shouted at
# about. Silence the one you have read and understood; keep the ones you have not.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/main.js"]
```

`.github/workflows/ci.yml`

```yaml
# The gate.
#
# Nothing here is clever. Its whole job is to run, on somebody else's machine, the
# thing that passed on yours - and to fail before a broken commit reaches a branch
# anybody else pulls.
name: ci

on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          # The version the Dockerfile runs and the version `engines` requires.
          # A CI that tests on a Node the production image does not have is a CI
          # that tells you about a different program.
          node-version: 22
          cache: npm

      # `ci`, not `install`. Exactly the lockfile, every time - and it fails if
      # package.json and package-lock.json disagree, which is the single most
      # common way a green CI ships a red container.
      - run: npm ci

      # Typecheck (including the tests, via tsconfig.check.json), then the tests,
      # then the build. In that order, because that is the order they get faster to
      # fix in.
      - run: npm run verify

      # The package as it would actually be published. This is the step that would
      # have caught the entire test and source tree being shipped
      # to npm, which is exactly what this repository was doing until Chapter 25.
      - name: check what would be published
        run: |
          npm pack --dry-run
          test "$(npm pack --dry-run --json | jq '[.[0].files[] | select(.path | test("\\.test\\."))] | length')" -eq 0 \
            || (echo "test files in the package" && exit 1)

  container:
    runs-on: ubuntu-latest
    needs: verify

    steps:
      - uses: actions/checkout@v4

      # Build the image. The Dockerfile runs `npm run verify` inside itself, so
      # this tests the artefact that ships rather than one that resembles it.
      - run: docker build -t chat-server:ci .

      # And then actually start it, because an image that builds is not an image
      # that runs. This is the cheapest possible smoke test and it catches the
      # embarrassing ones: a missing file, a bad CMD, a server that binds to
      # 127.0.0.1 inside a container and answers nobody.
      - name: it starts, and it answers
        run: |
          docker run -d --name chat -p 8080:8080 \
            -e JWT_SECRET=ci-secret-not-a-real-one \
            chat-server:ci
          for i in $(seq 1 20); do
            curl -sf localhost:8080/api/health && break || sleep 1
          done
          curl -sf localhost:8080/api/health | jq -e '.pid and .rooms'
          docker rm -f chat
```

## Try It

```bash
npm run verify        # typecheck (incl. tests), test, build
npm pack --dry-run    # exactly what would be published
```

```bash
docker build -t chat-server .
docker run -p 8080:8080 -e JWT_SECRET=$(openssl rand -hex 32) -v chat-data:/home/node/app/data chat-server
```

And in front of it, in production, the thing this chapter does **not** contain: something that terminates TLS. nginx, Caddy, a cloud load balancer - anything. Chapter 24 said it and it is still true: **everything in this tutorial is defending a plaintext connection**, and `ws://` means every password crosses the network in the clear. TLS belongs at the edge, and the edge is not this program.

## Exercise

1. Delete `"files"` from `package.json` and run `npm pack --dry-run`. Read the list. That is what you were about to publish under your own name.
2. Move `COPY src ./src` above `RUN npm ci` and time two builds with a one-character change between them. That is what the layer cache is worth.
3. Remove `USER node`. Now `docker exec` into the container and `npm install` something. That is what an attacker with code execution just got.
4. Make `/api/health` fail when the database is unreachable. Now take the database down and watch every replica get pulled out of rotation at once. Put it back.
5. `--disable-warning=ExperimentalWarning` silences a warning that is telling you something true: `node:sqlite` is experimental and its API may change. Write down what you will do when it does - and notice that Chapter 21's `MessageStore` interface is most of the answer.

## What's Next

Nothing. This is the end of the tutorial.

The server is a program with a shape. One port, three protocols. A wire format that is checked at compile time and validated at runtime from a single schema. An error boundary that has never once let a stranger's typo take the process down. History in a real database, with an index, and migrations that refuse to run backwards. Passwords that are slow on purpose, tokens that cannot be forged, and a door that is shut - including the one that had been open since Chapter 7. A heartbeat that notices the dead. Logs a machine can read and that do not contain anybody's password. A hundred and eleven tests, two of which exist because the tutorial shipped the bug first and had to go back for it.

It also has four things wrong with it that Chapter 24 lists by name, a timing side-channel the test suite cannot see, and a Dockerfile I have not run.

That is not a failure of the method. **That is the method.** The measure of a codebase is not that it has no problems; it is whether it can tell you what they are.

---

Written for this repository. Upstream: <https://purphoros.com/howto/typescript/deployment>
