'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function database(clock) {
  let data = {};
  const listeners = new Map();
  const read = path => path.split('/').filter(Boolean).reduce((v, key) => v?.[key], data) ?? null;
  const snapshot = path => { const value = clone(read(path)); return { val: () => value, exists: () => value != null }; };
  const resolve = value => value && typeof value === 'object'
    ? value['.sv'] === 'timestamp' ? clock.now : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)])) : value;
  const write = (path, value) => {
    const keys = path.split('/').filter(Boolean);
    if (!keys.length) data = resolve(value) || {};
    else {
      let cursor = data;
      for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {};
      if (value == null) delete cursor[keys.at(-1)]; else cursor[keys.at(-1)] = resolve(value);
    }
    for (const [watched, callbacks] of [...listeners]) {
      if (path === watched || path.startsWith(watched + '/') || watched.startsWith(path + '/') || !path) {
        for (const callback of [...callbacks]) callback(snapshot(watched));
      }
    }
  };
  return {
    read, write, subscriptions: () => [...listeners].filter(([, callbacks]) => callbacks.size).map(([path]) => path),
    ref: path => ({
      once: async () => snapshot(path),
      set: async value => write(path, value),
      update: async values => { for (const [key, value] of Object.entries(values)) write(`${path}/${key}`, value); },
      remove: async () => write(path, null),
      on(type, cb) { if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(cb); cb(snapshot(path)); },
      off(type, cb) { if (cb) listeners.get(path)?.delete(cb); else listeners.delete(path); },
      transaction: async update => {
        const next = update(clone(read(path)));
        if (next === undefined) return { committed: false, snapshot: snapshot(path) };
        write(path, next);
        return { committed: true, snapshot: snapshot(path) };
      }
    })
  };
}
class Element {
  constructor() { this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.label = { textContent: '' }; this.hidden = false; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  querySelector(selector) {
    if (selector === '.msg-menu-label') return this.label;
    if (selector === '[data-call-ring]') return this.children.find(child => 'data-call-ring' in child.attributes);
    return null;
  }
}
function harness({ desktop = true, code = 'alice', db, clock = { now: 100000 }, initialize = true } = {}) {
  db ||= database(clock);
  const originalRef = db.ref.bind(db);
  if (!db.childrenReady) {
    db.ref = path => { const ref = originalRef(path); ref.child = suffix => db.ref(`${path}/${suffix}`); return ref; };
    db.childrenReady = true;
  }
  const initializers = new Map(), publications = [], loops = new Map([['Called', false], ['Ringing', false]]), events = {}, native = {}, actions = [], timers = new Map();
  let nextId = 0, nextTimer = 0;
  const App = {
    register: (id, init) => initializers.set(id, init), db,
    firebase: { database: { ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } } } },
    currentUser: { code }, currentCallRoomId: null, callSessionId: null, firebaseServerTimeOffsetMs: 0,
    callMembersCache: [], liveUserCache: new Map(), roomsMetaCache: new Map(),
    callHasLiveMembers: members => Object.values(members || {}).some(m => m?.connected && m?.sessionId),
    makeCallSessionId: () => `${code}-unique-${++nextId}`,
    callRunTransaction: (ref, fn, { isCurrent = () => true } = {}) => ref.transaction(value => isCurrent() ? fn(value) : undefined),
    defaultStickmanDataURL: () => 'data:image/png,default',
    roomDisplayName: (id, meta) => meta?.name || id,
    normalizeTransformToRel: value => value || { x: 0, y: 0, scale: 1 },
    views: { chat: { dataset: { active: 'true' } } },
    ensureLiveUserListener() {}, renderCallMenu() { actions.push('render'); },
    setNotificationLoop: (name, enabled) => loops.set(name, enabled), isDoNotDisturb: () => false,
    openRoom: async id => { actions.push(['open', id]); App.currentRoomId = id; },
    leaveCall: async () => { actions.push(['leave', App.currentCallRoomId]); App.currentCallRoomId = null; },
    joinCall: async id => { actions.push(['join', id]); App.currentCallRoomId = id; },
    showToast: value => actions.push(['toast', value])
  };
  const document = { hasFocus: () => false, visibilityState: 'visible', createElement: () => new Element(), addEventListener() {} };
  const context = vm.createContext({ ChatApp: App, Date: class extends Date { static now() { return clock.now; } },
    setInterval: () => { throw new Error('Ringing must not poll'); },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock.now + delay, delay }); return id; },
    clearTimeout: id => timers.delete(id), queueMicrotask, console, document, CustomEvent: class { constructor(type) { this.type = type; } },
    window: { addEventListener: (type, callback) => events[type] = callback, dispatchEvent() {} }
  });
  if (desktop) context.chatDesktopRings = { version: 2,
    publish: value => publications.push(clone(value)),
    onCommand: callback => native.command = callback,
    onVisibility: callback => native.visibility = callback,
    getVisibility: async () => ({ focused: false })
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/calling/ringing.js'), 'utf8'), context);
  if (initialize) initializers.get('calling/ringing')();
  return { App, db, clock, publications, loops, native, context, events, actions, document, initializers, timers };
}
const member = (code, sessionId = `${code}-session`) => ({ code, sessionId, connected: true });
function seed(h) {
  h.db.write('users', { alice: { username: 'Alice' }, bob: { username: 'Bob' }, charlie: { username: 'Charlie' } });
  h.db.write('memberships', { alice: { room: true, second: true }, bob: { room: true }, charlie: { second: true } });
  h.db.write('roomMembers', {room:{alice:true,bob:true},second:{alice:true,charlie:true}});
  h.db.write('calls/room', { instanceId: 'call1', members: { alice: member('alice') } });
  h.db.write('calls/second', { instanceId: 'call2', members: { charlie: member('charlie') } });
  h.App.currentCallRoomId = 'room'; h.App.callSessionId = 'alice-session';
  h.App.callSyncRingingSession();
}
const ring = (from = 'alice', to = 'bob', id = 'r1', instanceId = 'call1', createdAt = 100000) => ({ from, to, id, instanceId, createdAt });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('room members can ring and stop ringing while outside the active call', async () => {
  const h = harness({ desktop:false }); seed(h);
  h.App.currentCallRoomId = null; h.App.callSessionId = null; h.App.currentRoomId = 'room';
  h.db.write('calls/room/members', { charlie:member('charlie') });
  h.App.callRingingContextChanged(); await settle();
  assert.equal(h.App.getProfileRingAction('bob').label, 'Ring');
  assert.equal(await h.App.callRingUser('bob'), true);
  await settle();
  const action = h.App.getProfileRingAction('bob');
  assert.equal(action.label, 'Stop Ringing');
  assert.equal(await action.action(), true);
  assert.equal(h.App.currentCallRoomId, null, 'ringing never joins the call');
  h.db.write('calls/room/members', {}); await settle();
  assert.equal(h.App.getProfileRingAction('bob'), null, 'an ended call cannot be rung');
});

test('Ring requires room membership on web and desktop, never self or an already joined participant', async () => {
  const h = harness(); seed(h);
  await settle();
  assert.equal(h.App.getProfileRingAction('alice'), null);
  assert.equal(h.App.getProfileRingAction('charlie'), null);
  assert.equal(h.App.getProfileRingAction('bob').label, 'Ring');
  assert.equal(await h.App.callRingUser('bob'), true);
  assert.equal(h.App.getProfileRingAction('bob').label, 'Stop Ringing');
  assert.equal(h.loops.get('Ringing'), true);
  h.db.write('calls/room/members/bob', member('bob'));
  await settle();
  assert.equal(h.App.getProfileRingAction('bob'), null);
  assert.equal(h.loops.get('Ringing'), false);
  await settle();
  assert.ok(h.db.read('calls/room/rings/bob'), 'a sender cannot cancel a ring from a possibly stale target snapshot');
  const receiver = harness({ db: h.db, clock: h.clock, code: 'bob' });
  receiver.App.currentCallRoomId = 'room'; receiver.App.callSessionId = 'bob-session';
  receiver.App.callRefreshRinging(); await settle();
  assert.equal(h.db.read('calls/room/rings/bob'), null, 'the accepting session clears its own invitation');
  const web = harness({ desktop: false }); seed(web);
  assert.equal(web.App.getProfileRingAction('bob').label, 'Ring');
  assert.equal(await web.App.callRingUser('bob'), true);
  assert.equal(web.publications.length, 0);
});

test('ring leases expire at exactly thirty seconds using server time and no delayed snapshot restarts audio', async () => {
  const h = harness(); seed(h);
  h.db.write('calls/room/rings/bob', ring());
  await settle();
  h.clock.now = 129999; h.App.callRefreshRinging();
  assert.equal(h.loops.get('Ringing'), true);
  h.clock.now = 130000; h.App.callRefreshRinging();
  assert.equal(h.loops.get('Ringing'), false);
  assert.equal(h.App.getProfileRingAction('bob').label, 'Ring');
  h.db.write('calls/room/rings/bob', ring());
  assert.equal(h.loops.get('Ringing'), false);
  await settle();
  h.App.callRefreshRinging();
  await settle();
  assert.equal(h.db.read('calls/room/rings/bob'), null);
});

test('incoming and outgoing tones overlap; focused rooms and DND suppress incoming delivery without declining', async () => {
  const h = harness(); seed(h); await settle();
  h.db.write('calls/room/rings/bob', ring());
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'r2', 'call2'));
  await settle();
  assert.equal(h.loops.get('Called'), true);
  assert.equal(h.loops.get('Ringing'), true);
  assert.equal(h.publications.at(-1).rings.length, 1);
  h.App.currentRoomId = 'second'; h.native.visibility({ focused: true });
  await settle();
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.loops.get('Ringing'), true);
  assert.equal(h.publications.at(-1).rings.length, 0);
  h.native.visibility({ focused: false });
  await settle();
  assert.equal(h.loops.get('Called'), true, 'room behind a different foreground app still rings');
  h.App.isDoNotDisturb = () => true; h.events['app:status-changed']();
  await settle();
  assert.equal(h.loops.get('Called'), false, 'desktop DND suppresses incoming audio');
  assert.equal(h.db.read('calls/second/rings/alice').id, 'r2', 'DND leaves the active invitation intact');
  assert.equal(h.publications.at(-1).rings.length, 0);
  h.App.isDoNotDisturb = () => false; h.App.callRefreshRinging();
  h.db.write('rooms/second', { name: 'Renamed room', photoDataURL: 'data:image/png,new' });
  await settle();
  assert.equal(h.publications.at(-1).rings[0].roomName, 'Renamed room');
  assert.equal(h.publications.at(-1).rings[0].roomIcon, 'data:image/png,new');
});

test('multiple rooms stack and declining one preserves others; stale native commands cannot stop a replacement', async () => {
  const h = harness(); seed(h); await settle();
  h.db.write('memberships/alice/third', true); h.db.write('memberships/bob/third', true);
  h.db.write('calls/third', { instanceId: 'call3', members: { bob: member('bob') }, rings: { alice: ring('bob', 'alice', 'r3', 'call3') } });
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'r2', 'call2'));
  await settle();
  assert.equal(h.publications.at(-1).rings.length, 2);
  await h.App.callHandleRingCommand({ action: 'decline', roomId: 'second', id: 'r2' });
  assert.equal(h.publications.at(-1).rings.length, 1);
  assert.equal(h.loops.get('Called'), true);
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'r4', 'call2'));
  await h.App.callHandleRingCommand({ action: 'decline', roomId: 'second', id: 'r2' });
  assert.equal(h.db.read('calls/second/rings/alice').id, 'r4');
  await h.App.callHandleRingCommand({ action: 'join', roomId: 'second', id: 'r4' });
  assert.deepEqual(h.actions.filter(Array.isArray), [['leave', 'room'], ['open', 'second'], ['join', 'second']]);
});

test('any eligible participant can stop another sender’s ring; menu label changes live without reopening', async () => {
  const h = harness(); seed(h);
  h.db.write('memberships/charlie/room', true);
  h.db.write('calls/room/members/charlie', member('charlie'));
  h.App.msgMenuEl = new Element(); h.App.msgMenuCtx = { menu: 'avatar', userCode: 'bob' };
  h.App.callSyncRingMenu();
  const button = h.App.msgMenuEl.querySelector('[data-call-ring]');
  assert.equal(button.label.textContent, 'Ring');
  h.db.write('calls/room/rings/bob', ring('charlie', 'bob'));
  await settle();
  assert.equal(button.label.textContent, 'Stop Ringing');
  await h.App.getProfileRingAction('bob').action();
  assert.equal(button.label.textContent, 'Ring');
  h.App.currentCallRoomId = null; h.App.callRefreshRinging();
  assert.equal(button.hidden, true);
});

test('room removal/logout clears popups and loops, and ring observers cannot delete a still-loading valid lease', async () => {
  const clock = { now: 100000 }, db = database(clock);
  db.write('memberships', { alice: { room: true }, bob: { room: true } });
  db.write('calls/room', { instanceId: 'call1', members: { bob: member('bob') }, rings: { alice: ring('bob', 'alice') } });
  const h = harness({ db, clock }); await settle();
  assert.equal(db.read('calls/room/rings/alice').id, 'r1', 'initial listener ordering preserves a live invitation');
  assert.equal(h.loops.get('Called'), true);
  db.write('memberships/alice/room', null);
  await settle();
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.publications.at(-1).rings.length, 0);
  h.App.currentUser = null; h.App.callSyncRingingSession();
  db.write('calls/room/rings/alice', ring('bob', 'alice', 'new'));
  assert.equal(h.loops.get('Called'), false);
});

test('only the winning call generation rings on simultaneous starts, and joining/reconnecting never rings again', async () => {
  const clock = { now: 100000 }, db = database(clock);
  db.write('users', { alice: { username: 'Alice' }, bob: { username: 'Bob' }, charlie: { username: 'Charlie' } });
  db.write('memberships', { alice: { room: true }, bob: { room: true }, charlie: { room: true }, outsider: { other: true } });
  db.write('roomMembers', {room:{alice:true,bob:true,charlie:true},other:{outsider:true}});
  const a = harness({ desktop: false, code: 'alice', db, clock });
  const b = harness({ desktop: false, code: 'bob', db, clock });
  for (const h of [a, b]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../call-modules/lifecycle.js'), 'utf8'), h.context);
    h.App.currentCallRoomId = 'room'; h.App.callSessionId = `${h.App.currentUser.code}-session`; h.App.callLifecycleToken = 1;
  }
  const started = [];
  for (const h of [a, b]) {
    const original = h.App.callRingOnCallStarted;
    h.App.callRingOnCallStarted = (...args) => { started.push(h.App.currentUser.code); return original(...args); };
  }
  await Promise.all([a.App.callCommitMembership('room', member('alice')), b.App.callCommitMembership('room', member('bob'))]);
  await settle();
  assert.equal(started.length, 1, 'one instanceId transaction elects one fanout owner');
  assert.deepEqual(Object.keys(db.read('calls/room/rings')), ['charlie'], 'already joined users, starter and nonmembers are excluded');
  const invitation = clone(db.read('calls/room/rings/charlie'));
  await b.App.callCommitMembership('room', member('bob'));
  await settle();
  assert.equal(started.length, 1);
  assert.deepEqual(db.read('calls/room/rings/charlie'), invitation, 'reconnect does not reset the thirty-second timer');
});

test('compare-and-delete cancellation never removes a newer ring, and clock skew is translated for native expiry', async () => {
  const h = harness(); seed(h); await settle();
  h.App.firebaseServerTimeOffsetMs = 5000;
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'fresh', 'call2', 105000));
  await settle();
  assert.equal(h.publications.at(-1).rings[0].expiresAt, 130000);
  assert.equal(await h.App.callStopRing('second', 'alice', 'old'), false);
  assert.equal(h.db.read('calls/second/rings/alice').id, 'fresh');
  h.clock.now = 130000; h.App.callRefreshRinging();
  assert.equal(h.loops.get('Called'), false);
});

test('idle sessions use narrow memberships and invitation subscriptions with no polling or lease timer', async () => {
  const h = harness(); seed(h); await settle();
  const paths = h.db.subscriptions();
  assert.equal(paths.includes('memberships'), false, 'never observe all users and all rooms');
  assert.equal(paths.includes('memberships/alice'), true);
  assert.equal(paths.includes('calls/second/rings'), true);
  assert.equal(paths.includes('calls/second/members'), false, 'unrelated room call activity needs no observer while there are no rings');
  assert.equal(paths.some(path => path.startsWith('rooms/')), false, 'room metadata is unnecessary until an incoming invitation');
  assert.equal(h.timers.size, 0, 'idle ring features schedule no repeating or one-shot work');
  let refreshes = 0, menus = 0;
  const refresh = h.App.callRefreshRinging, menu = h.App.callSyncRingMenu;
  h.App.callRefreshRinging = () => { ++refreshes; return refresh(); };
  h.App.callSyncRingMenu = () => { ++menus; return menu(); };
  for (let i = 0; i < 100; i++) {
    h.db.write('memberships/someone-else/unrelated/lastSeenAt', i);
    h.db.write('memberships/alice/room', { lastSeenAt: i });
    h.db.write('calls/room/members/alice/speaking', i % 2 === 0);
    h.db.write('calls/room/members/alice/lastSeenAt', h.clock.now + i);
    h.db.write('rooms/room/messageCount', i);
    h.App.callRingingContextChanged();
  }
  await settle();
  assert.equal(refreshes, 0, 'membership read receipts, unrelated rooms, VAD and healthy heartbeats do not repaint rings');
  assert.equal(menus, 0, 'hidden context menus incur no DOM traversal');
});

test('Firebase event bursts coalesce and a single exact-deadline timer stops tones and releases listeners', async () => {
  const h = harness(); seed(h); await settle();
  let refreshes = 0;
  const refresh = h.App.callRefreshRinging;
  h.App.callRefreshRinging = () => { ++refreshes; return refresh(); };
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'one', 'call2'));
  h.db.write('rooms/second/name', 'A');
  h.db.write('rooms/second/name', 'B');
  h.db.write('rooms/second/name', 'Final room');
  await settle();
  assert.equal(refreshes, 1, 'one render for the database event burst');
  assert.equal(h.publications.at(-1).rings[0].roomName, 'Final room');
  assert.equal(h.db.subscriptions().includes('rooms/second'), false, 'only metadata leaves are watched');
  assert.equal(h.timers.size, 1);
  const [timerId, timer] = [...h.timers][0];
  assert.equal(timer.at, 130000);
  assert.equal(timer.delay, 30000);
  h.clock.now = timer.at; h.timers.delete(timerId); timer.fn(); await settle();
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.publications.at(-1).rings.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.db.subscriptions().includes('calls/second/members'), false);
  assert.equal(h.db.subscriptions().some(path => path.startsWith('rooms/second/')), false);
});

test('live menu eligibility follows target membership changes without a global membership observer', async () => {
  const h = harness(); seed(h); await settle();
  h.App.msgMenuEl = new Element(); h.App.msgMenuCtx = { menu: 'avatar', userCode: 'bob' };
  h.App.callSyncRingMenu(); await settle();
  const button = h.App.msgMenuEl.querySelector('[data-call-ring]');
  assert.equal(button.label.textContent, 'Ring');
  assert.equal(h.db.subscriptions().includes('memberships/bob/room'), true);
  h.db.write('memberships/bob/room', null); await settle();
  assert.equal(button.hidden, true);
  h.db.write('memberships/bob/room', true); await settle();
  assert.equal(button.hidden, false);
  h.App.currentCallRoomId = null; h.App.callRingingContextChanged(); await settle();
  assert.equal(button.hidden, true);
  assert.equal(h.db.subscriptions().includes('memberships/bob/room'), false);
});

test('call starts and manual rings skip orphan memberships and partial deleted accounts', async () => {
  const h = harness(); seed(h);
  h.db.write('memberships/ghost/room', true);
  h.db.write('memberships/partial/room', true);
  h.db.write('roomMembers/room/ghost',true);
  h.db.write('roomMembers/room/partial',true);
  h.db.write('users/partial', { notificationStatus: 'online' });
  await h.App.callRingOnCallStarted('room', { instanceId: 'call1' }, 'call1');
  assert.deepEqual(Object.keys(h.db.read('calls/room/rings')), ['bob']);
  h.db.write('calls/room/rings/ghost', ring('alice', 'ghost', 'orphan'));
  await settle();
  assert.deepEqual(clone(h.App.callGetRingingMembers('room')).map(user => user.username), ['Bob']);
  assert.equal(h.App.getProfileRingAction('ghost'), null);
  h.db.write('users/bob', null); await settle();
  assert.equal(h.App.callGetRingingMembers('room').length, 0);
  assert.equal(await h.App.callRingUser('bob'), false);
});

test('Decline silences immediately during another call transition even when Firebase never acknowledges', async () => {
  const h = harness(); seed(h);
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'incoming', 'call2'));
  await settle();
  h.App.callJoinPending = true;
  h.App.callStopRing = () => new Promise(() => {});
  await h.App.callHandleRingCommand({ action: 'decline', roomId: 'second', id: 'incoming' });
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.publications.at(-1).rings.length, 0);
  h.App.callRefreshRinging();
  assert.equal(h.loops.get('Called'), false, 'unacknowledged snapshot cannot restore a dismissed invitation');
});

test('Join answers immediately without reopening the current room or waiting for ring deletion', async () => {
  const h = harness(); seed(h);
  h.App.currentCallRoomId = null;
  h.App.currentRoomId = 'second';
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'incoming', 'call2'));
  await settle();
  h.App.callStopRing = () => new Promise(() => {});
  await h.App.callHandleRingCommand({ action: 'join', roomId: 'second', id: 'incoming' });
  assert.deepEqual(h.actions.filter(Array.isArray), [['join', 'second']]);
  assert.equal(h.loops.get('Called'), false);
});

test('rapid Ring/Stop/Ring updates immediately and serializes intent over slow reads', async () => {
  const h = harness(); seed(h); await settle();
  let release;
  const original = h.db.ref;
  let delayOnce = true;
  h.db.ref = path => {
    const ref = original(path);
    if (path === 'memberships/bob/room') {
      const once = ref.once;
      ref.once = (...args) => delayOnce ? (delayOnce = false, new Promise(resolve => { release = () => once(...args).then(resolve); })) : once(...args);
    }
    return ref;
  };
  const first = h.App.callRingUser('bob');
  assert.equal(h.App.getProfileRingAction('bob').label, 'Stop Ringing', 'the first press does not await network reads');
  await settle();
  const stop = h.App.getProfileRingAction('bob').action();
  assert.equal(h.App.getProfileRingAction('bob').label, 'Ring', 'stop updates while the first send is pending');
  const latest = h.App.callRingUser('bob');
  assert.equal(h.App.getProfileRingAction('bob').label, 'Stop Ringing');
  release();
  assert.deepEqual(await Promise.all([first, stop, latest]), [false, true, true]);
  assert.equal(h.db.read('calls/room/rings/bob').id, 'alice-unique-2', 'old commands cannot delete the replacement');
});

test('out-of-order member snapshots and unresolved timestamps never cancel a new ring', async () => {
  const h = harness(); seed(h); await settle();
  h.db.write('calls/room/members/bob', member('bob', 'old-session'));
  h.db.write('calls/room/rings/bob', ring('alice', 'bob', 'fresh'));
  await settle();
  assert.equal(h.db.read('calls/room/rings/bob').id, 'fresh');
  h.db.write('calls/room/members/bob', null); await settle();
  assert.equal(h.App.getProfileRingAction('bob').label, 'Stop Ringing');
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'future', 'call2', h.clock.now + 5000));
  await settle();
  assert.equal(h.db.read('calls/second/rings/alice').id, 'future', 'a future timestamp is not an expired lease');
});

test('desktop policy readiness gates the first ring publication and audio without changing its lease', async () => {
  const h = harness(); seed(h);
  h.App.desktopNotificationPolicyReady = () => false;
  h.db.write('calls/second/rings/alice', ring('charlie', 'alice', 'incoming', 'call2'));
  await settle();
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.publications.at(-1).statusReady, false);
  assert.equal(h.publications.at(-1).rings.length, 0);
  h.App.desktopNotificationPolicyReady = () => true;
  h.App.isDoNotDisturb = () => true;
  h.App.callRefreshRinging();
  assert.equal(h.loops.get('Called'), false);
  assert.equal(h.publications.at(-1).doNotDisturb, true);
  assert.equal(h.db.read('calls/second/rings/alice').id, 'incoming');
});
