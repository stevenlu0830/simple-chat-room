import { test, expect } from '@playwright/test';
import { GRACE_MS } from '../playwright.config.js';

// Server state lives in memory and outlives a single test, so every test gets
// its own room. That's the isolation boundary — without it, test N sees the
// messages test N-1 left behind and exact-match assertions fail only when the
// suite runs as a whole.
const roomFor = (testInfo) => `test-${testInfo.testId}`;

/** Open a fresh browser context (its own cookies, storage, sockets) and join. */
async function openClient(browser, room, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('join-button').click();
  // Wait for the round trip to complete rather than for a fixed delay.
  await expect(page.getByTestId('room')).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('connected');
  return { context, page, name };
}

async function say(page, text) {
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('send-button').click();
}

/** All message bubbles currently rendered, as plain text. */
const bubbles = (page) => page.getByTestId('message-text');

test.describe('real-time chat', () => {
  test('a message sent by one user appears for the other', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const ada = await openClient(browser, room, 'ada');
    const grace = await openClient(browser, room, 'grace');

    await say(ada.page, 'hello world');

    // No waitForTimeout anywhere: web-first assertions retry until the socket
    // delivers, so the test is as fast as the network and never flaky-by-sleep.
    await expect(bubbles(grace.page)).toHaveText(['hello world']);
    await expect(bubbles(ada.page)).toHaveText(['hello world']);

    await ada.context.close();
    await grace.context.close();
  });

  test('both directions, and ordering is identical for everyone', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const a = await openClient(browser, room, 'a');
    const b = await openClient(browser, room, 'b');

    await say(a.page, 'first');
    await expect(bubbles(b.page)).toHaveText(['first']);
    await say(b.page, 'second');
    await expect(bubbles(a.page)).toHaveText(['first', 'second']);
    await say(a.page, 'third');

    const expected = ['first', 'second', 'third'];
    await expect(bubbles(a.page)).toHaveText(expected);
    await expect(bubbles(b.page)).toHaveText(expected);

    await a.context.close();
    await b.context.close();
  });

  test('a late joiner receives the backlog', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const early = await openClient(browser, room, 'early');
    await say(early.page, 'said before you arrived');
    await expect(bubbles(early.page)).toHaveText(['said before you arrived']);

    const late = await openClient(browser, room, 'late');
    await expect(bubbles(late.page)).toHaveText(['said before you arrived']);

    await early.context.close();
    await late.context.close();
  });

  test('the presence list updates on join and on disconnect', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const host = await openClient(browser, room, 'host');
    await expect(host.page.getByTestId('user-list')).toContainText(`1 online: ${host.name}`);

    const guest = await openClient(browser, room, 'guest');
    await expect(host.page.getByTestId('user-list')).toContainText('2 online');
    await expect(host.page.getByTestId('user-list')).toContainText(guest.name);

    // Closing the context kills the socket the way closing a tab would. The
    // departure is announced only once the grace period expires without them.
    await guest.context.close();
    await expect(host.page.getByTestId('messages')).toContainText(`${guest.name} left`, { timeout: 8000 });
    await expect(host.page.getByTestId('user-list')).toContainText(`1 online: ${host.name}`);

    await host.context.close();
  });

  test('leaving deliberately is immediate and stays left', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const stayer = await openClient(browser, room, 'stayer');
    const quitter = await openClient(browser, room, 'quitter');

    // Nothing should dial back out after this point. Watching for the socket
    // itself is what pins the `leaving` guard down: without it the client
    // reopens a connection it has no use for.
    const socketsAfterLeave = [];
    quitter.page.on('websocket', (socket) => socketsAfterLeave.push(socket.url()));

    await quitter.page.getByTestId('leave-button').click();

    // Back at the join screen...
    await expect(quitter.page.getByTestId('join-form')).toBeVisible();
    await expect(quitter.page.getByTestId('room')).toBeHidden();

    // ...and it sticks. Asserting that something *doesn't* happen is the one
    // case a real wait is required — no assertion can retry its way to proving
    // absence. The first backoff attempt would fire at 1s, so outlast it.
    await quitter.page.waitForTimeout(2500);
    await expect(quitter.page.getByTestId('room')).toBeHidden();
    await expect(quitter.page.getByTestId('join-form')).toBeVisible();
    expect(socketsAfterLeave, 'a deliberate leave must not reconnect').toEqual([]);

    // No grace period for an explicit leave: the room hears about it at once.
    await expect(stayer.page.getByTestId('messages')).toContainText('quitter left');
    await expect(stayer.page.getByTestId('user-list')).toContainText('1 online: stayer');

    await stayer.context.close();
    await quitter.context.close();
  });

  test('a user who left can rejoin', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const stayer = await openClient(browser, room, 'stayer');
    await say(stayer.page, 'still here');

    const guest = await openClient(browser, room, 'guest');
    await guest.page.getByTestId('leave-button').click();
    await expect(stayer.page.getByTestId('user-list')).toContainText('1 online');

    // Same name is free again, and the backlog comes back with them.
    await guest.page.getByTestId('name-input').fill('guest');
    await guest.page.getByTestId('join-button').click();
    await expect(guest.page.getByTestId('status')).toHaveText('connected');
    await expect(bubbles(guest.page)).toHaveText(['still here']);
    await expect(stayer.page.getByTestId('user-list')).toContainText('2 online');

    await stayer.context.close();
    await guest.context.close();
  });

  test('a refresh does not announce a departure', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const watcher = await openClient(browser, room, 'watcher');
    const refresher = await openClient(browser, room, 'refresher');
    await expect(watcher.page.getByTestId('user-list')).toContainText('2 online');

    // A reload drops the socket exactly like a crash would — the server can't
    // tell the difference, which is why it waits before saying anything.
    await refresher.page.reload();
    await refresher.page.getByTestId('name-input').fill('refresher');
    await refresher.page.getByTestId('join-button').click();
    await expect(refresher.page.getByTestId('status')).toHaveText('connected');

    // Genuinely wait out the grace window — a retrying assertion would pass at
    // t=0 and never see the "left" that a missing grace period would emit.
    await watcher.page.waitForTimeout(GRACE_MS + 1000);

    // The room never noticed: no "left", and no second "joined" either.
    // Everyone sees their own join too, so the baseline is both arrivals.
    await expect(watcher.page.getByTestId('system-message'))
      .toHaveText(['watcher joined', 'refresher joined']);
    await expect(watcher.page.getByTestId('user-list')).toContainText('2 online');

    await watcher.context.close();
    await refresher.context.close();
  });

  test('the typing indicator turns on and off', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const writer = await openClient(browser, room, 'writer');
    const reader = await openClient(browser, room, 'reader');

    await writer.page.getByTestId('message-input').pressSequentially('drafting');
    await expect(reader.page.getByTestId('typing-indicator')).toHaveText(`${writer.name} is typing…`);

    await say(writer.page, 'done');
    await expect(reader.page.getByTestId('typing-indicator')).toHaveText('');

    await writer.context.close();
    await reader.context.close();
  });

  test('a duplicate display name is rejected', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const name = 'twin';
    const first = await openClient(browser, room, name);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`/?room=${room}`);
    await page.getByTestId('name-input').fill(name);
    await page.getByTestId('join-button').click();

    await expect(page.getByTestId('join-error')).toHaveText('That name is taken');
    await expect(page.getByTestId('room')).toBeHidden();

    await first.context.close();
    await context.close();
  });

  test('message text is escaped, not executed', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const attacker = await openClient(browser, room, 'mallory');
    const victim = await openClient(browser, room, 'victim');

    const payload = '<img src=x onerror="window.__pwned = true">';
    await say(attacker.page, payload);

    // Rendered verbatim as text on the receiving side...
    await expect(bubbles(victim.page)).toHaveText([payload]);
    // ...and no element was actually created from it.
    await expect(victim.page.locator('.messages img')).toHaveCount(0);
    expect(await victim.page.evaluate(() => window.__pwned)).toBeUndefined();

    await attacker.context.close();
    await victim.context.close();
  });

  test('rooms are isolated from each other', async ({ browser }, testInfo) => {
    const room = roomFor(testInfo);
    const inside = await openClient(browser, room, 'inside');
    const elsewhere = await openClient(browser, `${room}-other`, 'elsewhere');

    await say(inside.page, 'private to this room');
    await expect(bubbles(inside.page)).toHaveText(['private to this room']);

    // The other room never sees it, and its presence list stays at one.
    await expect(bubbles(elsewhere.page)).toHaveCount(0);
    await expect(elsewhere.page.getByTestId('user-list')).toContainText('1 online');

    await inside.context.close();
    await elsewhere.context.close();
  });
});
