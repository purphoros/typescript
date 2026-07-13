// The browser client, served from the same port it will connect back to.
//
// This is the other half of the protocol, and it is worth reading as such. The
// page builds a ClientMessage from what you type and switches over every
// ServerMessage it might be sent - the same two unions, from the other end. The
// slash commands are not in the server; they are here, which is where they
// always belonged. They are input sugar for a human, not part of the wire.
//
// The counts arrive as arguments. Chapter 10's version reached straight into the
// `clients` and `rooms` globals, which meant a function about HTML could not be
// called without a running server. Now it can: `chatPage(0, 3)` is a string, and
// this module imports nothing at all.

export function chatPage(clientCount: number, roomCount: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Chat</title>
<h1>Chat server</h1>
<p>${clientCount} client(s) connected across ${roomCount} rooms.</p>
<p><small>Start with <code>/login alice correct-horse</code>, then /join general.
Also: /who, /rooms, /history, /w bob hello, /leave, /logout, /status, /help</small></p>
<div id="log" style="font-family:monospace;white-space:pre-wrap"></div>
<input id="input" style="width:30em" placeholder="/join general" autofocus>
<script>
  const logEl = document.getElementById("log");
  const log = (line) => { logEl.textContent += line + "\\n"; };

  // A client-side ConnectionState. This is where "reconnecting" lives - the
  // server never has that state, because a server does not reconnect.
  let state = "connecting";
  let ws = null;

  // What you typed → a ClientMessage. The server no longer parses slashes;
  // this does, and sends it a well-formed object.
  const toMessage = (input) => {
    if (!input.startsWith("/")) return { type: "chat", text: input };
    const [command, ...rest] = input.slice(1).split(" ");
    switch (command) {
      case "join":    return { type: "join", room: rest[0] ?? "" };
      case "login":   return { type: "login", name: rest[0] ?? "", password: rest.slice(1).join(" ") };
      case "auth":    return { type: "auth", token: rest[0] ?? "" };
      case "logout":  return { type: "logout" };
      case "leave":   return { type: "leave" };
      case "who":     return { type: "who" };
      case "rooms":   return { type: "rooms" };
      case "history": return { type: "history" };
      case "status":  return { type: "status" };
      case "help":    return { type: "help" };
      case "quit":    return { type: "quit" };
      case "w":
      case "whisper": return { type: "whisper", to: rest[0] ?? "", text: rest.slice(1).join(" ") };
      case "kick":    return { type: "kick", target: rest[0] ?? "", reason: rest.slice(1).join(" ") || "no reason" };
      default:        return null;
    }
  };

  // A ServerMessage → a line on screen. Every variant the server can send is
  // handled here; anything else is a bug worth seeing rather than swallowing.
  const render = (msg) => {
    const time = (at) => new Date(at).toLocaleTimeString();
    switch (msg.type) {
      case "welcome":  return msg.text;
      case "token":
        // Keep it, so a reload does not mean typing the password again. This is
        // localStorage, which is readable by any script on the page - the honest
        // trade-off is discussed in the chapter, and an httpOnly cookie is the
        // answer when you have one.
        localStorage.setItem("chat-token", msg.token);
        return "[got a token - sending it]";
      case "authenticated":
        return "You are " + msg.user + (msg.admin ? " (admin)" : "") +
               ", until " + new Date(msg.expiresAt).toLocaleString();
      case "system":   return "[system] " + msg.text;
      case "chat":     return "[" + time(msg.at) + "] " + msg.sender + ": " + msg.text;
      case "whisper":  return "(private) " + msg.from + " → " + msg.to + ": " + msg.text;
      case "joined":   return "→ " + msg.user + " joined " + msg.room + " (" + msg.members + " here)";
      case "left":     return "← " + msg.user + " left " + msg.room;
      case "userList": return msg.users.length + " connected:\\n" + msg.users
        .map((u) => "  " + u.label + " [" + u.transport + "]" + (u.admin ? " (admin)" : "") + (u.room ? " in " + u.room : ""))
        .join("\\n");
      case "roomList": return msg.rooms
        .map((r) => "  " + r.name + " - " + r.members + " member(s), " + r.messages + " message(s)")
        .join("\\n");
      case "history":  return msg.messages.length === 0
        ? "(no history in " + msg.room + ")"
        : "--- last " + msg.messages.length + " in " + msg.room + " ---\\n" + msg.messages
            .map((m) => "  " + m.sender + ": " + m.text)
            .join("\\n");
      case "commands": return "The server understands:\\n" + msg.commands
        .map((c) => "  " + c.type.padEnd(8) + " " + c.description + "\\n           " + c.example)
        .join("\\n");
      case "kicked":   return "You were kicked by " + msg.by + ": " + msg.reason;
      case "error":    return "[error: " + msg.code + "] " + msg.message;
      default:         return "[unknown message] " + JSON.stringify(msg);
    }
  };

  const connect = () => {
    ws = new WebSocket("ws://" + location.host);

    ws.onopen = () => {
      if (state === "reconnecting") log("[reconnected]");
      state = "connected";
      // Reconnect without re-authenticating: this is what the token is *for*.
      const saved = localStorage.getItem("chat-token");
      if (saved) ws.send(JSON.stringify({ type: "auth", token: saved }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        log(render(msg));
        // A fresh token is immediately presented. login -> token -> auth, without
        // the human doing the second step.
        if (msg.type === "token") ws.send(JSON.stringify({ type: "auth", token: msg.token }));
      } catch {
        log("[unparseable] " + event.data);
      }
    };

    ws.onclose = () => {
      if (state === "closed") return;
      state = "reconnecting";
      log("[disconnected - retrying in 2s]");
      setTimeout(connect, 2000);
    };
  };

  connect();

  document.getElementById("input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.value) return;
    const message = toMessage(event.target.value);
    if (message === null) {
      log("[error] unknown command. Try /help");
    } else if (state !== "connected") {
      log("[error] not connected");
    } else {
      if (message.type === "quit") state = "closed";
      ws.send(JSON.stringify(message));
    }
    event.target.value = "";
  });
</script>`;
}
