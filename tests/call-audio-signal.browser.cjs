/* Real Web Audio and WebRTC signal regression. Hardware capture is replaced
 * with a quiet tone; signaling is isolated and external HTTP is blocked. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream' });
    res.end(error ? 'Not found' : data);
  });
});
async function signal(page) {
  return page.evaluate(async () => {
    // Average actual decoded samples, not gain-node configuration or RTP bytes.
    const samples = [];
    for (let n = 0; n < 8; n++) {
      await new Promise(resolve => setTimeout(resolve, 35));
      const data = new Float32Array(window.__probe.fftSize);
      window.__probe.getFloatTimeDomainData(data);
      samples.push(Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length));
    }
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  });
}
async function waitForSignal(page, predicate, label) {
  const deadline = Date.now() + 10000;
  let value;
  let consecutive = 0;
  do {
    value = await signal(page);
    consecutive = predicate(value) ? consecutive + 1 : 0;
    if (consecutive >= 2) return value;
  } while (Date.now() < deadline);
  assert.fail(`${label}: decoded signal did not settle (last RMS ${value})`);
}
(async () => {
  const backend = createSharedFirebaseBackend(2);
  const errors = [];
  const pages = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  try {
    for (const code of ['P1', 'P2']) {
      const context = await browser.newContext();
      await backend.bind(context);
      await context.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${code}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.evaluate(user => {
        ChatApp.currentUser = user;
        ChatApp.currentRoomId = 'test';
        document.body.dataset.mode = 'chat';
        document.querySelectorAll('.view').forEach(view => view.dataset.active = String(view.id === 'view-chat'));
        ChatApp.callMakeRtcConfig = () => ({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        ChatApp.callRefreshIceServers = async () => [];
        window.__captures = [];
        window.__captureRequests = [];
        navigator.mediaDevices.getUserMedia = async options => {
          window.__captureRequests.push(options);
          const ctx = new AudioContext();
          await ctx.resume();
          const tone = ctx.createOscillator(); tone.frequency.value = 440;
          const gain = ctx.createGain(); gain.gain.value = 0.08;
          const output = ctx.createMediaStreamDestination();
          tone.connect(gain).connect(output); tone.start();
          const track = output.stream.getAudioTracks()[0];
          const settings = track.getSettings.bind(track);
          track.getSettings = () => ({ ...settings(), deviceId: options.audio?.deviceId?.exact || 'default' });
          window.__captures.push({ ctx, tone, gain, stream: output.stream });
          return output.stream;
        };
      }, backend.values.users[code]);
      pages.push(page);
    }
    await Promise.all(pages.map(page => page.evaluate(() => ChatApp.joinCall('test', { openMenu: true }))));
    await pages[1].waitForFunction(() => ChatApp.callPeerMap.get('P1')?.connectionState === 'connected' && ChatApp.callRemoteAudioEls.get('P1')?.srcObject?.getAudioTracks().length);
    await pages[1].evaluate(async () => {
      window.__probeCtx = new AudioContext();
      await window.__probeCtx.resume();
      window.__probe = window.__probeCtx.createAnalyser();
      window.__probe.fftSize = 2048;
      window.__probeSource = window.__probeCtx.createMediaStreamSource(ChatApp.callRemoteAudioEls.get('P1').srcObject);
      window.__probeSource.connect(window.__probe);
    });
    await pages[1].waitForTimeout(600);
    const full = await waitForSignal(pages[1], value => value > 0.045 && value < 0.07, 'Original microphone');
    assert.ok(full > 0.01, `Receiver hears original signal (${full})`);
    // Permission/audio-route suspension leaves tracks live but the outgoing
    // processing graph silent. The same recovery used on join must restore
    // actual received samples without replacing the page or the peer.
    const sessionsBefore = await pages[0].evaluate(() => ({ session: ChatApp.callSessionId, peers: [...ChatApp.callPeerMap.keys()] }));
    await pages[0].evaluate(async () => { await ChatApp.callMicCtx.suspend(); await ChatApp.callResumeRemoteAudio({ fromGesture: false }); });
    assert.ok(await waitForSignal(pages[1], value => value > 0.045 && value < 0.07, 'Resumed microphone graph') > 0.01);
    assert.deepEqual(await pages[0].evaluate(() => ({ session: ChatApp.callSessionId, peers: [...ChatApp.callPeerMap.keys()] })), sessionsBefore);
    await pages[0].evaluate(() => { __captures.at(-1).gain.gain.value = 0.016; });
    await pages[0].waitForFunction(() => ChatApp.callVadSpeaking === true);
    await pages[1].waitForFunction(() => ChatApp.callMembersCache.find(member => member.code === 'P1')?.speaking === true);
    await pages[0].evaluate(() => { __captures.at(-1).gain.gain.value = 0; });
    await pages[0].waitForFunction(() => ChatApp.callVadSpeaking === false);
    await pages[1].waitForFunction(() => ChatApp.callMembersCache.find(member => member.code === 'P1')?.speaking === false);
    await pages[0].evaluate(() => { __captures.at(-1).gain.gain.value = 0.016; });
    await pages[0].waitForFunction(() => ChatApp.callVadSpeaking === true);
    assert.equal(await pages[0].locator('.call-user-avatar[data-usercode="P1"]').evaluate(node => node.classList.contains('speaking')), true, 'Quiet microphone updates the local speaking ring');
    await pages[0].evaluate(() => { __captures.at(-1).gain.gain.value = 0.08; });
    await pages[0].evaluate(() => ChatApp.callSetInputVolumePercent(25));
    await pages[1].waitForTimeout(400);
    const quarter = await waitForSignal(pages[1], value => value / full > 0.17 && value / full < 0.34, 'Quarter-volume microphone');
    assert.ok(quarter / full > 0.17 && quarter / full < 0.34, `Remote microphone signal follows 25% input volume (${quarter / full})`);
    await pages[0].evaluate(() => ChatApp.callSetInputVolumePercent(0));
    assert.equal(await pages[0].evaluate(() => ChatApp.callMuted), true, 'zero input marks the local participant muted');
    assert.equal(await pages[0].locator('#btn-call-mute').getAttribute('aria-label'), 'Unmute');
    await pages[1].waitForFunction(() => ChatApp.callMembersCache.find(member => member.code === 'P1')?.muted === true);
    assert.equal(backend.get('calls/test/members/P1/muted'), true, 'zero input publishes mute to other participants');
    await pages[1].waitForTimeout(500);
    const silence = await waitForSignal(pages[1], value => value < 0.0002, 'Silent microphone');
    assert.ok(silence < 0.0002, `0% microphone is silent for the other participant (${silence})`);
    await pages[0].evaluate(() => ChatApp.callSetInputVolumePercent(60));
    assert.equal(await pages[0].evaluate(() => ChatApp.callMuted), false, 'raising input clears the volume-induced mute');
    await pages[1].waitForFunction(() => ChatApp.callMembersCache.find(member => member.code === 'P1')?.muted === false);
    // Switching devices must preserve the gain, and Refresh must reacquire
    // that same exact source without invoking any device selection UI.
    await pages[0].evaluate(() => ChatApp.callSetInputDevice('test-mic-2'));
    await pages[0].evaluate(() => ChatApp.callRefreshMic());
    const requests = await pages[0].evaluate(() => ({ requests: window.__captureRequests, volume: ChatApp.callGetInputVolumePercent() }));
    assert.equal(requests.volume, 60);
    assert.equal(requests.requests.at(-1).audio.deviceId.exact, 'test-mic-2');
    assert.equal(requests.requests.at(-2).audio.deviceId.exact, 'test-mic-2');
    await pages[1].waitForTimeout(600);
    const refreshed = await waitForSignal(pages[1], value => value / full > 0.45 && value / full < 0.75, 'Refreshed microphone');
    assert.ok(refreshed / full > 0.45 && refreshed / full < 0.75, `Refresh preserves outbound input volume (${refreshed / full})`);
    await pages[0].evaluate(() => ChatApp.callToggleMute());
    await pages[1].waitForTimeout(500);
    assert.ok(await signal(pages[1]) < 0.0002, 'Mute still silences processed microphone');
    await pages[0].evaluate(() => ChatApp.callToggleMute());
    await pages[1].waitForTimeout(400);
    assert.ok(await signal(pages[1]) > 0.01, 'Unmute restores processed microphone');
    await pages[1].evaluate(async () => {
      await ChatApp.callResumeRemoteAudio({ fromGesture: true });
      window.__probeSource.disconnect();
      window.__probe = ChatApp.callPlaybackCtx.createAnalyser();
      window.__probe.fftSize = 2048;
      ChatApp.callPlaybackMix.ceiling.connect(window.__probe);
    });
    const outputFull = await signal(pages[1]);
    assert.ok(outputFull > 0.01, 'Protected playback mix contains the received signal');
    await pages[1].evaluate(() => {
      ChatApp.callSetUserVolumePercent('P1', 50, { smooth: false, fromGesture: true });
      ChatApp.callSetOutputVolumePercent(200, { smooth: false, fromGesture: true });
    });
    await pages[1].waitForTimeout(300);
    const outputStacked = await signal(pages[1]);
    assert.ok(outputStacked / outputFull > 0.85 && outputStacked / outputFull < 1.15, '200% output × 50% user restores original playback level');
    await pages[1].evaluate(() => ChatApp.callSetOutputVolumePercent(50, { smooth: false, fromGesture: true }));
    await pages[1].waitForTimeout(300);
    const outputQuiet = await signal(pages[1]);
    assert.ok(outputQuiet / outputFull > 0.18 && outputQuiet / outputFull < 0.32, '50% output × 50% user produces quarter-level playback');
    await pages[1].evaluate(() => ChatApp.callSetOutputVolumePercent(0, { smooth: false }));
    await pages[1].waitForTimeout(300);
    assert.ok(await signal(pages[1]) < 0.0002, '0% output silences the protected playback mix');
    const limiterPeak = await pages[1].evaluate(async () => {
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      const saved = [ChatApp.callPlaybackCtx, ChatApp.callPlaybackMix];
      ChatApp.callPlaybackCtx = ctx;
      ChatApp.callPlaybackMix = null;
      let mix;
      try { mix = ChatApp.callEnsurePlaybackMix(); }
      finally { [ChatApp.callPlaybackCtx, ChatApp.callPlaybackMix] = saved; }
      const tone = ctx.createOscillator(); tone.frequency.value = 440;
      const boost = ctx.createGain(); boost.gain.value = 40; // five simultaneous 400% users at 200% output
      tone.connect(boost).connect(mix.input); tone.start();
      const rendered = await ctx.startRendering();
      return rendered.getChannelData(0).reduce((peak, x) => Math.max(peak, Math.abs(x)), 0);
    });
    assert.ok(limiterPeak > 0.1 && limiterPeak < 0.96, `Extreme summed boosts retain a bounded output waveform (${limiterPeak})`);
    assert.deepEqual(errors, []);
    assert.deepEqual(backend.deliveryErrors, []);
    console.log('Real audio signal: microphone gain, selected-device refresh, mute, stacked output gain, silence and peak limiter PASS', { full, quarter, silence, refreshed, outputFull, outputStacked, outputQuiet, limiterPeak });
  } finally {
    await Promise.all(pages.map(page => page.evaluate(async () => {
      await ChatApp.leaveCall({ quiet: true });
      for (const capture of window.__captures || []) { capture.tone.stop(); await capture.ctx.close(); }
      await window.__probeCtx?.close();
    }).catch(() => {})));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
