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
