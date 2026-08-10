import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

// Reconnection is the part of a WebSocket app that breaks in production and
// never in development, so it deserves a test that kills a real server process
// rather than one that mocks a socket. This spec runs its own server on its own
// port so it can stop and start it without disturbing the shared one.

const PORT = 3200;
const ORIGIN = `http://localhost:${PORT}`;
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

let server = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    // Resolve on the listening log line, not on a guessed delay.
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('Chat room on')) resolve(child);
    });
    child.on('error', reject);
    child.on('exit', (code) => { if (code !== null && server === child) server = null; });
  });
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL'); // hard kill: sockets die without a close handshake
  await exited;
}

test.beforeEach(async () => { server = await startServer(); });
test.afterEach(async () => { await stopServer(); });

test('the client reconnects and re-joins after the server restarts', async ({ browser }) => {
  const room = 'reconnect';
  const contexts = [];

  async function client(name) {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/?room=${room}`);
    await page.getByTestId('name-input').fill(name);
    await page.getByTestId('join-button').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    return page;
  }

  const alice = await client('alice');
  const bob = await client('bob');
  await expect(alice.getByTestId('user-list')).toContainText('2 online');

  await stopServer();

  // The browser notices the socket died and flips into its backoff loop.
  await expect(alice.getByTestId('status')).toHaveText(/reconnecting|disconnected/);
  await expect(bob.getByTestId('status')).toHaveText(/reconnecting|disconnected/);

  server = await startServer();

  // No page reload, no user action: the client re-opens the socket and replays
  // its `join`, which is the entire session-recovery story for this app.
  // Generous timeout because the retry delay doubles on each failed attempt.
  await expect(alice.getByTestId('status')).toHaveText('connected', { timeout: 30_000 });
  await expect(bob.getByTestId('status')).toHaveText('connected', { timeout: 30_000 });
  await expect(alice.getByTestId('user-list')).toContainText('2 online');

  // And the room is live again in both directions.
  await bob.getByTestId('message-input').fill('back online');
  await bob.getByTestId('send-button').click();
  await expect(alice.getByTestId('message-text')).toContainText(['back online']);

  for (const context of contexts) await context.close();
});
