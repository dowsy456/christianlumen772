/* Shared in-memory realtime backend for browser integration tests. Never reaches Firebase. */
"use strict";

function installSharedFirebaseMock() {
  const callbacks = new Map();
  let sequence = 0;
  const normalize = (path) => String(path || "").split("/").filter(Boolean).join("/");
  const request = (op, path, value, extra = {}) => window.__sharedDbRequest({ op, path: normalize(path), value, ...extra });
  function snapshot(path, value) {
    const copy = value == null ? null : JSON.parse(JSON.stringify(value));
    return { key: normalize(path).split("/").at(-1) || null, ref: ref(path), val: () => copy,
      exists: () => copy != null, numChildren: () => Object.keys(copy || {}).length,
      child: (key) => snapshot(`${path}/${key}`, String(key).split("/").reduce((obj, part) => obj?.[part], copy)),
      forEach: (cb) => Object.entries(copy || {}).some(([key, val]) => cb(snapshot(`${path}/${key}`, val)) === true) };
  }
  window.__sharedDbEvent = ({ id, path, value }) => {
    const listener = callbacks.get(id);
    if (listener) listener.cb(snapshot(path, value));
  };
  function ref(rawPath = "") {
    const path = normalize(rawPath);
    return {
      key: path.split("/").at(-1) || null, child: (key) => ref(`${path}/${key}`), toString: () => path,
      set: (value) => request("set", path, value), update: (value) => request("update", path, value), remove: () => request("set", path, null),
      once: async (event, cb) => { const snap = snapshot(path, await request("get", path)); cb?.(snap); return snap; },
      get: async () => snapshot(path, await request("get", path)),
      on(event, cb, cancel) {
        const id = String(++sequence);
        callbacks.set(id, { path, event, cb });
        request("subscribe", path, null, { event, id }).catch((error) => cancel?.(error));
        return cb;
      },
      off(event, cb) {
        for (const [id, item] of callbacks) if (item.path === path && (!event || item.event === event) && (!cb || item.cb === cb)) {
          callbacks.delete(id); void request("unsubscribe", path, null, { id });
        }
      },
      onDisconnect: () => ({ set: () => Promise.resolve(), update: () => Promise.resolve(), remove: () => Promise.resolve(), cancel: () => Promise.resolve() }),
      async transaction(fn, cb) {
        for (let retry = 0; retry < 30; retry++) {
          const before = await request("get", path);
          const value = fn(before);
          if (value === undefined) { const snap = snapshot(path, before); cb?.(null, false, snap); return { committed: false, snapshot: snap }; }
          const result = await request("transaction", path, value, { before });
          if (result.committed) { const snap = snapshot(path, result.value); cb?.(null, true, snap); return { committed: true, snapshot: snap }; }
        }
        throw new Error("Shared fixture transaction retry limit");
      },
      push(value) {
        const next = ref(`${path}/-TEST${Date.now()}${crypto.randomUUID().replaceAll("-", "")}`);
        if (value !== undefined) void next.set(value);
        return next;
      },
      orderByKey() { return this; }, orderByChild() { return this; }, limitToLast() { return this; }, limitToFirst() { return this; },
      startAt() { return this; }, endAt() { return this; }, equalTo() { return this; },
    };
  }
  const database = () => ({ ref, goOffline() {}, goOnline() {} });
  database.ServerValue = { TIMESTAMP: { ".sv": "timestamp" }, increment: (increment) => ({ ".sv": { increment } }) };
  window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, database };
}

function createSharedFirebaseBackend(count = 6) {
  const now = Date.now();
  const values = {
    ".info": { connected: true, serverTimeOffset: 0 },
    admin: { accountCreationEnabled: true, scheduleType: "full" },
    rooms: { test: { name: "Local six-person test", createdBy: "P1", createdAt: now, messageCount: 0 } },
    users: {}, credentials: {}, memberships: {}, roomMembers: { test: {} },
  };
  for (let index = 1; index <= count; index++) {
    const code = `P${index}`;
    const credentialHash = require('node:crypto').createHash('sha256').update(code).digest('hex');
    values.credentials[credentialHash] = code;
    values.users[code] = { code, credentialHash, username: code, usernameLower: code.toLowerCase(), displayName: code, displayNameLower: code.toLowerCase(), createdAt: now };
    values.memberships[code] = { test: true };
    values.roomMembers.test[code] = true;
  }
  const listeners = new Map();
  const writes = [];
  const deliveryErrors = [];
  const clone = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
  const parts = (path) => String(path || "").split("/").filter(Boolean);
  const getFrom = (root, path) => parts(path).reduce((obj, key) => obj?.[key], root) ?? null;
  const get = (path) => getFrom(values, path);
  function stamp(value, previous) {
    if (!value || typeof value !== "object") return value;
    if (value[".sv"] === "timestamp") return Date.now();
    if (typeof value[".sv"]?.increment === "number") return (Number(previous) || 0) + value[".sv"].increment;
    if (Array.isArray(value)) return value.map((entry, index) => stamp(entry, previous?.[index]));
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, stamp(val, previous?.[key])]));
  }
  function put(path, value) {
    const keys = parts(path);
    if (!keys.length) throw new Error("Root set is not supported by this fixture");
    let obj = values;
    for (const key of keys.slice(0, -1)) obj = obj[key] ??= {};
    if (value === null) delete obj[keys.at(-1)];
    else obj[keys.at(-1)] = stamp(value, obj[keys.at(-1)]);
    writes.push({ path, at: Date.now() });
  }
  function send(page, listener, path, value) {
    if (page.isClosed()) return;
    void page.evaluate((event) => window.__sharedDbEvent(event), { id: listener.id, path, value: clone(value) })
      .catch((error) => { if (!page.isClosed() && !/closed|destroyed|navigation/i.test(error.message)) deliveryErrors.push(error.message); });
  }
  function notify(before) {
    for (const [page, entries] of listeners) for (const item of entries.values()) {
      const oldValue = getFrom(before, item.path);
      const next = get(item.path);
      if (JSON.stringify(oldValue) === JSON.stringify(next)) continue;
      if (item.event === "value") send(page, item, item.path, next);
      else for (const key of new Set([...Object.keys(oldValue || {}), ...Object.keys(next || {})])) {
        const oldChild = oldValue?.[key];
        const nextChild = next?.[key];
        if (JSON.stringify(oldChild) === JSON.stringify(nextChild)) continue;
        const event = oldChild == null ? "child_added" : nextChild == null ? "child_removed" : "child_changed";
        if (item.event === event) send(page, item, `${item.path}/${key}`, event === "child_removed" ? oldChild : nextChild);
      }
    }
  }
  async function bind(context) {
    await context.exposeBinding("__sharedDbRequest", ({ page }, message) => {
      const { op, path, value, event, id } = message;
      if (op === "get") return clone(get(path));
      if (op === "subscribe") {
        if (!listeners.has(page)) listeners.set(page, new Map());
        const item = { id, path, event };
        listeners.get(page).set(id, item);
        if (event === "value") send(page, item, path, get(path));
        if (event === "child_added") for (const [key, child] of Object.entries(get(path) || {})) send(page, item, `${path}/${key}`, child);
        return true;
      }
      if (op === "unsubscribe") { listeners.get(page)?.delete(id); return true; }
      if (op === "transaction" && JSON.stringify(get(path)) !== JSON.stringify(message.before)) return { committed: false };
      const before = clone(values);
      if (op === "update") for (const [key, item] of Object.entries(value)) put(`${path}/${key}`, item);
      else put(path, value);
      notify(before);
      return op === "transaction" ? { committed: true, value: clone(get(path)) } : true;
    });
    await context.addInitScript(installSharedFirebaseMock);
  }
  return { bind, get, values, writes, deliveryErrors };
}

module.exports = { createSharedFirebaseBackend };
