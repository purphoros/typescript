// Configuration, and the one decision it has to make out loud.

import { parsePort, type RoomName } from "./protocol.js";
import { EnvSchema } from "./schemas.js";
import type { Host, Port } from "./types.js";

// `Readonly<T>` marks every property immutable, so nothing can reassign the
// config after startup.
export type ServerConfig = Readonly<{
  host: Host;
  port: Port;
  rooms: readonly RoomName[];
  historyLimit: number;
  dataDir: string;
  // Rooms are created on demand (Chapter 16), which means a stranger can create
  // them. Chapter 15's rule applies: anything a stranger can grow, bound.
  maxRooms: number;
}>;

// `as const` gives every field its literal type and makes the object readonly:
// DEFAULTS.port has type 8080, not number, and cannot be reassigned.
export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8080,
  rooms: ["general", "random", "dev"],
  // How many messages a room keeps in memory. Beyond this, a history request
  // goes to disk - which is the whole reason Chapter 12 has anything to await.
  historyLimit: 50,
  dataDir: "data",
  maxRooms: 100,
} as const;

// A client that connects and says nothing is assumed to be a human at a
// terminal, and gets greeted. curl and browsers send their request at once.
export const GREETING_DELAY_MS = 200;

// How much history a joining client is shown.
export const HISTORY_ON_JOIN = 5;

// `Partial<T>` makes every property optional, which is exactly what an override
// is: supply the fields you care about, inherit the rest.
export function configure(base: ServerConfig, overrides: Partial<ServerConfig>): ServerConfig {
  return { ...base, ...overrides };
}

// A bad port on the command line is an expected failure - humans type things -
// so parsePort hands back a Result and we deal with it here, in the open.
export function resolvePort(argument: string | undefined): Port {
  if (argument === undefined) {
    return DEFAULTS.port;
  }
  const parsed = parsePort(argument);
  if (!parsed.ok) {
    console.error(`${parsed.error.message} Falling back to ${DEFAULTS.port}.`);
    return DEFAULTS.port;
  }
  return parsed.value;
}

export function address(host: Host, port: Port): string {
  return `${host}:${port}`;
}

// Where the settings actually come from, in order of who wins.
//
//   argv    what you typed just now, for this one run
//   env     what this deployment always wants
//   DEFAULTS what a laptop wants
//
// Specific beats general, and immediate beats standing. That order is not a
// convention to memorise, it is the order of how *deliberate* each source is.
//
// A bad value in the environment is fatal, and that is on purpose. PORT=banana
// is not a request to use the default - it is a mistake in a deployment, and a
// server that silently binds to 8080 anyway will be found by somebody at 3am
// wondering why the load balancer is unhappy. Fail at startup, loudly, where the
// person who typed it is still watching.
export function fromEnvironment(env: NodeJS.ProcessEnv, argv: readonly string[]): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.error(`Bad environment - ${detail}`);
    process.exit(1);
  }

  const e = parsed.data;

  return configure(DEFAULTS, {
    ...(e.HOST !== undefined ? { host: e.HOST } : {}),
    ...(e.PORT !== undefined ? { port: e.PORT } : {}),
    ...(e.DATA_DIR !== undefined ? { dataDir: e.DATA_DIR } : {}),
    ...(e.HISTORY_LIMIT !== undefined ? { historyLimit: e.HISTORY_LIMIT } : {}),
    ...(e.ROOMS !== undefined ? { rooms: e.ROOMS } : {}),
    // argv last: it beats everything, because you typed it thirty seconds ago.
    ...(argv[2] !== undefined ? { port: resolvePort(argv[2]) } : {}),
  });
}
