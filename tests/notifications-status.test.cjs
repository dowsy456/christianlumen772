'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const installFirebaseMock = require('./firebase-mock.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup({ desktop = true, audioState = 'running', policyReady = true } = {}) {
  const sounds = [], notifications = [], sources = [], gains = [], compressors = [];
  const initializers = [];
  const events = new Map();
  const audioContexts = [];
  class AudioContext {
    constructor() { this.state = audioState; this.currentTime = 1; this.destination = {}; this.events = {}; audioContexts.push(this); }
    addEventListener(event, callback) { this.events[event] = callback; }
    createGain() { const node = { gain: { value: 1, setTargetAtTime(value) { this.value = value; }, cancelScheduledValues() {} }, connect() { return this; }, disconnect() {} }; gains.push(node); return node; }
    createDynamicsCompressor() { const node = { connect() { return this; } }; for (const key of ['threshold','knee','ratio','attack','release']) node[key] = { value: 0 }; compressors.push(node); return node; }
    createBufferSource() { const node = { connect() { return this; }, disconnect() {}, start() { this.started = true; }, stop(when) { this.stoppedAt = when; } }; sources.push(node); return node; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
  }
  class Notification {
    static permission = 'granted';
    constructor(title, options) { notifications.push({ title, ...options }); }
  }
  const App = {
    register(id, initialize) { initializers.push({ id, initialize }); },
    currentUser: { code: 'TEST-USER', username: 'Tester' },
    membershipMap: new Map([['test', true], ['other', true]]),
    liveUserCache: new Map(), appPresenceCache: new Map([['TEST-USER','idle']]),
    playNotificationSound: sound => sounds.push(sound), pushNotifsEnabled: true,
    roomsMetaCache: new Map(), roomDisplayName: id => `Room ${id}`,
    renderOnlineIndicator() {}, refreshOpenUserProfilePresence() {},
    writeCurrentUserBootstrapCache() {}, seenPingKeys: new Set(),
    getStoredPlace: () => 'home', views: { chat: { dataset: { active: 'true' } } },
    showToast() {}, showPingSummaryToast() {}, escapeHtml: String
  };
  const documentEvents = new Map();
  const document = { baseURI: 'https://local.invalid/', hidden: false, focused: true,
    hasFocus() { return this.focused; },
    addEventListener(name, callback) { if (!documentEvents.has(name)) documentEvents.set(name, []); documentEvents.get(name).push(callback); },
    dispatchEvent(event) { for (const callback of documentEvents.get(event.type) || []) callback(event); },
    getElementById() { return null; }
  };
  const context = vm.createContext({ ChatApp: App, document, Notification, AudioContext, URL, console, Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, CustomEvent: class { constructor(name, options) { this.type=name; this.detail=options.detail; } }, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) });
  context.window = context;
  context.addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); };
  context.dispatchEvent = event => { for (const callback of events.get(event.type) || []) callback(event); };
  if (desktop) context.chatDesktopOverlay = { version: 1 };
  vm.runInContext(`(${installFirebaseMock.toString()})()`, context);
  App.db = context.firebase.database();
  const load = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  load('js/profiles/status.js'); load('js/chat/notifications.js');
  App.notificationStatusReady = policyReady;
  return { App, context, document, sounds, sources, gains, compressors, notifications, audioContexts, load, initializers, events };
}
test('all joined rooms notify once for new messages, initial history and room navigation do not replay', async () => {
  const { App, sounds } = setup();
  await App.db.ref('messages/test/old').set({ userCode: 'peer', text: 'history', createdAt: 1 });
  App.syncRoomMessageNotifications(); await flush();
  assert.deepEqual(sounds, []);
  await App.db.ref('messages/test/one').set({ userCode: 'peer', text: 'hello', createdAt: Date.now() });
  await App.db.ref('messages/other/two').set({ userCode: 'peer', text: '@Tester hi', createdAt: Date.now() });
  await flush();
  assert.deepEqual(sounds, ['Message', 'Ping']);
  App.currentRoomId = 'other'; App.syncRoomMessageNotifications(); await flush();
  await App.db.ref('messages/other/two/text').set('@Tester edited'); await flush();
  assert.deepEqual(sounds, ['Message', 'Ping']);
  await App.db.ref('messages/test/self').set({ userCode: 'TEST-USER', text: 'my message' }); await flush();
  assert.deepEqual(sounds, ['Message', 'Ping'], 'own messages are silent');
  App.membershipMap.delete('other'); App.syncRoomMessageNotifications();
  await App.db.ref('messages/other/left').set({ userCode: 'peer', text: 'left' }); await flush();
  assert.equal(sounds.length, 2);
  App.detachRoomMessageNotifications();
  await App.db.ref('messages/test/logout').set({ userCode: 'peer', text: 'logout' }); await flush();
  assert.equal(sounds.length, 2);
});
test('pings produce one silent desktop notification per message; DND never blocks desktop notifications', () => {
  const { App, notifications } = setup();
  App.currentUser.notificationStatus = 'dnd';
  App.handleRoomNotificationMessage('test', 'one', { userCode:'peer', username:'Friend', text:'@Tester hi' });
  App.showDesktopPingNotification({ roomId:'test', fromUsername:'Friend', messageKey:'one' });
  App.handleRoomNotificationMessage('test', 'two', { userCode:'peer', username:'Friend', text:'@everyone again' });
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(notification => notification.silent));
  assert.notEqual(notifications[0].tag, notifications[1].tag);
  App.handleRoomNotificationMessage('test', 'three', { userCode:'peer', text:'regular' });
  assert.equal(notifications.length, 2);
  App.pushNotifsEnabled = false;
  App.handleRoomNotificationMessage('test', 'four', { userCode:'peer', text:'@Tester hi' });
  assert.equal(notifications.length, 2);
});
test('mention detection respects token boundaries, case and roomwide aliases', () => {
  const { App } = setup();
  for (const text of ['@tester hi','Hi @Tester ','@ALL hi','@a hi','@everyone hi']) assert.equal(App.messagePingsCurrentUser({ text }), true, text);
  for (const text of ['test@Tester.com','@TesterExtra hello','hi tester','@Other hi']) assert.equal(App.messagePingsCurrentUser({ text }), false, text);
});

test('all ten app sound effects default on; per-effect and master preferences gate the shared mixer', async () => {
  const { App, sources, load } = setup();
  load('js/chat/notification-audio.js');
  App.currentSettings = { soundEffectsEnabled: true, soundEffects: App.normalizeSoundEffects({ startwatching:false }) };
  assert.equal(Object.keys(App.soundEffectCatalog).length, 10);
  assert.equal(Object.values(App.normalizeSoundEffects({})).every(Boolean), true);
  App.playNotificationSound('StartWatching');
  await flush();
  assert.equal(sources.length, 0);
  App.playNotificationSound('StartScreen'); App.playNotificationSound('EndScreen'); App.playNotificationSound('StopWatching');
  await flush();
  assert.equal(sources.length, 3, 'enabled screen cues overlap independently');
  App.currentSettings.soundEffectsEnabled = false;
  App.syncSoundEffectPreferences();
  assert.ok(sources.every(source => source.stoppedAt), 'disabling fades active app sound voices');
  App.playNotificationSound('Message'); App.playNotificationSound('JoinCall');
  await flush();
  assert.equal(sources.length, 3, 'master gates messages and call cues alike');
});

test('new screen and watcher sound assets match the existing sound loudness', () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/sounds/processing-report.json'), 'utf8'));
  assert.equal(report.sounds.length, 10);
  const levels = report.sounds.map(sound => sound.integratedLUFS);
  assert.ok(Math.max(...levels) - Math.min(...levels) < 0.15, 'all ten cues have matching integrated loudness');
  for (const sound of report.sounds) {
    assert.ok(sound.truePeakDBTP <= report.truePeakCeilingDBTP);
    assert.ok(fs.statSync(path.join(__dirname, '../assets/sounds', sound.file)).size > 1000);
  }
});
test('DND persists while notification-enabled status follows real idle and offline state', async () => {
  const { App, document } = setup();
  assert.equal(await App.setNotificationStatus('dnd'), true);
  assert.equal((await App.db.ref('users/TEST-USER/notificationStatus').once('value')).val(), 'dnd');
  document.hidden = true; App.myRoomIdle = true;
  assert.equal(App.getUserVisiblePresence('TEST-USER'), 'dnd');
  assert.equal(await App.setNotificationStatus('online'), true);
  assert.equal(App.getUserVisiblePresence('TEST-USER'), 'idle');
  App.appPresenceCache.set('TEST-USER', 'offline');
  assert.equal(App.getUserVisiblePresence('TEST-USER'), 'offline');
  App.appPresenceCache.delete('TEST-USER');
  assert.equal(App.getUserVisiblePresence('TEST-USER'), 'offline', 'an absent session never manufactures online presence');
  const web = setup({ desktop:false });
  web.App.currentUser.notificationStatus = 'dnd';
  assert.equal(web.App.isDoNotDisturb(), true);
  assert.equal(await web.App.setNotificationStatus('online'), false);
  assert.equal(web.App.isDoNotDisturb(), true);
});
test('desktop initialization preserves a DND choice saved by another device', async () => {
  const { App } = setup();
  await App.db.ref('users/TEST-USER/notificationStatus').set('dnd');
  App.initializeNotificationStatus(); await flush();
  assert.equal(App.currentUser.notificationStatus, 'dnd');
});
test('account status sync works without any room/profile listener and detaches on logout', async () => {
  const { App } = setup({ desktop:false });
  App.startNotificationStatusSync(); await flush();
  await App.db.ref('users/TEST-USER/notificationStatus').set('dnd'); await flush();
  assert.equal(App.isDoNotDisturb(), true);
  App.stopNotificationStatusSync();
  await App.db.ref('users/TEST-USER/notificationStatus').set('online'); await flush();
  assert.equal(App.isDoNotDisturb(), true, 'detached session cannot modify the signed-out user');
});
test('audio voices overlap with shared compression and independent fading ring loops', async () => {
  const { App, sources, gains, compressors, load } = setup();
  load('js/chat/notification-audio.js');
  App.playNotificationSound('Message'); App.playNotificationSound('Ping'); await flush();
  assert.equal(sources.length, 2);
  assert.ok(sources.every(source => source.started && !source.stoppedAt));
  assert.equal(compressors.length, 1);
  assert.equal(compressors[0].ratio.value, 12);
  assert.ok(gains.slice(1).every(gain => gain.gain.value < 1));
  App.setNotificationLoop('Ringing', true); App.setNotificationLoop('Called', true); await flush();
  assert.equal(sources.filter(source => source.loop).length, 2);
  App.setNotificationLoop('Called', false);
  assert.ok(sources[3].stoppedAt > 1);
  assert.equal(sources[2].stoppedAt, undefined);
  App.currentUser.notificationStatus = 'dnd';
  App.playNotificationSound('Message'); App.playNotificationSound('Ping'); await flush();
  assert.equal(sources.length, 4, 'DND suppresses only message and ping voices');
  App.setNotificationLoop('Called', true); await flush();
  assert.equal(sources.length, 4, 'desktop DND blocks the incoming ringtone before it starts');
  App.stopNotificationAudio();
  assert.ok(sources.every(source => source.stoppedAt));
});
test('blocked loops recover after autoplay unlock and cancelled loops never start later', async () => {
  const { App, audioContexts, sources, load } = setup({ audioState:'suspended' });
  load('js/chat/notification-audio.js');
  App.setNotificationLoop('Ringing', true);
  App.setNotificationLoop('Called', true);
  App.setNotificationLoop('Called', false);
  App.playNotificationSound('Message');
  await flush();
  assert.equal(sources.length, 0);
  audioContexts[0].state = 'running';
  audioContexts[0].events.statechange();
  await flush();
  assert.equal(sources.length, 1, 'only the still-current outgoing loop starts after unlock');
  assert.equal(sources[0].loop, true);
  App.setNotificationLoop('Ringing', true);
  await flush();
  assert.equal(sources.length, 1, 'repeated realtime snapshots do not duplicate a loop');
  App.stopNotificationAudio();
});
test('file previews use media elements without fetch/CORS and bound the combined fallback peak', async () => {
  const { App, context, document, audioContexts, load } = setup();
  document.baseURI = 'file:///C:/chat/index.html';
  const media = [];
  let fetches = 0;
  context.fetch = () => { fetches++; throw new Error('file fetch must not run'); };
  context.Audio = class {
    constructor(src) { this.src = src; this.volume = 1; this.events = {}; media.push(this); }
    addEventListener(name, callback) { this.events[name] = callback; }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  };
  load('js/chat/notification-audio.js');
  App.playNotificationSound('Message'); App.playNotificationSound('Ping');
  App.setNotificationLoop('Called', true); await flush();
  assert.equal(fetches, 0);
  assert.equal(audioContexts.length, 0);
  assert.equal(media.length, 3);
  assert.ok(media.every(audio => audio.src.startsWith('file:///C:/chat/assets/sounds/')));
  assert.ok(media.reduce((sum, audio) => sum + audio.volume, 0) <= 0.700001);
  App.setNotificationLoop('Called', false);
  App.setNotificationLoop('Ringing', true); await flush();
  assert.ok(media.reduce((sum, audio) => sum + audio.volume, 0) <= 0.700001, 'fading and new voices share the same cap');
  App.stopNotificationAudio();
});
test('call joins and leaves remain audible during DND and finish while logout clears other sounds', async () => {
  const { App, sources, load } = setup();
  load('js/chat/notification-audio.js');
  App.currentUser.notificationStatus = 'dnd';
  App.playNotificationSound('JoinCall'); App.playNotificationSound('LeaveCall');
  App.setNotificationLoop('Called', true); await flush();
  assert.equal(sources.length, 2, 'call cues remain audible; incoming rings are silent');
  App.stopNotificationAudio({ preserveCallCues:true });
  assert.equal(sources[0].stoppedAt, undefined);
  assert.equal(sources[1].stoppedAt, undefined);
  App.stopNotificationAudio();
  assert.ok(sources.every(source => source.stoppedAt));
});

test('unloaded desktop policy and DND gate incoming sound before decoding or playback starts', async () => {
  const { App, sources, load, initializers } = setup({ policyReady:false });
  load('js/chat/notification-audio.js');
  initializers.find(item => item.id === 'chat/notification-audio').initialize();
  App.playNotificationSound('Message'); App.playNotificationSound('Ping'); App.setNotificationLoop('Called', true);
  await flush();
  assert.equal(sources.length, 0);
  App.currentUser.notificationStatus = 'dnd'; App.notificationStatusReady = true; App.notifyStatusChanged();
  await flush(); assert.equal(sources.length, 0, 'DND must not start and fade a blocked sound');
  App.currentUser.notificationStatus = 'online'; App.notifyStatusChanged();
  await flush(); assert.equal(sources.length, 1, 'the still-active ring resumes once notifications are allowed');
  App.stopNotificationAudio(); App.stopNotificationStatusSync();
});

test('native ping popups retain metadata, deduplicate, hide DND preview and jump to their message', async () => {
  const { App, context, notifications, initializers } = setup();
  const popups = [], policies = [], actions = [];
  let command;
  context.chatDesktopNotifications = { showPing: ping => popups.push(ping), setPolicy: policy => policies.push(policy), onPingCommand: callback => { command = callback; } };
  initializers.find(item => item.id === 'chat/notifications').initialize();
  App.roomsMetaCache.set('test', { photoDataURL:'data:image/png;base64,room' });
  App.handleRoomNotificationMessage('test', 'one', { userCode:'peer', username:'Friend', text:'@Tester hello' });
  App.showDesktopPingNotification({ roomId:'test', fromUsername:'Friend', messageKey:'one' });
  assert.equal(popups.length, 1);
  assert.equal(popups[0].preview, '@Tester hello');
  assert.equal(popups[0].username, 'Friend');
  assert.equal(popups[0].roomIcon, 'data:image/png;base64,room');
  App.currentUser.notificationStatus = 'dnd';
  App.handleRoomNotificationMessage('test', 'two', { userCode:'peer', username:'Friend', text:'@Tester private' });
  assert.equal(popups[1].preview, ''); assert.equal(popups[1].doNotDisturb, true);
  assert.equal(notifications.length, 0, 'native popups never add Notification Center entries');
  App.openRoom = async room => { actions.push(['room',room]); App.currentRoomId = room; };
  App.jumpToRoomMessage = async (key, { roomId }) => { assert.equal(roomId, 'test'); actions.push(['message',key]); };
  command({ roomId:'test', messageKey:'two' }); await flush();
  assert.deepEqual(actions, [['room','test'],['message','two']]);
  App.pushNotifsEnabled = false;
  App.handleRoomNotificationMessage('test', 'three', { userCode:'peer', username:'Friend', text:'@Tester silent' });
  assert.equal(popups.length, 2);
  assert.ok(policies.at(-1).doNotDisturb);
});

test('native pings suppress only the focused room and independently retain simultaneous rooms', () => {
  const { App, context, document, notifications } = setup();
  const popups = [], policies = [];
  context.chatDesktopNotifications = { showPing: ping => popups.push(ping), setPolicy: policy => policies.push(policy) };
  App.currentRoomId = 'test';
  App.desktopPresenceFocused = true;
  App.membershipMap.set('third', true);
  const ping = (roomId, messageKey) => App.showDesktopPingNotification({ roomId, messageKey, fromUsername:'Friend', message:{ text:'@Tester hi' } });
  ping('test', 'viewed'); ping('other', 'one'); ping('third', 'two'); ping('other', 'three');
  assert.deepEqual(popups.map(popup => popup.id), ['other/one', 'third/two', 'other/three']);
  assert.equal(App.getDesktopNotificationRoomId(), 'test');
  assert.equal(policies.at(-1).activeRoomId, 'test');
  App.desktopPresenceFocused = false;
  ping('test', 'viewed');
  assert.equal(popups.length, 3, 'a delayed inbox copy cannot replay a ping already seen in the focused room');
  ping('test', 'background');
  assert.equal(popups.at(-1).id, 'test/background', 'another foreground app still allows a ping for the selected room');
  App.desktopPresenceFocused = true;
  document.hidden = true;
  ping('test', 'hidden');
  assert.equal(popups.at(-1).id, 'test/hidden');
  document.hidden = false;
  App.views.chat.dataset.active = 'false';
  ping('test', 'another-view');
  assert.equal(popups.at(-1).id, 'test/another-view');
  App.syncDesktopNotificationPolicy();
  assert.equal(policies.at(-1).activeRoomId, '', 'leaving chat clears the native suppression target');
  assert.equal(notifications.length, 0);
});

test('native ping rechecks focused room after asynchronous message loading', async () => {
  const { App, context } = setup();
  const popups = [];
  context.chatDesktopNotifications = { showPing: ping => popups.push(ping), setPolicy() {} };
  App.currentRoomId = 'other'; App.desktopPresenceFocused = false;
  let resolveMessage;
  const original = App.db.ref.bind(App.db);
  App.db.ref = key => key === 'messages/test/one' ? { once: () => new Promise(resolve => { resolveMessage = resolve; }) } : original(key);
  App.showDesktopPingNotification({ roomId:'test', messageKey:'one', fromUsername:'Friend' });
  App.currentRoomId = 'test'; App.desktopPresenceFocused = true;
  resolveMessage({ val: () => ({ text:'@Tester arrived while opening' }) });
  await flush();
  assert.equal(popups.length, 0, 'a fetch completing after the room opens cannot flash a stale popup');
});

test('native ping activation reuses an open room and waits for its initial message paint', async () => {
  const { App, context, initializers, load } = setup();
  context.chatDesktopNotifications = { showPing() {}, setPolicy() {}, onPingCommand() {} };
  load('js/chat/header.js');
  initializers.find(item => item.id === 'chat/notifications').initialize();
  const actions = [];
  App.currentRoomId = 'test';
  App.sanitizeRoomCode = String;
  App.getStoredPlace = () => `room:${App.currentRoomId}`;
  App.msgElByKey = new Map([['one', {}], ['two', {}]]);
  App.closeRoomSearch = () => {};
  App.msgHistoryRoomId = 'test';
  App.msgInitialTailPending = true;
  App.bulkLoading = true;
  App.openRoom = async room => { actions.push(['room', room]); App.currentRoomId = room; };
  App.scrollToMessageKey = async key => actions.push(['message', key]);
  const activation = App.openDesktopPingMessage({ roomId:'test', messageKey:'one' });
  await flush();
  assert.deepEqual(actions, [], 'room loading must finish before calling the shared message jump');
  App.msgInitialTailPending = false; App.bulkLoading = false;
  await activation;
  assert.deepEqual(actions, [['message', 'one']], 'selected room is preserved without reopening its subscriptions');
  App.views.chat.dataset.active = 'false';
  App.showView = name => { actions.push(['view', name]); App.views.chat.dataset.active = 'true'; };
  await App.openDesktopPingMessage({ roomId:'test', messageKey:'two' });
  assert.deepEqual(actions.slice(1), [['view','chat'], ['message','two']]);
});

test('native ping activation opens another room once and waits for the asynchronously loaded history', async () => {
  const { App, context, initializers, load } = setup();
  context.chatDesktopNotifications = { showPing() {}, setPolicy() {}, onPingCommand() {} };
  load('js/chat/header.js');
  initializers.find(item => item.id === 'chat/notifications').initialize();
  const actions = [];
  App.currentRoomId = 'test';
  App.sanitizeRoomCode = String;
  App.getStoredPlace = () => `room:${App.currentRoomId}`;
  App.msgElByKey = new Map([['target', {}]]);
  App.closeRoomSearch = () => {};
  App.openRoom = async room => { actions.push(['room', room]); App.currentRoomId = room; App.msgHistoryRoomId = room; App.msgInitialTailPending = true; };
  App.scrollToMessageKey = async key => actions.push(['message', key]);
  const activation = App.openDesktopPingMessage({ roomId:'other', messageKey:'target' });
  await flush();
  assert.deepEqual(actions, [['room','other']]);
  App.msgInitialTailPending = false;
  await activation;
  assert.deepEqual(actions, [['room','other'], ['message','target']]);
  await App.openDesktopPingMessage({ roomId:'unknown', messageKey:'forbidden' });
  assert.equal(actions.length, 2, 'a popup cannot open a room the account has left');
});

test('simultaneous native ping commands reuse pending navigation and keep the latest message target', async () => {
  const { App } = setup();
  App.currentRoomId = 'test';
  const actions = [];
  let finishOpening;
  App.openRoom = room => {
    actions.push(['room', room]);
    return new Promise(resolve => { finishOpening = () => { App.currentRoomId = room; resolve(); }; });
  };
  App.jumpToRoomMessage = async (key, { roomId }) => actions.push(['message', roomId, key]);
  const first = App.openDesktopPingMessage({ roomId:'other', messageKey:'first' });
  const second = App.openDesktopPingMessage({ roomId:'other', messageKey:'second' });
  await flush();
  assert.deepEqual(actions, [['room','other']]);
  finishOpening();
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(actions, [['room','other'], ['message','other','second']]);
});

test('cross-room native ping activations serialize an outstanding activity close and keep the latest room', async () => {
  const { App } = setup();
  App.currentRoomId = 'test'; App.membershipMap.set('third', true);
  const actions = [];
  let finishFirstOpen;
  App.openRoom = room => {
    actions.push(['room', room]);
    if (room === 'other') return new Promise(resolve => { finishFirstOpen = () => { App.currentRoomId = room; resolve(); }; });
    App.currentRoomId = room;
    return Promise.resolve();
  };
  App.jumpToRoomMessage = async (key, { roomId }) => actions.push(['message', roomId, key]);
  const first = App.openDesktopPingMessage({ roomId:'other', messageKey:'old-target' });
  await flush();
  const latest = App.openDesktopPingMessage({ roomId:'third', messageKey:'latest-target' });
  await flush();
  assert.deepEqual(actions, [['room','other']], 'second navigation waits for the outstanding activity close');
  finishFirstOpen();
  assert.deepEqual(await Promise.all([first, latest]), [false, true]);
  assert.equal(App.currentRoomId, 'third');
  assert.deepEqual(actions, [['room','other'], ['room','third'], ['message','third','latest-target']]);
});

test('a latest ping for the currently selected room wins after an older pending room open', async () => {
  const { App } = setup();
  App.currentRoomId = 'test';
  const actions = [];
  let finishFirstOpen;
  App.openRoom = room => {
    actions.push(['room', room]);
    if (room === 'other') return new Promise(resolve => { finishFirstOpen = () => { App.currentRoomId = room; resolve(); }; });
    App.currentRoomId = room;
    return Promise.resolve();
  };
  App.jumpToRoomMessage = async (key, { roomId }) => actions.push(['message', roomId, key]);
  const first = App.openDesktopPingMessage({ roomId:'other', messageKey:'old-target' });
  await flush();
  const latest = App.openDesktopPingMessage({ roomId:'test', messageKey:'current-room-target' });
  await flush();
  assert.deepEqual(actions, [['room','other']], 'already-selected destination still waits for an older open in flight');
  finishFirstOpen();
  assert.deepEqual(await Promise.all([first, latest]), [false, true]);
  assert.equal(App.currentRoomId, 'test');
  assert.deepEqual(actions, [['room','other'], ['room','test'], ['message','test','current-room-target']]);
});

test('desktop DND expires at six hours or next displayed 6 AM using network time and persists across restart', async () => {
  const { App, load } = setup();
  load('js/ui/clock.js');
  App.EST_TZ = 'America/New_York';
  App.getDateTimeFormatter = (locale, options) => new Intl.DateTimeFormat(locale, options);
  let now = Date.parse('2026-10-18T09:59:00Z');
  App.accurateNowMs = () => now;
  assert.equal(App.notificationDndDeadline(), Date.parse('2026-10-18T10:00:00Z'));
  now = Date.parse('2026-10-18T14:00:00Z');
  assert.equal(App.notificationDndDeadline(), now + 6 * 3600000);
  await App.setNotificationStatus('dnd');
  const saved = (await App.db.ref('users/TEST-USER/notificationStatusExpiresAt').once('value')).val();
  App.startNotificationStatusSync(); await flush();
  assert.equal(App.currentUser.notificationStatusExpiresAt, saved);
  now = saved + 1; App.syncDndExpiry(); await flush();
  assert.equal(App.currentUser.notificationStatus, 'online');
  assert.equal((await App.db.ref('users/TEST-USER/notificationStatus').once('value')).val(), 'online');
  App.stopNotificationStatusSync();
  const web = setup({desktop:false});
  web.App.currentUser.notificationStatus = 'dnd'; web.App.currentUser.notificationStatusExpiresAt = 1;
  web.App.syncDndExpiry(); assert.equal(web.App.currentUser.notificationStatus, 'dnd', 'web does not automatically change the preference');
});

test('expired DND remains effectively online through a failed save and primes cold-cache guarded writes', async () => {
  const { App, context } = setup();
  const now = Date.now(), deadline = now - 1000, policies = [];
  App.accurateNowMs = () => now;
  await App.db.ref('users/TEST-USER').update({ notificationStatus:'dnd', notificationStatusExpiresAt:deadline });
  App.currentUser.notificationStatus = 'dnd'; App.currentUser.notificationStatusExpiresAt = deadline;
  context.chatDesktopNotifications = { setPolicy: policy => policies.push(policy) };
  const original = App.db.ref.bind(App.db);
  let fail = true, primed = false, transactions = 0;
  App.db.ref = path => {
    const ref = original(path);
    if (path === 'users/TEST-USER') {
      const once = ref.once.bind(ref), transaction = ref.transaction.bind(ref);
      ref.once = async (...args) => { if (fail) throw new Error('offline'); primed = true; return once(...args); };
      ref.transaction = (...args) => { assert.equal(primed, true, 'CAS must not abort against an empty local cache'); transactions++; return transaction(...args); };
    }
    return ref;
  };
  App.syncDndExpiry(); await flush();
  assert.equal(App.isDoNotDisturb(), false, 'offline persistence cannot extend local DND');
  assert.equal(policies.at(-1).doNotDisturb, false);
  assert.equal(transactions, 0);
  fail = false; App.syncDndExpiry(); await flush();
  assert.equal(transactions, 1);
  assert.equal(App.currentUser.notificationStatus, 'online');
  assert.equal((await original('users/TEST-USER/notificationStatus').once('value')).val(), 'online');
  App.stopNotificationStatusSync();
});
