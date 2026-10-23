/* Device discovery/routing regression. Real Chromium fake hardware verifies
 * file:// and localhost; isolated fixtures cover permission/host edge cases. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + requested);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream' });
    res.end(error ? 'Not found' : data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const contexts = [];
  const errors = [];
  const fileUrl = pathToFileURL(path.join(root, 'index.html')).href;
  const httpUrl = `http://127.0.0.1:${server.address().port}/index.html`;
  async function app(url = fileUrl, fixture) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    contexts.push(context);
    await context.addInitScript(installFirebaseMock);
    if (fixture) await context.addInitScript(fixture);
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
      ChatApp.callSessionId = 'audio-device-test';
      ChatApp.callMembersCache = [{ code: 'TEST-USER', connected: true, joinedAt: Date.now() }];
      ChatApp.callMuted = true;
      ChatApp.callInputVolume = 41;
      ChatApp.callOutputVolume = 73;
      ChatApp.closeToast();
      ChatApp.syncCallControlsUI();
      ChatApp.openCallMenu();
    });
    return page;
  }
  const choices = (page, kind) => page.locator(`#call-${kind}-device option`).evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
  async function open(page, kind) {
    await page.evaluate(() => ChatApp.closeCallAudioSettings());
    await page.click(`#btn-call-${kind}-settings`);
    await page.waitForFunction(kind => !document.getElementById(`call-${kind}-settings-menu`).hidden, kind);
  }
  try {
    // No enumerateDevices/getUserMedia/setSinkId mocks in these two cases.
    for (const url of [fileUrl, httpUrl]) {
      const page = await app(url);
      const baseline = await page.evaluate(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        window.__originalDeviceStream = stream;
        ChatApp.callRawMicrophoneStream = stream;
        ChatApp.callLocalStream = stream;
        const track = stream.getAudioTracks()[0];
        track.enabled = false;
        ChatApp.callPreferredAudioInputId = track.getSettings().deviceId;
        const devices = await navigator.mediaDevices.enumerateDevices();
        await ChatApp.callRefreshAudioDevices();
        return { secure: isSecureContext, inputs: devices.filter(device => device.kind === 'audioinput').map(device => device.deviceId), label: track.label, selected: track.getSettings().deviceId === 'default' ? '' : track.getSettings().deviceId };
      });
      assert.equal(baseline.secure, true);
      assert.ok(baseline.inputs.length > 0, 'Native fake microphone enumeration returns devices');
      await open(page, 'input');
      await page.waitForFunction(id => [...document.getElementById('call-input-device').options].some(option => option.value === id), baseline.selected);
      const inputOptions = await choices(page, 'input');
      assert.ok(inputOptions.some(option => option.value === baseline.selected && !/unavailable/i.test(option.label)), 'Active native microphone is identified');
      const realInput = baseline.inputs.find(id => id && id !== 'default' && id !== 'communications') || baseline.selected;
      await page.locator('#call-input-device + .custom-select-dd .custom-select-btn').click();
      await page.locator('.custom-select-pop.portal').getByRole('button', { name: inputOptions.find(option => option.value === realInput).label, exact: true }).click();
      await page.waitForFunction(id => ChatApp.callPreferredAudioInputId === id && !ChatApp.callMicRefreshPending, realInput);
      assert.equal(await page.evaluate(() => __originalDeviceStream.getTracks().every(track => track.readyState === 'ended')), true, 'Clicking a rendered device row invokes the actual microphone replacement pipeline');
      const routed = await page.evaluate(async () => {
        const selected = ChatApp.callPreferredAudioInputId;
        const success = await ChatApp.callSetInputDevice(selected);
        const audio = document.createElement('audio');
        await audio.setSinkId('');
        const outputSuccess = await ChatApp.callSetOutputDevice('');
        return { success, outputSuccess, muted: ChatApp.callMuted, input: ChatApp.callInputVolume, output: ChatApp.callOutputVolume,
          originalStopped: __originalDeviceStream.getTracks().every(track => track.readyState === 'ended'),
          currentLive: ChatApp.callRawMicrophoneStream.getAudioTracks()[0].readyState === 'live', sink: audio.sinkId };
      });
      assert.deepEqual(routed, { success: true, outputSuccess: true, muted: true, input: 41, output: 73, originalStopped: true, currentLive: true, sink: '' });
      console.log(JSON.stringify({ origin: new URL(url).protocol, nativeCaptureEnumerationAndDefaultRouting: true }));
      await page.context().close();
    }

    const permission = await app(fileUrl, () => {
      window.__discovery = { allowed: false, requests: 0, stopped: 0, enumWhileLive: false, live: false };
      navigator.mediaDevices.enumerateDevices = async () => {
        if (__discovery.live) __discovery.enumWhileLive = true;
        return __discovery.allowed ? [
          { kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk Microphone' },
          { kind: 'audioinput', deviceId: 'headset-mic', label: 'Headset Microphone' },
          { kind: 'audiooutput', deviceId: 'headphones', label: 'Headphones' }
        ] : [{ kind: 'audioinput', deviceId: 'current-mic', label: '' }, { kind: 'audiooutput', deviceId: '', label: '' }];
      };
      navigator.mediaDevices.getUserMedia = async options => {
        __discovery.requests++;
        __discovery.constraints = options;
        __discovery.allowed = __discovery.live = true;
        const track = { kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; __discovery.stopped++; __discovery.live = false; } };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      };
    });
    await permission.evaluate(() => {
      window.__existingTrack = { kind: 'audio', label: 'Current Microphone', readyState: 'live', enabled: false,
        getSettings: () => ({ deviceId: 'current-mic' }), stop() { throw new Error('Discovery must not stop the call microphone'); } };
      window.__existingStream = { getAudioTracks: () => [__existingTrack], getTracks: () => [__existingTrack] };
      ChatApp.callRawMicrophoneStream = ChatApp.callLocalStream = __existingStream;
      ChatApp.callPreferredAudioInputId = 'current-mic';
    });
    await open(permission, 'input');
    await permission.waitForFunction(() => [...document.getElementById('call-input-device').options].some(option => option.value === 'current-mic' && option.textContent.includes('Current Microphone')));
    assert.equal(await permission.evaluate(() => __discovery.requests), 0, 'Opening menus does not silently request capture');
    await permission.locator('#call-input-device-access').click();
    await permission.waitForFunction(() => [...document.getElementById('call-input-device').options].some(option => option.value === 'headset-mic'));
    const discovery = await permission.evaluate(() => ({ ...__discovery, sameRaw: ChatApp.callRawMicrophoneStream === __existingStream,
      sameLocal: ChatApp.callLocalStream === __existingStream, currentEnabled: __existingTrack.enabled,
      muted: ChatApp.callMuted, input: ChatApp.callInputVolume, output: ChatApp.callOutputVolume }));
    assert.equal(discovery.requests, 1);
    assert.equal(discovery.constraints.audio, true);
    assert.equal(discovery.stopped, 1, 'Temporary permission stream is stopped');
    assert.equal(discovery.enumWhileLive, true, 'Enumeration runs while permission stream remains live');
    assert.equal(discovery.live, false);
    assert.deepEqual([discovery.sameRaw, discovery.sameLocal, discovery.currentEnabled, discovery.muted, discovery.input, discovery.output], [true, true, false, true, 41, 73]);
    await permission.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await permission.locator('#call-input-settings-menu').isVisible(), true, 'Native picker blur preserves the settings menu');

    const denied = await app(fileUrl, () => {
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: '', label: '' }];
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied by user', 'NotAllowedError'); };
    });
    await open(denied, 'input');
    await denied.locator('#call-input-device-access').click();
    await denied.waitForFunction(() => /permission|allow|blocked|denied/i.test(document.getElementById('call-input-device-status').textContent));
    assert.equal(await denied.locator('#call-input-volume').isEnabled(), true, 'Denied discovery leaves volume usable');
    assert.equal(await denied.locator('#call-input-device-access').isEnabled(), true, 'Denied discovery permits retry');

    // Even when enumeration fails after permission succeeds, release only the
    // temporary discovery stream and keep the original call capture untouched.
    const failedEnumeration = await permission.evaluate(async () => {
      navigator.mediaDevices.enumerateDevices = async () => { throw new Error('Host enumeration failed'); };
      await ChatApp.callRefreshAudioDevices({ requestAccess: true });
      return { stopped: __discovery.stopped, temporaryLive: __discovery.live,
        currentIntact: ChatApp.callRawMicrophoneStream === __existingStream && __existingTrack.readyState === 'live' };
    });
    assert.deepEqual(failedEnumeration, { stopped: 2, temporaryLive: false, currentIntact: true });

    const missing = await app(fileUrl, () => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: undefined });
      Object.defineProperty(MediaStreamTrack, 'getSources', { configurable: true, value: undefined });
    });
    await open(missing, 'input');
    await missing.waitForFunction(() => !document.getElementById('call-input-device-status').hidden && document.getElementById('call-input-device-status').textContent.length > 0);
    assert.ok((await choices(missing, 'input')).some(option => option.value === ''), 'System default remains available without enumeration');

    const legacy = await app(fileUrl, () => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: undefined });
      MediaStreamTrack.getSources = callback => callback([{ kind: 'audio', id: 'legacy-mic', label: 'Legacy Microphone' }]);
    });
    await open(legacy, 'input');
    await legacy.waitForFunction(() => [...document.getElementById('call-input-device').options].some(option => option.value === 'legacy-mic'));

    const output = await app(httpUrl, () => {
      window.__devices = [{ kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk Microphone' }];
      navigator.mediaDevices.enumerateDevices = async () => __devices;
      navigator.mediaDevices.selectAudioOutput = async () => {
        window.__pickerGesture = navigator.userActivation.isActive;
        return { kind: 'audiooutput', deviceId: 'picked-output', label: 'USB Headphones' };
      };
    });
    await output.evaluate(() => {
      ChatApp.callSetOutputDevice = async id => { window.__chosenOutput = id; ChatApp.callPreferredAudioOutputId = id; return true; };
    });
    await open(output, 'output');
    await output.locator('#call-output-device-access').click();
    await output.waitForFunction(() => window.__chosenOutput === 'picked-output');
    assert.equal(await output.evaluate(() => __pickerGesture), true, 'Native output picker runs with user activation');
    assert.ok((await choices(output, 'output')).some(option => option.value === 'picked-output' && option.label.includes('USB Headphones')), 'Native picker label survives delayed enumeration');
    await output.evaluate(() => {
      window.__devices = [{ kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk Microphone' }, { kind: 'audiooutput', deviceId: 'new-speaker', label: 'New Speaker' }];
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await output.waitForFunction(() => [...document.getElementById('call-output-device').options].some(option => option.value === 'new-speaker'));
    assert.equal(await output.locator('#call-output-device').inputValue(), 'picked-output', 'Hotplug does not silently replace the chosen output');

    const outputWithoutPicker = await app(httpUrl, () => {
      window.__outputOnly = { captures: 0, enumerations: 0, devices: [] };
      Object.defineProperty(navigator.mediaDevices, 'selectAudioOutput', { configurable: true, value: undefined });
      navigator.mediaDevices.enumerateDevices = async () => { __outputOnly.enumerations++; return __outputOnly.devices; };
      navigator.mediaDevices.getUserMedia = async () => {
        __outputOnly.captures++;
        throw new Error('Output refresh must not request a microphone');
      };
    });
    await open(outputWithoutPicker, 'output');
    await outputWithoutPicker.locator('#call-output-device-access').click();
    await outputWithoutPicker.evaluate(async () => {
      await ChatApp.callRefreshAudioDevices({ requestAccess: true, kind: 'output' });
      __outputOnly.devices = [
        { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
        { kind: 'audiooutput', deviceId: 'headphones', label: 'Headphones' }
      ];
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      ChatApp.callSetOutputDevice = async id => { __outputOnly.selected = id; ChatApp.callPreferredAudioOutputId = id; return true; };
    });
    await outputWithoutPicker.waitForFunction(() => [...document.getElementById('call-output-device').options].some(option => option.value === 'headphones'));
    await outputWithoutPicker.locator('#call-output-device + .custom-select-dd .custom-select-btn').click();
    await outputWithoutPicker.locator('.custom-select-pop.portal [data-value="headphones"]').click();
    assert.equal(await outputWithoutPicker.evaluate(() => __outputOnly.selected), 'headphones');
    assert.equal(await outputWithoutPicker.evaluate(() => __outputOnly.captures), 0, 'Output discovery, refresh and real row selection never request microphone access without a native output picker');

    const race = await app(fileUrl, () => {
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'initial', label: 'Initial Microphone' }];
    });
    await open(race, 'input');
    await race.waitForFunction(() => [...document.getElementById('call-input-device').options].some(option => option.value === 'initial'));
    await race.evaluate(async () => {
      const deferred = [];
      navigator.mediaDevices.enumerateDevices = () => new Promise(resolve => deferred.push(resolve));
      const oldRefresh = ChatApp.callRefreshAudioDevices();
      const newRefresh = ChatApp.callRefreshAudioDevices();
      while (deferred.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
      deferred[1]([{ kind: 'audioinput', deviceId: 'newest', label: 'Newest Microphone' }]);
      await newRefresh;
      deferred[0]([{ kind: 'audioinput', deviceId: 'obsolete', label: 'Obsolete Microphone' }]);
      await oldRefresh;
      // Rendering from cached results must also retain the winning enumeration.
      navigator.mediaDevices.enumerateDevices = () => new Promise(() => {});
      ChatApp.closeCallAudioSettings();
      ChatApp.openCallAudioSettings('input', document.getElementById('btn-call-input-settings'));
    });
    const finalOptions = await choices(race, 'input');
    assert.ok(finalOptions.some(option => option.value === 'newest'));
    assert.ok(!finalOptions.some(option => option.value === 'obsolete'), 'Stale enumeration never replaces the cached device list');
    assert.deepEqual(errors, [], 'All device scenarios complete without page errors');
    console.log(JSON.stringify({ permissionRecovery: true, discoveryPreservesCall: true, deniedAndUnsupported: true, legacyEnumeration: true,
      outputPickerGestureAndLabel: true, hotplug: true, enumerationRace: true, nativePickerBlur: true, errors: 0 }));
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
