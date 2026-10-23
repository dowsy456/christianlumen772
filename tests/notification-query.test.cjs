'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const pushKey = timestamp => {
  const chars = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let key = '';
  for (let index = 0; index < 8; index++) { key = chars[timestamp % 64] + key; timestamp = Math.floor(timestamp / 64); }
  return key + '------------';
};

// Exercise actual key ordering and limit-window eviction/refill, which the
// general app fixture deliberately does not implement. No remote database.
function setup() {
  const rooms = new Map(), listeners = new Set(), queries = [], sounds = [];
  const since = 10000;
  function select(query) {
    return [...(rooms.get(query.path) || new Map())].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(-query.limit);
  }
  function snapshot(entries) {
    return { forEach: callback => entries.some(([key, value]) => callback({ key, val: () => value }) === true) };
  }
  function ref(roomPath, limit = null, ordered = false) {
    return {
      path: roomPath, limit, ordered,
      orderByKey() { return ref(roomPath, limit, true); },
      orderByChild() { throw new Error('Message listeners must not require a custom Firebase index'); },
      limitToLast(count) { return ref(roomPath, count, ordered); },
      on(event, callback) {
        assert.equal(ordered, true); assert.ok(limit > 0 && limit <= 50);
        queries.push({ path: roomPath, limit, event });
        const query = this, entry = { query, event, callback };
        listeners.add(entry);
        const entries = select(query);
        if (event === 'value') queueMicrotask(() => callback(snapshot(entries)));
        if (event === 'child_added') for (const [key, value] of entries) queueMicrotask(() => callback({ key, val: () => value }));
      },
      off(event, callback) {
        for (const entry of listeners) if (entry.query === this && entry.event === event && entry.callback === callback) listeners.delete(entry);
      },
      once() { return Promise.resolve(snapshot(select(this))); }
    };
  }
  function put(room, timestamp, message) {
    const roomPath = `messages/${room}`, key = pushKey(timestamp);
    const relevant = [...listeners].filter(entry => entry.query.path === roomPath);
    const prior = new Map(relevant.map(entry => [entry, new Map(select(entry.query))]));
    if (!rooms.has(roomPath)) rooms.set(roomPath, new Map());
    if (message === null) rooms.get(roomPath).delete(key);
    else rooms.get(roomPath).set(key, { userCode: 'peer', createdAt: timestamp, ...message });
    for (const entry of relevant) {
      const entries = select(entry.query);
      if (entry.event === 'value') queueMicrotask(() => entry.callback(snapshot(entries)));
      if (entry.event === 'child_added') for (const [childKey, value] of entries) {
        if (!prior.get(entry).has(childKey)) queueMicrotask(() => entry.callback({ key: childKey, val: () => value }));
      }
    }
    return key;
  }
  const App = {
    register() {}, db: { ref }, currentUser: { code: 'me', username: 'Me' },
    membershipMap: new Map([['test', true], ['other', true]]),
    appPresenceNow: () => since, playNotificationSound: sound => sounds.push(sound),
    queueReadReceiptSync() {}
  };
  const context = vm.createContext({ ChatApp: App, window: {}, document: { hidden: false }, console, setTimeout, clearTimeout, Date });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/chat/notifications.js'), 'utf8'), context);
  return { App, put, queries, listeners, sounds, since };
}

test('notification queries use the built-in key index and a bounded tail; head follows the room history', async () => {
  const { App, put, queries, listeners, sounds } = setup();
  for (let timestamp = 1; timestamp <= 140; timestamp++) put('test', timestamp, { text: 'history' });
  App.syncRoomMessageNotifications(); await flush();
  assert.deepEqual(sounds, []);
  assert.deepEqual(queries.map(query => query.limit), [50, 50, 50, 50], 'head/cache and notifications share the exact bounded SDK query');
  assert.equal(App.notificationRoomHeads.get('test'), pushKey(140));
  assert.equal(App.notificationRoomHeads.get('other'), '');
  // Delayed poll-end logs can have an older createdAt than their insertion key.
  put('test', 150, { t: 'system', createdAt: 10 }); await flush();
  assert.equal(App.notificationRoomHeads.get('test'), pushKey(150));
  put('test', 150, null); await flush();
  assert.equal(App.notificationRoomHeads.get('test'), pushKey(140));
  App.detachRoomMessageNotifications();
  assert.equal(listeners.size, 0); assert.equal(App.notificationRoomHeads.size, 0);
});

test('limited-query refill stays silent, live messages notify once, and leaving detaches both listeners', async () => {
  const { App, put, sounds, since, listeners } = setup();
  for (let timestamp = 1; timestamp <= 140; timestamp++) put('test', timestamp, { text: 'history' });
  App.syncRoomMessageNotifications(); await flush();
  put('test', since + 1, { text: 'new message' });
  put('other', since + 2, { text: '@Me new ping' }); await flush();
  assert.deepEqual(sounds, ['Message', 'Ping']);
  put('test', since + 1, { text: 'edited message' });
  put('test', since + 1, null);
  // Removing enough children brings never-observed history into the window.
  for (let timestamp = 140; timestamp > 120; timestamp--) put('test', timestamp, null);
  await flush();
  assert.deepEqual(sounds, ['Message', 'Ping']);
  put('test', since + 3, { t: 'system', text: 'room event' });
  put('test', since + 4, { userCode: 'me', text: 'own message' }); await flush();
  assert.deepEqual(sounds, ['Message', 'Ping']);
  App.membershipMap.delete('other'); App.syncRoomMessageNotifications();
  put('other', since + 5, { text: '@Me after leaving' }); await flush();
  assert.equal(listeners.size, 2); assert.equal(App.notificationRoomHeads.has('other'), false);
  assert.deepEqual(sounds, ['Message', 'Ping']);
  App.detachRoomMessageNotifications();
});

test('new messages arriving before the initial value fence still notify, pending callbacks after logout do not', async () => {
  const { App, put, sounds, since } = setup();
  put('test', since - 1, { text: 'initial history' });
  App.syncRoomMessageNotifications();
  put('test', since + 1, { text: 'concurrent incoming message' }); await flush();
  assert.deepEqual(sounds, ['Message']);
  put('test', since + 2, { text: 'queued before logout' });
  App.detachRoomMessageNotifications(); await flush();
  assert.deepEqual(sounds, ['Message']);
});

test('sidebar previews follow remote inserts, edits and deletes without a sender metadata write', async () => {
  const { App, put } = setup();
  App.roomsMetaCache = new Map([['test', { lastMessagePreview: 'stale metadata', lastMessageAt: 1 }]]);
  App.getMessagePreviewText = message => message.text;
  App.formatRoomLastMessagePreview = (text, username) => `${username}: ${text}`;
  let renders = 0;App.renderRoomsList = () => { renders++; };
  put('test', 2, { text: 'earlier', username: 'Peer' });
  App.syncRoomMessageNotifications();await flush();
  put('test', 3, { text: 'remote latest', username: 'Peer' });await flush();
  assert.equal(App.getRoomDisplayMeta('test').lastMessagePreview,'Peer: remote latest');
  put('test', 3, { text: 'edited latest', username: 'Peer' });await flush();
  assert.equal(App.getRoomDisplayMeta('test').lastMessagePreview,'Peer: edited latest');
  put('test', 3, null);await flush();
  assert.equal(App.getRoomDisplayMeta('test').lastMessagePreview,'Peer: earlier');
  assert.ok(renders >= 4);App.detachRoomMessageNotifications();
});

function pingSetup({ epochs = {}, beforeCleanup = () => {}, readEpoch = null } = {}) {
  const { App } = setup(), paths = [], summaries = [], records = new Map();
  App.roomsMetaCache = new Map([['test', { messagesClearedAt: 1 }]]);
  App.seenPingKeys = new Set();
  App.getStoredPlace = () => 'home';
  App.views = { chat: { dataset: { active: 'true' } } };
  App.showPingSummaryToast = counts => summaries.push({ ...counts });
  App.db = { ref: location => {
    paths.push(location);
    return {
      once: async () => {
        assert.match(location, /^rooms\/[^/]+\/messagesClearedAt$/, 'No global membership, history or ping-tree scan');
        const room = location.split('/')[1];
        return { val: () => epochs[room] || 0, ...(readEpoch ? await readEpoch(room) : {}) };
      },
      transaction: async update => {
        assert.match(location, /^pings\/me\/[^/]+\/[^/]+$/, 'Cleanup only changes the exact old inbox record');
        beforeCleanup(location, records);
        const next = update(records.get(location) || null);
        if (next === null) records.delete(location);
        else if (next !== undefined) records.set(location, next);
        return { committed: next !== undefined };
      },
      onDisconnect: () => ({ remove() {}, cancel() {} }),
      remove: async () => { records.delete(location); }
    };
  } };
  const seed = inbox => {
    for (const [room, items] of Object.entries(inbox)) for (const [key, value] of Object.entries(items)) records.set(`pings/me/${room}/${key}`, value);
    return inbox;
  };
  return { App, paths, summaries, records, seed };
}

test('offline ping inbox suppresses cleared history using the current epoch and preserves post-clear and boundary pings', async () => {
  const { App, paths, summaries, records, seed } = pingSetup({ epochs: { test: 5000 } });
  const inbox = seed({ test: { old: { at: 4000 }, current: { at: 6000 }, boundary: { at: 5000 } }, other: { unaffected: { at: 10 } } });
  await App.handlePingsSnapshot(inbox, { isInitial: true });
  await flush();
  assert.deepEqual(summaries, [{ other: 1, test: 2 }]);
  assert.equal(records.has('pings/me/test/old'), false);
  for (const key of ['current', 'boundary']) assert.equal(records.has(`pings/me/test/${key}`), true);
  assert.equal(records.has('pings/me/other/unaffected'), true);
  assert.ok(paths.includes('rooms/test/messagesClearedAt'), 'Stale room-list bootstrap cache cannot revive an offline ping');
  assert.equal(paths.filter(item => item === 'rooms/test/messagesClearedAt').length, 1);
  assert.ok(!paths.includes('memberships'));
});

test('old-ping cleanup rechecks its exact record and never deletes a concurrently replaced new ping', async () => {
  const { App, records, summaries, seed } = pingSetup({ epochs: { test: 5000 }, beforeCleanup(location, values) {
    values.set(location, { at: 7000, fromUsername: 'New sender' });
  } });
  await App.handlePingsSnapshot(seed({ test: { replace: { at: 4000 } } }), { isInitial: true });
  await flush();
  assert.deepEqual(summaries, []);
  assert.equal(records.get('pings/me/test/replace').at, 7000);
});

test('pending ping epoch reads are bounded and logout invalidates delayed summaries and cleanup', async () => {
  const releases = [];
  const { App, summaries, records, seed } = pingSetup({ epochs: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`r${i}`, 5000])), readEpoch: () => new Promise(resolve => releases.push(resolve)) });
  const inbox = seed(Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`r${i}`, { old: { at: 4000 } }])));
  const pending = App.handlePingsSnapshot(inbox, { isInitial: true });
  await flush();
  assert.equal(releases.length, 4, 'At most four independent room leaves are read concurrently');
  App.detachPingsInbox();
  App.currentUser = null;
  releases.splice(0).forEach(resolve => resolve());
  await flush();
  releases.splice(0).forEach(resolve => resolve());
  await pending; await flush();
  assert.deepEqual(summaries, []);
  assert.equal(records.size, 7, 'A prior account callback cannot delete inbox records after logout');
});
