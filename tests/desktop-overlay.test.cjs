'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ desktop = true, storage = new Map() } = {}) {
  const initializers = new Map(), snapshots = [];
  const button = { hidden: true, dataset: {}, attributes: {}, listeners: {}, classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(key, callback) { this.listeners[key] = callback; } };
  const App = {
    register: (id, initialize) => initializers.set(id, initialize), $: () => button,
    currentUser: { code: 'self' }, currentCallRoomId: 'room', callSessionId: 'session',
    callMembersCache: [], liveUserCache: new Map(), defaultStickmanDataURL: () => 'data:image/svg+xml,default',
  };
  const context = vm.createContext({ ChatApp: App, localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
  }, console });
  if (desktop) context.chatDesktopOverlay = { version: 1, publish: snapshot => snapshots.push(JSON.parse(JSON.stringify(snapshot))) };
  for (const file of ['profiles/photo-editor', '../call-modules/panel', 'calling/desktop-overlay']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', file + '.js'), 'utf8'), context);
  }
  initializers.get('calling/desktop-overlay')();
  return { App, snapshots, button, context, storage };
}

test('ordinary web clients never expose or publish a call overlay', () => {
  const { App, button, snapshots, storage } = harness({ desktop: false });
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  App.callToggleDesktopOverlay();
  App.callSyncDesktopOverlay();
  assert.equal(button.hidden, true);
  assert.equal(button.listeners.click, undefined);
  assert.equal(snapshots.length, 0);
  assert.equal(storage.size, 0);
});

test('capable native clients receive photos once and small speaking deltas until the session changes', () => {
  const { App, context, snapshots } = harness();
  context.chatDesktopOverlay.deltaPhotos = true;
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  const first = snapshots.at(-1);
  assert.ok(first.members[0].photoDataURL);
  App.callVadSpeaking = true; App.callPublishDesktopOverlay();
  const delta = snapshots.at(-1);
  assert.equal(delta.members[0].reusePhoto, true);
  assert.equal(delta.members[0].photoDataURL, undefined);
  App.callSessionId = 'next'; App.callPublishDesktopOverlay();
  assert.ok(snapshots.at(-1).members[0].photoDataURL);
});

test('every join enables the overlay, including rejoining the same live call after disabling it', () => {
  const storage = new Map([['chatapp_desktop_overlay_calls_v1', JSON.stringify([[JSON.stringify(['room', 'first', 'self']), false]])]]);
  const { App } = harness({ storage });
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(App.callDesktopOverlayEnabled, true);
  App.callToggleDesktopOverlay();
  assert.equal(App.callDesktopOverlayEnabled, false);
  App.callClearDesktopOverlayScope();
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(App.callDesktopOverlayEnabled, true, 'rejoining enables the overlay by default');
  App.callToggleDesktopOverlay();
  const reloaded = harness({ storage }).App;
  reloaded.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(reloaded.callDesktopOverlayEnabled, true, 'reloading and joining enables the overlay');
  reloaded.currentUser = { code: 'other-user' };
  reloaded.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(reloaded.callDesktopOverlayEnabled, true);
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'second' });
  assert.equal(App.callDesktopOverlayEnabled, true, 'everyone leaving creates a new call instance');
  App.currentCallRoomId = 'other-room';
  App.callLoadDesktopOverlayPreferences('other-room', { instanceId: 'first' });
  assert.equal(App.callDesktopOverlayEnabled, true, 'a different room has independent preferences');
});

test('signaling reconnects cannot blank the roster while the local call is still joined', () => {
  const { App } = harness();
  App.currentUser.displayName = 'Local participant';
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(App.callDesktopOverlaySnapshot().members[0].displayName, 'Local participant');
  App.callMembersCache = [{ code: 'self', displayName: 'Local participant', connected: false }, { code: 'left', connected: false }];
  assert.deepEqual(Array.from(App.callDesktopOverlaySnapshot().members, member => member.code), ['self']);
  App.callLeavePending = true;
  assert.equal(App.callDesktopOverlaySnapshot().members.length, 0, 'actual leave still clears immediately');
});

test('live names sort alphabetically, avatars retain normalized crop, and muted or deafened users cannot speak', () => {
  const { App, snapshots } = harness();
  App.callMembersCache = [
    { code: 'z', displayName: 'Zoe', speaking: true },
    { code: 'self', displayName: 'Self', speaking: false },
    { code: 'b', displayName: 'Beth', muted: true, speaking: true },
    { code: 'c', displayName: 'Chris', deafened: true, speaking: true },
    { code: 'gone', displayName: 'Absent', connected: false },
  ];
  App.liveUserCache.set('z', { displayName: 'Aaron', photoDataURL: 'data:image/png,new', photoTransform: { x: 21, y: -42, scale: 2 } });
  App.callVadSpeaking = true;
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  const state = snapshots.at(-1);
  assert.deepEqual(state.members.map(member => member.displayName), ['Aaron', 'Beth', 'Chris', 'Self']);
  assert.deepEqual(state.members[0].photoTransform, { unit: 'rel', x: 0.25, y: -0.5, scale: 2 });
  assert.equal(state.members[0].photoDataURL, 'data:image/png,new');
  assert.deepEqual(state.members.map(member => member.speaking), [true, false, false, true]);
});

test('join, leave, and mismatched user or room scopes cannot publish a stale overlay', () => {
  const { App, snapshots, button } = harness();
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(snapshots.at(-1).active, true);
  App.callJoinPending = true;
  App.callSyncDesktopOverlay();
  assert.equal(button.disabled, true);
  assert.equal(snapshots.at(-1).active, false);
  App.callToggleDesktopOverlay();
  assert.equal(App.callDesktopOverlayEnabled, true);
  App.callJoinPending = false;
  App.callLeavePending = true;
  App.callSyncDesktopOverlay();
  assert.equal(snapshots.at(-1).active, false);
  App.callLeavePending = false;
  App.currentCallRoomId = 'different';
  App.callSyncDesktopOverlay();
  assert.equal(snapshots.at(-1).active, false);
  App.currentCallRoomId = 'room';
  App.currentUser = { code: 'different' };
  App.callSyncDesktopOverlay();
  assert.equal(snapshots.at(-1).active, false);
  App.currentCallRoomId = null;
  App.callSyncDesktopOverlay();
  assert.equal(button.hidden, true);
});

test('presence publishes only when changed and a failed native publish is retried without affecting calls', () => {
  const { App, context, snapshots } = harness();
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  const count = snapshots.length;
  App.callPublishDesktopOverlay();
  App.callSyncDesktopOverlay();
  assert.equal(snapshots.length, count);
  App.callMembersCache = [{ code: 'self', displayName: 'Self' }];
  const publish = context.chatDesktopOverlay.publish;
  context.chatDesktopOverlay.publish = () => { throw new Error('Window closed'); };
  assert.doesNotThrow(() => App.callPublishDesktopOverlay());
  context.chatDesktopOverlay.publish = publish;
  App.callPublishDesktopOverlay();
  assert.equal(snapshots.length, count + 1);
});

test('overlay toggles work without storage and a new join resets to enabled', () => {
  const { App, context } = harness();
  context.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.doesNotThrow(() => App.callToggleDesktopOverlay());
  assert.equal(App.callDesktopOverlayEnabled, false);
  App.callClearDesktopOverlayScope();
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  assert.equal(App.callDesktopOverlayEnabled, true);
});

test('live share/viewer flags and local audio controls publish independently of the call menu', () => {
  const { App, snapshots } = harness();
  App.callMenuOpen = false;
  App.callSharing = true;
  App.callMembersCache = [{ code: 'self', sharing: false }, { code: 'remote', sharing: true }, { code: 'other' }];
  App.callGetShareViewerUsers = () => [{ code: 'remote' }];
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  let byCode = new Map(snapshots.at(-1).members.map(member => [member.code, member]));
  assert.equal(byCode.get('remote').watchingYourScreen, true);
  assert.equal(byCode.get('remote').sharing, true);
  assert.equal(byCode.get('self').sharing, true, 'self uses immediate local share state');
  assert.equal(byCode.get('other').watchingYourScreen, false);
  App.callSharing = false;
  App.callMuted = true;
  App.callPublishDesktopOverlay();
  const state = snapshots.at(-1);
  byCode = new Map(state.members.map(member => [member.code, member]));
  assert.equal(byCode.get('remote').watchingYourScreen, false, 'stopping share clears cached viewer eyes');
  assert.equal(byCode.get('self').sharing, false);
  assert.equal(state.controls.muted, true);
  assert.equal(state.sessionId, 'session');
});

test('thumbnail commands reuse call handlers and reject stale or pending sessions', () => {
  const { App } = harness();
  const actions = [];
  App.callToggleMute = () => actions.push('mute');
  App.callToggleDeafen = () => actions.push('deafen');
  App.callToggleShareScreen = () => actions.push('share');
  App.callToggleCamera = () => actions.push('camera');
  App.leaveCall = () => actions.push('leave');
  App.callLoadDesktopOverlayPreferences('room', { instanceId: 'first' });
  const command = { roomId: 'room', sessionId: 'session' };
  for (const action of ['mute', 'deafen', 'share', 'camera', 'overlay', 'leave']) App.callHandleDesktopCommand({ ...command, action });
  assert.deepEqual(actions, ['mute', 'deafen', 'share', 'camera', 'leave']);
  assert.equal(App.callDesktopOverlayEnabled, false);
  App.callHandleDesktopCommand({ ...command, sessionId: 'old-session', action: 'leave' });
  App.callHandleDesktopCommand({ ...command, roomId: 'other-room', action: 'leave' });
  App.callJoinPending = true;
  App.callHandleDesktopCommand({ ...command, action: 'leave' });
  App.callJoinPending = false;
  App.callLeavePending = true;
  App.callHandleDesktopCommand({ ...command, action: 'leave' });
  assert.deepEqual(actions, ['mute', 'deafen', 'share', 'camera', 'leave']);
});


test('camera indicators preserve original avatar pixels and crop in every desktop shell',()=>{
  const {App,context}=harness();
  App.callCameraSharing=true;
  App.callCameraKey=code=>'camera:'+code;
  App.currentUser.photoDataURL='data:image/png,original';
  App.currentUser.photoTransform={unit:'rel',x:0.2,y:-0.1,scale:1.5};
  App.callLoadDesktopOverlayPreferences('room',{instanceId:'first'});
  for(const support of [false,true]){
    context.chatDesktopOverlay.cameraIndicators=support;
    const self=App.callDesktopOverlaySnapshot().members.find(member=>member.code==='self');
    assert.equal(self.cameraSharing,true);
    assert.equal(self.photoDataURL,'data:image/png,original');
    assert.deepEqual({...self.photoTransform},{unit:'rel',x:0.2,y:-0.1,scale:1.5});
  }
});

test('screen and camera overlay indicators coexist with all other call states', () => {
  const { App, snapshots } = harness();
  App.callMenuOpen = false;
  App.callSharing = App.callCameraSharing = App.callMuted = App.callDeafened = true;
  App.callCameraKey = code => 'camera:' + code;
  App.callMembersCache = [{ code:'self', sharing:false, cameraSharing:false }, { code:'remote', sharing:true, cameraSharing:true, muted:true, deafened:true }];
  App.callGetShareViewerUsers = () => [{code:'remote'}];
  App.callLoadDesktopOverlayPreferences('room', {instanceId:'all-indicators'});
  const rows = new Map(snapshots.at(-1).members.map(member => [member.code, member]));
  for (const key of ['muted','deafened','sharing','cameraSharing']) assert.equal(rows.get('self')[key], true, `Immediate local ${key} is authoritative`);
  for (const key of ['muted','deafened','sharing','cameraSharing','watchingYourScreen','watchingYourCamera']) assert.equal(rows.get('remote')[key], true, `${key} coexists with screen and camera`);
  App.callSharing = false; App.callPublishDesktopOverlay();
  assert.equal(snapshots.at(-1).members.find(member => member.code === 'self').cameraSharing, true, 'Stopping screen does not hide the camera indicator');
});
