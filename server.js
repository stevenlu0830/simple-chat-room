import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// 1. A plain HTTP server, just to serve the static client files.
//    WebSockets always start life as an HTTP request, so we need one anyway.
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Strip the query string *before* the index check, or "/?room=x" resolves to
  // the directory rather than index.html.
  const rawPath = req.url.split('?')[0];
  const urlPath = rawPath === '/' ? '/index.html' : rawPath;
  // Resolve inside PUBLIC_DIR and reject anything that escapes it (../../etc/passwd).
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// 2. The WebSocket server. `noServer: true` means *we* decide which HTTP
//    upgrade requests get handed over, instead of ws grabbing all of them.
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// The browser opens ws://host/ws  ->  HTTP GET / with "Upgrade: websocket".
// Node emits 'upgrade' instead of 'request' for those. This is the handshake:
// once we call handleUpgrade, the TCP socket stops speaking HTTP and starts
// speaking the WebSocket frame protocol, in both directions, until closed.
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/ws') {
    // Not a route we speak — close the TCP socket rather than leaving it open.
    socket.destroy();
    return;
  }
  const roomName = (searchParams.get('room') || 'lobby').slice(0, 64);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, roomName);
  });
});

// ---------------------------------------------------------------------------
// 3. Room state. Everything lives in memory — restart the server and it's gone.
// ---------------------------------------------------------------------------

const MAX_HISTORY = 50;
const MAX_MESSAGE_LENGTH = 2000;

// A dropped socket and a departing user look identical from here, so we wait
// before announcing anyone's departure. A refresh, a tunnel, or a phone
// switching to cellular all reconnect well inside this window.
const REJOIN_GRACE_MS = Number(process.env.GRACE_MS) || 5000;

/**
 * One entry per room. A room is just a set of sockets plus a message log —
 * "broadcasting" means looping over that set. Nothing here is persisted.
 * `disconnected` holds users whose socket dropped but whose seat we're still
 * keeping warm: name -> the timer that will announce their departure.
 * @type {Map<string, {history: Array<{id: number, user: string, text: string, at: number}>,
 *                     clients: Map<import('ws').WebSocket, {user: string|null, alive: boolean}>,
 *                     disconnected: Map<string, NodeJS.Timeout>,
 *                     nextMessageId: number}>}
 */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { history: [], clients: new Map(), disconnected: new Map(), nextMessageId: 1 };
    rooms.set(name, room);
  }
  return room;
}

// Keep an empty room alive while anyone might still come back — otherwise the
// last person to refresh loses the room's history.
function dropRoomIfEmpty(roomName, room) {
  if (room.clients.size === 0 && room.disconnected.size === 0) rooms.delete(roomName);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, { except } = {}) {
  const data = JSON.stringify(payload);
  for (const ws of room.clients.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function userList(room) {
  const live = [...room.clients.values()].map((c) => c.user).filter(Boolean);
  // People inside their grace window still count as present — that's the point
  // of the grace window: to the room, a blip never happened.
  return [...new Set([...live, ...room.disconnected.keys()])].sort();
}

function broadcastUsers(room) {
  broadcast(room, { type: 'users', users: userList(room) });
}

/** The one place a departure becomes visible, however it was triggered. */
function announceDeparture(room, name) {
  // Clear any typing indicator they left behind, or it sticks around forever.
  broadcast(room, { type: 'typing', user: name, on: false });
  broadcast(room, { type: 'system', text: `${name} left`, at: Date.now() });
  broadcastUsers(room);
}

// ---------------------------------------------------------------------------
// 4. Per-connection lifecycle: connection -> message* -> close.
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req, roomName) => {
  const room = getRoom(roomName);
  room.clients.set(ws, { user: null, alive: true });

  // A WebSocket has no request/response pairing — either side just sends
  // whenever it wants. So we invent our own envelope: every frame is JSON
  // with a `type` field, and both sides switch on it.
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Malformed JSON' });
      return;
    }

    const state = room.clients.get(ws);
    if (!state) return;

    switch (msg.type) {
      case 'join': {
        const name = String(msg.user ?? '').trim().slice(0, 32);
        if (!name) {
          send(ws, { type: 'error', message: 'Name required' });
          return;
        }
        // Someone reclaiming a seat we're holding for them. Names aren't real
        // identity, so this trusts whoever asks first — good enough for a room
        // where names are already first-come-first-served.
        const graceTimer = room.disconnected.get(name);
        const returning = graceTimer !== undefined;
        if (returning) {
          clearTimeout(graceTimer);
          room.disconnected.delete(name);
        }

        if (!returning && userList(room).includes(name)) {
          send(ws, { type: 'error', message: 'That name is taken' });
          return;
        }
        state.user = name;

        // Catch them up on what they missed either way.
        send(ws, { type: 'welcome', user: name, room: roomName, history: room.history });

        // A returning user was never marked absent, so there is nothing to
        // announce and the presence list is already correct. Staying silent
        // here is what stops a refresh from spamming "left" then "joined".
        if (!returning) {
          broadcast(room, { type: 'system', text: `${name} joined`, at: Date.now() });
          broadcastUsers(room);
        }
        break;
      }

      // An explicit "I'm leaving" — no grace period, because there's no doubt.
      case 'leave': {
        if (!state.user) return;
        const name = state.user;
        state.user = null; // so 'close' doesn't also start a grace timer
        announceDeparture(room, name);
        break;
      }

      case 'chat': {
        if (!state.user) {
          send(ws, { type: 'error', message: 'Join before sending messages' });
          return;
        }
        const text = String(msg.text ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
        if (!text) return;

        const message = { id: room.nextMessageId++, user: state.user, text, at: Date.now() };
        room.history.push(message);
        if (room.history.length > MAX_HISTORY) room.history.shift();

        // Including the sender: they render only what the server echoed back,
        // so every client sees the same list in the same order.
        broadcast(room, { type: 'chat', message });
        break;
      }

      case 'typing': {
        if (!state.user) return;
        broadcast(room, { type: 'typing', user: state.user, on: Boolean(msg.on) }, { except: ws });
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  });

  // 'close' fires for clean closes (tab closed, ws.close()) *and* for broken
  // ones once the socket errors out. It's the only cleanup hook you need.
  ws.on('close', () => {
    const state = room.clients.get(ws);
    room.clients.delete(ws);

    // We can't tell "closed the tab" from "went into a tunnel" — both arrive
    // here identically. So say nothing yet and start a countdown; if they
    // reconnect first, 'join' cancels it and the room never noticed.
    if (state?.user) {
      const name = state.user;
      const timer = setTimeout(() => {
        room.disconnected.delete(name);
        announceDeparture(room, name);
        dropRoomIfEmpty(roomName, room);
      }, REJOIN_GRACE_MS);
      room.disconnected.set(name, timer);
    }

    // Drop empty rooms so a long-running server doesn't leak history forever.
    dropRoomIfEmpty(roomName, room);
  });

  ws.on('error', () => ws.terminate());

  // Heartbeat: a laptop that goes to sleep or a yanked network cable leaves a
  // socket that looks OPEN forever. Ping every 30s; if a client misses one
  // round trip, drop it.
  ws.on('pong', () => {
    const state = room.clients.get(ws);
    if (state) state.alive = true;
  });
});

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const [ws, state] of room.clients) {
      if (!state.alive) {
        ws.terminate(); // fires 'close', which cleans up
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// 5. Convenience: `npm start` passes --open so the room pops up in your default
//    browser. The tests spawn this same file *without* the flag, so a test run
//    never launches browser windows.
// ---------------------------------------------------------------------------

function openInBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  // No browser, or no `xdg-open` on a bare Linux box: say so and keep serving.
  child.on('error', () => console.log(`Could not open a browser — visit ${url}`));
  child.unref(); // don't hold the event loop open on the child
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Chat room on ${url}`);
  if (process.argv.includes('--open')) openInBrowser(url);
});
