/* Real bundled Firebase 10.12.5 SDK, with an in-page server transport.
 * Transactions, local events, write ordering and cancellation are SDK code.
 * Only server storage/acknowledgements are simulated; no production requests.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function installSdkServer() {
  let data = null, sequence = 0, hashSnapshot = null;
  const clients = [], writes = [], held = [];
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const parts = value => String(value || '').split('/').filter(Boolean);
  const get = path => parts(path).reduce((item, key) => item?.[key], data) ?? null;
  const clean = value => {
    if (!value || typeof value !== 'object') return value;
    if (value['.sv'] === 'timestamp') return Date.now();
    const entries = Object.entries(value).map(([key, child]) => [key, clean(child)]).filter(([, child]) => child !== null);
    return entries.length ? Object.fromEntries(entries) : null;
  };
  function putValue(path, value) {
    const keys = parts(path);
    if (!keys.length) { data = clean(copy(value)); return; }
    data ||= {};
    let parent = data;
    for (const key of keys.slice(0, -1)) parent = parent[key] ||= {};
    const next = clean(copy(value));
    if (next === null) delete parent[keys.at(-1)]; else parent[keys.at(-1)] = next;
    data = clean(data);
  }
  const enqueue = (client, action) => {
    if (client.blocked) client.queue.push(action); else setTimeout(action, 4);
  };
  function broadcast(path) {
    hasher.server.onDataUpdate_('/', copy(data), false, null);
    for (const client of clients) client.server.onDataUpdate_(path, copy(get(path)), false, null);
  }
  function createClient(name, hashing = false) {
    const app = firebase.initializeApp({ apiKey: 'local-test', projectId: 'demo-call-join', databaseURL: 'https://demo-call-join.firebaseio.com' }, name + (++sequence));
    const db = app.database();
    db.useEmulator('127.0.0.1', 65001);
    db.goOffline();
    const server = db._delegate._repo.server_;
    const client = { name, app, db, server, blocked: false, queue: [], holdNextTransaction: false };
    server.listen = (query, _hash, tag, callback) => {
      setTimeout(() => { server.onDataUpdate_(query._path.toString(), copy(get(query._path.toString())), false, tag); callback('ok'); }, 0);
    };
    server.unlisten = () => {};
    server.get = async query => copy(get(query._path.toString()));
    server.onDisconnectPut = (_path, _value, callback) => setTimeout(() => callback('ok'), 0);
    server.onDisconnectMerge = (_path, _value, callback) => setTimeout(() => callback('ok'), 0);
    server.onDisconnectCancel = (_path, callback) => setTimeout(() => callback('ok'), 0);
    server.put = (path, value, callback, hash) => {
      const action = () => {
        const actualHash = hashSnapshot?.child(parts(path).join('/'))._delegate._node.hash() || '';
        if (hash !== undefined && hash !== actualHash) {
          server.onDataUpdate_(path, copy(get(path)), false, null);
          callback('datastale');
          return;
        }
        writes.push({ client: name, path, transaction: hash !== undefined, value: copy(value) });
        putValue(path, value);
        broadcast(path);
        callback('ok');
      };
      if (hash !== undefined && client.holdNextTransaction) { client.holdNextTransaction = false; held.push(action); }
      else enqueue(client, action);
    };
    server.merge = (path, values, callback) => enqueue(client, () => {
      writes.push({ client: name, path, merge: true, value: copy(values) });
      for (const [key, value] of Object.entries(values)) putValue(`${path}/${key}`, value);
      broadcast(path);
      callback('ok');
    });
    if (!hashing) clients.push(client);
    return client;
  }
  const hasher = createClient('server-hash', true);
  hasher.db.ref().on('value', snapshot => { hashSnapshot = snapshot; });
  hasher.server.onDataUpdate_('/', data, false, null);
  window.__sdkServer = { createClient, writes, get: path => copy(get(path)),
    seed(path, value) { putValue(path, value); broadcast(path); },
    releaseHeld() { for (const action of held.splice(0)) action(); },
    held,
    release(client) { client.blocked = false; for (const action of client.queue.splice(0)) setTimeout(action, 0); }
  };
}

async function run() {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { network.push(route.request().url()); return route.abort(); });
  try {
    await page.addScriptTag({ path: path.join(root, 'vendor/firebase-app-compat.js') });
    await page.addScriptTag({ path: path.join(root, 'vendor/firebase-database-compat.js') });
    await page.evaluate(installSdkServer);
    const reproduced = await page.evaluate(async () => {
      const server = window.__sdkServer;
      const client = server.createClient('original');
      server.seed('calls/repro', { instanceId: 'original', members: { peer: { sessionId: 'peer', connected: true } } });
      await client.db.ref('calls/repro').once('value');
      client.holdNextTransaction = true;
      const transaction = client.db.ref('calls/repro').transaction(record => ({ ...record, active: true }), undefined, false).then(() => 'unexpected success', error => error.message);
      // A real local update cancels the SDK transaction. A concurrent server
      // change makes its in-flight compare-and-swap return datastale.
      void client.db.ref('calls/repro/members/self').update({ viewingSharesSessionId: 'pending' });
      server.seed('calls/repro/members/peer/speaking', true);
      server.releaseHeld();
      return await transaction;
    });
    assert.equal(reproduced, 'set', 'The actual bundled SDK reproduces the exact reported toast');
    console.log('Reproduced the original Error("set") with the real Firebase SDK.');

    const sourceNames = ['policy', 'state', 'playback', 'microphone', 'viewers', 'presence', 'lifecycle'];
    const sources = sourceNames.map(name => ({ name, source: fs.readFileSync(path.join(root, 'call-modules', `${name}.js`), 'utf8') }));
    await page.evaluate(sources => {
      window.__makeCallingApp = function (code, room = 'test') {
        const client = __sdkServer.createClient(code);
        const initializers = [];
        const noop = () => {};
        const App = { register(name, initialize) { if (name !== 'calling/lifecycle') initializers.push(initialize); },
          db: client.db, firebase, currentUser: { code, username: code, displayName: code }, currentRoomId: room,
          sanitizeRoomCode: String, sanitizeCallRoom: String, $: () => null, LS: { CALL_ROOM: `call-${code}` }, liveUserCache: new Map(),
          callRuntimeConfig: () => ({}), callGetMemberByCode: code => App.callMembersCache.find(member => member.code === code),
          makeCallSessionId: () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`, toasts: [], showToast: toast => App.toasts.push(toast) };
        window.ChatApp = App;
        for (const { source } of sources) (0, eval)(source);
        for (const initialize of initializers) initialize();
        for (const name of ['syncCallButton', 'syncCallControlsUI', 'callSetMobileAudioSession', 'callPrimePlaybackContextFromGesture', 'callClosePlaybackContext', 'callDisposeMicrophoneGraph', 'callBindLocalMicrophoneHealth', 'callStartWebRTC', 'callSyncMenuStatusDisplay', 'callPatchSpeakingIndicators', 'callPublishDesktopOverlay', 'callApplyInputVolume', 'callApplyLocalMuteState', 'callScheduleMediaBudget', 'callSyncScreenAudioPlayback', 'ensureLiveUserListener', 'callRemoveRemoteScreenAudio', 'renderCallMenu']) App[name] = noop;
        App.getLiveOrStoredCallUser = member => member;
        App.callEnsurePeers = App.callResumeRemoteAudio = async () => {};
        App.callUpdateConnectionQuality = async () => {};
        App.callRefreshIceServers = async () => [];
        App.callRequestMicPermission = async () => new MediaStream();
        App.callAttachLocalStream = stream => { App.callLocalStream = stream; };
        App.openCallMenu = () => { App.callMenuOpen = true; void App.callSyncViewerPresence(); };
        App.closeCallMenu = () => { App.callMenuOpen = false; void App.callSyncViewerPresence(); };
        App.callStopWebRTC = () => { App.callStopShareViewerObserver(); App.callLocalStream = null; };
        App.client = client;
        return App;
      };
    }, sources);

    const joined = await page.evaluate(async () => {
      __sdkServer.seed('calls/test', { instanceId: 'continuing', members: { peer: { code: 'peer', sessionId: 'peer', connected: true, lastSeenAt: Date.now() } } });
      const a = __makeCallingApp('A'), b = __makeCallingApp('B');
      window.__apps = [a, b];
      const chatter = setInterval(() => {
        __sdkServer.seed('calls/test/members/peer/lastSeenAt', Date.now());
        for (const app of [a, b]) { app.callSetLocalSpeaking(true, { force: true }); void app.callSyncViewerPresence({ force: true }); }
      }, 8);
      await Promise.all([a.joinCall('test'), b.joinCall('test')]);
      clearInterval(chatter);
      await Promise.all([a.callSyncViewerPresence(), b.callSyncViewerPresence()]);
      return [a, b].map(app => ({ room: app.currentCallRoomId, pending: app.callJoinPending, instance: app.callAudioPreferenceScope?.instanceId, toasts: app.toasts, session: app.callSessionId, serverSession: __sdkServer.get(`calls/test/members/${app.currentUser.code}/sessionId`) }));
    });
    for (const client of joined) {
      assert.equal(client.room, 'test', JSON.stringify(client)); assert.equal(client.pending, false); assert.equal(client.instance, 'continuing');
      assert.equal(client.serverSession, client.session); assert.deepEqual(client.toasts, []);
    }
    assert.equal(await page.evaluate(() => __sdkServer.writes.filter(write => ['A', 'B'].includes(write.client) && write.path === '/calls/test' && write.transaction).length), 0, 'Busy established joins never transact the signaling parent');

    const fresh = await page.evaluate(async () => {
      const c = __makeCallingApp('C', 'fresh'), d = __makeCallingApp('D', 'fresh');
      __apps.push(c, d);
      await Promise.all([c.joinCall('fresh'), d.joinCall('fresh')]);
      return [c, d].map(app => ({ room: app.currentCallRoomId, instance: app.callAudioPreferenceScope?.instanceId, toasts: app.toasts }));
    });
    assert.equal(fresh[0].room, 'fresh'); assert.equal(fresh[1].room, 'fresh');
    assert.ok(fresh[0].instance); assert.equal(fresh[0].instance, fresh[1].instance);
    assert.deepEqual(fresh.map(item => item.toasts), [[], []]);

    const immediatePresence = await page.evaluate(async () => {
      const server = __sdkServer;
      const joining = __makeCallingApp('Immediate', 'immediate');
      const observing = __makeCallingApp('Observer', 'immediate');
      __apps.push(joining, observing);
      observing.attachCallObserver('immediate');
      observing.callMenuOpen = true;
      const menus = [], overlays = [];
      observing.renderCallMenu = () => menus.push(observing.callMembersCache.map(member => member.code));
      observing.callPublishDesktopOverlay = () => overlays.push(observing.callMembersCache.map(member => member.code));
      joining.client.holdNextTransaction = true;
      const join = joining.joinCall('immediate');
      await new Promise(resolve => setTimeout(resolve, 30));
      const pendingSelf = joining.callMembersCache.map(member => member.code);
      const pendingJoin = joining.callJoinPending;
      server.releaseHeld();
      await join;
      const remoteJoin = { menu: menus.at(-1), overlay: overlays.at(-1) };

      // Hold only instance retirement. The real SDK still publishes the small
      // session-guarded removal, and all observers must render it immediately.
      const transact = joining.callRunTransaction;
      let retire;
      joining.callRunTransaction = (ref, update, options) => {
        if (ref.toString().endsWith('/calls/immediate')) {
          return new Promise(resolve => { retire = () => resolve(transact(ref, update, options)); });
        }
        return transact(ref, update, options);
      };
      const leave = joining.leaveCall({ quiet: true });
      const localLeave = { room: joining.currentCallRoomId, roster: joining.callMembersCache.map(member => member.code) };
      await new Promise(resolve => setTimeout(resolve, 30));
      const beforeRetirement = { menu: menus.at(-1), overlay: overlays.at(-1), members: server.get('calls/immediate/members'), instance: server.get('calls/immediate/instanceId') };
      retire();
      await leave;
      return { pendingSelf, pendingJoin, remoteJoin, localLeave, beforeRetirement, afterRetirement: server.get('calls/immediate') };
    });
    assert.equal(immediatePresence.pendingJoin, true);
    assert.deepEqual(immediatePresence.pendingSelf, ['Immediate'], 'Initial SDK snapshot cannot erase the optimistic local join while acknowledgement is held');
    assert.deepEqual(immediatePresence.remoteJoin, { menu: ['Immediate'], overlay: ['Immediate'] });
    assert.deepEqual(immediatePresence.localLeave, { room: null, roster: [] }, 'Local leave clears before its first network await');
    assert.deepEqual(immediatePresence.beforeRetirement.menu, []);
    assert.deepEqual(immediatePresence.beforeRetirement.overlay, []);
    assert.equal(immediatePresence.beforeRetirement.members, null);
    assert.ok(immediatePresence.beforeRetirement.instance, 'Remote removal is delivered while unrelated final cleanup remains held');
    assert.equal(immediatePresence.afterRetirement, null);

    const pagehideDeparture = await page.evaluate(async () => {
      const leaving=__makeCallingApp('Hidden','pagehide'), observing=__makeCallingApp('Watching','pagehide');
      __apps.push(leaving,observing); observing.attachCallObserver('pagehide');
      await leaving.joinCall('pagehide');
      leaving.callRemoveMembershipSession=()=>new Promise(()=>{});
      leaving.callHandlePageHide();
      await new Promise(resolve=>setTimeout(resolve,40));
      return {localRoom:leaving.currentCallRoomId,remoteMembers:observing.callMembersCache.map(member=>member.code)};
    });
    assert.equal(pagehideDeparture.localRoom,null);
    assert.deepEqual(pagehideDeparture.remoteMembers,[],'Pagehide departure is visible even while full membership removal is stalled');

    const simultaneous = await page.evaluate(async () => {
      const server = __sdkServer;
      const callers = Array.from({ length: 6 }, (_, i) => __makeCallingApp(`S${i}`, 'simultaneous'));
      __apps.push(...callers);
      const invitations = [];
      for (const app of callers) app.callRingOnCallStarted = (room, record, instance) => invitations.push(instance);
      server.seed('calls/simultaneous', { active: true, instanceId: 'abandoned', audioPreferences: { obsolete: true } });
      await Promise.all(callers.map(app => app.joinCall('simultaneous')));
      const afterJoin = server.get('calls/simultaneous');
      const cleanupErrors = [];
      for (const app of callers) {
        const remove = app.callRemoveMembershipSession;
        app.callRemoveMembershipSession = async (...args) => { try { return await remove(...args); } catch (error) { cleanupErrors.push(error.message); throw error; } };
      }
      await Promise.all(callers.map(app => app.leaveCall({ quiet: true })));
      return { invitations, count: Object.keys(afterJoin?.members || {}).length, instance: afterJoin?.instanceId,
        confirmed: Object.values(afterJoin?.members || {}).every(member => member.joinConfirmed === true),
        inheritedPreferences: afterJoin?.audioPreferences || null, afterLeave: server.get('calls/simultaneous'),
        cleanupErrors, failedJoins: callers.flatMap(app => app.toasts.filter(toast => toast.title === 'Unable to join call')) };
    });
    assert.equal(simultaneous.count, 6); assert.equal(simultaneous.confirmed, true);
    assert.notEqual(simultaneous.instance, 'abandoned'); assert.equal(simultaneous.inheritedPreferences, null);
    assert.deepEqual(simultaneous.invitations, [simultaneous.instance], 'One atomic winner rings exactly once');
    assert.deepEqual(simultaneous.failedJoins, []);
    assert.deepEqual(simultaneous.cleanupErrors, []);
    assert.equal(simultaneous.afterLeave, null, 'Simultaneous final departures leave no active ghost record');

    const late = await page.evaluate(async () => {
      const app = __makeCallingApp('T', 'timeout'); __apps.push(app);
      // Hold the server write stream, retaining request order across reconnect.
      app.client.blocked = true;
      const originalAwait = app.callAwaitSignaling;
      app.callAwaitSignaling = (operation, timeout) => originalAwait(operation, timeout || 100);
      const oldJoin = app.joinCall('timeout');
      await new Promise(resolve => setTimeout(resolve, 35));
      const pendingSession = app.callSessionId;
      const publisherBeforeCommit = app.myCallMemberRef;
      app.callSetLocalSpeaking(true, { force: true });
      await app.callSyncViewerPresence({ force: true });
      await oldJoin;
      const afterTimeout = { room: app.currentCallRoomId, pending: app.callJoinPending, stopped: app.callLocalStream === null, message: app.toasts.at(-1)?.body };
      app.callAwaitSignaling = originalAwait;
      const newJoin = app.joinCall('timeout');
      await new Promise(resolve => setTimeout(resolve, 25));
      __sdkServer.release(app.client);
      await newJoin;
      await new Promise(resolve => setTimeout(resolve, 250));
      return { publisherBeforeCommit, afterTimeout, pendingSession, session: app.callSessionId, room: app.currentCallRoomId, pending: app.callJoinPending, serverSession: __sdkServer.get('calls/timeout/members/T/sessionId') };
    });
    assert.equal(late.publisherBeforeCommit, null);
    assert.equal(late.afterTimeout.room, null); assert.equal(late.afterTimeout.pending, false); assert.equal(late.afterTimeout.stopped, true);
    assert.match(late.afterTimeout.message, /did not respond/);
    assert.equal(late.room, 'timeout'); assert.equal(late.pending, false);
    assert.notEqual(late.session, late.pendingSession); assert.equal(late.serverSession, late.session, 'Late writes/cleanup cannot erase the newer joined session');
    assert.deepEqual(errors, []);
    assert.deepEqual(network, [], 'SDK test never makes a network request');
    console.log('PASS: authentic Firebase cancellation, immediate local/remote presence, concurrent joins/heartbeats, shared instance creation, timeout rollback and delayed-write rejoin.');
  } finally {
    await page.evaluate(() => { for (const app of window.__apps || []) { app.callStopHeartbeat(); app.detachCallObserver(); } }).catch(() => {});
    await browser.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
