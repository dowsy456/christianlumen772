/* Calendar lifecycle tests use only an isolated in-memory realtime database. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This day differs from Eastern Time; dates must use the viewer's local day.
process.env.TZ = 'Pacific/Honolulu';
const source = () => fs.readFileSync(path.join(__dirname, '../js/calendar/data.js'), 'utf8');
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function database(seed = {}) {
  let values = { '.info': { connected: true, serverTimeOffset: 0 }, ...clone(seed) }, sequence = 0, revision = 0;
  const listeners = [], reads = [], writes = [], coldTransactions = new Set();
  const parts = value => String(value || '').split('/').filter(Boolean);
  const normal = value => parts(value).join('/');
  const get = raw => clone(parts(raw).reduce((obj, key) => obj?.[key], values));
  const snapshot = raw => ({ key: parts(raw).at(-1) || null, ref: ref(raw), val: () => get(raw), exists: () => get(raw) != null,
    child: key => snapshot(`${normal(raw)}/${key}`), forEach: cb => Object.keys(get(raw) || {}).some(key => cb(snapshot(`${normal(raw)}/${key}`)) === true) });
  const stamp = value => value && typeof value === 'object'
    ? value['.sv'] === 'timestamp' ? Date.now() : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stamp(item)])) : value;
  function put(raw, value) {
    const keys = parts(raw), before = clone(values);
    if (!keys.length) values = stamp(clone(value)) || {};
    else {
      let obj = values;
      for (const key of keys.slice(0, -1)) obj = obj[key] ??= {};
      if (value == null) delete obj[keys.at(-1)]; else obj[keys.at(-1)] = stamp(clone(value));
    }
    revision++;
    writes.push({ path: normal(raw), value: clone(value) });
    for (const listener of [...listeners]) {
      const old = parts(listener.path).reduce((obj, key) => obj?.[key], before) ?? null;
      const next = get(listener.path);
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      if (listener.event === 'value') queueMicrotask(() => { if (listeners.includes(listener)) listener.cb(snapshot(listener.path)); });
      if (listener.event === 'child_added') for (const key of Object.keys(next || {})) {
        if (old?.[key] != null || (listener.end != null && key > listener.end)) continue;
        queueMicrotask(() => { if (listeners.includes(listener)) listener.cb(snapshot(`${listener.path}/${key}`)); });
      }
    }
  }
  function ref(raw = '', end = null) {
    const name = normal(raw);
    return {
      key: parts(name).at(-1), child: key => ref(`${name}/${key}`), toString: () => name,
      set: value => { put(name, value); return Promise.resolve(); }, remove: () => { put(name, null); return Promise.resolve(); },
      update: patch => { for (const [key, value] of Object.entries(patch)) put(`${name}/${key}`, value); return Promise.resolve(); },
      once: async (event, cb) => { reads.push(name); const snap = snapshot(name); cb?.(snap); return snap; },
      get: async () => { reads.push(name); return snapshot(name); },
      on(event, cb) {
        assert.ok(['value', 'child_added'].includes(event), `unsupported fixture event: ${event}`);
        reads.push(name); const item = { path: name, cb, event, end }; listeners.push(item);
        if (event === 'value') queueMicrotask(() => { if (listeners.includes(item)) cb(snapshot(name)); });
        else for (const key of Object.keys(get(name) || {})) if (end == null || key <= end) {
          queueMicrotask(() => { if (listeners.includes(item)) cb(snapshot(`${name}/${key}`)); });
        }
        return cb;
      },
      off(event, cb) { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === name && (!cb || listeners[i].cb === cb)) listeners.splice(i, 1); },
      async transaction(update, complete) {
        if (coldTransactions.delete(name)) {
          const proposal = update(null);
          if (proposal === undefined) { const snap = snapshot(name); complete?.(null, false, snap); return { committed: false, snapshot: snap }; }
          // A stale empty cache proposal is retried with the actual server value.
          await Promise.resolve();
        }
        // Yield before commit so simultaneous clients exercise Firebase-style retries.
        for (let attempt = 0; attempt < 30; attempt++) {
          const version = revision;
          const next = update(get(name));
          if (next === undefined) { const snap = snapshot(name); complete?.(null, false, snap); return { committed: false, snapshot: snap }; }
          await Promise.resolve();
          if (version !== revision) continue;
          put(name, next); const snap = snapshot(name); complete?.(null, true, snap); return { committed: true, snapshot: snap };
        }
        throw new Error('Fixture transaction retry limit exceeded');
      },
      push(value) { const child = ref(`${name}/-LOCAL${String(++sequence).padStart(10, '0')}`); if (value !== undefined) void child.set(value); return child; },
      orderByKey() { return this; }, endAt(value) { return ref(name, String(value)); }
    };
  }
  return { ref, get, reads, writes, listeners, coldTransaction: name => coldTransactions.add(normal(name)) };
}

function client(db, { code = 'P1', now = '2026-09-15T07:30:00Z' } = {}) {
  let milliseconds = Date.parse(now), timerId = 0;
  const timers = new Map(), events = new Map(), initializers = [], toasts = [];
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [milliseconds])); } static now() { return milliseconds; } }
  const eventTarget = { addEventListener: (name, cb) => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(cb); },
    removeEventListener: (name, cb) => events.get(name)?.delete(cb) };
  const nodes = new Map(['toast', 'toast-title', 'toast-body', 'toast-code', 'btn-copy-code', 'toast-timer-bar', 'btn-toast-close'].map(id => {
    const classes = new Set();
    return [id, { hidden: true, textContent: '', innerHTML: '', dataset: {}, style: {}, offsetHeight: 40,
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
      addEventListener() {} }];
  }));
  const App = { db, currentUser: { code, username: code, displayName: code }, register: (id, initialize) => initializers.push(initialize),
    firebase: { database: { ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } } } }, getAccurateNow: () => new ClockDate(),
    accurateNowMs: () => milliseconds, renderCalendarPage() {}, renderCalendar() {},
    $: id => nodes.get(id) || null, escapeHTML: value => String(value), userDisplayName: user => user?.displayName || user?.username || '' };
  const ctx = vm.createContext({ ChatApp: App, Date: ClockDate, Intl, console, queueMicrotask, ...eventTarget,
    window: eventTarget, document: { ...eventTarget, hidden: false, visibilityState: 'visible', getElementById: () => null },
    setTimeout: (cb, delay) => { const id = ++timerId; timers.set(id, { cb, delay }); return id; },
    setInterval: (cb, delay) => { const id = ++timerId; timers.set(id, { cb, delay, interval: true }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui/toasts.js'), 'utf8'), ctx, { filename: 'ui/toasts.js' });
  const showToast = App.showToast;
  App.showToast = opts => { toasts.push(opts); return showToast(opts); };
  vm.runInContext(source(), ctx, { filename: 'calendar/data.js' });
  initializers.forEach(initialize => initialize());
  return { App, toasts, nodes, timers, events, setNow: value => { milliseconds = Date.parse(value); },
    async finishToast() {
      App.closeToast('manual');
      const timer = timers.get(App.toastHideTimer);
      timers.delete(App.toastHideTimer); timer?.cb(); await settle();
    },
    async start() { await App.startCalendarSession(); await settle(); },
    async midnight(value) {
      const timer = [...timers].find(([, item]) => !item.interval);
      assert.ok(timer, 'session has scheduled the next local midnight');
      milliseconds = Date.parse(value); timers.delete(timer[0]); timer[1].cb(); await settle();
    },
    async advance(value) { milliseconds = Date.parse(value); await App.refreshCalendarDate(); await settle(); } };
}

async function remindAbout(user, date, text) {
  const id = await user.App.saveCalendarNote(date, null, text);
  await user.App.setCalendarNoteReminder(date, id, true);
  await settle();
  return id;
}

test('shared note ordering persists, retains authors/reminders, survives edits, and appends new notes', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14';
  const ids = [];
  for (const text of ['First', 'Second', 'Third']) ids.push(await one.App.saveCalendarNote(date, null, text));
  await one.App.setCalendarNoteReminder(date, ids[2], true);
  const before = db.get(`calendar/years/2026/${date}`);
  const reminder = db.get(`calendarReminders/P1/${date}/${ids[2]}`);
  const order = app => Array.from(app.getCalendarNoteEntries(app.calendarState.notes[date]), ([id]) => id);
  assert.deepEqual(order(one.App), ids);
  db.coldTransaction('calendar');
  assert.equal(await two.App.moveCalendarNote(date, ids[2], -1), true);
  await settle();
  assert.deepEqual(order(one.App), [ids[0], ids[2], ids[1]]);
  assert.equal(await two.App.moveCalendarNote(date, ids[2], -1), true);
  await settle();
  assert.deepEqual(order(one.App), [ids[2], ids[0], ids[1]]);
  for (const id of ids) {
    const after = db.get(`calendar/years/2026/${date}/${id}`);
    const { order: savedOrder, ...content } = after;
    assert.deepEqual(content, before[id], 'moving modifies only order, never content/authorship/timestamps');
    assert.ok(Number.isSafeInteger(savedOrder));
  }
  assert.deepEqual(db.get(`calendarReminders/P1/${date}/${ids[2]}`), reminder);
  assert.equal(db.get(`calendarReminders/P2/${date}`), null);
  await one.App.saveCalendarNote(date, ids[2], 'Edited third', 'Third');
  await settle();
  assert.equal(db.get(`calendar/years/2026/${date}/${ids[2]}`).order, 0, 'editing preserves placement');
  const newest = await one.App.saveCalendarNote(date, null, 'Newest');
  await settle();
  assert.deepEqual(order(two.App), [ids[2], ids[0], ids[1], newest]);
  const restarted = client(db, { code: 'P3' });
  await restarted.start();
  assert.deepEqual(order(restarted.App), order(one.App), 'a new client uses saved shared order');
  const writes = db.writes.length;
  assert.equal(await restarted.App.moveCalendarNote(date, ids[2], -1), false);
  assert.equal(await restarted.App.moveCalendarNote(date, newest, 1), false);
  assert.equal(db.writes.length, writes, 'boundary moves are no-ops');
  for (const user of [one, two, restarted]) user.App.stopCalendarSession();
});

test('concurrent moves and edits/additions retry without dropping notes or resetting placement', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14', ids = [];
  for (const text of ['A', 'B', 'C']) ids.push(await one.App.saveCalendarNote(date, null, text));
  const [, , added] = await Promise.all([
    one.App.moveCalendarNote(date, ids[2], -1),
    two.App.saveCalendarNote(date, ids[2], 'C edited', 'C'),
    two.App.saveCalendarNote(date, null, 'D')
  ]);
  await settle();
  const ordered = one.App.getCalendarNoteEntries(db.get(`calendar/years/2026/${date}`));
  assert.deepEqual(Array.from(ordered, ([id]) => id), [ids[0], ids[2], ids[1], added]);
  assert.equal(db.get(`calendar/years/2026/${date}/${ids[2]}`).text, 'C edited');
  await Promise.all([one.App.moveCalendarNote(date, ids[2], -1), two.App.saveCalendarNote(date, ids[1], '', 'B')]);
  assert.equal(db.get(`calendar/years/2026/${date}/${ids[1]}`), null, 'concurrent deletion is never resurrected');
  const remaining = Array.from(one.App.getCalendarNoteEntries(db.get(`calendar/years/2026/${date}`)), ([id]) => id);
  assert.deepEqual(remaining, [ids[2], ids[0], added]);
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('note ordering validates targets, offline sessions, and ended years without writes', async () => {
  const db = database(), user = client(db);
  await user.start();
  const date = '2026-09-14', id = await user.App.saveCalendarNote(date, null, 'A');
  await user.App.saveCalendarNote(date, null, 'B');
  let writes = db.writes.length;
  for (const [day, note, direction, expected] of [[date, id, 0, 'invalid-order'], [date, 'bad/id', -1, 'invalid-id'], [date, 'missing', -1, 'note-missing'], ['2026-02-30', id, -1, 'invalid-date']]) {
    await assert.rejects(user.App.moveCalendarNote(day, note, direction), error => error.code === `calendar/${expected}`);
  }
  assert.equal(db.writes.length, writes);
  await db.ref('.info/connected').set(false); await settle(); writes = db.writes.length;
  await assert.rejects(user.App.moveCalendarNote(date, id, 1), error => error.code === 'calendar/offline');
  assert.equal(db.writes.length, writes);
  await db.ref('.info/connected').set(true); await db.ref('calendar/activeYear').set(2027); await settle(); writes = db.writes.length;
  await assert.rejects(user.App.moveCalendarNote(date, id, 1), error => error.code === 'calendar/year-ended');
  assert.equal(db.writes.length, writes);
  user.App.stopCalendarSession();
  await assert.rejects(user.App.moveCalendarNote(date, id, 1), error => error.code === 'calendar/signed-out');
});

test('calendar dates use the local day and current year', async () => {
  const db = database(), user = client(db);
  await user.start();
  assert.equal(user.App.calendarState.today, '2026-09-14');
  assert.equal(user.App.calendarState.year, 2026);
  assert.equal(user.App.calendarState.month, 8);
  user.App.stopCalendarSession();
});

test('two users add independent shared notes and receive live edits to a previous month', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-08-05';
  const [first, second] = await Promise.all([
    one.App.saveCalendarNote(date, null, 'Bring the book'),
    two.App.saveCalendarNote(date, null, 'Meet after lunch')
  ]);
  await settle();
  assert.ok(first && second && first !== second, 'concurrent additions have independent IDs');
  assert.equal(Object.keys(db.get(`calendar/years/2026/${date}`)).length, 2);
  assert.equal(two.App.calendarState.notes[date][first].text, 'Bring the book');
  assert.equal(one.App.calendarState.notes[date][second].text, 'Meet after lunch');
  await two.App.saveCalendarNote(date, first, 'Bring both books', 'Bring the book');
  await settle();
  assert.equal(one.App.calendarState.notes[date][first].text, 'Bring both books', 'any user may edit a previous month');
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('conflicting edits preserve the first committed update and clearing text removes a note', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14', id = await one.App.saveCalendarNote(date, null, 'Original');
  const results = await Promise.allSettled([
    one.App.saveCalendarNote(date, id, 'First edit', 'Original'),
    two.App.saveCalendarNote(date, id, 'Second edit', 'Original')
  ]);
  await settle();
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected?.reason.code, 'calendar/conflict');
  const saved = db.get(`calendar/years/2026/${date}/${id}`).text;
  assert.ok(['First edit', 'Second edit'].includes(saved));
  await two.App.saveCalendarNote(date, id, '   \n ', saved);
  await settle();
  assert.equal(db.get(`calendar/years/2026/${date}/${id}`), null);
  assert.equal(one.App.calendarState.notes[date]?.[id], undefined);
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('an initially empty Firebase cache retries with server data without losing siblings or authorship', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14';
  const first = await one.App.saveCalendarNote(date, null, 'Existing note');
  const second = await one.App.saveCalendarNote(date, null, 'Keep this sibling');
  const before = db.get(`calendar/years/2026/${date}/${first}`);
  db.coldTransaction('calendar');
  await two.App.saveCalendarNote(date, first, 'Updated from a cold cache', 'Existing note');
  const after = db.get(`calendar/years/2026/${date}/${first}`);
  assert.equal(after.text, 'Updated from a cold cache');
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.authorName, 'P1');
  assert.equal(after.authorCode, undefined, 'public metadata does not disclose sign-in codes');
  assert.equal(db.get(`calendar/years/2026/${date}/${second}`).text, 'Keep this sibling');
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('notes store the public username and retain original authorship when another user edits', async () => {
  const db = database(), author = client(db, { code: 'PRIVATE_AUTHOR_CODE' }), editor = client(db, { code: 'PRIVATE_EDITOR_CODE' });
  Object.assign(author.App.currentUser, { username: 'original_writer', displayName: 'Original Display Name' });
  Object.assign(editor.App.currentUser, { username: 'later_editor', displayName: 'Editor Display Name' });
  await Promise.all([author.start(), editor.start()]);
  const date = '2026-09-14';
  const id = await author.App.saveCalendarNote(date, null, 'The original note');
  let record = db.get(`calendar/years/2026/${date}/${id}`);
  assert.equal(record.authorUsername, 'original_writer');
  assert.equal(record.authorName, 'original_writer', 'compatibility name is the username, not the display name');
  const createdAt = record.createdAt;
  await editor.App.saveCalendarNote(date, id, 'Edited by someone else', 'The original note');
  record = db.get(`calendar/years/2026/${date}/${id}`);
  assert.equal(record.authorUsername, 'original_writer');
  assert.equal(record.authorName, 'original_writer');
  assert.equal(record.createdAt, createdAt);
  assert.equal(JSON.stringify(record).includes('PRIVATE_'), false, 'shared notes contain no sign-in codes');
  author.App.stopCalendarSession(); editor.App.stopCalendarSession();
});

test('editing a legacy note does not claim that its editor is the original author', async () => {
  const date = '2026-09-14';
  const db = database({ calendar: { years: { 2026: { [date]: {
    legacy: { text: 'Legacy note', authorName: 'Original Display Name', createdAt: 1234 },
    unnamed: { text: 'Unknown author', createdAt: 5678 }
  } } } } });
  const editor = client(db);
  Object.assign(editor.App.currentUser, { username: 'later_editor', displayName: 'Original Display Name' });
  await editor.start();
  await editor.App.saveCalendarNote(date, 'legacy', 'Legacy note edited', 'Legacy note');
  const legacy = db.get(`calendar/years/2026/${date}/legacy`);
  assert.equal(legacy.authorName, 'Original Display Name');
  assert.equal(legacy.authorUsername, undefined, 'matching display names are not sufficient proof of authorship');
  assert.equal(legacy.createdAt, 1234);
  await editor.App.saveCalendarNote(date, 'unnamed', 'Unknown author edited', 'Unknown author');
  const unnamed = db.get(`calendar/years/2026/${date}/unnamed`);
  assert.equal(unnamed.authorUsername, undefined);
  assert.equal(unnamed.authorName, 'User');
  editor.App.stopCalendarSession();
});

test('year cleanup stores local January 1 and retains an already earlier cleanup deadline', async () => {
  const expected = Date.parse('2027-01-01T10:00:00Z');
  const db = database(), user = client(db);
  await user.start();
  assert.equal(db.get('calendar/yearExpiry/2026'), expected);
  user.App.stopCalendarSession();
  await db.ref('calendar/yearExpiry/2026').set(expected - 3600000);
  await user.start();
  assert.equal(db.get('calendar/yearExpiry/2026'), expected - 3600000, 'later clients never postpone year cleanup');
  user.App.stopCalendarSession();
});

test('the month rolls automatically while older current-year notes remain editable', async () => {
  const db = database(), user = client(db, { now: '2026-10-01T09:59:59Z' });
  await user.start();
  const id = await user.App.saveCalendarNote('2026-09-30', null, 'September note');
  await user.midnight('2026-10-01T10:00:00.025Z');
  assert.equal(user.App.calendarState.today, '2026-10-01');
  assert.equal(user.App.calendarState.month, 9);
  await user.App.saveCalendarNote('2026-09-30', id, 'Still editable', 'September note');
  assert.equal(db.get(`calendar/years/2026/2026-09-30/${id}`).text, 'Still editable');
  user.App.stopCalendarSession();
});

test('new year purges previous years and rejects old-year writes', async () => {
  const db = database({ calendar: { years: { 2025: { '2025-12-30': { old: { text: 'Older note' } } } } } });
  const user = client(db, { now: '2027-01-01T09:59:59Z' });
  await user.start();
  assert.equal(db.get('calendar/years/2025'), null, 'opening the calendar removes older-year records');
  const id = await user.App.saveCalendarNote('2026-12-31', null, 'Last year note');
  await user.midnight('2027-01-01T10:00:00.025Z');
  assert.equal(user.App.calendarState.year, 2027);
  assert.equal(user.App.calendarState.month, 0);
  assert.equal(user.App.calendarState.today, '2027-01-01');
  assert.equal(db.get('calendar/years/2026'), null);
  await assert.rejects(user.App.saveCalendarNote('2026-12-31', id, 'Do not recreate'), error => error.code === 'calendar/year-changed');
  assert.equal(db.get('calendar/years/2026'), null);
  const newId = await user.App.saveCalendarNote('2027-01-01', null, 'New year note');
  assert.equal(db.get(`calendar/years/2027/2027-01-01/${newId}`).text, 'New year note');
  user.App.stopCalendarSession();
});

test('a stale client cannot recreate a year after another client advances the shared year', async () => {
  const db = database(), old = client(db, { now: '2027-01-01T09:59:59Z' });
  await old.start();
  const id = await old.App.saveCalendarNote('2026-12-31', null, 'Last entry');
  const next = client(db, { code: 'P2', now: '2027-01-01T10:00:01Z' });
  await next.start();
  assert.equal(db.get('calendar/activeYear'), 2027);
  assert.equal(db.get('calendar/years/2026'), null);
  assert.equal(old.App.calendarState.year, 2026, 'stale viewer still believes its local year has not ended');
  await assert.rejects(old.App.saveCalendarNote('2026-12-31', id, 'Do not resurrect'), error => /year-ended|year-changed/.test(error.code));
  assert.equal(db.get('calendar/years/2026'), null);
  assert.equal(db.get('calendar/activeYear'), 2027, 'a stale session never lowers the shared year');
  old.App.stopCalendarSession(); next.App.stopCalendarSession();
});

test('offline saves fail without silently queueing obsolete entries', async () => {
  const db = database(), user = client(db);
  await user.start();
  await db.ref('.info/connected').set(false);
  await settle();
  const writes = db.writes.length;
  await assert.rejects(user.App.saveCalendarNote('2026-09-14', null, 'Offline note'), error => error.code === 'calendar/offline');
  await assert.rejects(user.App.setCalendarNoteReminder('2026-09-14', 'note', true), error => error.code === 'calendar/offline');
  assert.equal(db.writes.length, writes);
  await db.ref('.info/connected').set(true);
  await settle();
  const id = await user.App.saveCalendarNote('2026-09-14', null, 'Online again');
  assert.ok(db.get(`calendar/years/2026/2026-09-14/${id}`));
  user.App.stopCalendarSession();
});

test('invalid calendar dates are rejected without database changes', async () => {
  const db = database(), user = client(db);
  await user.start();
  const writes = db.writes.length;
  for (const date of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-09-31', '../users/P2']) {
    await assert.rejects(user.App.saveCalendarNote(date, null, 'Invalid date'));
  }
  assert.equal(db.writes.length, writes);
  user.App.stopCalendarSession();
});

test('multiple reminders belong only to the signed-in user and expire at local midnight', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14';
  const first = await remindAbout(one, date, 'Call home');
  const second = await remindAbout(one, date, 'Take the book');
  const tomorrow = await remindAbout(one, '2026-09-15', 'Tomorrow only');
  const other = await remindAbout(two, date, 'P2 reminder');
  await settle();
  assert.ok(first !== second);
  assert.equal(Object.keys(one.App.calendarState.reminders[date]).length, 2);
  assert.equal(two.App.calendarState.reminders[date]?.[first], undefined);
  assert.equal(one.App.calendarState.reminders[date]?.[other], undefined);
  assert.equal(one.App.isCalendarNoteReminder(date, first), true);
  assert.equal(two.App.isCalendarNoteReminder(date, first), false);
  assert.deepEqual(Object.keys(db.get(`calendarReminders/P1/${date}/${first}`)).sort(), ['createdAt', 'expiresAt', 'noteId']);
  assert.equal(db.get(`calendarReminders/P1/${date}/${first}`).expiresAt, Date.parse('2026-09-15T10:00:00Z'));
  await one.advance('2026-09-15T09:59:59Z');
  assert.ok(db.get(`calendarReminders/P1/${date}/${first}`), 'today is retained until midnight');
  await one.advance('2026-09-15T10:00:00Z');
  assert.equal(db.get(`calendarReminders/P1/${date}`), null);
  assert.ok(db.get(`calendarReminders/P1/2026-09-15/${tomorrow}`));
  assert.ok(db.get(`calendarReminders/P2/${date}/${other}`), 'one account never deletes another account reminders');
  await assert.rejects(one.App.setCalendarNoteReminder(date, first, true), error => error.code === 'calendar/past-reminder');
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('today and future reminders can be added while the calendar is viewing a past day', async () => {
  const db = database(), user = client(db);
  await user.start();
  user.App.calendarState.selectedDate = '2026-08-05';
  user.App.calendarState.month = 7;
  assert.equal(user.App.calendarState.today, '2026-09-14', 'local day is still September 14 when UTC is September 15');
  const today = await remindAbout(user, '2026-09-14', 'Today from an older month');
  const future = await remindAbout(user, '2026-09-16', 'Future from an older month');
  assert.equal(db.get(`calendarReminders/P1/2026-09-14/${today}`).noteId, today);
  assert.equal(db.get(`calendarReminders/P1/2026-09-16/${future}`).noteId, future);
  assert.equal(user.App.calendarState.selectedDate, '2026-08-05', 'saving reminders does not depend on the selected note day');
  await assert.rejects(user.App.setCalendarNoteReminder('2026-09-13', 'past-note', true), error => error.code === 'calendar/past-reminder');
  user.App.stopCalendarSession();
});

test('unavailable or invalid synchronized time falls back to the device local date for reminders', async () => {
  for (const getAccurateNow of [undefined, () => new Date(NaN), () => { throw new Error('Clock unavailable'); }]) {
    const db = database(), user = client(db);
    user.App.getAccurateNow = getAccurateNow;
    await user.start();
    assert.equal(user.App.calendarState.today, '2026-09-14');
    const id = await remindAbout(user, '2026-09-14', 'Fallback date');
    assert.equal(db.get(`calendarReminders/P1/2026-09-14/${id}`).expiresAt, Date.parse('2026-09-15T10:00:00Z'));
    user.App.stopCalendarSession();
  }
});

test('a personal reminder tag changes only its owner and leaves the shared note untouched', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-15', id = await one.App.saveCalendarNote(date, null, 'Shared plan');
  const original = db.get(`calendar/years/2026/${date}/${id}`);
  await one.App.setCalendarNoteReminder(date, id, true);
  const firstTag = db.get(`calendarReminders/P1/${date}/${id}`);
  await one.App.setCalendarNoteReminder(date, id, true);
  assert.deepEqual(db.get(`calendarReminders/P1/${date}/${id}`), firstTag, 'enabling a tag twice is idempotent');
  assert.equal(one.App.isCalendarNoteReminder(date, id), true);
  assert.equal(two.App.isCalendarNoteReminder(date, id), false);
  await two.App.setCalendarNoteReminder(date, id, true);
  await one.App.setCalendarNoteReminder(date, id, false);
  await settle();
  assert.equal(one.App.isCalendarNoteReminder(date, id), false);
  assert.equal(two.App.isCalendarNoteReminder(date, id), true);
  assert.equal(db.get(`calendarReminders/P1/${date}/${id}`), null);
  assert.deepEqual(db.get(`calendar/years/2026/${date}/${id}`), original, 'no personal flag is added to a public note');
  await assert.rejects(one.App.setCalendarNoteReminder(date, 'missing-note', true), error => error.code === 'calendar/note-missing');
  await assert.rejects(one.App.setCalendarNoteReminder(date, '../P2', true), error => error.code === 'calendar/invalid-id');
  assert.equal(one.App.saveCalendarReminder, undefined, 'standalone reminder creation is no longer exposed');
  one.App.stopCalendarSession(); two.App.stopCalendarSession();
});

test('normal toasts queue due notes, refresh live text, and replay on the next site session', async () => {
  const db = database(), user = client(db), other = client(db, { code: 'P2' });
  await Promise.all([user.start(), other.start()]);
  user.App.showToast({ title: 'Welcome', body: 'Signed in' });
  const date = '2026-09-14';
  const first = await remindAbout(user, date, 'First note');
  const second = await remindAbout(user, date, 'Second note');
  assert.equal(user.nodes.get('toast-body').textContent, 'Signed in', 'queued reminders never replace an existing notice');
  await user.finishToast();
  assert.equal(user.nodes.get('toast-title').textContent, 'Reminder for today');
  assert.equal(user.nodes.get('toast-body').textContent, 'First note');
  await other.App.saveCalendarNote(date, first, 'First note edited live', 'First note');
  await other.App.saveCalendarNote(date, second, 'Second note edited while queued', 'Second note');
  await settle();
  assert.equal(user.nodes.get('toast-body').textContent, 'First note edited live');
  await user.finishToast();
  assert.equal(user.nodes.get('toast-body').textContent, 'Second note edited while queued');
  await user.finishToast();
  assert.equal(user.nodes.get('toast').hidden, true);
  for (const callback of user.events.get('focus')) callback({ type: 'focus' });
  await settle();
  assert.equal(user.nodes.get('toast').hidden, true, 'ordinary focus does not repeat dismissed reminders');
  user.App.stopCalendarSession();
  const reopened = client(db);
  await reopened.start();
  assert.equal(reopened.nodes.get('toast-body').textContent, 'First note edited live');
  await reopened.finishToast();
  assert.equal(reopened.nodes.get('toast-body').textContent, 'Second note edited while queued');
  reopened.App.stopCalendarSession(); other.App.stopCalendarSession();
});

test('an immediate app notice interrupts and then resumes a queued reminder without losing the others', async () => {
  const db = database(), user = client(db);
  await user.start();
  await remindAbout(user, '2026-09-14', 'First due note');
  await remindAbout(user, '2026-09-14', 'Second due note');
  assert.equal(user.nodes.get('toast-body').textContent, 'First due note');
  user.App.showToast({ title: 'Welcome back', body: 'Login finished' });
  assert.equal(user.nodes.get('toast-body').textContent, 'Login finished');
  await user.finishToast();
  assert.equal(user.nodes.get('toast-body').textContent, 'First due note');
  await user.finishToast();
  assert.equal(user.nodes.get('toast-body').textContent, 'Second due note');
  user.App.stopCalendarSession();
});

test('queued reminder cancellation on logout cannot display personal notes in the next account', async () => {
  const db = database(), user = client(db);
  await user.start();
  user.App.showToast({ title: 'Notice', body: 'An existing notice' });
  const id = await remindAbout(user, '2026-09-14', 'P1 reminder only');
  user.App.stopCalendarSession();
  user.App.currentUser = { code: 'P2', username: 'P2', displayName: 'P2' };
  await user.start();
  assert.equal(user.App.isCalendarNoteReminder('2026-09-14', id), false);
  await user.finishToast();
  assert.equal(user.nodes.get('toast').hidden, true);
  assert.equal(user.nodes.get('toast-body').textContent, 'An existing notice');
  user.App.stopCalendarSession();
});

test('deleting a shared note cancels its toast and leaves silent tags to expire at midnight', async () => {
  const db = database(), one = client(db), two = client(db, { code: 'P2' });
  await Promise.all([one.start(), two.start()]);
  const date = '2026-09-14', id = await remindAbout(one, date, 'Delete this note');
  await two.App.setCalendarNoteReminder(date, id, true);
  two.App.stopCalendarSession();
  await one.App.saveCalendarNote(date, id, '', 'Delete this note');
  await settle();
  assert.ok(db.get(`calendarReminders/P1/${date}/${id}`), 'a missing cached note does not trigger destructive tag cleanup');
  assert.ok(db.get(`calendarReminders/P2/${date}/${id}`), 'cleanup does not read or alter another account');
  await one.finishToast();
  assert.equal(one.nodes.get('toast').hidden, true);
  const reopened = client(db, { code: 'P2' });
  await reopened.start();
  assert.equal(reopened.nodes.get('toast').hidden, true, 'orphan tags do not produce empty or stale note toasts');
  assert.ok(db.get(`calendarReminders/P2/${date}/${id}`));
  await one.advance('2026-09-15T10:00:00Z');
  assert.equal(db.get(`calendarReminders/P1/${date}`), null);
  one.App.stopCalendarSession(); reopened.App.stopCalendarSession();
});

test('note reminders wait for shared notes to load, while old private reminder text stays private', async () => {
  const date = '2026-09-14';
  const db = database({ calendarReminders: { P1: { [date]: { legacy: { text: 'Old private reminder', expiresAt: Date.parse('2026-09-15T10:00:00Z') } } } } });
  const user = client(db);
  await user.start();
  assert.equal(user.nodes.get('toast-body').textContent, 'Old private reminder');
  assert.equal(JSON.stringify(db.get('calendar')).includes('Old private reminder'), false);
  await user.finishToast();
  const id = await user.App.saveCalendarNote(date, null, 'Shared note still loading');
  user.App.calendarState.ready = false;
  await db.ref(`calendarReminders/P1/${date}/${id}`).set({ noteId: id, createdAt: 1, expiresAt: Date.parse('2026-09-15T10:00:00Z') });
  await settle();
  assert.equal(user.nodes.get('toast').hidden, true, 'no tag toast before notes are ready');
  assert.ok(db.get(`calendarReminders/P1/${date}/${id}`), 'an unloaded note is not an orphan');
  await db.ref(`calendar/years/2026/${date}/${id}/text`).set('Loaded shared note');
  await settle();
  assert.equal(user.nodes.get('toast-body').textContent, 'Loaded shared note');
  await user.advance('2026-09-15T10:00:00Z');
  await user.finishToast();
  assert.equal(db.get(`calendarReminders/P1/${date}`), null);
  assert.equal(user.nodes.get('toast').hidden, true, 'legacy and tag reminders expire at the same local midnight');
  user.App.stopCalendarSession();
});

test('queued app toast cancellation runs cleanup once and close callbacks may show the next notice safely', async () => {
  const user = client(database());
  user.App.showToast({ body: 'Active notice' });
  const reasons = [];
  const handle = user.App.showToast({ queue: true, body: 'Never show this', onClose: reason => reasons.push(reason) });
  handle.cancel(); handle.cancel();
  assert.deepEqual(reasons, ['cancelled']);
  await user.finishToast();
  assert.equal(user.nodes.get('toast').hidden, true);
  user.App.showToast({ body: 'Before callback', onClose: () => user.App.showToast({ body: 'Callback notice' }) });
  await user.finishToast();
  assert.equal(user.nodes.get('toast').hidden, false);
  assert.equal(user.nodes.get('toast-body').textContent, 'Callback notice');
});

test('reminder subscriptions read only the current account and logout releases listeners and timers', async () => {
  const db = database(), user = client(db);
  await user.start();
  assert.ok(db.reads.includes('calendarReminders/P1'));
  assert.equal(db.reads.includes('calendarReminders'), false, 'no collection-wide reminder subscription');
  assert.equal(db.reads.some(name => name.startsWith('calendarReminders/P2')), false);
  assert.ok(db.listeners.length > 0);
  assert.ok(user.timers.size > 0);
  user.App.stopCalendarSession(); user.App.currentUser = null;
  await settle();
  assert.equal(db.listeners.length, 0);
  assert.equal(user.timers.size, 0);
  assert.equal([...user.events.values()].reduce((total, callbacks) => total + callbacks.size, 0), 0, 'focus, pageshow and visibility hooks are removed');
  const writes = db.writes.length;
  await assert.rejects(user.App.saveCalendarNote('2026-09-14', null, 'After logout'));
  await assert.rejects(user.App.setCalendarNoteReminder('2026-09-14', 'note', true));
  assert.equal(db.writes.length, writes);
});

test('a delayed startup or login response cannot restart calendar after logout', async () => {
  for (const mode of ['startup', 'login']) {
    const initializers = new Map(), callbacks = new Map(), calls = [];
    let storedCode = 'P1', finishLogin;
    const login = new Promise(resolve => { finishLogin = resolve; });
    const App = { accountSessionGeneration: 0, currentUser: null, selectedGame: null,
      roomsMetaCache: new Map(), membershipMap: new Map(),
      register: (id, initialize) => initializers.set(id, initialize),
      getStoredAccountCode: () => storedCode, clearStoredAccountCode: () => { storedCode = null; },
      readCachedUserBootstrap: () => null, readCachedSettings: () => ({}), normalizeCodeInput: value => value,
      $: id => ({ value: 'P1', addEventListener: (event, cb) => callbacks.set(`${id}:${event}`, cb) }),
      syncMySchedulePresence: async () => {}, leaveStaleCallFromPreviousSession: async () => {},
      startCalendarSession: () => calls.push('calendar-start'), startAppPresence: () => calls.push('presence-start'),
      showView: view => calls.push(`view:${view}`), showToast() {}, setError: (_, message) => calls.push(`error:${message}`) };
    for (const name of ['setDefaultPfp', 'syncEye', 'applyScrollFixes', 'startAccountCreationListener',
      'applyResolvedSettings', 'resetVisualSettingsToDefaults', 'syncPanelButtonVisibility', 'stopCalendarSession',
      'resetCalendarUI', 'leaveCall', 'discardPausedMergeParty', 'stopScheduleViewersListener', 'teardownHtmlHubModal',
      'cancelQueuedSettingsSave', 'stopAppPresence', 'stopRoomPresence', 'detachOnlineIndicator', 'detachMessages',
      'teardownStickerRuntime', 'stopSchedulesHighlightTimer', 'stopSchedulesPeopleListener', 'stopScheduleTypeListener',
      'detachPingsInbox', 'stopPinnedRoomsSync', 'stopRoomMetaListeners', 'clearStoredPlace', 'clearBootstrapCaches', 'clearRecentRoomMessages',
      'syncCallButton', 'hideError', 'ensureLiveUserListener', 'startScheduleViewersListener', 'migrateLegacyHtmlLibrariesToHub',
      'writeCurrentUserBootstrapCache', 'setMeHeader', 'attachMemberships', 'attachPingsInbox', 'startScheduleTypeListener']) App[name] = () => {};
    const context = vm.createContext({ ChatApp: App, console, document: { body: { dataset: {} }, querySelector: () => null } });
    for (const file of ['accounts/logout', mode === 'startup' ? 'core/start' : 'accounts/login']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, `../js/${file}.js`), 'utf8'), context, { filename: `${file}.js` });
    }
    App.loginWithCode = () => login;
    let pending;
    if (mode === 'startup') initializers.get('core/start')();
    else { initializers.get('accounts/login')(); pending = callbacks.get('btn-login:click')(); }
    await App.logoutToLanding();
    finishLogin({ code: 'P1', username: 'P1', displayName: 'P1', settings: {} });
    await pending; await settle();
    assert.equal(App.currentUser, null, `${mode} must not restore an account after logout`);
    assert.equal(storedCode, null);
    assert.equal(calls.includes('calendar-start'), false, `${mode} must not restart reminder listeners`);
    assert.equal(calls.includes('presence-start'), false);
    assert.equal(calls.at(-1), 'view:home');
  }
});


test('independent account IDs preserve note authorship across later edits and profile labels', async () => {
  const db=database(),author=client(db,{code:'uid_ACCOUNT'}),editor=client(db,{code:'uid_EDITOR'});
  author.App.currentUser.username='Before';editor.App.currentUser.username='Editor';
  await Promise.all([author.start(),editor.start()]);
  const date='2026-09-14',id=await author.App.saveCalendarNote(date,null,'Original');
  assert.equal(db.get(`calendar/years/2026/${date}/${id}`).authorCode,'uid_ACCOUNT');
  author.App.currentUser.username='After';
  await editor.App.saveCalendarNote(date,id,'Edited','Original');
  const record=db.get(`calendar/years/2026/${date}/${id}`);assert.equal(record.authorCode,'uid_ACCOUNT');assert.equal(record.authorUsername,'Before');
  author.App.stopCalendarSession();editor.App.stopCalendarSession();
});
