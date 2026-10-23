'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('settings saves send changed leaves without repeating media or storing local defaults', async () => {
  const { App } = setup();
  const writes = [];
  App.currentUser = { code: 'STABLE-ID' };
  App.db = { ref: path => ({ update: async value => writes.push({ path, value }) }) };
  App.currentSettings = App.mergeSettings(App.currentSettings, {
    background: { dataURL: 'data:image/png;base64,UNCHANGED', blur: 3 },
    customSoundEffects: { message: { name: 'Sound.mp3', dataURL: 'data:audio/mpeg;base64,UNCHANGED' } }
  });
  App.rememberLoadedSettings('STABLE-ID', App.currentSettings);
  await App.flushCurrentSettingsSave('STABLE-ID');
  assert.equal(writes.length, 0, 'login and unchanged settings do not write');
  App.currentSettings = App.mergeSettings(App.currentSettings, { autoScroll: false });
  await App.flushCurrentSettingsSave('STABLE-ID');
  assert.equal(JSON.stringify(writes[0]), JSON.stringify({ path: 'users/STABLE-ID/settings', value: { autoScroll: false } }));
  App.currentSettings = App.mergeSettings(App.currentSettings, { autoScroll: true, background: { blur: 0 } });
  await App.flushCurrentSettingsSave('STABLE-ID');
  assert.equal(JSON.stringify(writes[1].value), JSON.stringify({ autoScroll: null, 'background/blur': null }));
  await App.flushCurrentSettingsSave('STABLE-ID');
  assert.equal(writes.length, 2);
});

function setup({ state = 'running', resume, fetch: fetchOverride } = {}) {
  const sources = [], urls = [], contexts = [], media = [];
  let time = 10000;
  class AudioContext {
    constructor() { this.state = state; this.currentTime = 1; this.destination = {}; this.events = {}; contexts.push(this); }
    addEventListener(name, handler) { this.events[name] = handler; }
    createGain() { return { gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {} }, connect() { return this; }, disconnect() {} }; }
    createDynamicsCompressor() { return { ...Object.fromEntries(['threshold','knee','ratio','attack','release'].map(key => [key, { value: 0 }])), connect() { return this; } }; }
    createBufferSource() { const source = { connect() { return this; }, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; queueMicrotask(() => this.onended?.()); } }; sources.push(source); return source; }
    decodeAudioData() { return Promise.resolve({ decoded: true }); }
    resume() { return resume ? resume(this) : Promise.resolve(); }
  }
  class Audio {
    constructor(src) { this.src = src; this.events = {}; media.push(this); }
    addEventListener(name, handler) { this.events[name] = handler; }
    play() { this.started = true; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class Clock extends Date { static now() { return time; } }
  const App = { register() {}, SETTINGS_DEFAULTS: { autoScroll: true, pushNotifications: true, sidebarPosition: 'left', tab: { name: '', icon: '' }, blackoutCloakKeys: ['Control','Q'], background: {} } };
  const context = vm.createContext({ ChatApp: App, AudioContext, Audio, URL, Date: Clock, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console, document: { baseURI: 'https://app.invalid/' }, fetch: async url => { urls.push(String(url)); return fetchOverride ? fetchOverride(url) : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; } });
  context.window = context;
  for (const name of ['notification-audio', '../core/session']) {
    const file = name === 'notification-audio' ? 'js/chat/notification-audio.js' : 'js/core/session.js';
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  App.currentSettings = App.cloneDefaultSettings();
  return { App, contexts, sources, urls, media, setTime(value) { time = value; } };
}

test('sidebar defaults to the left while an explicitly saved right side survives normalization and unrelated settings edits', () => {
  const { App } = setup();
  assert.equal(App.cloneDefaultSettings().sidebarPosition, 'left');
  for (const sidebarPosition of [undefined, null, '', 'left', 'unexpected']) {
    assert.equal(App.normalizeSettings({ sidebarPosition }).sidebarPosition, 'left');
    assert.equal(App.mergeSettings({ sidebarPosition: 'right' }, { sidebarPosition }).sidebarPosition, 'left');
  }
  assert.equal(App.normalizeSettings({ sidebarPosition: 'right' }).sidebarPosition, 'right');
  App.currentSettings = App.mergeSettings({ sidebarPosition: 'right' }, { autoScroll: false });
  assert.equal(App.getSavedSidebarPosition(), 'right');
  App.currentSettings = {};
  assert.equal(App.getSavedSidebarPosition(), 'left');
});

test('the first HTML paint uses the saved sidebar side and remains left when storage is unavailable', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /<body\s+data-sidebar-position="left">/);
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('chatapp_sidebar_position'));
  assert.ok(source, 'The prepaint script exists before app boot');
  for (const value of [null, 'left', 'right', 'invalid', 'unavailable']) {
    const document = { body: { dataset: { sidebarPosition: 'left' } } };
    vm.runInNewContext(source, { document, localStorage: { getItem() { if (value === 'unavailable') throw new Error('Storage disabled'); return value; } } });
    assert.equal(document.body.dataset.sidebarPosition, value === 'right' ? 'right' : 'left');
  }
});

test('master and individual sound preferences remain consistent across disable, restore, and all-off states', () => {
  const { App } = setup();
  let settings = App.mergeSettings(App.currentSettings, { soundEffects: { message: false } });
  settings = App.mergeSettings(settings, { soundEffectsEnabled: false });
  App.currentSettings = settings;
  assert.ok(Object.keys(App.soundEffectCatalog).every(key => !App.isSoundEffectEnabled(key)));
  settings = App.mergeSettings(settings, { soundEffectsEnabled: true });
  assert.equal(settings.soundEffects.message, false, 'master restores individual choices');
  assert.equal(settings.soundEffects.ping, true);
  settings = App.mergeSettings(settings, { soundEffectsEnabled: false });
  settings = App.mergeSettings(settings, { soundEffects: { message: true } });
  assert.equal(settings.soundEffectsEnabled, true);
  assert.equal(Object.values(settings.soundEffects).filter(Boolean).length, 1, 'enabling one visible switch enables that sound only');
  settings = App.mergeSettings(settings, { soundEffects: { message: false } });
  assert.equal(settings.soundEffectsEnabled, false, 'last individual sound switches master off');
  settings = App.mergeSettings(settings, { soundEffectsEnabled: true });
  assert.equal(Object.values(settings.soundEffects).filter(Boolean).length, 10, 'all-off master can be enabled again');
});

test('custom audio survives settings normalization and removal restores defaults without affecting other sounds', async () => {
  const { App, urls } = setup();
  const custom = { name: 'My sound.mp3', dataURL: 'data:audio/mpeg;base64,YXVkaW8=' };
  App.currentSettings = App.mergeSettings(App.currentSettings, { customSoundEffects: { message: custom, ping: { name: 'no', dataURL: 'data:text/html;base64,YXVkaW8=' }, unknown: custom } });
  assert.deepEqual(Object.keys(App.currentSettings.customSoundEffects), ['message']);
  App.playNotificationSound('Message'); await flush();
  assert.equal(urls[0], custom.dataURL);
  App.currentSettings = App.mergeSettings(App.currentSettings, { customSoundEffects: { message: null } });
  App.playNotificationSound('Message'); await flush();
  assert.equal(urls.at(-1), 'https://app.invalid/assets/sounds/Message.mp3');
  assert.equal(Object.keys(App.currentSettings.customSoundEffects).length, 0);
  App.stopNotificationAudio();
});

test('watch and unwatch sounds are independently limited to twice per rolling six seconds', async () => {
  const { App, sources, setTime } = setup();
  for (let index = 0; index < 40; index++) { App.playNotificationSound('StartWatching'); App.playNotificationSound('StopWatching'); }
  App.playNotificationSound('Message'); App.playNotificationSound('Message'); App.playNotificationSound('Message');
  await flush();
  assert.equal(sources.length, 7, 'watch spam caps at four voices while other alerts retain their own rules');
  setTime(15999); App.playNotificationSound('StartWatching'); await flush();
  assert.equal(sources.length, 7);
  setTime(16000); App.playNotificationSound('StartWatching'); App.playNotificationSound('StopWatching'); await flush();
  assert.equal(sources.length, 9, 'new cues resume at exact window boundary');
  App.stopNotificationAudio();
});

test('the first cue waits for asynchronous AudioContext resume instead of being lost', async () => {
  const { App, sources } = setup({ state: 'suspended', resume: async ctx => { await flush(); ctx.state = 'running'; ctx.events.statechange?.(); } });
  App.playNotificationSound('Message'); await flush(); await flush();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  App.stopNotificationAudio();
});

test('slow initial downloads fall back to a media element and never play a delayed duplicate', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { App, sources, media, setTime } = setup({ fetch: () => response });
  App.playNotificationSound('Ping');
  await new Promise(resolve => setTimeout(resolve, 1250));
  assert.equal(media.length, 1);
  assert.equal(media[0].started, true);
  finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }); await flush();
  assert.equal(sources.length, 0);
  App.stopNotificationAudio();
  setTime(10200);
});

test('logout and cancelled rings cannot start audio after an in-flight decode finishes', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { App, sources, media } = setup({ fetch: () => response });
  App.playNotificationSound('Message'); App.setNotificationLoop('Called', true);
  App.stopNotificationAudio();
  finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }); await flush();
  assert.equal(sources.length, 0); assert.equal(media.length, 0);
});

test('logout preserves an in-flight leave cue while cancelling a pending message', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const { App, sources } = setup({ fetch: () => response });
  App.playNotificationSound('Message'); App.playNotificationSound('LeaveCall');
  App.stopNotificationAudio({ preserveCallCues: true });
  finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }); await flush();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].started, true);
  App.stopNotificationAudio();
});
