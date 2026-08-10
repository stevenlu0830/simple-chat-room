# simple-chat-room

A real-time chat room in plain Node + browser JavaScript — no framework, no Socket.IO — so the
WebSocket API stays visible. Plus a Playwright end-to-end suite that drives two real browsers
talking to one real server.

```bash
npm install
npm start        # serves on :3000 and opens it in your default browser
npm run serve    # same, without opening a browser
npm test         # the end-to-end suite
```

Open a second window to see it work — messages cross between them live. `?room=standup` puts you
in a separate room.

The browser only opens because `npm start` passes `--open`; the test suite spawns this same
`server.js` without the flag, so a test run never launches windows.

| File | What's in it |
| --- | --- |
| [server.js](server.js) | HTTP static server, the WebSocket upgrade, room state, broadcast |
| [public/app.js](public/app.js) | Connect, send JSON, react to JSON, reconnect |
| [tests/chat.spec.js](tests/chat.spec.js) | Two-client behaviour: delivery, presence, history, escaping |
| [tests/reconnect.spec.js](tests/reconnect.spec.js) | Kills the server process, asserts the client recovers |

---

## Part 1: what WebSocket actually looks like

### It starts as an HTTP request

A WebSocket is not a separate protocol you dial directly. The browser sends an ordinary HTTP GET
with `Upgrade: websocket`; if the server agrees, that same TCP socket stops speaking HTTP and
starts speaking WebSocket frames. In Node that shows up as a distinct event:

```js
// server.js
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {      // not 'request' — 'upgrade'
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, searchParams.get('room') || 'lobby');
  });
});
```

`noServer: true` is the important bit: *you* decide which upgrades to accept. That's where auth
and routing go. Note the room came from the handshake URL — the handshake is a normal HTTP
request, so cookies, headers, and query params are all available exactly once, right here.

### The client API is four events

```js
// public/app.js
const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';   // wss on https, always
ws = new WebSocket(`${scheme}//${location.host}/ws?room=${roomName}`);

ws.addEventListener('open',    () => send({ type: 'join', user: name }));
ws.addEventListener('message', (event) => handle(JSON.parse(event.data)));
ws.addEventListener('close',   () => scheduleReconnect());
ws.addEventListener('error',   () => setStatus('disconnected'));

ws.send(JSON.stringify({ type: 'chat', text }));   // strings or binary; that's it
```

That is the entire surface. Everything else in a chat app is convention you invent on top.

### There is no request/response

HTTP gives you a reply paired to your request. A WebSocket gives you two independent streams —
either side sends whenever it likes, and nothing correlates a message to an earlier one. So you
invent an envelope. Here every frame is JSON with a `type`, and both sides `switch` on it:

| Direction | Types |
| --- | --- |
| client → server | `join`, `chat`, `typing` |
| server → client | `welcome`, `chat`, `system`, `users`, `typing`, `error` |

If you later need "send this and await a reply", you have to build it: attach an `id` to each
request and have the server echo it back so the client can match up the response. Nothing in the
protocol does that for you.

### Broadcast is just a loop

There is no "publish to a channel" primitive. A room is a `Set` of sockets, and broadcasting is
iterating over it:

```js
function broadcast(room, payload, { except } = {}) {
  const data = JSON.stringify(payload);
  for (const ws of room.clients.keys()) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}
```

The `readyState` check matters — a socket can be in `CLOSING` while still sitting in your `Set`.

### Three things that bite you in production

**1. Sockets are stateless about identity.** The connection knows nothing about who you are. The
server stores `ws -> { user }` in a `Map` keyed by the socket, and the client re-sends `join` on
every `open`. That single line is what makes reconnection recover the session:

```js
ws.addEventListener('open', () => {
  const name = username ?? pendingName;
  if (name) send({ type: 'join', user: name });   // replays automatically on reconnect
});
```

**2. Dead sockets look alive.** A laptop that sleeps or a yanked cable leaves a socket that stays
`OPEN` forever — no `close` event ever arrives. The fix is a heartbeat: ping everyone on an
interval, and terminate anyone who didn't pong since the last round.

```js
ws.on('pong', () => { state.alive = true; });

setInterval(() => {
  for (const [ws, state] of room.clients) {
    if (!state.alive) { ws.terminate(); continue; }   // missed a round trip → drop
    state.alive = false;
    ws.ping();
  }
}, 30_000);
```

**3. Clients must reconnect themselves.** The browser will not retry for you. Use exponential
backoff, or a server restart means every client stampedes it at once:

```js
const delay = Math.min(1000 * 2 ** reconnectAttempts, 10_000);
reconnectAttempts += 1;
setTimeout(connect, delay);
```

Also: `error` never tells you why (the browser hides the reason deliberately), and `close` always
follows it — so put your recovery logic in `close` and treat `error` as a status update only.

---

## Part 2: how to test this end to end

End-to-end means **no test doubles anywhere**: a real server process, a real browser, a real
WebSocket over a real port. Anything you mock is the thing most likely to be broken.

### Why Playwright fits WebSockets specifically

The whole point of this app is that something happening in tab A shows up in tab B. Playwright's
`browser.newContext()` gives you fully independent browser sessions — separate storage, separate
sockets — so you can act as two users in one test:

```js
const ada   = await openClient(browser, room, 'ada');
const grace = await openClient(browser, room, 'grace');

await say(ada.page, 'hello world');
await expect(bubbles(grace.page)).toHaveText(['hello world']);   // crossed the wire for real
```

### Let Playwright own the server

`webServer` in the config boots the real server before the suite and kills it afterwards, so
`npm test` is the whole story on a laptop and in CI alike:

```js
// playwright.config.js
webServer: {
  command: 'node server.js',
  env: { PORT: '3100' },        // not 3000, so it never fights your dev server
  url: 'http://localhost:3100',
  reuseExistingServer: !process.env.CI,
}
```

### The rule that kills flakiness: never sleep

The instinct with async messaging is `await page.waitForTimeout(500)`. Don't. It's slow when the
socket is fast and flaky when it isn't. Playwright's assertions retry until they pass or time out,
so express the *condition* instead:

```js
await expect(bubbles(grace.page)).toHaveText(['hello world']);   // retries until delivered
```

There is not a single `waitForTimeout` in this suite, and it runs in about 4 seconds.

Same rule for setup — after clicking Join, wait for the server's answer, not for a duration:

```js
await expect(page.getByTestId('room')).toBeVisible();
await expect(page.getByTestId('status')).toHaveText('connected');
```

### Isolate state, or tests only fail in CI

This bit an early version of these tests: they passed one at a time and failed as a suite, because
the server's in-memory history outlived each test and exact-match assertions saw the previous
test's messages. Server state is global; your tests must not be.

The fix here was to give each test its own room — which is also a feature users want:

```js
const roomFor = (testInfo) => `test-${testInfo.testId}`;
await page.goto(`/?room=${room}`);
```

The general principle: find the app's natural partition key (room, tenant, user, workspace) and
give every test a unique one. It beats a reset endpoint, because it also lets tests run in
parallel later.

### Test the failure paths, not just the happy one

Reconnection is the part of a WebSocket app that works perfectly in development and breaks in
production. So [tests/reconnect.spec.js](tests/reconnect.spec.js) spawns its own server on its own
port and `SIGKILL`s it mid-test — no close handshake, exactly like a crash:

```js
await stopServer();
await expect(alice.getByTestId('status')).toHaveText(/reconnecting|disconnected/);

server = await startServer();

// No reload, no user action — the client re-opens and replays its join.
await expect(alice.getByTestId('status')).toHaveText('connected', { timeout: 30_000 });
await expect(alice.getByTestId('user-list')).toContainText('2 online');
```

Note the server-ready detection: `startServer` resolves on the "Chat room on" stdout line, not on
a guessed delay. Same no-sleeping rule, applied to process management.

Other failure paths worth covering, all of them in the suite: a disconnect updates everyone else's
presence list, a duplicate name is rejected without entering the room, a late joiner gets the
backlog, and a message containing `<img src=x onerror=...>` renders as text rather than executing.

### Assert on stable hooks

Every element the tests touch carries `data-testid`. Test IDs don't move when you reword a label
or restyle a component, and `getByTestId` reads the same in the test as the markup does:

```html
<input data-testid="message-input" ... />
```

### When something fails, read the trace

The config keeps a trace and video on failure only. The trace viewer replays the run with DOM
snapshots at every step, which is how you diagnose a delivery race in seconds:

```bash
npx playwright show-trace test-results/<failing-test>/trace.zip
```

### Check that a passing test can fail

A test that can't fail is worse than no test. Break the behaviour on purpose and confirm the test
goes red — for the reconnect test, comment out `setTimeout(connect, delay)` in
[public/app.js](public/app.js) and re-run. If it still passes, the test is asserting nothing.

---

## What's deliberately missing

In-memory only (restart clears everything), no auth, no rate limiting, and a single process — a
second instance would have its own rooms, so multi-instance deployment needs a Redis pub/sub or
similar fan-out between servers. Names are first-come-first-served per room, which is not identity.
