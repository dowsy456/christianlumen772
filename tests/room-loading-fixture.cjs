/* Query-aware room fixture. It deliberately differs from firebase-mock.js:
 * limited-query evictions emit child_removed, range pages stay live, and only
 * queried records cross the simulated network boundary. No remote service used.
 */
'use strict';
function installRoomLoadingFixture({ count = 12000, latencyMs = 120, blockedStorage = false } = {}) {
  if (blockedStorage) {
    for (const name of ['getItem', 'setItem', 'removeItem', 'clear']) {
      Storage.prototype[name] = function () { throw new DOMException('Storage disabled by room-loading test', 'SecurityError'); };
    }
  }
  const now = Date.now();
  const values = { '.info': { connected: true, serverTimeOffset: 0 }, admin: { accountCreationEnabled: true, scheduleType: 'full' },
    credentials: { '2959471ec9b8257bf8064f372f5c3e22ba83d04594114827a47aeb797b3907bd': 'TEST-USER' }, roomNames: {},
    users: { 'TEST-USER': { credentialHash: '2959471ec9b8257bf8064f372f5c3e22ba83d04594114827a47aeb797b3907bd', username: 'Tester', usernameLower: 'tester', displayName: 'Tester', displayNameLower: 'tester', createdAt: now } },
    usernames: { tester: 'TEST-USER' }, displayNames: { tester: 'TEST-USER' }, rooms: {}, messages: {},
    memberships: { 'TEST-USER': {} }, roomMembers: {} };
  const keyFor = index => 'k' + String(index).padStart(8, '0');
  for (const room of ['test', 'second']) {
    // Deliberately stale metadata: fullness must come from the bounded query,
    // not this lower counter, or history silently disappears after 60 rows.
    values.rooms[room] = { name: room === 'test' ? 'Large Test Room' : 'Second Large Room', createdBy: 'TEST-USER', createdAt: now, messageCount: Math.min(60, count) };
    values.roomNames[values.rooms[room].name.toLowerCase()] = room;
    values.memberships['TEST-USER'][room] = true;
    values.roomMembers[room] = { 'TEST-USER': true };
    values.messages[room] = Object.fromEntries(Array.from({ length: count }, (_, index) => [keyFor(index), {
      userCode: 'TEST-USER', username: 'Tester', text: `${room} history ${index}: ` + 'Readable conversation text. '.repeat(4), createdAt: now - (count - index) * 1000
    }]));
  }
  const listeners = new Set();
  const traces = [];
  const writes = [];
  const held = [];
  const heldInitial = [];
  const heldNewer = [];
  let latency = latencyMs;
  let sequence = 0;
  const parts = path => String(path || '').split('/').filter(Boolean);
  const normalize = path => parts(path).join('/');
  const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const get = path => parts(path).reduce((object, key) => object?.[key], values) ?? null;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stamp = (value, old) => {
    if (value == null || typeof value !== 'object') return value;
    if (value['.sv'] === 'timestamp') return Date.now();
    if (typeof value['.sv']?.increment === 'number') return (Number(old) || 0) + value['.sv'].increment;
    return Array.isArray(value) ? value.map((item, index) => stamp(item, old?.[index])) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stamp(item, old?.[key])]));
  };
  function queryValue(path, query) {
    const raw = get(path);
    if (!raw || typeof raw !== 'object' || !Object.keys(query).length) return clone(raw);
    let entries = Object.entries(raw).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (query.startAt != null) entries = entries.filter(([key]) => key >= query.startAt);
    if (query.endAt != null) entries = entries.filter(([key]) => key <= query.endAt);
    if (query.endBefore != null) entries = entries.filter(([key]) => key < query.endBefore);
    if (query.equalTo != null) entries = entries.filter(([key, value]) => (query.orderByChild ? value?.[query.orderByChild] : key) === query.equalTo);
    if (query.limitToLast != null) entries = entries.slice(-query.limitToLast);
    if (query.limitToFirst != null) entries = entries.slice(0, query.limitToFirst);
    return entries.length ? clone(Object.fromEntries(entries)) : null;
  }
  function trace(kind, path, query, value, event) {
    if (!path.startsWith('messages/')) return;
    traces.push({ at: performance.now(), kind, path, query: { ...query }, event,
      records: parts(path).length === 2 ? Object.keys(value || {}).length : value == null ? 0 : 1,
      bytes: JSON.stringify(value)?.length || 0 });
  }
  function snapshot(path, value) {
    const copied = clone(value);
    return { key: parts(path).at(-1) || null, val: () => clone(copied), exists: () => copied != null,
      numChildren: () => copied && typeof copied === 'object' ? Object.keys(copied).length : 0,
      child: key => snapshot(path + '/' + key, parts(key).reduce((object, part) => object?.[part], copied)),
      forEach: callback => Object.entries(copied || {}).some(([key, child]) => callback(snapshot(path + '/' + key, child)) === true), ref: ref(path) };
  }
  function deliver(listener, path, value) {
    const snap = snapshot(path, value);
    setTimeout(() => {
      if (!listeners.has(listener)) return;
      trace('delivery', path, listener.query, value, listener.event);
      listener.callback(snap);
    }, latency);
  }
  function notify() {
    for (const listener of [...listeners]) {
      const next = queryValue(listener.path, listener.query);
      const previous = listener.previous;
      if (same(previous, next)) continue;
      listener.previous = next;
      if (listener.event === 'value') deliver(listener, listener.path, next);
      else {
        for (const key of new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])) {
          const before = previous?.[key], after = next?.[key];
          if (same(before, after)) continue;
          const event = before == null ? 'child_added' : after == null ? 'child_removed' : 'child_changed';
          if (listener.event === event) deliver(listener, listener.path + '/' + key, event === 'child_removed' ? before : after);
        }
      }
    }
  }
  function put(path, value) {
    const keys = parts(path);
    let parent = values;
    for (const key of keys.slice(0, -1)) parent = parent[key] ??= {};
    if (value === null) delete parent[keys.at(-1)];
    else parent[keys.at(-1)] = stamp(clone(value), parent[keys.at(-1)]);
    writes.push({ path, at: performance.now() });
    notify();
  }
  function ref(raw = '', query = {}) {
    const path = normalize(raw), signature = JSON.stringify(query);
    const refine = (name, value) => ref(path, { ...query, [name]: value });
    return { key: parts(path).at(-1) || null, child: key => ref(path + '/' + key), toString: () => path,
      set: value => { put(path, value); return Promise.resolve(); }, remove: () => { put(path, null); return Promise.resolve(); },
      update: patch => { for (const [key, value] of Object.entries(patch)) put(path + '/' + key, value); return Promise.resolve(); },
      once: (event = 'value', callback) => {
        const value = queryValue(path, query); trace('once', path, query, value, event);
        return new Promise(resolve => {
          const finish = () => { const snap = snapshot(path, value); callback?.(snap); resolve(snap); };
          if (api.holdHistory && path.startsWith('messages/') && query.endAt != null && query.limitToLast != null) held.push(finish);
          else if (api.holdNewerFinal && path.startsWith('messages/') && query.limitToFirst != null && Object.keys(value || {}).length < query.limitToFirst) heldNewer.push(finish);
          else if (api.holdInitial && path.startsWith('messages/') && query.endAt == null && query.limitToLast != null) heldInitial.push(finish);
          else setTimeout(finish, latency);
        });
      },
      get() { return this.once('value'); },
      on(event, callback) {
        const value = queryValue(path, query);
        const listener = { path, query, signature, event, callback, previous: value };
        listeners.add(listener); trace('on', path, query, value, event);
        if (event === 'value') deliver(listener, path, value);
        else if (event === 'child_added') for (const [key, item] of Object.entries(value || {})) deliver(listener, path + '/' + key, item);
        return callback;
      },
      off(event, callback) { for (const listener of [...listeners]) if (listener.path === path && listener.signature === signature && (!event || event === listener.event) && (!callback || callback === listener.callback)) listeners.delete(listener); },
      transaction(fn, callback) { const value = fn(clone(get(path))); const committed = value !== undefined; if (committed) put(path, value); const snap = snapshot(path, get(path)); callback?.(null, committed, snap); return Promise.resolve({ committed, snapshot: snap }); },
      onDisconnect: () => ({ set: () => Promise.resolve(), update: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }),
      push(value) { const child = ref(path + '/z' + Date.now() + String(++sequence).padStart(4, '0')); if (value !== undefined) void child.set(value); return child; },
      orderByKey: () => refine('orderByKey', true), orderByChild: value => refine('orderByChild', value),
      startAt: value => refine('startAt', value), endAt: value => refine('endAt', value), endBefore: value => refine('endBefore', value), equalTo: value => refine('equalTo', value),
      limitToLast: value => refine('limitToLast', value), limitToFirst: value => refine('limitToFirst', value) };
  }
  const api = { values, traces, writes, ref, get, keyFor, holdHistory: false, holdInitial: false,
    holdNewerFinal: false, pendingNewer: () => heldNewer.length,
    releaseNewer: () => { api.holdNewerFinal = false; heldNewer.splice(0).forEach(finish => finish()); },
    setLatency: value => { latency = value; }, pendingHistory: () => held.length,
    releaseHistory: () => { api.holdHistory = false; held.splice(0).forEach(finish => finish()); },
    pendingInitial: () => heldInitial.length,
    releaseInitial: () => { api.holdInitial = false; heldInitial.splice(0).forEach(finish => finish()); },
    activeMessageListeners: () => [...listeners].filter(item => item.path.startsWith('messages/')).map(({ path, query, event }) => ({ path, query, event })) };
  const database = () => ({ ref, goOffline() {}, goOnline() {} });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' }, increment: increment => ({ '.sv': { increment } }) };
  window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, database };
  window.__roomLoadFixture = api;
}
module.exports = installRoomLoadingFixture;
