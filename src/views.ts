// Projections: an internal thing, as the outside world is allowed to see it.
//
// A ChatRoom has a Set of members and a RingBuffer of history. A ChatMessage has
// an id and a serialize() method. None of that is anyone else's business, and
// none of it should be one `JSON.stringify` away from the wire. These three
// functions are the only place an internal object becomes an external one.
//
// Both `handler.ts` and `http.ts` need them, which is exactly why they live in
// neither: a module that two siblings import belongs underneath both of them,
// not inside one of them with the other reaching across.

import type { ChatRoom, ChatMessage } from "./model.js";
import type { MessageSummary, RoomSummary, UserSummary } from "./protocol.js";
import { isAdmin, type ChatClient } from "./types.js";

export function summarize(message: ChatMessage): MessageSummary {
  return { sender: message.sender, text: message.text, room: message.room, at: message.at };
}

export function describeRoom(room: ChatRoom): RoomSummary {
  return { name: room.name, members: room.memberCount, messages: room.messageCount };
}

export function describeClient(client: ChatClient): UserSummary {
  const user = client.user;
  return {
    id: client.id,
    label: client.label,
    transport: client.transport,
    room: client.room ?? null,
    admin: user !== undefined && isAdmin(user),
  };
}
