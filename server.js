import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * One entry per room. A room is just a set of sockets plus a message log —
 * "broadcasting" means looping over that set. Nothing here is persisted.
 * @type {Map<string, {history: Array<{id: number, user: string, text: string, at: number}>,
 *                     clients: Map<import('ws').WebSocket, {user: string|null, alive: boolean}>,
 *                     nextMessageId: number}>}
 */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { history: [], clients: new Map(), nextMessageId: 1 };
    rooms.set(name, room);
  }
  return room;
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
  return [...room.clients.values()].map((c) => c.user).filter(Boolean).sort();
}

function broadcastUsers(room) {
  broadcast(room, { type: 'users', users: userList(room) });
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
        if (userList(room).includes(name)) {
          send(ws, { type: 'error', message: 'That name is taken' });
          return;
        }
        state.user = name;

        // Catch the newcomer up on what they missed, then tell everyone.
        send(ws, { type: 'welcome', user: name, room: roomName, history: room.history });
        broadcast(room, { type: 'system', text: `${name} joined`, at: Date.now() });
        broadcastUsers(room);
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
    if (state?.user) {
      broadcast(room, { type: 'system', text: `${state.user} left`, at: Date.now() });
      broadcastUsers(room);
    }
    // Drop empty rooms so a long-running server doesn't leak history forever.
    if (room.clients.size === 0) rooms.delete(roomName);
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

server.listen(PORT, () => {
  console.log(`Chat room on http://localhost:${PORT}`);
});
