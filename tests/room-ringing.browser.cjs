/* Production UI with an in-memory Firebase server and the desktop preload contract. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  try {
    await context.addInitScript(mock);
    await context.addInitScript(() => {
      window.__ringPublications = [];
      window.chatDesktopRings = { version: 1,
        publish: state => window.__ringPublications.push(state),
        onCommand: callback => window.__ringCommand = callback,
        onVisibility: callback => window.__ringVisibility = callback,
        getVisibility: async () => ({ focused: true })
      };
    });
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login');
    await page.fill('#login-code', 'TEST-USER');
    await page.click('#btn-login');
    await page.waitForFunction(() => ChatApp.currentUser);
    await page.evaluate(async () => {
      const A = ChatApp;
      await A.db.ref('users/BOB').set({ username: 'Bob', usernameLower: 'bob', displayName: 'Bob', displayNameLower: 'bob' });
      await A.db.ref('usernames/bob').set('BOB');
      await A.db.ref('displayNames/bob').set('BOB');
      await A.db.ref('memberships/BOB/test').set(true);
      await A.db.ref('roomMembers/test/BOB').set(true);
      await A.openRoom('test', { quiet: true });
      A.closeToast();
      A.currentCallRoomId = 'test'; A.callSessionId = 'self-session';
      A.callEnsurePeers = () => {};
      await A.db.ref('calls/test').set({ instanceId: 'first-call', members: {
        'TEST-USER': { code: 'TEST-USER', sessionId: 'self-session', username: 'Tester', displayName: 'Tester', connected: true, joinedAt: Date.now(), lastSeenAt: Date.now() }
      } });
      A.callSyncRingingSession();
      A.openCallMenu();
    });
    await page.waitForFunction(() => ChatApp.getProfileRingAction('BOB')?.label === 'Ring');
    const bob = page.locator('.members-sidebar .online-ava[data-usercode="BOB"] .online-ava-img');
    await bob.click({ button: 'right' });
    await page.locator('#msg-menu [data-call-ring]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#msg-menu [data-call-ring]').innerText(), 'Ring');
    assert.equal(await page.locator('#msg-menu [data-call-ring] svg').count(), 1, 'SVG bell, never an emoji');
    assert.equal(await page.locator('#msg-menu [data-call-ring] .msg-menu-icon').evaluate(el => getComputedStyle(el).color),
      await page.locator('#msg-menu [data-act="copyImageAddress"] .msg-menu-icon').evaluate(el => getComputedStyle(el).color),
      'Ring uses the same icon color as the other context-menu actions');
    // Keep the menu open to detect the old 200ms idle loop and redundant label
    // writes, not merely IPC deduplication. This is the actual production UI.
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.__ringIdle = { refreshes: 0, menuSyncs: 0, mutations: 0, startedAt: performance.now() };
      const refresh = ChatApp.callRefreshRinging, menu = ChatApp.callSyncRingMenu;
      ChatApp.callRefreshRinging = function (...args) { ++__ringIdle.refreshes; return refresh.apply(this, args); };
      ChatApp.callSyncRingMenu = function (...args) { ++__ringIdle.menuSyncs; return menu.apply(this, args); };
      window.__ringIdleObserver = new MutationObserver(records => { __ringIdle.mutations += records.length; });
      __ringIdleObserver.observe(document.querySelector('#msg-menu [data-call-ring]'), { attributes: true, childList: true, characterData: true, subtree: true });
    });
    await page.waitForTimeout(3200);
    const idle = await page.evaluate(() => { __ringIdleObserver.disconnect(); return { ...__ringIdle, elapsedMs: Math.round(performance.now() - __ringIdle.startedAt) }; });
    assert.equal(idle.refreshes, 0, 'idle ring feature performs no periodic refreshes');
    assert.equal(idle.menuSyncs, 0, 'unchanged open menu does not get rescanned');
    assert.equal(idle.mutations, 0, 'unchanged Ring label and styling cause zero DOM writes');
    console.log('Measured ring idle work:', JSON.stringify(idle));
    await page.locator('#msg-menu [data-call-ring]').click();
    await page.waitForFunction(() => document.querySelector('.call-participant.is-ringing[data-usercode="BOB"]'));
    assert.equal(await page.locator('#msg-menu [data-call-ring]').innerText(), 'Stop Ringing', 'open context menu updates without reopening');
    assert.equal(await page.evaluate(() => ChatApp.callMembersCache.some(user => user.code === 'BOB')), false, 'ringing tile is not a call member');
    assert.ok(await page.locator('.call-participant.is-ringing').evaluate(el => Number(getComputedStyle(el).opacity) < 0.6));
    assert.equal(await page.locator('.call-participant.is-ringing .call-ringing-label').innerText(), 'Ringing…');
    const report = path.resolve(__dirname, '../../room-ringing-checks');
    fs.mkdirSync(report, { recursive: true });
    await page.screenshot({ path: path.join(report, 'ringing-call-menu.png') });
    await page.locator('.call-participant.is-ringing .call-user-avatar').click({ button: 'right' });
    await page.locator('#call-user-context-menu [data-call-ring]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#call-user-context-menu [data-call-ring]').innerText(), 'Stop Ringing');
    assert.equal(await page.locator('#call-user-context-menu .call-user-volume-control').isVisible(), false, 'unjoined invitees have no volume slider');
    await page.locator('#call-user-context-menu [data-call-ring]').click();
    await page.waitForFunction(() => !document.querySelector('.call-participant.is-ringing'));
    await page.evaluate(async () => {
      const A = ChatApp;
      await A.db.ref('rooms/other').set({ name: 'Other Room' });
      await A.db.ref('memberships/TEST-USER/other').set(true);
      await A.db.ref('memberships/BOB/other').set(true);
      await A.db.ref('roomMembers/other').update({'TEST-USER':true,BOB:true});
      await A.db.ref('calls/other').set({ instanceId: 'other-call', members: {
        BOB: { code: 'BOB', sessionId: 'bob-session', connected: true, joinedAt: Date.now(), lastSeenAt: Date.now() }
      }, rings: { 'TEST-USER': { id: 'incoming', from: 'BOB', to: 'TEST-USER', instanceId: 'other-call', createdAt: Date.now() } } });
    });
    await page.waitForFunction(() => window.__ringPublications.at(-1)?.rings[0]?.roomName === 'Other Room');
    await page.evaluate(() => ChatApp.db.ref('rooms/other/name').set('Renamed Live'));
    await page.waitForFunction(() => window.__ringPublications.at(-1)?.rings[0]?.roomName === 'Renamed Live');
    await page.evaluate(async () => { await ChatApp.openRoom('other'); window.__ringVisibility({ focused: true }); });
    await page.waitForFunction(() => window.__ringPublications.at(-1)?.rings.length === 0);
    await page.evaluate(() => window.__ringVisibility({ focused: false }));
    await page.waitForFunction(() => window.__ringPublications.at(-1)?.rings.length === 1);
    await page.evaluate(() => window.__ringCommand({ action: 'decline', roomId: 'other', id: 'incoming' }));
    await page.waitForFunction(() => window.__ringPublications.at(-1)?.rings.length === 0);
    assert.deepEqual(errors, []);
    console.log('Room ringing browser checks passed: production menu, translucent roster, shared stop, native payloads, live metadata, focused-room suppression and decline.');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
