// Configuration, and the one decision it has to make out loud.

import { parsePort, type RoomName } from "./protocol.js";
import type { Host, Port } from "./types.js";

// `Readonly<T>` marks every property immutable, so nothing can reassign the
// config after startup.
export type ServerConfig = Readonly<{
  host: Host;
  port: Port;
  rooms: readonly RoomName[];
  historyLimit: number;
}>;

// `as const` gives every field its literal type and makes the object readonly:
// DEFAULTS.port has type 8080, not number, and cannot be reassigned.
export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8080,
  rooms: ["general", "random", "dev"],
  historyLimit: 50,
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
