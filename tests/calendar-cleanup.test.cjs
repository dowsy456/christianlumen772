const test = require('node:test');
const assert = require('node:assert/strict');
const { expireCalendar, expireReminders } = require('../backend/functions/cleanup');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('scheduled cleanup advances the shared year and removes only obsolete notes', () => {
  const now = Date.parse('2027-01-01T05:00:00Z');
  const data = { activeYear: 2026, yearExpiry: { 2026: now },
    years: { 2025: { old: true }, 2026: { expired: true }, 2027: { fresh: true } }, extra: 'preserved' };
  const before = expireCalendar(data, now - 1);
  assert.equal(before.activeYear, 2026);
  assert.equal(before.years[2025], undefined);
  assert.deepEqual(before.years[2026], data.years[2026]);
  const after = expireCalendar(data, now);
  assert.equal(after.activeYear, 2027);
  assert.deepEqual(after.years, { 2027: { fresh: true } });
  assert.equal(after.extra, 'preserved');
  assert.ok(data.years[2026], 'helper never mutates the transaction input');
  assert.equal(expireCalendar(after, now), undefined);
  const stale = { ...after, years: { ...after.years, 2026: { late: true } } };
  assert.equal(expireCalendar(stale, now).years[2026], undefined, 'late stale writes are purged');
});

test('scheduled reminders respect each stored local midnight and preserve other reminders', () => {
  const now = Date.parse('2026-09-15T04:00:00Z');
  const data = { '2026-09-14': {
    east: { text: 'Eastern reminder', expiresAt: now },
    west: { text: 'Pacific reminder', expiresAt: now + 3 * 3600000 }
  }, '2026-09-16': { future: { text: 'Future', expiresAt: now + 86400000 } } };
  const result = expireReminders(data, now);
  assert.equal(result['2026-09-14'].east, undefined);
  assert.equal(result['2026-09-14'].west.text, 'Pacific reminder');
  assert.deepEqual(result['2026-09-16'], data['2026-09-16']);
  assert.equal(expireReminders(result, now), undefined);
  assert.equal(expireReminders(result, now + 2 * 86400000), null);
  assert.ok(data['2026-09-14'].east, 'helper never mutates the transaction input');
});

test('the scheduled worker retries cold Firebase transactions and preserves future data', async () => {
  const cutoff = Date.now() - 1000;
  const records = {
    calendar: { activeYear: 2026, yearExpiry: { 2026: cutoff }, years: { 2026: { old: true }, 2027: { fresh: true } } },
    'calendarReminders/P1': { '2026-09-14': { old: { text: 'Expired', expiresAt: cutoff } }, '2026-09-16': { future: { text: 'Keep', expiresAt: Date.now() + 86400000 } } }
  };
  const attempts = [];
  const db = { ref(key) { return {
    get: async () => ({ val: () => ({ P1: records['calendarReminders/P1'] }) }),
    transaction: async update => {
      attempts.push(key);
      // An abort here means the server never provides its existing value.
      const proposal = update(null);
      if (proposal === undefined) return { committed: false };
      const result = update(structuredClone(records[key]));
      if (result !== undefined) records[key] = result;
      return { committed: result !== undefined };
    }
  }; } };
  const context = {
    exports: {}, Date, require(name) {
      if (name === 'firebase-admin/app') return { initializeApp() {} };
      if (name === 'firebase-admin/database') return { getDatabase: () => db };
      if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_options, run) => run };
      if (name === 'firebase-functions/v2/database') return { onValueWritten: (_options, run) => run };
      if (name === './cleanup') return { expireCalendar, expireReminders };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/functions/index.js'), 'utf8'), context);
  await context.exports.cleanupCalendar();
  assert.deepEqual(attempts, ['calendar', 'calendarReminders/P1']);
  assert.equal(records.calendar.activeYear, 2027);
  assert.deepEqual(records.calendar.years, { 2027: { fresh: true } });
  assert.equal(records['calendarReminders/P1']['2026-09-14'], undefined);
  assert.equal(records['calendarReminders/P1']['2026-09-16'].future.text, 'Keep');
});

function roomEventWorkerFixture() {
  const data = { rooms: { test: { name: 'Test', messageCount: 0 } }, users: { A: { username: 'Alice' } } };
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const read = key => key.split('/').filter(Boolean).reduce((value, part) => value?.[part], data) ?? null;
  const write = (key, value) => { const parts = key.split('/').filter(Boolean); let cursor = data; for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {}; if (value === null) delete cursor[parts.at(-1)]; else cursor[parts.at(-1)] = clone(value); };
  const snapshot = value => ({ val: () => clone(value), exists: () => value != null });
  let sequence = 0;
  const fixture = { data, read, write, snapshot, beforeTransaction: null, now: 1000000 };
  const db = { ref(key) { return {
    key: key.split('/').at(-1), get: async () => snapshot(read(key)), once: async () => snapshot(read(key)),
    push: () => ({ key: `message-${++sequence}` }),
    set: async value => write(key, value), remove: async () => write(key, null),
    update: async patch => { for (const [part, value] of Object.entries(patch)) write(`${key}/${part}`, value); },
    transaction: async update => { fixture.beforeTransaction?.(key); const value = update(clone(read(key))); if (value !== undefined) write(key, value); return { committed: value !== undefined, snapshot: snapshot(read(key)) }; }
  }; } };
  class WorkerDate extends Date { static now() { return fixture.now; } }
  const context = { exports: {}, Date: WorkerDate, require(name) {
    if (name === 'firebase-admin/app') return { initializeApp() {} };
    if (name === 'firebase-admin/database') return { getDatabase: () => db };
    if (name === 'firebase-functions/v2/scheduler') return { onSchedule: (_options, run) => run };
    if (name === 'firebase-functions/v2/database') return { onValueWritten: (_options, run) => run };
    if (name === './cleanup') return { expireCalendar, expireReminders };
    throw new Error(`Unexpected dependency: ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/functions/index.js'), 'utf8'), context);
  fixture.worker = context.exports; fixture.log = context.writeSystemMessage; fixture.db = db;
  fixture.messages = () => Object.values(read('messages/test') || {});
  fixture.callEvent = async (before, after, time) => { fixture.now = time; write('calls/test', after); await context.exports.logCallLifecycle({ params: { roomId: 'test' }, time: new Date(time).toISOString(), data: { before: snapshot(before), after: snapshot(after) } }); };
  return fixture;
}

test('system-event retries and concurrent workers insert one message without replacing newer previews', async () => {
  const f = roomEventWorkerFixture(); f.data.rooms.test.lastMessageAt = 3000; f.data.rooms.test.lastMessagePreview = 'Newer chat';
  const event = { type: 'member_joined', userCode: 'A', displayName: 'Alice', createdAt: 2000 };
  await Promise.all([f.log('test', event, 'member-joined:A:2000'), f.log('test', event, 'member-joined:A:2000')]);
  await f.log('test', event, 'member-joined:A:2000');
  assert.equal(f.messages().length, 1); assert.equal(f.data.rooms.test.messageCount, 1);
  assert.equal(f.data.rooms.test.lastMessageAt, 3000); assert.equal(f.data.rooms.test.lastMessagePreview, 'Newer chat');
});

test('clearing chat rejects delayed events and removes an in-flight stale insertion', async () => {
  const f = roomEventWorkerFixture(); f.data.rooms.test.messagesClearedAt = 1500;
  await f.log('test', { type: 'call_ended', createdAt: 1000 }, 'call-ended:old'); assert.equal(f.messages().length, 0);
  f.beforeTransaction = key => { if (key.startsWith('messages/test/')) { f.beforeTransaction = null; f.write('messages/test', null); f.data.rooms.test.messagesClearedAt = 2500; } };
  await f.log('test', { type: 'call_ended', createdAt: 2000 }, 'call-ended:pending');
  assert.equal(f.messages().length, 0); assert.equal(f.data.rooms.test.messageCount, 0);
});

test('temporary call disconnection does not log an end; final departure logs once', async () => {
  const f = roomEventWorkerFixture();
  const connected = { instanceId: 'call-1', startedAt: 1000000, startedBy: 'A', members: { A: { code: 'A', username: 'Alice', sessionId: 'a-session', connected: true, joinedAt: 1000000 } } };
  const disconnected = structuredClone(connected); disconnected.members.A.connected = false; disconnected.members.A.updatedAt = 1001000;
  await f.callEvent(null, connected, 1000000); await f.callEvent(connected, disconnected, 1001000);
  assert.equal(f.messages().filter(message => message.system.type === 'call_ended').length, 0);
  await f.callEvent(disconnected, connected, 1002000);
  assert.equal(f.messages().length, 1); assert.equal(f.read('pendingCallEnds/test')?.canceled, true);
  await f.callEvent(connected, null, 1003000); await f.callEvent(connected, null, 1003000);
  assert.equal(f.messages().filter(message => message.system.type === 'call_ended').length, 1);
});

test('event replay repairs interrupted room counters without duplicating the system message', async () => {
  const f = roomEventWorkerFixture();
  const event = { type: 'member_joined', userCode: 'A', displayName: 'Alice', createdAt: 2000 };
  f.beforeTransaction = key => { if (key === 'rooms/test') { f.beforeTransaction = null; throw Error('set'); } };
  await assert.rejects(f.log('test', event, 'member-joined:A:2000'), /set/);
  assert.equal(f.messages().length, 1); assert.equal(f.data.rooms.test.messageCount, 0);
  await f.log('test', event, 'member-joined:A:2000'); await f.log('test', event, 'member-joined:A:2000');
  assert.equal(f.messages().length, 1); assert.equal(f.data.rooms.test.messageCount, 1);
  assert.equal(f.data.rooms.test.lastMessagePreview, 'Alice joined the room.');
});

for (const writer of ['worker', 'browser']) test(`${writer} retries keep the original call event time and never revive an old preview`, async () => {
  const f = roomEventWorkerFixture();
  if (writer === 'browser') {
    const app = { register() {}, db: f.db, sanitizeRoomCode: String, pollNow: () => f.now };
    const context = { ChatApp: app, Date, Map, Set };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/chat/send.js'), 'utf8'), context);
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/chat/message-history.js'), 'utf8'), context);
    app.FIREBASE_PUSH_KEY_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    f.log = app.commitRoomSystemMessage;
  }
  f.beforeTransaction = key => { if (key === 'rooms/test') { f.beforeTransaction = null; throw Error('set'); } };
  await assert.rejects(f.log('test', { type: 'call_ended', createdAt: 2000 }, 'call-ended:one'), /set/);
  f.data.rooms.test.lastMessageAt = 3000; f.data.rooms.test.lastMessagePreview = 'Alice: A newer message';
  await f.log('test', { type: 'call_ended', createdAt: 5000 }, 'call-ended:one');
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].createdAt, 2000);
  assert.equal(f.data.rooms.test.lastMessageAt, 3000);
  assert.equal(f.data.rooms.test.lastMessagePreview, 'Alice: A newer message');
  assert.equal(f.data.rooms.test.messageCount, 1);
  f.beforeTransaction = key => { if (key.startsWith('messages/test/')) { f.beforeTransaction = null; throw Error('set'); } };
  await assert.rejects(f.log('test', { type: 'call_ended', createdAt: 2100 }, 'call-ended:before-clear'), /set/);
  f.write('messages/test', null); f.data.rooms.test.messagesClearedAt = 4000;
  await f.log('test', { type: 'call_ended', createdAt: 6000 }, 'call-ended:before-clear');
  assert.equal(f.messages().length, 0, 'A retained claim cannot resurrect its original pre-clear event');
});

test('legacy call timestamps cannot pin old logs above newer chat or decode arbitrary keys as dates', () => {
  const app = { register() {}, FIREBASE_PUSH_KEY_CHARS: '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/chat/message-history.js'), 'utf8'), { ChatApp: app });
  const stamp = 1791417600000;
  let number = stamp, key = '';
  for (let i = 0; i < 8; i++) { key = app.FIREBASE_PUSH_KEY_CHARS[number % 64] + key; number = Math.floor(number / 64); }
  key += '------------';
  assert.equal(app.firebasePushKeyTimestamp(key), stamp);
  assert.equal(app.firebasePushKeyTimestamp('call-ended:session'), 0);
  const event = { t: 'system', _key: key, createdAt: stamp + 86400000, system: { type: 'call_ended' } };
  assert.equal(app.getMessageSortTimestamp(event), stamp);
  assert.ok(app.compareMessagesChronologically(event, { _key: 'later', createdAt: stamp + 1000 }) < 0);
  assert.equal(app.getMessageSortTimestamp({ t: 'system', system: { createdAt: stamp } }), stamp);
});

test('a worker finishing a legacy skewed call save cannot replace a newer message preview', async () => {
  const f = roomEventWorkerFixture(), alphabet = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let value = 2000, key = '';
  for (let i = 0; i < 8; i++) { key = alphabet[value % 64] + key; value = Math.floor(value / 64); }
  key += '------------';
  f.write('roomSystemEvents/test/call-ended%3Alegacy', { key, at: 2000 });
  f.write(`messages/test/${key}`, { t: 'system', createdAt: 2000000, system: { type: 'call_ended' } });
  f.data.rooms.test.lastMessageAt = 5000;
  f.data.rooms.test.lastMessagePreview = 'Alice: Newer conversation';
  await f.log('test', { type: 'call_ended', createdAt: 2000 }, 'call-ended:legacy');
  assert.equal(f.messages().length, 1);
  assert.equal(f.data.rooms.test.lastMessageAt, 5000);
  assert.equal(f.data.rooms.test.lastMessagePreview, 'Alice: Newer conversation');
});

test('late reconnect events do not cancel newer disconnect cleanup, which respects the grace period', async () => {
  const f = roomEventWorkerFixture();
  const connected = { instanceId: 'call-1', startedAt: 1000000, startedBy: 'A', members: { A: { code: 'A', username: 'Alice', sessionId: 'a-session', connected: true, joinedAt: 1000000 } } };
  const firstDisconnect = structuredClone(connected); firstDisconnect.members.A.connected = false; firstDisconnect.members.A.updatedAt = 1001000;
  const finalDisconnect = structuredClone(firstDisconnect); finalDisconnect.members.A.updatedAt = 1008000;
  await f.callEvent(null, connected, 1000000); await f.callEvent(connected, firstDisconnect, 1001000);
  await f.callEvent(connected, finalDisconnect, 1008000);
  // Delayed delivery of the intervening reconnect must preserve the later end.
  await f.callEvent(firstDisconnect, connected, 1002000); f.write('calls/test', finalDisconnect);
  assert.equal(f.read('pendingCallEnds/test')?.eligibleAt, 1053000);
  assert.equal(f.read('pendingCallEnds/test')?.canceled, false);
  f.now = 1052000; await f.worker.finishExpiredPolls(); assert.ok(f.read('calls/test'));
  f.now = 1054000; await f.worker.finishExpiredPolls(); assert.equal(f.read('calls/test'), null);
});
