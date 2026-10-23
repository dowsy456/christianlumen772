/* Nested activity input and lifecycle checks, with an entirely local database. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(installFirebaseMock);
    await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.evaluate(async () => {
      ChatApp.currentUser = await ChatApp.loginWithCode('TEST-USER');
      ChatApp.startAppPresence();
      const frame = document.createElement('iframe');
      frame.id = 'activity-presence-test';
      frame.style.cssText = 'position:fixed;inset:10px;width:500px;height:220px;z-index:999999;background:white';
      frame.srcdoc = '<!doctype html><input id="activity-input"><iframe id="nested-activity"></iframe>';
      document.body.appendChild(frame);
    });
    const activity = page.frameLocator('#activity-presence-test');
    await activity.locator('#activity-input').waitFor();
    await page.evaluate(() => {
      const inner = document.querySelector('#activity-presence-test').contentDocument.querySelector('#nested-activity');
      inner.srcdoc = '<!doctype html><input id="nested-input">';
    });
    const nested = activity.frameLocator('#nested-activity').locator('#nested-input');
    await nested.waitFor();
    await nested.focus();
    const setIdle = () => page.evaluate(() => {
      ChatApp.lastAppInputAt = Date.now() - ChatApp.ROOM_IDLE_MS - 100;
      ChatApp.syncAppIdle();
      return ChatApp.lastAppInputAt;
    });
    await setIdle();
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), true);
    await nested.press('A');
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), false, 'keyboard input inside a nested activity makes the app active');
    assert.ok(await page.evaluate(() => Date.now() - ChatApp.lastAppInputAt < 2000));

    await page.evaluate(() => {
      const frame = document.querySelector('#activity-presence-test');
      window.__oldActivityDocument = frame.contentDocument;
      window.__oldNestedDocument = frame.contentDocument.querySelector('#nested-activity').contentDocument;
      frame.srcdoc = '<!doctype html><input id="after-navigation">';
    });
    await activity.locator('#after-navigation').waitFor();
    await activity.locator('#after-navigation').focus();
    const afterNavigateIdleAt = await setIdle();
    await page.evaluate(() => {
      __oldActivityDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true }));
      __oldNestedDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true }));
    });
    assert.equal(await page.evaluate(() => ChatApp.lastAppInputAt), afterNavigateIdleAt, 'navigation cleans both obsolete document bindings');
    await activity.locator('#after-navigation').press('B');
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), false, 'new document receives an input binding after navigation');

    await page.evaluate(() => {
      const frame = document.querySelector('#activity-presence-test');
      window.__removedActivityDocument = frame.contentDocument;
      frame.remove();
    });
    const afterRemovalIdleAt = await setIdle();
    await page.evaluate(() => __removedActivityDocument.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true })));
    assert.equal(await page.evaluate(() => ChatApp.lastAppInputAt), afterRemovalIdleAt, 'removing the frame releases input listeners');

    await page.evaluate(() => new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.id = 'opaque-presence-test';
      frame.sandbox = 'allow-scripts';
      frame.srcdoc = '<script>addEventListener("message",()=>parent.postMessage({type:"app-input-active"},"*"))<\/script>';
      frame.addEventListener('load', resolve, { once: true });
      document.body.appendChild(frame);
    }));
    await page.waitForTimeout(100);
    const beforeOpaqueMessage = await setIdle();
    await page.evaluate(() => document.querySelector('#opaque-presence-test').contentWindow.postMessage('ping', '*'));
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => ChatApp.lastAppInputAt), beforeOpaqueMessage, 'opaque frame messages cannot manufacture app activity');
    await page.evaluate(() => {
      ChatApp.stopAppPresenceInputTracking();
      ChatApp.startAppPresenceInputTracking();
      ChatApp.startAppPresenceInputTracking();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', bubbles: true }));
    });
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), false, 'tracking restarts safely after page restoration');
    await page.evaluate(() => { document.getElementById('opaque-presence-test')?.remove(); document.activeElement?.blur(); });
    await page.keyboard.press('Shift+Z');
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), true, 'showing the blackout cloak immediately marks the session idle');
    await page.mouse.move(600, 400);
    await page.keyboard.press('A');
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), true, 'input on a visible cloak cannot advertise Online');
    await page.waitForTimeout(160);
    await page.keyboard.press('Shift+Z');
    assert.equal(await page.evaluate(() => ChatApp.myRoomIdle), false, 'removing the cloak restores the active session');
    await page.evaluate(() => { ChatApp.$('btn-side-settings').click(); });
    assert.equal(await page.locator('#settings-tab-name').count(), 1, 'web retains tab customization');
    await page.evaluate(() => { ChatApp.closeModal(); });
    await page.waitForTimeout(250);
    await page.evaluate(() => { globalThis.chatDesktopRings = { version: 1 }; ChatApp.$('btn-side-settings').click(); });
    assert.equal(await page.locator('#settings-tab-name').count(), 0, 'EXE omits tab name');
    assert.equal(await page.locator('#settings-tab-icon').count(), 0, 'EXE omits tab icon');
    assert.deepEqual(errors, []);
    console.log('App presence: nested frame activity, frame navigation/removal cleanup, opaque isolation and tracking restart passed');
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
