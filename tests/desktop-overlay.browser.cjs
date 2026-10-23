/* Real call/profile events and controls; fake media/backend, no remote writes. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');

(async () => {
  const backend = createSharedFirebaseBackend(2);
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  const entry = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
  async function prepare(page) {
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.evaluate(() => {
      ChatApp.callRequestMicPermission = async () => new MediaStream();
      ChatApp.callRefreshIceServers = async () => [];
      ChatApp.callPrimePlaybackContextFromGesture = () => null;
      ChatApp.callStartWebRTC = () => {};
      ChatApp.callStartSpeakingMonitor = () => {};
      ChatApp.callEnsurePeers = async () => {};
      ChatApp.callResumeRemoteAudio = async () => true;
    });
  }
  async function client(code, desktop) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await backend.bind(context);
    if (desktop) await context.addInitScript(() => {
      window.__overlaySnapshots = [];
      window.chatDesktopOverlay = { version: 1, publish: snapshot => window.__overlaySnapshots.push(structuredClone(snapshot)) };
    });
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(entry);
    await prepare(page);
    await page.click('#btn-go-login');
    await page.fill('#login-code', code);
    await page.click('#btn-login');
    await page.waitForFunction(code => ChatApp.currentUser?.code === code, code);
    await page.evaluate(() => ChatApp.openRoom('test', { quiet: true }));
    return page;
  }
  async function join(page) {
    await page.evaluate(() => ChatApp.joinCall('test'));
    assert.equal(await page.evaluate(() => ChatApp.currentCallRoomId), 'test');
    return page.evaluate(() => ChatApp.callAudioPreferenceScope.instanceId);
  }
  async function leave(page) {
    await page.evaluate(() => ChatApp.leaveCall({ quiet: true }));
  }
  try {
    const desktop = await client('P1', true);
    const web = await client('P2', false);
    assert.equal(await desktop.locator('#btn-call-overlay').isHidden(), true, 'hidden before joining');
    const firstInstance = await join(desktop);
    await join(web);
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1)?.members.length === 2);
    assert.equal(await desktop.locator('#btn-call-overlay').isVisible(), true);
    assert.equal(await web.locator('#btn-call-overlay').isHidden(), true, 'web clients have no overlay control');
    assert.equal(await desktop.locator('#btn-call-overlay').getAttribute('aria-pressed'), 'true');
    assert.equal(await desktop.locator('[id^="btn-sidebar-call"][id*="overlay"]').count(), 0);
    const controls = await desktop.locator('.call-menu-controls').boundingBox();
    const toggle = await desktop.locator('#btn-call-overlay').boundingBox();
    assert.ok(toggle.x >= controls.x && toggle.x + toggle.width <= controls.x + controls.width + 1);

    await desktop.click('#btn-call-overlay');
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).enabled), false);
    assert.equal(await desktop.locator('#btn-call-overlay').getAttribute('aria-label'), 'Turn On Call Overlay');
    await leave(desktop);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).active), false);
    assert.equal(backend.get('calls/test/instanceId'), firstInstance);
    assert.equal(await join(desktop), firstInstance);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).enabled), true, 'rejoining the same call defaults to enabled');
    await desktop.click('#btn-call-overlay');

    await leave(desktop);
    await desktop.reload();
    await prepare(desktop);
    await desktop.waitForFunction(() => ChatApp.currentUser?.code === 'P1');
    assert.equal(await join(desktop), firstInstance);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).enabled), true, 'joining after reload defaults to enabled');
    await desktop.evaluate(() => ChatApp.closeCallMenu());
    await web.evaluate(async () => {
      await ChatApp.db.ref('users/P2').update({ displayName: 'Aaron', displayNameLower: 'aaron',
        photoDataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        photoTransform: { x: 21, y: -42, scale: 2 } });
      await ChatApp.db.ref('calls/test/members/P2').update({ speaking: true, muted: false, deafened: false });
    });
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1)?.members[0]?.displayName === 'Aaron' && __overlaySnapshots.at(-1).members[0].speaking);
    const updated = await desktop.evaluate(() => __overlaySnapshots.at(-1).members[0]);
    assert.equal(updated.code, 'P2');
    assert.equal(updated.photoDataURL.startsWith('data:image/png;base64,'), true);
    assert.deepEqual(updated.photoTransform, { unit: 'rel', x: 0.25, y: -0.5, scale: 2 });
    assert.equal(await desktop.evaluate(() => ChatApp.callMenuOpen), false, 'live overlay updates do not depend on an open call panel');
    await web.evaluate(() => ChatApp.db.ref('calls/test/members/P2').update({ speaking: true, muted: true }));
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2')?.muted);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2').speaking), false);
    await desktop.evaluate(() => {
      ChatApp.callMuted = false;
      ChatApp.callDeafened = false;
      ChatApp.callSetLocalSpeaking(true, { force: true });
    });
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P1').speaking), true, 'local speaking publishes synchronously');
    await desktop.evaluate(() => ChatApp.callSetLocalSpeaking(false, { force: true }));
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P1').speaking), false);

    await desktop.evaluate(async () => {
      ChatApp.callSharing = true;
      ChatApp.callScreenShareId = 'overlay-live-share';
      await ChatApp.myCallMemberRef.update({ sharing: true, shareId: 'overlay-live-share' });
      ChatApp.callSyncDesktopOverlay();
    });
    await web.evaluate(() => ChatApp.myCallMemberRef.update({ sharing: true, shareId: 'remote-live-share',
      viewingShares: { P1: 'overlay-live-share' }, viewingSharesSessionId: ChatApp.callSessionId }));
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2')?.watchingYourScreen);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2').sharing), true);
    await web.evaluate(() => ChatApp.myCallMemberRef.update({ viewingShares: null, sharing: false }));
    await desktop.waitForFunction(() => {
      const member = __overlaySnapshots.at(-1).members.find(member => member.code === 'P2');
      return member && !member.watchingYourScreen && !member.sharing;
    });
    await desktop.evaluate(async () => {
      ChatApp.callSharing = false;
      ChatApp.callScreenShareId = '';
      await ChatApp.myCallMemberRef.update({ sharing: false, shareId: null });
      ChatApp.callSyncDesktopOverlay();
    });

    await web.evaluate(() => ChatApp.db.ref('users/P2').update({ photoDataURL: null, photoTransform: null }));
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2')?.photoDataURL === ChatApp.defaultStickmanDataURL());
    await web.evaluate(() => ChatApp.myCallMemberRef.update({ cameraSharing: true, cameraShareId: 'camera-overlay' }));
    await desktop.waitForFunction(() => {
      const member = __overlaySnapshots.at(-1).members.find(member => member.code === 'P2');
      return member?.cameraSharing && member.photoDataURL === ChatApp.defaultStickmanDataURL() && member.photoTransform.scale === 1;
    });
    assert.equal(await desktop.evaluate(() => ChatApp.liveUserCache.get('P2')?.photoDataURL === ChatApp.defaultStickmanDataURL()), true, 'Camera state never changes the saved profile');
    assert.equal(backend.get('users/P2/photoDataURL'), null);
    if (process.argv[2]) {
      fs.mkdirSync(process.argv[2], { recursive: true });
      const overlayState = await desktop.evaluate(() => structuredClone(__overlaySnapshots.at(-1)));
      const overlay = await browser.newPage({ viewport: { width: 360, height: 150 } });
      await overlay.addInitScript(state => {
        window.chatOverlayDisplay = { onState(callback) { window.addEventListener('DOMContentLoaded', () => callback(state)); }, painted() {} };
      }, overlayState);
      await overlay.goto(pathToFileURL(path.resolve(__dirname, '../desktop/ui/overlay.html')).href);
      await overlay.waitForFunction(() => document.querySelectorAll('.overlay-member').length === 2);
      await overlay.waitForTimeout(150);
      await overlay.screenshot({ path: path.join(process.argv[2], 'overlay-camera.png'), omitBackground: true });
      await overlay.close();
    }
    await web.evaluate(() => ChatApp.myCallMemberRef.update({ cameraSharing: false, cameraShareId: null }));
    await desktop.waitForFunction(() => __overlaySnapshots.at(-1).members.find(member => member.code === 'P2')?.photoDataURL === ChatApp.defaultStickmanDataURL());
    await desktop.evaluate(() => ChatApp.callToggleDesktopOverlay());
    await leave(web);
    await leave(desktop);
    assert.equal(backend.get('calls/test'), null);
    const secondInstance = await join(desktop);
    assert.notEqual(secondInstance, firstInstance);
    assert.equal(await desktop.evaluate(() => __overlaySnapshots.at(-1).enabled), true, 'new call resets to on after everyone leaves');
    await leave(desktop);
    assert.deepEqual(errors, []);
    assert.deepEqual(backend.deliveryErrors, []);
    console.log('Desktop overlay: call-instance lifetime, reload, desktop-only controls, live profile/crop/speaking/share/viewer state with closed menu, and final reset PASS');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
