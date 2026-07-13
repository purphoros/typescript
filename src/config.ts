// Configuration, and the one decision it has to make out loud.

import { parsePort, type RoomName } from "./protocol.js";
import { EnvSchema } from "./schemas.js";
import { defaultFormat, type LogFormat, type LogLevel } from "./logger.js";
import type { CliOptions } from "./cli.js";
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
  // The HMAC key every token is signed with. Anyone who has it can mint an admin.
  jwtSecret: string;
  tokenTtlSeconds: number;
  logLevel: LogLevel;
  logFormat: LogFormat;
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
  // A default that is safe only because it is obviously not a secret, and because
  // fromEnvironment() refuses to start with it in production. A "sensible
  // default" for a signing key is a backdoor with good manners.
  jwtSecret: "development-secret-not-for-production",
  tokenTtlSeconds: 60 * 60 * 24,   // 24 hours
  logLevel: "info",
  logFormat: "pretty",
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
export function resolveConfig(env: NodeJS.ProcessEnv, cli: CliOptions): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    console.error(`Bad environment - ${detail}`);
    process.exit(1);
  }

  const e = parsed.data;

  // The one setting the server will not guess at.
  //
  // A signing secret with a default is not a default, it is a published private
  // key: every deployment that forgets to set it shares one, and anyone who has
  // read this file can mint an admin token for any of them. So in production, its
  // absence is fatal - the server does not start, and says why.
  if (e.NODE_ENV === "production" && e.JWT_SECRET === undefined) {
    console.error("JWT_SECRET is required in production. Refusing to start with a public default.");
    process.exit(1);
  }

  return configure(DEFAULTS, {
    // Format is the one setting with a *computed* default: pretty when somebody
    // is watching, JSON when a machine is. Nobody has to choose and nobody has to
    // remember to.
    logFormat: defaultFormat(),

    // Environment: what this deployment always wants.
    ...(e.HOST !== undefined ? { host: e.HOST } : {}),
    ...(e.PORT !== undefined ? { port: e.PORT } : {}),
    ...(e.DATA_DIR !== undefined ? { dataDir: e.DATA_DIR } : {}),
    ...(e.HISTORY_LIMIT !== undefined ? { historyLimit: e.HISTORY_LIMIT } : {}),
    ...(e.ROOMS !== undefined ? { rooms: e.ROOMS } : {}),
    ...(e.JWT_SECRET !== undefined ? { jwtSecret: e.JWT_SECRET } : {}),
    ...(e.TOKEN_TTL_SECONDS !== undefined ? { tokenTtlSeconds: e.TOKEN_TTL_SECONDS } : {}),
    ...(e.LOG_LEVEL !== undefined ? { logLevel: e.LOG_LEVEL } : {}),
    ...(e.LOG_FORMAT !== undefined ? { logFormat: e.LOG_FORMAT } : {}),

    // Command line last, so it beats everything. You typed it thirty seconds ago;
    // the environment was set by a deploy last March. Specific beats general, and
    // immediate beats standing - which is not a convention to memorise, it is the
    // order of how *deliberate* each source is.
    ...(cli.host !== undefined ? { host: cli.host } : {}),
    ...(cli.port !== undefined ? { port: cli.port } : {}),
    ...(cli.rooms !== undefined ? { rooms: cli.rooms } : {}),
    ...(cli.dataDir !== undefined ? { dataDir: cli.dataDir } : {}),
    ...(cli.logLevel !== undefined ? { logLevel: cli.logLevel } : {}),
    ...(cli.logFormat !== undefined ? { logFormat: cli.logFormat } : {}),
  });
}

// Whether the development JWT default is in play. main.ts warns about it *through
// the logger*, which did not exist when config.ts was written - so config reports
// the fact and lets the caller decide how to say it.
export function usingDefaultSecret(config: ServerConfig): boolean {
  return config.jwtSecret === DEFAULTS.jwtSecret;
}
