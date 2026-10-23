'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const clock = { now: 100000 };
  class FakeDate extends Date { static now() { return clock.now; } }
  const App = { register(_name, initialize) { initialize(); }, callPeerMap: new Map(), callMembersCache: [],
    currentUser: { code: 'self' }, currentCallRoomId: 'room', callScreenShareId: 'share',
    callRuntimeConfig: () => ({}), callGetMemberByCode: code => App.callMembersCache.find(m => m.code === code),
    callTuneAudioSender: sender => App.callApplySenderBudget(sender, 'audio'),
    callTuneScreenSender: sender => App.callApplySenderBudget(sender, 'video') };
  const context = vm.createContext({ ChatApp: App, navigator: { mediaDevices: { getSupportedConstraints: () => ({ restrictOwnAudio: true }) } }, console, Map, Set, WeakMap, Promise,
    document: { addEventListener() {} }, addEventListener() {},
    setTimeout, clearTimeout, Date: FakeDate, Math, location: { protocol: 'https:' } });
  context.window = context;
  for (const name of ['policy', 'media-policy', 'signaling', 'screen-share']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../call-modules', name + '.js'), 'utf8'), context);
  }
  class Sender {
    constructor() { this.track = null; this.params = { encodings: [{}] }; this.replacements = []; }
    async replaceTrack(track) { this.track = track; this.replacements.push(track); }
    getParameters() { return structuredClone(this.params); }
    async setParameters(parameters) { this.params = structuredClone(parameters); }
  }
  const txs = [];
  const pc = { __peerCode: 'viewer', getTransceivers: () => txs,
    addTransceiver(kind, options) { const tx = { mid: null, direction: options.direction, sender: new Sender(),
      receiver: { track: { kind, readyState: 'live' } } }; txs.push(tx); return tx; } };
  const video = { kind: 'video', readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }) };
  const audio = { kind: 'audio', readyState: 'live', getSettings: () => ({ channelCount: 2 }) };
  App.callScreenAudioTrack = audio;
  App.callMembersCache.push({ code: 'viewer', sessionId: 'viewer-session', viewingSharesSessionId: 'viewer-session', viewingShares: { self: 'share' } });
  App.callPeerMap.set('viewer', pc);
  return { App, context, pc, txs, video, audio, clock };
}

test('screen preview is captured once per call and late frames cannot publish after the share stops', async () => {
  const { App } = harness();
  App.callSessionId = 'session';
  App.callSharing = true;
  const images = [];
  let captures = 0;
  App.callCaptureScreenPreview = async () => { captures++; return 'data:image/jpeg;base64,Zmlyc3Q='; };
  App.db = { ref: () => ({ update: async value => images.push(value.sharePreviewDataURL) }) };
  await App.callPublishScreenPreview({}, 'room', 'session', 'share');
  App.callScreenShareId = 'share2';
  await App.callPublishScreenPreview({}, 'room', 'session', 'share2');
  assert.equal(captures, 1, 'restarting a share retains the first snapshot');
  assert.deepEqual(images, ['data:image/jpeg;base64,Zmlyc3Q=', 'data:image/jpeg;base64,Zmlyc3Q=']);
  App.callScreenPreviewDataURL = null;
  App.callCaptureScreenPreview = async () => { App.callSharing = false; return 'data:image/jpeg;base64,bGF0ZQ=='; };
  await App.callPublishScreenPreview({}, 'room', 'session', 'share2');
  assert.equal(images.length, 2, 'a late snapshot never revives an ended share');
  assert.equal(App.callScreenPreviewDataURL, null);
});

test('display capture excludes call playback while retaining 720p30 and audio through compatibility fallback', async () => {
  const { App, context } = harness();
  const calls = [];
  let applied;
  const track = { readyState: 'live', applyConstraints: async options => { applied = options; } };
  const stream = { getVideoTracks: () => [track] };
  context.navigator.mediaDevices.getDisplayMedia = async options => {
    calls.push(options);
    if (calls.length === 1) throw Object.assign(new Error('optional constraint unsupported'), { name: 'TypeError' });
    return stream;
  };
  assert.equal(await App.callRequestDisplayStream(), stream);
  assert.equal(calls[0].video.frameRate.ideal, 30);
  assert.equal(calls[0].video.frameRate.max, 30);
  assert.equal(calls[0].video.width.max, 1280);
  assert.equal(calls[0].video.height.max, 720);
  assert.equal(applied.width.max, 1280);
  assert.equal(applied.height.max, 720);
  assert.equal(applied.frameRate.max, 30);
  assert.equal(calls[0].audio.echoCancellation, false);
  assert.equal(calls[0].systemAudio, 'include');
  assert.equal(calls[0].windowAudio, 'system');
  for (const request of calls) {
    assert.equal(request.audio.restrictOwnAudio, true);
    assert.equal(request.audio.suppressLocalAudioPlayback, false, 'capture exclusion never silences local call playback');
    assert.equal(request.systemAudio, 'include', 'supported exclusion retains other applications and system media');
    assert.equal(request.selfBrowserSurface, 'exclude');
  }
  assert.equal(calls[1].video, true);
});

test('older browsers offer tab audio without unrestricted system or window loopback, including fallback', async () => {
  for (const supported of [() => ({ restrictOwnAudio: false }), () => ({}), undefined, () => { throw new Error('unavailable'); }]) {
    const { App, context } = harness();
    context.navigator.mediaDevices.getSupportedConstraints = supported;
    const requests = [];
    const stream = { getVideoTracks: () => [] };
    context.navigator.mediaDevices.getDisplayMedia = async options => {
      requests.push(options);
      if (requests.length === 1) throw Object.assign(new Error('optional resolution unsupported'), { name: 'OverconstrainedError' });
      return stream;
    };
    assert.equal(await App.callRequestDisplayStream(), stream);
    assert.equal(requests.length, 2);
    for (const options of requests) {
      assert.equal(options.audio.restrictOwnAudio, true);
      assert.equal(options.audio.suppressLocalAudioPlayback, false);
      assert.equal(options.systemAudio, 'exclude');
      assert.equal(options.windowAudio, 'exclude');
      assert.equal(options.selfBrowserSurface, 'exclude');
    }
  }
});

test('screen-share cancellation does not reprompt or change call voice playback', async () => {
  const { App, context } = harness();
  let requests = 0;
  App.callMuted = false;
  App.callDeafened = false;
  const error = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  context.navigator.mediaDevices.getDisplayMedia = async () => { requests++; throw error; };
  await assert.rejects(App.callRequestDisplayStream(), error);
  assert.equal(requests, 1);
  assert.equal(App.callMuted, false);
  assert.equal(App.callDeafened, false);
});

test('only verified call-free system/window audio or selected-tab audio reaches the share', async () => {
  for (const entry of [
    { surface: 'monitor', settings: { restrictOwnAudio: true }, keep: true },
    { surface: 'window', settings: { deviceId: 'loopbackWithoutChrome' }, keep: true },
    { surface: 'monitor', settings: { restrictOwnAudio: false, deviceId: 'loopback' }, keep: false },
    { surface: 'window', settings: {}, keep: false },
    { surface: undefined, settings: {}, keep: false },
    { surface: undefined, settings: { restrictOwnAudio: true }, keep: true },
    { surface: 'browser', settings: {}, keep: true },
  ]) {
    const { App, context } = harness();
    let stopped = false, videoStopped = false;
    const notices = [];
    const audio = { kind: 'audio', readyState: 'live', getSettings: () => entry.settings,
      stop() { stopped = true; this.readyState = 'ended'; } };
    const video = { kind: 'video', readyState: 'live', getSettings: () => ({ displaySurface: entry.surface }),
      stop() { videoStopped = true; }, async applyConstraints() {} };
    let tracks = [audio];
    const stream = { getVideoTracks: () => [video], getAudioTracks: () => tracks, removeTrack(track) { tracks = tracks.filter(item => item !== track); } };
    App.callMuted = false;
    App.callDeafened = false;
    App.showToast = notice => notices.push(notice);
    context.navigator.mediaDevices.getDisplayMedia = async () => stream;
    assert.equal(await App.callRequestDisplayStream(), stream);
    assert.equal(stopped, !entry.keep, `${entry.surface}: stop only unverified capture audio`);
    assert.equal(tracks.length, entry.keep ? 1 : 0);
    assert.equal(videoStopped, false, 'video stays shared even when system audio cannot exclude the call');
    assert.equal(App.callMuted, false);
    assert.equal(App.callDeafened, false);
    assert.equal(notices.length, entry.keep ? 0 : 1);
    if (!entry.keep) assert.match(notices[0].body, /browser tab with audio/);
  }
});

test('unsafe audio is removed even when compatibility fallback ignores picker hints', async () => {
  const { App, context } = harness();
  context.navigator.mediaDevices.getSupportedConstraints = () => ({});
  let attempts = 0, stops = 0, notices = 0;
  const audio = { getSettings: () => ({ deviceId: 'loopback' }), stop() { stops++; } };
  const video = { getSettings: () => ({ displaySurface: 'monitor' }), async applyConstraints() {} };
  let tracks = [audio];
  const stream = { getVideoTracks: () => [video], getAudioTracks: () => tracks, removeTrack() { tracks = []; } };
  App.showToast = () => notices++;
  context.navigator.mediaDevices.getDisplayMedia = async () => {
    if (++attempts === 1) throw Object.assign(new Error('optional constraint unsupported'), { name: 'TypeError' });
    return stream;
  };
  await App.callRequestDisplayStream();
  assert.equal(attempts, 2);
  assert.equal(stops, 1);
  assert.equal(tracks.length, 0);
  assert.equal(notices, 1);
});

test('video-only captures do not show an audio limitation notice', async () => {
  const { App, context } = harness();
  let notices = 0;
  App.showToast = () => notices++;
  const stream = { getVideoTracks: () => [], getAudioTracks: () => [] };
  context.navigator.mediaDevices.getDisplayMedia = async () => stream;
  await App.callRequestDisplayStream();
  assert.equal(notices, 0);
});

test('microphone and subscribed screen audio have independent stable senders', async () => {
  const { App, pc, txs, video, audio } = harness();
  const mic = { kind: 'audio', readyState: 'live' };
  await App.callSetPeerAudioTrack(pc, mic);
  await App.callSetPeerScreenTrack(pc, video);
  assert.deepEqual(txs.map(tx => tx.receiver.track.kind), ['audio', 'video', 'audio']);
  assert.equal(pc.__audioTx.sender.track, mic);
  assert.equal(pc.__screenAudioTx.sender.track, audio);
  assert.equal(pc.__screenAudioTx.sender.params.encodings[0].priority, 'low');
  assert.equal(pc.__audioTx.sender.params.encodings[0].priority, 'high');
  await App.callSetPeerAudioTrack(pc, null);
  assert.equal(pc.__screenAudioTx.sender.track, audio, 'microphone mute cannot detach screen audio');
  App.callMembersCache[0].viewingShares = {};
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, null);
  assert.equal(pc.__screenAudioTx.sender.track, null, 'unsubscribing pauses both screen senders');
  App.callMembersCache[0].viewingShares = { self: 'share' };
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenAudioTx.sender.track, audio);
  assert.equal(txs.length, 3, 'subscribe and mute actions reuse the existing m-lines');
});

test('negotiated answerer reuses offered microphone and screen audio in their correct roles', async () => {
  const { App, pc, txs, video, audio } = harness();
  pc.__polite = true;
  assert.equal(App.callEnsurePeerScreenAudioTransceiver(pc), null, 'polite peer waits for remote offer');
  ['audio', 'video', 'audio'].forEach((kind, index) => {
    const tx = pc.addTransceiver(kind, { direction: 'recvonly' });
    tx.mid = String(index);
  });
  // ontrack is dispatched during setRemoteDescription, before our answer path.
  assert.equal(App.callIsScreenAudioTrack(pc, { track: txs[0].receiver.track, transceiver: txs[0] }), false);
  assert.equal(App.callIsScreenAudioTrack(pc, { track: txs[2].receiver.track, transceiver: txs[2] }), true);
  pc.remoteDescription = { type: 'offer' };
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__audioTx, txs[0]);
  assert.equal(pc.__screenAudioTx, txs[2]);
  assert.equal(txs[2].sender.track, audio);
  assert.equal(txs.length, 3);
});

test('queued stop wins over a delayed screen attachment without stopping microphone', async () => {
  const { App, pc, video } = harness();
  const mic = { kind: 'audio', readyState: 'live' };
  await App.callSetPeerAudioTrack(pc, mic);
  const first = App.callSetPeerScreenTrack(pc, video);
  const stop = App.callSetPeerScreenTrack(pc, null);
  await Promise.all([first, stop]);
  assert.equal(pc.__screenTx.sender.track, null);
  assert.equal(pc.__screenAudioTx.sender.track, null);
  assert.equal(pc.__audioTx.sender.track, mic);
});

test('ended capture audio detaches independently while video remains live', async () => {
  const { App, pc, video, audio } = harness();
  await App.callSetPeerScreenTrack(pc, video);
  audio.readyState = 'ended';
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenAudioTx.sender.track, null);
  assert.equal(pc.__screenTx.sender.track, video);
});

test('mesh upload stays bounded as participants increase while capture stays 720p30', () => {
  const { context } = harness();
  const budget = context.ChatCallPolicy.mediaBudget;
  for (const count of [1, 2, 5, 12, 24]) {
    const group = budget({ peers: count, subscribers: count, sharingCount: count, constrained: true, cpuConstrained: true });
    assert.equal(group.maxFramerate, 30);
    assert.equal(group.width, 1280);
    assert.equal(group.height, 720);
    assert.equal(group.videoBitrate, Math.min(4000000, Math.floor(12000000 / count)));
    assert.ok(group.totalVideoBudget <= 12000000);
  }
});

test('one busy encoder cannot reduce capture FPS or bitrate for every viewer', () => {
  const { App, pc, video, clock } = harness();
  pc.__screenTx = { sender: { track: video } };
  for (let sample = 0; sample < 6; sample++) {
    pc.__qualityStats = { cpuLimited: true, bandwidthLimited: true, lossPct: 0, rttMs: 20 };
    pc.__qualityStatsAt = clock.now;
    assert.equal(App.callGetMediaBudget().maxFramerate, 30);
    assert.equal(App.callGetMediaBudget().videoBitrate, 4000000);
    clock.now += 5000;
  }
});
test('one slow receiver does not force every screen into a persistent global low-quality budget', () => {
  const { App, pc, video, clock } = harness();
  pc.__screenTx = { sender: { track: video } };
  for (let sample = 0; sample < 6; sample++) {
    pc.__qualityStats = { cpuLimited: false, bandwidthLimited: true, lossPct: 8, rttMs: 350 };
    pc.__qualityStatsAt = clock.now;
    const budget = App.callGetMediaBudget();
    assert.equal(budget.maxFramerate, 30);
    assert.equal(budget.videoBitrate, 4000000);
    assert.equal(App.callMediaPressureUntil, 0);
    clock.now += 5000;
  }
});

test('network hints do not pin screens below the requested 720p30 target', () => {
  const { App, context } = harness();
  context.navigator.connection = { saveData: true, effectiveType: '4g' };
  assert.equal(App.callGetMediaBudget().maxFramerate, 30);
  assert.equal(App.callGetMediaBudget().videoBitrate, 4000000);
  context.navigator.connection.saveData = false;
  assert.equal(App.callGetMediaBudget().maxFramerate, 30);
  assert.equal(App.callGetMediaBudget().videoBitrate, 4000000);
});

test('sender caps landscape and portrait sources at 720p30 and preserves screen clarity during bandwidth adaptation', async () => {
  const { App, pc, video } = harness();
  await App.callSetPeerScreenTrack(pc, video);
  const sender = pc.__screenTx.sender;
  assert.equal(sender.params.encodings[0].maxFramerate, 30);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(sender.params.degradationPreference, 'maintain-resolution');
  video.getSettings = () => ({ width: 1080, height: 1920 });
  await App.callTuneScreenSender(sender);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1920 / 720);
  video.getSettings = () => ({ width: 1280, height: 720 });
  await App.callTuneScreenSender(sender);
  assert.equal(sender.params.encodings[0].scaleResolutionDownBy, 1, '720p capture must not be downscaled a second time');
});

test('subscriber arriving during a pending rebalance is applied without waiting for a health poll', async () => {
  const { App, pc, video } = harness();
  App.callPeerIsCurrent = () => true;
  App.callScreenTrack = video;
  App.callSharing = true;
  let release;
  let started;
  const inFlight = new Promise(resolve => { started = resolve; });
  let runs = 0;
  const tune = App.callTuneAudioSender;
  App.callTuneAudioSender = async sender => {
    runs++;
    if (runs === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return tune(sender);
  };
  const pending = App.callRebalanceMedia();
  await inFlight;
  await App.callRebalanceMedia();
  assert.equal(App.callMediaBudgetQueued, true);
  release();
  await pending;
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(runs, 2, 'the queued subscriber gets a new pass immediately');
  assert.equal(pc.__screenTx.sender.track, video);
});

test('a queued screen pause reads the latest viewer subscription before it runs', async () => {
  const { App, pc, video } = harness();
  let release;
  pc.__screenTrackPromise = new Promise(resolve => { release = resolve; });
  App.callMembersCache[0].viewingShares = {};
  const pending = App.callSetPeerScreenTrack(pc, video);
  App.callMembersCache[0].viewingShares = { self: 'share' };
  release();
  await pending;
  assert.equal(pc.__screenTx.sender.track, video);
});

test('unsupported optional sender hints still retain bitrate, frame rate, and size limits', async () => {
  const { App, pc, video } = harness();
  const tx = App.callEnsurePeerScreenTransceiver(pc);
  tx.sender.setParameters = async parameters => {
    if (parameters.degradationPreference || parameters.encodings[0].networkPriority) throw new TypeError('optional hint unsupported');
    tx.sender.params = structuredClone(parameters);
  };
  await App.callSetPeerScreenTrack(pc, video);
  const encoding = tx.sender.params.encodings[0];
  assert.equal(encoding.maxFramerate, 30);
  assert.equal(encoding.maxBitrate, 4000000);
  assert.equal(encoding.scaleResolutionDownBy, 1.5);
});

test('manual screen pause replaces only screen media and late subscribers receive the frozen track', async () => {
  const { App, pc, video, audio } = harness();
  const frozen = { kind: 'video', readyState: 'live', getSettings: () => ({ width: 320, height: 180 }) };
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, video);
  assert.equal(pc.__screenAudioTx.sender.track, audio);
  App.callScreenPaused = true;
  App.callScreenPauseTrack = frozen;
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, frozen);
  assert.equal(pc.__screenAudioTx.sender.track, null, 'paused screen audio cannot continue live');
  App.callMembersCache[0].viewingShares = {};
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, null);
  App.callMembersCache[0].viewingShares = { self: 'share' };
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, frozen, 'a new viewer cannot bypass manual pause');
  App.callScreenPaused = false;
  await App.callSetPeerScreenTrack(pc, video);
  assert.equal(pc.__screenTx.sender.track, video);
  assert.equal(pc.__screenAudioTx.sender.track, audio);
});
