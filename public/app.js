// The whole client is four things: open a socket, send JSON, react to JSON,
// reconnect when it dies.

const joinForm = document.querySelector('[data-testid="join-form"]');
const nameInput = document.querySelector('[data-testid="name-input"]');
const joinError = document.querySelector('[data-testid="join-error"]');
const room = document.querySelector('[data-testid="room"]');
const roomTitle = document.querySelector('[data-testid="room-title"]');
const statusEl = document.querySelector('[data-testid="status"]');
const userList = document.querySelector('[data-testid="user-list"]');
const messages = document.querySelector('[data-testid="messages"]');
const typingEl = document.querySelector('[data-testid="typing-indicator"]');
const chatForm = document.querySelector('[data-testid="chat-form"]');
const messageInput = document.querySelector('[data-testid="message-input"]');

// Visit /?room=standup to get an independent room; everything is scoped to it.
const roomName = new URLSearchParams(location.search).get('room') || 'lobby';

let ws = null;
let username = null; // set only once the server confirms with `welcome`
let pendingName = null;
let reconnectAttempts = 0;
let typingTimer = null;
let sentTyping = false;
const typingUsers = new Set();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  // ws:// over http, wss:// over https — mixed content is blocked, so derive
  // the scheme from the page instead of hardcoding it.
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${scheme}//${location.host}/ws?room=${encodeURIComponent(roomName)}`);

  // The four events are the entire API surface: open, message, close, error.
  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    setStatus('connected');
    // The socket carries no identity of its own, so re-announce who we are.
    // On a reconnect this replays automatically — that's the whole recovery.
    const name = username ?? pendingName;
    if (name) send({ type: 'join', user: name });
  });

  ws.addEventListener('message', (event) => {
    // event.data is a string here because the server sends text frames.
    // Binary frames arrive as Blob/ArrayBuffer instead.
    handle(JSON.parse(event.data));
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected');
    scheduleReconnect();
  });

  // 'error' never tells you why (the browser hides it for security reasons);
  // 'close' always follows, so let that path do the work.
  ws.addEventListener('error', () => setStatus('disconnected'));
}

function scheduleReconnect() {
  // Exponential backoff, capped — otherwise a server restart means every
  // client hammers it at once.
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10_000);
  reconnectAttempts += 1;
  setStatus('reconnecting');
  setTimeout(connect, delay);
}

function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function setStatus(state) {
  statusEl.dataset.state = state;
  statusEl.textContent = { connected: 'connected', connecting: 'connecting…', reconnecting: 'reconnecting…', disconnected: 'disconnected' }[state];
}

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      username = msg.user;
      pendingName = null;
      roomTitle.textContent = `#${msg.room}`;
      joinForm.hidden = true;
      room.hidden = false;
      messages.replaceChildren();
      msg.history.forEach(addMessage);
      messageInput.focus();
      break;

    case 'chat':
      addMessage(msg.message);
      break;

    case 'system':
      addSystem(msg.text);
      break;

    case 'users':
      userList.textContent = `${msg.users.length} online: ${msg.users.join(', ')}`;
      break;

    case 'typing':
      if (msg.on) typingUsers.add(msg.user);
      else typingUsers.delete(msg.user);
      renderTyping();
      break;

    case 'error':
      if (username) {
        addSystem(`Error: ${msg.message}`);
      } else {
        pendingName = null;
        joinError.textContent = msg.message;
        joinError.hidden = false;
      }
      break;
  }
}

function addMessage({ id, user, text, at }) {
  const li = document.createElement('li');
  li.className = 'message';
  li.dataset.testid = 'message';
  li.dataset.messageId = id;
  li.dataset.user = user;
  if (user === username) li.classList.add('own');

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${user} · ${new Date(at).toLocaleTimeString()}`;

  const body = document.createElement('span');
  body.className = 'body';
  body.dataset.testid = 'message-text';
  body.textContent = text; // textContent, not innerHTML — this is user input

  li.append(meta, body);
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function addSystem(text) {
  const li = document.createElement('li');
  li.className = 'system';
  li.dataset.testid = 'system-message';
  li.textContent = text;
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function renderTyping() {
  const names = [...typingUsers];
  typingEl.textContent = names.length === 0 ? '' : `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`;
}

// ---------------------------------------------------------------------------
// Outbound events
// ---------------------------------------------------------------------------

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  joinError.hidden = true;
  pendingName = name;
  send({ type: 'join', user: name });
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  messageInput.value = '';
  stopTyping();
});

messageInput.addEventListener('input', () => {
  if (!sentTyping) {
    sentTyping = true;
    send({ type: 'typing', on: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
});

function stopTyping() {
  clearTimeout(typingTimer);
  if (!sentTyping) return;
  sentTyping = false;
  send({ type: 'typing', on: false });
}

connect();
