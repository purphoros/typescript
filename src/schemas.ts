// The protocol, as a schema.
//
// Chapter 9 wrote the ClientMessage union by hand and then wrote a decoder to
// check it, field by field:
//
//     chat: (f) => (isString(f.text) ? { type: "chat", text: f.text } : null),
//     join: (f) => (isString(f.room) ? { type: "join", room: f.room } : null),
//
// Twelve variants, one line per property, and the two halves kept in step by
// nothing but diligence. Add a field to the type and the decoder still compiles.
// Add it to the decoder and the type still compiles. They agreed because someone
// remembered, every time, for four chapters - and "someone remembered" is not a
// guarantee, it is a nice thing that has not stopped being true yet.
//
// A schema is both halves at once. It validates at runtime and it *is* the type
// at compile time, via z.infer. There is no longer a second thing to keep in
// step, because there is no longer a second thing.
//
// The constraints below are new, and they are the part that was never in the
// type system at all. `text: string` says nothing about a client sending ten
// megabytes of it.

import { z } from "zod";

// A nickname: 1-20 characters, letters, digits, underscore or hyphen. This rule
// used to live in `validateNickname` in protocol.ts, as a regex applied in the
// handler, several layers away from the type that described the field. Now it is
// attached to the field it constrains.
const nickname = z.string().min(1).max(20).regex(/^[a-z0-9_-]+$/i, {
  message: "must be 1-20 characters: letters, digits, _ or -",
});

// A room name. Lowercase, because "General" and "general" being different rooms
// is a bug waiting for a Tuesday.
const roomName = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/, {
  message: "must be lowercase letters, digits or hyphens",
});

// What somebody can actually say. A megabyte of "a" is not a chat message, and
// `text: string` was never going to be the thing that noticed.
const chatText = z.string().min(1).max(1000);

// `.strict()` rejects unknown keys instead of silently dropping them, so
// {"type":"chat","txet":"hi"} is an error naming `txet` rather than a chat
// message with no text.
//
// This is a real trade and worth making on purpose. The permissive rule -
// ignore what you do not recognise - is what lets a protocol evolve: an old
// server can survive a new client sending a field it has never heard of. We give
// that up, and we can afford to, because this server *serves its own client*
// (page.ts, over HTTP, from the same port). They ship together and can never
// skew. A protocol with clients you do not control should think much harder
// before choosing this.
const message = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  message({ type: z.literal("chat"), text: chatText }),
  message({ type: z.literal("whisper"), to: nickname, text: chatText }),
  message({ type: z.literal("join"), room: roomName }),
  message({ type: z.literal("leave") }),
  // `nick` is gone. It announced an identity; these two *prove* one.
  message({ type: z.literal("login"), name: nickname, password: z.string().min(1).max(200) }),
  message({ type: z.literal("auth"), token: z.string().min(1).max(4096) }),
  message({ type: z.literal("logout") }),
  message({ type: z.literal("who") }),
  message({ type: z.literal("rooms") }),
  message({ type: z.literal("history"), limit: z.number().int().positive().max(500).optional() }),
  // Free text from a stranger, headed for a database. See sqlite.ts - the schema
  // bounds the length, and the bound parameter is what stops it being SQL.
  message({ type: z.literal("search"), query: z.string().min(1).max(200) }),
  message({ type: z.literal("kick"), target: nickname, reason: z.string().min(1).max(200) }),
  message({ type: z.literal("status") }),
  // Ephemeral. Never archived, never persisted, and gone in four seconds whether
  // or not anybody says so - see presence.ts.
  message({ type: z.literal("typing"), typing: z.boolean() }),
  // The answer to a {"type":"ping"}. Raw TCP has no ping frame; WebSocket does,
  // and its clients answer it without any application code at all.
  message({ type: z.literal("pong") }),
  message({ type: z.literal("help") }),
  message({ type: z.literal("quit") }),
]);

// `z.discriminatedUnion` is not merely a union of objects. It reads the literal
// `type` on each member and builds a lookup, so an unknown discriminant fails
// once, immediately, with a message naming the twelve it knows - rather than
// trying all twelve schemas and reporting twelve separate failures about a
// message that was only ever going to be one of them.

// A port off the command line. Not JSON, but the same argument applies: someone
// typed it, so it is wrong sometimes. `z.coerce` runs `Number(input)` first,
// which is the one place a coercion is honest - the value genuinely arrives as a
// string and genuinely needs to be a number.
export const PortSchema = z.coerce.number().int().min(1).max(65535);

// The environment.
//
// `process.env` is `Record<string, string | undefined>` - every value a string,
// every value possibly missing. It is untrusted input that happens to come from
// a shell rather than a socket, and it deserves exactly the same treatment.
//
// Everything is optional: an unset variable is not an error, it is a default.
// But a *set* one that is nonsense - PORT=banana, PORT=99999 - is an error, and
// the server should say so at startup rather than binding to something surprising
// and leaving you to find out later.
export const EnvSchema = z.object({
  HOST: z.string().min(1).optional(),
  // The signing secret. Optional here, and checked hard at startup - see
  // config.ts, which refuses to run in production without it.
  JWT_SECRET: z.string().min(16).optional(),
  TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(60 * 60 * 24 * 30).optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  LOG_FORMAT: z.enum(["pretty", "json"]).optional(),
  STORAGE: z.enum(["sqlite", "file"]).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  DATA_DIR: z.string().min(1).optional(),
  HISTORY_LIMIT: z.coerce.number().int().positive().max(10_000).optional(),
  // "general,random,dev" → ["general", "random", "dev"]. z.transform runs after
  // validation, so what comes out is parsed, not merely checked.
  ROOMS: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((room) => room.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1))
    .optional(),
});
