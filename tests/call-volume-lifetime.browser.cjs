/* Exercise real call membership/preferences against the shared in-memory backend.
 * Media acquisition and peer transport are stubbed; external HTTP is blocked. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { createHash } = require('node:crypto');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');

const entry = pathToFileURL(path.resolve(__dirname, '../index.html')).href;
const oldKey = 'chatapp_call_user_volumes_v1';
async function volumes(page, code) {
  return page.evaluate(code => ({ user: ChatApp.callGetUserVolumePercent(code), screen: ChatApp.callGetScreenVolume(code), muted: ChatApp.callIsScreenMuted(code) }), code);
}
async function controls(page) {
  return page.evaluate(() => ({ input: ChatApp.callGetInputVolumePercent(), output: ChatApp.callGetOutputVolumePercent() }));
}
async function setControls(page, input, output) {
  await page.evaluate(async ({ input, output }) => {
    ChatApp.callSetInputVolumePercent(input);
    ChatApp.callSetOutputVolumePercent(output);
    await ChatApp.callFlushAudioPreferences();
  }, { input, output });
}
async function join(page, room = 'test') {
  await page.evaluate(room => ChatApp.joinCall(room, { openMenu: false }), room);
  assert.equal(await page.evaluate(() => ChatApp.currentCallRoomId), room, 'the actual join lifecycle completed');
  return page.evaluate(() => ChatApp.callAudioPreferenceScope.instanceId);
}
async function leave(page) {
  await page.evaluate(() => ChatApp.leaveCall({ quiet: true }));
  assert.equal(await page.evaluate(() => ChatApp.currentCallRoomId), null);
}
async function setVolumes(page, code, user, screen, muted) {
  await page.evaluate(async ({ code, user, screen, muted }) => {
    ChatApp.callSetUserVolumePercent(code, user);
    ChatApp.callSetScreenVolume(code, screen);
    ChatApp.callSetScreenMuted(code, muted);
    await ChatApp.callFlushAudioPreferences();
  }, { code, user, screen, muted });
}

(async () => {
  const backend = createSharedFirebaseBackend(2);
  backend.values.credentials = {};
  for (const code of ['P1', 'P2']) {
    const credentialHash = createHash('sha256').update(`VOLUME-${code}-PASSWORD`).digest('hex');
    backend.values.users[code].credentialHash = credentialHash;
    backend.values.credentials[credentialHash] = code;
  }
  backend.values.rooms.other = { name: 'Other call', createdBy: 'P1', createdAt: Date.now() };
  backend.values.memberships.P1.other = true;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  async function listener(code) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await backend.bind(context);
    await context.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify({ P1: 5, P2: 25 }));
      window.__volumeStorageWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && /volume|mutedscreen/i.test(key)) window.__volumeStorageWrites.push(key);
        return original.call(this, key, value);
      };
    }, oldKey);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`${code}: ${error.message}`));
    await page.goto(entry);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.click('#btn-go-login');
    await page.fill('#login-code', `VOLUME-${code}-PASSWORD`);
    await page.click('#btn-login');
    await page.waitForFunction(code => ChatApp.currentUser?.code === code, code);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), oldKey), null, 'legacy local preferences are retired');
    await page.evaluate(() => {
      ChatApp.callRequestMicPermission = async () => new MediaStream();
      ChatApp.callRefreshIceServers = async () => [];
      ChatApp.callPrimePlaybackContextFromGesture = () => null;
      ChatApp.callStartWebRTC = () => {};
      ChatApp.callEnsurePeers = async () => {};
      ChatApp.callResumeRemoteAudio = async () => true;
    });
    return page;
  }
  try {
    const one = await listener('P1');
    const two = await listener('P2');
    const firstInstance = await join(one);
    assert.ok(firstInstance);
    assert.equal(await join(two), firstInstance, 'another member joins the same call instance');
    assert.deepEqual(await volumes(one, 'P2'), { user: 100, screen: 100, muted: false });
    assert.deepEqual(await volumes(two, 'P1'), { user: 100, screen: 100, muted: false });
    assert.deepEqual(await controls(one), { input: 100, output: 100 });
    assert.deepEqual(await controls(two), { input: 100, output: 100 });

    await setVolumes(one, 'P2', 275, 320, true);
    await setVolumes(two, 'P1', 50, 140, false);
    await setControls(one, 35, 160);
    await setControls(two, 80, 50);
    assert.deepEqual(backend.get('calls/test/audioPreferences/P1'), { users: { P2: 275 }, screens: { P2: 320 }, mutedScreens: { P2: true }, mutedUsers: {}, inputVolume: 35, outputVolume: 160 });
    assert.deepEqual(backend.get('calls/test/audioPreferences/P2'), { users: { P1: 50 }, screens: { P1: 140 }, mutedScreens: {}, mutedUsers: {}, inputVolume: 80, outputVolume: 50 });
    assert.equal(await one.evaluate(() => ChatApp.callGetPlaybackGain('P2')), 4.4, 'master output multiplies the listener\'s user volume');
    assert.deepEqual(await volumes(one, 'OTHER-SCREEN'), { user: 100, screen: 100, muted: false }, 'separate screen settings stay independent');
    const oldScope = await one.evaluate(() => ({ ...ChatApp.callAudioPreferenceScope }));
    await one.evaluate(async () => { ChatApp.callSetUserMuted('P2', true); await ChatApp.callFlushAudioPreferences(); });

    await leave(one);
    assert.equal(backend.get('calls/test/instanceId'), firstInstance, 'a remaining participant keeps the call alive');
    assert.ok(backend.get('calls/test/audioPreferences/P1'), 'a departed listener retains settings while the call exists');
    await one.evaluate(() => ChatApp.callAudioPreferenceCache.clear());
    assert.equal(await join(one), firstInstance);
    assert.deepEqual(await volumes(one, 'P2'), { user: 275, screen: 320, muted: true }, 'rejoin reloads saved server values without local memory');
    assert.equal(await one.evaluate(() => ChatApp.callIsUserMuted('P2')), true, 'participant mute survives rejoining the same ongoing call');
    await one.evaluate(async () => { ChatApp.callSetUserMuted('P2', false); await ChatApp.callFlushAudioPreferences(); });
    assert.deepEqual(await volumes(two, 'P1'), { user: 50, screen: 140, muted: false }, 'one listener never changes another listener settings');
    assert.deepEqual(await controls(one), { input: 35, output: 160 }, 'input/output reload from the still-active call');
    assert.deepEqual(await controls(two), { input: 80, output: 50 }, 'control volumes remain personal');

    await leave(one);
    const otherInstance = await join(one, 'other');
    assert.notEqual(otherInstance, firstInstance);
    assert.deepEqual(await volumes(one, 'P2'), { user: 100, screen: 100, muted: false }, 'another room begins with defaults');
    assert.deepEqual(await controls(one), { input: 100, output: 100 }, 'another room resets the master controls');
    await setVolumes(one, 'P2', 40, 70, false);
    await setControls(one, 10, 20);
    assert.equal(backend.get('calls/test/audioPreferences/P1/users/P2'), 275, 'a different room cannot change original preferences');
    await leave(one);
    assert.equal(backend.get('calls/other'), null, 'last departure removes the other call and preferences');
    assert.equal(await join(one), firstInstance);
    assert.deepEqual(await volumes(one, 'P2'), { user: 275, screen: 320, muted: true }, 'returning to the original still-live call restores only its settings');
    assert.deepEqual(await controls(one), { input: 35, output: 160 });

    await leave(two);
    assert.equal(backend.get('calls/test/instanceId'), firstInstance);
    await one.evaluate(async () => {
      await ChatApp.db.ref('calls/test/members/OLD-DISCONNECTED').set({ code: 'OLD-DISCONNECTED', sessionId: 'old-session', connected: false, disconnectedAt: Date.now() - ChatApp.CALL_STALE_MEMBER_MS - 5000, lastSeenAt: Date.now() });
    });
    await leave(one);
    assert.equal(backend.get('calls/test'), null, 'the last live departure removes preferences even with an obsolete disconnected row');

    const staleWrite = { scope: oldScope, preferences: { users: { P2: 399 }, screens: { P2: 399 }, mutedScreens: { P2: true }, mutedUsers: {}, inputVolume: 1, outputVolume: 199 } };
    await one.evaluate(async pending => { ChatApp.callAudioPreferencePending = pending; await ChatApp.callFlushAudioPreferences(); }, staleWrite);
    assert.equal(backend.get('calls/test'), null, 'a delayed preference write cannot recreate an ended call');

    const nextInstance = await join(one);
    assert.notEqual(nextInstance, firstInstance, 'a completely new call receives another instance');
    assert.deepEqual(await volumes(one, 'P2'), { user: 100, screen: 100, muted: false }, 'all settings reset for a new call');
    assert.deepEqual(await controls(one), { input: 100, output: 100 }, 'new call resets input/output volumes');
    await one.evaluate(async pending => { ChatApp.callAudioPreferencePending = pending; await ChatApp.callFlushAudioPreferences(); }, staleWrite);
    assert.equal(backend.get('calls/test/audioPreferences'), null, 'a delayed old-instance write cannot mutate a new call');
    assert.equal(await join(two), nextInstance);
    assert.deepEqual(await volumes(two, 'P1'), { user: 100, screen: 100, muted: false }, 'each listener resets when the previous call ended');
    assert.deepEqual(await controls(two), { input: 100, output: 100 });

    await setVolumes(one, 'P2', 900, -20, false);
    assert.deepEqual(await volumes(one, 'P2'), { user: 400, screen: 100, muted: false }, 'explicit unmute restores audible volume after clamping to zero');
    await one.evaluate(() => ChatApp.callSetScreenVolume('P2', -20));
    assert.deepEqual(await volumes(one, 'P2'), { user: 400, screen: 0, muted: true }, 'zero volume marks only the selected screen muted');
    await setControls(one, -20, 900);
    assert.deepEqual(await controls(one), { input: 0, output: 200 }, 'input/output lower and upper bounds are enforced');
    await setControls(one, 900, -20);
    assert.deepEqual(await controls(one), { input: 100, output: 0 }, 'input is never amplified and output can be silenced');
    await setVolumes(one, 'P2', 100, 100, false);
    await setControls(one, 100, 100);
    assert.deepEqual(backend.get('calls/test/audioPreferences/P1'), { users: {}, screens: {}, mutedScreens: {}, mutedUsers: {}, inputVolume: 100, outputVolume: 100 }, 'restoring defaults removes per-user overrides');
    for (const page of [one, two]) {
      assert.equal(await page.evaluate(key => localStorage.getItem(key), oldKey), null);
      assert.deepEqual(await page.evaluate(() => window.__volumeStorageWrites), [], 'call audio preferences are never saved in localStorage');
    }
    await leave(two);
    await leave(one);
    assert.equal(backend.get('calls/test'), null);
    assert.deepEqual(errors, []);
    assert.deepEqual(backend.deliveryErrors, []);
    console.log('Call volume lifetime: defaults, shared-call persistence, listener/room isolation, final cleanup, bounds, and delayed-write protection PASS');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
