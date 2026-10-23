/* Exercise the visible device pickers using real pointer events. In particular,
 * inspecting/selecting the hidden native <select> cannot detect portal layering,
 * clipping, stale custom buttons, or an outside-click handler closing its parent. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
const root = path.resolve(process.env.AUDIO_DEVICE_SOURCE_ROOT || path.join(__dirname, '..'));
const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + requested);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream' });
    res.end(error ? 'Not found' : data);
  });
});

function installDeviceFixture() {
  window.__deviceUi = { captureRequests: 0, actions: [], animations: [] };
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk Microphone' },
    { kind: 'audioinput', deviceId: 'headset-mic', label: 'Headset Microphone' },
    { kind: 'audiooutput', deviceId: 'desk-speakers', label: 'Desk Speakers' },
    { kind: 'audiooutput', deviceId: 'headphones', label: 'USB Headphones' }
  ];
  navigator.mediaDevices.getUserMedia = async () => {
    __deviceUi.captureRequests++;
    throw new Error('Opening or selecting an output must never request microphone capture');
  };
  for (const eventName of ['animationstart', 'animationend']) document.addEventListener(eventName, event => {
    if (!event.target.matches?.('.call-audio-settings-menu')) return;
    const style = getComputedStyle(event.target);
    __deviceUi.animations.push({ event: eventName, target: event.target.id, name: event.animationName,
      duration: style.animationDuration, easing: style.animationTimingFunction, hidden: event.target.hidden });
  }, true);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const contexts = [];
  const errors = [];
  const urls = [pathToFileURL(path.join(root, 'index.html')).href, `http://127.0.0.1:${server.address().port}/index.html`];
  try {
    for (const url of urls) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      contexts.push(context);
      await context.addInitScript(installFirebaseMock);
      await context.addInitScript(installDeviceFixture);
      await context.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login');
      await page.fill('#login-code', 'TEST-USER');
      await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      await page.evaluate(async () => {
        await ChatApp.openRoom('test', { quiet: true });
        ChatApp.currentCallRoomId = 'test';
        ChatApp.callSessionId = 'device-pointer-test';
        ChatApp.callMembersCache = [{ code: 'TEST-USER', connected: true, joinedAt: Date.now() }];
        ChatApp.callPreferredAudioInputId = 'desk-mic';
        ChatApp.callPreferredAudioOutputId = '';
        ChatApp.callSetInputDevice = async value => { __deviceUi.actions.push(['input', value]); ChatApp.callPreferredAudioInputId = value; return true; };
        ChatApp.callSetOutputDevice = async value => { __deviceUi.actions.push(['output', value]); ChatApp.callPreferredAudioOutputId = value; return true; };
        ChatApp.closeToast();
        ChatApp.syncCallControlsUI();
        ChatApp.openCallMenu();
        document.body.dataset.mobileNav = '0';
      });

      for (const surface of ['main', 'sidebar']) {
        await page.evaluate(surface => {
          if (surface === 'main') { ChatApp.openCallMenu(); document.body.dataset.mobileNav = '0'; }
          else { ChatApp.closeCallMenu(); if (document.body.dataset.mobileUi === '1') document.body.dataset.mobileNav = '1'; }
        }, surface);
        await page.waitForTimeout(350);
        for (const kind of ['output', 'input']) {
          // The outside click after each device menu also closes the mobile
          // drawer. Reopen it before exercising the next sidebar control.
          if (surface === 'sidebar') {
            await page.evaluate(() => { if (document.body.dataset.mobileUi === '1') document.body.dataset.mobileNav = '1'; });
            await page.waitForTimeout(250);
          }
          const prefix = surface === 'main' ? 'btn-call' : 'btn-sidebar-call';
          const menu = page.locator(`#call-${kind}-settings-menu`);
          await page.click(`#${prefix}-${kind}-settings`);
          await page.waitForTimeout(180);
          const customButton = page.locator(`#call-${kind}-device + .custom-select-dd .custom-select-btn`);
          assert.equal(await customButton.isVisible(), true, 'Interact with the visible custom device button');
          await customButton.click();
          const popup = page.locator('.custom-select-pop.portal:visible');
          await popup.waitFor({ state: 'visible' });
          const hitTests = await popup.locator('.custom-select-opt').evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { label: node.textContent.trim(), value: node.dataset.value, hit: node === hit || node.contains(hit),
              blockedBy: hit?.id || hit?.className || '', width: box.width, height: box.height };
          }));
          assert.equal(hitTests.filter(option => option.value).length >= 2, true, `${kind} shows at least two real devices in the rendered popup`);
          assert.equal(hitTests.every(option => option.hit && option.width > 0 && option.height > 0), true,
            `Device options must receive pointer hits above the parent menu (${new URL(url).protocol}, ${viewport.width}, ${surface}, ${kind}): ${JSON.stringify(hitTests)}`);
          if (process.env.AUDIO_DEVICE_SCREENSHOT_DIR && surface === 'main') {
            fs.mkdirSync(process.env.AUDIO_DEVICE_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.AUDIO_DEVICE_SCREENSHOT_DIR, `${new URL(url).protocol.replace(':', '')}-${viewport.width}-${kind}.png`) });
          }
          const value = kind === 'input' ? (surface === 'sidebar' ? 'desk-mic' : 'headset-mic') : (surface === 'sidebar' ? 'desk-speakers' : 'headphones');
          const label = kind === 'input' ? (value === 'desk-mic' ? 'Desk Microphone' : 'Headset Microphone') : (value === 'desk-speakers' ? 'Desk Speakers' : 'USB Headphones');
          const actionCount = await page.evaluate(() => __deviceUi.actions.length);
          await popup.locator(`[data-value="${value}"]`).click();
          await page.waitForFunction(count => __deviceUi.actions.length === count + 1, actionCount);
          assert.deepEqual(await page.evaluate(() => __deviceUi.actions.at(-1)), [kind, value], 'Every pointer selection invokes exactly one device-switch action');
          assert.equal(await menu.isVisible(), true, 'Selecting a portaled device keeps its parent settings menu open');
          await page.waitForFunction(({ kind, label }) => document.querySelector(`#call-${kind}-device + .custom-select-dd .custom-select-btn`)?.textContent === label, { kind, label });
          assert.equal(await customButton.isEnabled(), true, 'Switch completion restores the visible picker');
          assert.equal(await popup.count(), 0, 'Selected device popup closes cleanly');
          assert.equal(await page.evaluate(() => __deviceUi.captureRequests), 0, 'Output selection never requests microphone permission');
          await page.mouse.click(viewport.width - 5, 5);
          await menu.waitFor({ state: 'hidden' });
          assert.equal(await page.locator('.custom-select-pop.portal:visible').count(), 0, 'Closing the parent leaves no orphaned device popup');
          const animations = await page.evaluate(kind => __deviceUi.animations.filter(item => item.target === `call-${kind}-settings-menu`), kind);
          for (const name of ['msgMenuIn', 'msgMenuOut']) {
            const event = animations.find(item => item.event === 'animationstart' && item.name === name);
            assert.ok(event, `Audio menu uses the shared ${name} animation`);
            assert.equal(event.duration, '0.14s');
            assert.equal(event.easing, 'cubic-bezier(0.16, 0.9, 0.22, 1)');
            assert.equal(event.hidden, false, 'Opening and closing remain rendered during animation');
          }
        }
      }
      // Permission recovery must update the visible enhanced picker too. A test
      // of hidden native <option> nodes alone missed the original broken UI.
      await page.evaluate(() => {
        ChatApp.openCallMenu();
        document.body.dataset.mobileNav = '0';
        ChatApp.callPreferredAudioInputId = '';
        __deviceUi.permissionAllowed = false;
        __deviceUi.temporaryStops = 0;
        navigator.mediaDevices.enumerateDevices = async () => __deviceUi.permissionAllowed ? [
          { kind: 'audioinput', deviceId: 'permission-desk', label: 'Allowed Desk Microphone' },
          { kind: 'audioinput', deviceId: 'permission-headset', label: 'Allowed Headset Microphone' }
        ] : [{ kind: 'audioinput', deviceId: '', label: '' }];
        navigator.mediaDevices.getUserMedia = async () => {
          __deviceUi.captureRequests++;
          __deviceUi.permissionAllowed = true;
          const track = { kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; __deviceUi.temporaryStops++; } };
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        };
      });
      await page.waitForTimeout(200);
      await page.click('#btn-call-input-settings');
      const access = page.locator('#call-input-device-access');
      await access.waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => __deviceUi.captureRequests), 0, 'Only the explicit input permission action requests capture');
      await access.click();
      await access.waitFor({ state: 'hidden' });
      await page.locator('#call-input-device + .custom-select-dd .custom-select-btn').click();
      const allowedPopup = page.locator('.custom-select-pop.portal:visible');
      const allowedOption = allowedPopup.locator('[data-value="permission-headset"]');
      await allowedOption.waitFor({ state: 'visible' });
      assert.equal(await allowedOption.evaluate(node => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      }), true, 'Newly authorized microphone is visible and can receive pointer input');
      const permissionActionCount = await page.evaluate(() => __deviceUi.actions.length);
      await allowedOption.click();
      await page.waitForFunction(count => __deviceUi.actions.length === count + 1, permissionActionCount);
      assert.deepEqual(await page.evaluate(() => __deviceUi.actions.at(-1)), ['input', 'permission-headset']);
      assert.equal(await page.locator('#call-input-settings-menu').isVisible(), true);
      assert.equal(await page.locator('#call-input-device + .custom-select-dd .custom-select-btn').textContent(), 'Allowed Headset Microphone');
      assert.deepEqual(await page.evaluate(() => [__deviceUi.captureRequests, __deviceUi.temporaryStops]), [1, 1], 'Input permission recovery releases its temporary capture');
      await page.mouse.click(viewport.width - 5, 5);
      await page.locator('#call-input-settings-menu').waitFor({ state: 'hidden' });
      console.log(JSON.stringify({ origin: new URL(url).protocol, viewport, mainAndSidebarPointerDeviceSelection: true, menuAnimations: true, outputMicrophoneRequests: 0, visibleInputPermissionRecovery: true }));
      await context.close();
    }
    assert.deepEqual(errors, [], 'All rendered-device scenarios complete without page errors');
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
