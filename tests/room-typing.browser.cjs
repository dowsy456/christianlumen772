// Offline layout regressions: reserve typing space and restore the room roster.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(mock);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login');
    await page.fill('#login-code', 'TEST-USER');
    await page.click('#btn-login');
    await page.waitForFunction(() => ChatApp.currentUser);
    await page.evaluate(async () => {
      await __testDatabase.ref('users/ALICE').set({ username: 'Alice', displayName: 'Alice' });
      await __testDatabase.ref('memberships/ALICE/test').set(true);
      await __testDatabase.ref('roomMembers/test/ALICE').set(true);
      await __testDatabase.ref('messages/test/one').set({ userCode: 'TEST-USER', username: 'Tester', text: 'The typing indicator has its own line.', createdAt: Date.now() });
      await ChatApp.openRoom('test', { quiet: true });
      ChatApp.closeToast();
    });
    await page.locator('#online-list [data-usercode="ALICE"]').waitFor();
    assert.equal(await page.locator('#members-sidebar').isVisible(), true);
    for (const visit of ['same', 'home', 'calendar']) {
      await page.evaluate(async visit => {
        ChatApp.membersListVisible = false;
        ChatApp.syncEmojiButtonVisibility();
        if (visit === 'home') ChatApp.showLoggedInHome();
        if (visit === 'calendar') ChatApp.showCalendarPage();
        await ChatApp.openRoom('test', { quiet: true });
      }, visit);
      assert.equal(await page.locator('#members-sidebar').isVisible(), true, `${visit} room entry restores members`);
    }
    await page.setViewportSize({ width: 790, height: 900 });
    await page.evaluate(() => ChatApp.openRoom('test', { quiet: true }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.body.dataset.membersSidebar === '1');
    assert.equal(await page.locator('#members-sidebar').isVisible(), true, 'desktop roster returns after narrow-window room entry');
    await page.locator('#btn-emoji').focus();
    await page.evaluate(() => ChatApp.syncMobileUiMode());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-emoji', 'same-mode viewport events retain composer focus');
    const geometry = () => page.evaluate(() => {
      const line = document.querySelector('#typing-bar').getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      const messages = document.querySelector('#messages').getBoundingClientRect();
      return { lineTop: line.top, height: line.height, lineBottom: line.bottom, composerTop: composer.top, messagesBottom: messages.bottom };
    });
    await page.waitForTimeout(250);
    const idle = await geometry();
    assert.equal(idle.height, 24);
    assert.ok(idle.messagesBottom <= idle.lineTop, 'typing line never overlaps message history');
    await page.evaluate(() => {
      ChatApp.onlinePresenceCache.set('ALICE', { username: 'Alice', typing: true });
      ChatApp.appPresenceCache.set('ALICE', 'online');
      ChatApp.renderOnlineIndicator();
    });
    await page.waitForFunction(() => !document.querySelector('#typing-bar').hidden);
    assert.deepEqual(await geometry(), idle, 'starting typing does not shift the composer or messages');
    assert.match(await page.locator('#typing-bar-users').textContent(), /Alice is typing\.\.\./);
    assert.equal(await page.locator('.typing-bar-text').evaluate(el => el.firstElementChild.className), 'typing-bar-suffix');
    assert.equal(await page.locator('.typing-bar-text').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => {
        ChatApp.initOverlaysUI();
        ChatApp.replyBarEl.hidden = false;
        ChatApp.replyBarEl.classList.add('open');
        ChatApp.syncChatOverlayMetrics();
      });
      await page.waitForTimeout(220);
      const bounds = await page.evaluate(() => ({
        replyBottom: document.querySelector('#reply-bar').getBoundingClientRect().bottom,
        typingTop: document.querySelector('#typing-bar').getBoundingClientRect().top
      }));
      assert.ok(bounds.replyBottom <= bounds.typingTop, 'composer popovers remain above the reserved typing line');
      await page.evaluate(() => { ChatApp.replyBarEl.hidden = true; ChatApp.replyBarEl.classList.remove('open'); ChatApp.syncChatOverlayMetrics(); });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(220);
    const captures = path.resolve(__dirname, '../../qa');
    fs.mkdirSync(captures, { recursive: true });
    await page.screenshot({ path: path.join(captures, 'typing-room.png') });
    await page.evaluate(() => { ChatApp.onlinePresenceCache.get('ALICE').typing = false; ChatApp.renderOnlineIndicator(); });
    await page.waitForTimeout(220);
    assert.deepEqual(await geometry(), idle, 'stopping typing preserves the reserved space');
    await page.evaluate(() => ChatApp.showLoggedInHome());
    assert.equal(await page.locator('#typing-bar').evaluate(el => el.getBoundingClientRect().height), 0, 'home has no unused typing line');
    assert.deepEqual(errors, []);
    console.log('Room roster restoration, responsive transition, typing layout and lifecycle: PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
