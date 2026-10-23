'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture(kind = 'merge-party') {
  const data = {}, timers = new Map(), disconnects = new Set(), events = []; let timer = 0, sequence = 0;
  const read = path => path.split('/').reduce((value, key) => value?.[key], data) ?? null;
  const write = (path, value) => { const keys = path.split('/'); let cursor = data; for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {}; if (value == null) delete cursor[keys.at(-1)]; else cursor[keys.at(-1)] = clone(value); };
  const ref = path => ({ path, child: suffix => ref(path + '/' + suffix),
    onDisconnect: () => ({ remove: async () => disconnects.add(path), cancel: async () => disconnects.delete(path) }),
    remove: async () => write(path, null),
    transaction: async update => { if (f.gate) { const gate = f.gate; f.gate = null; await gate; } const value = update(clone(read(path))); if (value !== undefined) write(path, value); return { committed: value !== undefined, snapshot: { val: () => clone(read(path)) } }; }
  });
  const controller = kind === 'bopl-royale' ? { isOnline: () => true, reconnectOnline: async () => events.push(['reconnect', App.currentUser.code]) }
    : { updateAccountPassword: code => events.push(['rebind', code]) };
  const frame = { contentWindow: kind === 'bopl-royale' ? { __boplRoyale: controller } : { __mergeParty: controller } };
  const game = { roomActivityId: kind, roomActivityRoomId: 'room', label: 'Game' };
  const App = { currentUser: { code: 'old-password' }, currentRoomId: 'room', selectedGame: game, gamesStageOpen: true,
    db: { ref }, CLIENT_INSTANCE_ID: 'client', accurateNowMs: () => 100000,
    sanitizeRoomCode: value => String(value || ''), roomDisplayName: () => 'Grind Outpost', register() {}, $: id => id === 'games-frame' ? frame : null,
    showToast: toast => events.push(['toast', toast.title]), syncMyRoomActivityPresence: async () => {},
    ROOM_ACTIVITY_BOPL_ROYALE: 'bopl-royale', ROOM_ACTIVITY_MERGE_PARTY: 'merge-party',
    ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION: 2, ROOM_ACTIVITY_CLAIM_LEASE_MS: 60000, ROOM_ACTIVITY_CLAIM_HEARTBEAT_MS: 15000, ROOM_ACTIVITY_LEGACY_STALE_MS: 120000
  };
  const f = { App, read, write, timers, disconnects, events, frame, game };
  const window = f.window = { setInterval: fn => { const id = ++timer; timers.set(id, fn); return id; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../activity-modules/room-games.js'), 'utf8'), { ChatApp: App, window, console, clearInterval: id => timers.delete(id), setTimeout, clearTimeout, Date, Math });
  App.makeRoomActivityClaimToken = () => `token-${++sequence}`;
  App.closeGamesStage = async () => { events.push(['close', App.currentUser.code]); await App.releaseRoomActivityClaim(kind); App.selectedGame = null; };
  App.openBoplRoyaleActivity = async roomId => { events.push(['open', App.currentUser.code, roomId]); App.selectedGame = { ...game }; await App.claimRoomActivity({ activityId: kind, roomId, title: 'Game' }); };
  f.claim = () => App.claimRoomActivity({ activityId: kind, roomId: 'room', title: 'Game' });
  return f;
}

test('room display name changes update active games without changing multiplayer keys or writing data', () => {
  const f = fixture('bopl-royale'), changes = [];
  const bopl = f.window.__boplRoyaleLaunchConfig = { roomId: 'room', roomName: 'Old label' };
  const merge = f.window.__mergePartyLaunchConfig = { roomId: 'elsewhere', roomName: 'Other room' };
  f.frame.contentWindow.__boplRoyale.updateRoomDisplayName = name => changes.push(name);
  f.App.db.ref = () => { throw new Error('A display update must reuse cached metadata'); };
  f.App.syncRoomActivityDisplayName('room');
  assert.equal(bopl.roomName, 'Grind Outpost'); assert.equal(bopl.roomId, 'room');
  assert.equal(merge.roomName, 'Other room');
  assert.deepEqual(changes, ['Grind Outpost']);
  f.App.selectedGame = { ...f.game, roomActivityRoomId: 'elsewhere' };
  f.App.syncRoomActivityDisplayName('room');
  assert.deepEqual(changes, ['Grind Outpost'], 'An unrelated active frame is not renamed');
  assert.equal(f.timers.size, 0, 'No polling timer is required');
});
test('password change releases old claim and reclaims current activity without resetting its iframe', async () => {
  const f = fixture(); assert.equal(await f.claim(), true); const token = f.App.roomActivityClaimToken;
  const snapshot = await f.App.suspendRoomActivityForPasswordChange();
  assert.equal(f.read('activities/roomActivityClaims/old-password'), null); assert.equal(f.timers.size, 0);
  assert.equal(await f.App.renewRoomActivityClaim(token, 'merge-party', 'room', 'Game'), false);
  f.App.currentUser.code = 'new-password';
  assert.equal(await f.App.resumeRoomActivityAfterPasswordChange(snapshot), true);
  assert.equal(f.App.selectedGame, f.game); assert.equal(f.App.roomActivityClaimRef.path, 'activities/roomActivityClaims/new-password');
  assert.equal(f.timers.size, 1); assert.deepEqual(f.events, [['rebind', 'new-password']]);
  assert.ok([...f.disconnects].every(path => path.includes('/new-password/')));
});
test('suspension drains a pending renewal and a failed password update can resume under the old key', async () => {
  const f = fixture(); await f.claim(); let release;
  f.gate = new Promise(resolve => { release = resolve; });
  const renewal = f.App.renewRoomActivityClaim(f.App.roomActivityClaimToken, 'merge-party', 'room', 'Game');
  const suspension = f.App.suspendRoomActivityForPasswordChange();
  assert.equal(f.timers.size, 0); release(); assert.equal(await renewal, false);
  const snapshot = await suspension; await f.App.resumeRoomActivityAfterPasswordChange(snapshot);
  assert.equal(f.App.roomActivityClaimRef.path, 'activities/roomActivityClaims/old-password'); assert.equal(f.timers.size, 1);
});
test('online Bopl closes the old network frame and reconnects in the same room under the new password', async () => {
  const f = fixture('bopl-royale'); await f.claim(); const snapshot = await f.App.suspendRoomActivityForPasswordChange();
  assert.deepEqual(f.events, [['close', 'old-password']]); assert.equal(f.read('activities/roomActivityClaims/old-password'), null);
  f.App.currentUser.code = 'new-password'; await f.App.resumeRoomActivityAfterPasswordChange(snapshot);
  assert.deepEqual(f.events, [['close', 'old-password'], ['open', 'new-password', 'room'], ['reconnect', 'new-password']]);
  assert.equal(f.App.roomActivityClaimRef.path, 'activities/roomActivityClaims/new-password');
});
test('Bopl reconnect waits until the replacement iframe has loaded its new identity', async () => {
  const f = fixture('bopl-royale'); await f.claim(); const snapshot = await f.App.suspendRoomActivityForPasswordChange();
  f.App.currentUser.code = 'new-password'; const controller = f.frame.contentWindow.__boplRoyale;
  let loaded; f.frame.addEventListener = (_type, callback) => { loaded = callback; }; f.frame.removeEventListener = () => {};
  f.App.openBoplRoyaleActivity = async () => { f.App.selectedGame = { ...f.game }; delete f.frame.contentWindow.__boplRoyale; };
  const resume = f.App.resumeRoomActivityAfterPasswordChange(snapshot); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.some(event => event[0] === 'reconnect'), false);
  f.frame.contentWindow.__boplRoyale = controller; loaded(); await resume;
  assert.deepEqual(f.events.at(-1), ['reconnect', 'new-password']);
});
