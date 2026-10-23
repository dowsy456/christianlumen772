'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const member = (code, extra = {}) => ({ code, sessionId:`session-${code}`, connected:true, ...extra });
function setup() {
  const sounds = [];
  const App = { register() {}, currentUser:{ code:'self' }, currentCallRoomId:'one', callSessionId:'self-session', playNotificationSound: name => sounds.push(name) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../js/calling/notification-sounds.js'),'utf8'), { ChatApp:App });
  return { App, sounds };
}
test('successful self join sounds once with quiet existing roster; failed or cancelled joins never activate sounds', () => {
  const { App, sounds } = setup();
  App.callObserveNotificationMembers('one', [member('existing')]);
  App.callStartNotificationSession('wrong', 'self-session', []);
  App.callStartNotificationSession('one', 'cancelled-session', []);
  App.callStopNotificationSession('one', 'self-session');
  assert.deepEqual(sounds, []);
  App.callStartNotificationSession('one', 'self-session', [member('self'),member('existing')]);
  App.callStartNotificationSession('one', 'self-session', [member('self'),member('existing')]);
  App.callObserveNotificationMembers('one', [member('self'),member('existing')]);
  assert.deepEqual(sounds, ['JoinCall']);
  App.callStopNotificationSession('one', 'self-session');
  App.callStopNotificationSession('one', 'self-session');
  App.callObserveNotificationMembers('one', []);
  assert.deepEqual(sounds, ['JoinCall','LeaveCall']);
});
test('only actual participant additions/removals sound; metadata, reconnect grace and ringing ghosts are silent', () => {
  const { App, sounds } = setup();
  App.callStartNotificationSession('one','self-session',[member('peer')]);
  App.callObserveNotificationMembers('one',[member('peer',{muted:true,speaking:true,updatedAt:1000})]);
  App.callObserveNotificationMembers('one',[member('peer',{connected:false,disconnectedAt:1001})]);
  App.callObserveNotificationMembers('one',[member('peer',{connected:true,sessionId:'replacement-peer'})]);
  App.callObserveNotificationMembers('one',[member('peer'),{code:'ring-target'},member('ring-card',{ringing:true}),member('pending',{joinConfirmed:false})]);
  assert.deepEqual(sounds,['JoinCall']);
  App.callObserveNotificationMembers('one',[member('peer'),member('pending',{joinConfirmed:true})]);
  App.callObserveNotificationMembers('one',[member('pending')]);
  assert.deepEqual(sounds,['JoinCall','JoinCall','LeaveCall']);
});
test('local disconnect freezes sounds and reconnect silently rebases before tracking later changes', () => {
  const { App, sounds } = setup();
  App.callStartNotificationSession('one','self-session',[member('old')]);
  App.callSetNotificationConnectionState('one','self-session',false);
  App.callObserveNotificationMembers('one',[],{expiry:true});
  App.callObserveNotificationMembers('one',[member('during-outage')]);
  App.callSetNotificationConnectionState('one','self-session',true);
  App.callObserveNotificationMembers('one',[],{expiry:true});
  App.callObserveNotificationMembers('one',[member('during-outage')]);
  assert.deepEqual(sounds,['JoinCall']);
  App.callObserveNotificationMembers('one',[member('during-outage'),member('new')]);
  App.callObserveNotificationMembers('one',[member('new')]);
  assert.deepEqual(sounds,['JoinCall','JoinCall','LeaveCall']);
});
test('viewing another room keeps current call sounds; switching calls resets baseline and ignores stale callbacks', () => {
  const { App, sounds } = setup();
  App.callStartNotificationSession('one','self-session',[member('peer')]);
  App.currentRoomId = 'two';
  App.callObserveNotificationMembers('two',[member('unrelated')]);
  App.callObserveNotificationMembers('one',[member('peer'),member('friend')]);
  App.callStopNotificationSession('one','self-session');
  App.currentCallRoomId = 'two'; App.callSessionId = 'new-self-session';
  App.callStartNotificationSession('two','new-self-session',[member('unrelated')]);
  App.callSetNotificationConnectionState('one','self-session',false);
  App.callStopNotificationSession('one','self-session');
  App.callObserveNotificationMembers('one',[]);
  App.callObserveNotificationMembers('two',[member('unrelated')]);
  assert.deepEqual(sounds,['JoinCall','JoinCall','LeaveCall','JoinCall']);
  App.callObserveNotificationMembers('two',[]);
  assert.deepEqual(sounds,['JoinCall','JoinCall','LeaveCall','JoinCall','LeaveCall']);
});

for (const camera of [false, true]) test(`${camera ? 'camera' : 'screen'} effects reach the call; watching effects reach the sharer and other current watchers only`, () => {
  const codes = ['owner', 'alice', 'bob', 'outside'];
  const clients = codes.map(code => {
    const client = setup();
    client.App.currentUser.code = code;
    client.App.callSessionId = `session-${code}`;
    return client;
  });
  let roster = codes.map(code => member(code));
  for (const { App, sounds } of clients) {
    App.callStartNotificationSession('one', App.callSessionId, roster);
    sounds.length = 0;
  }
  const publish = () => clients.forEach(({ App }) => App.callObserveNotificationMembers('one', roster));
  const effect = expected => {
    clients.forEach(({ sounds }, index) => { assert.deepEqual(sounds, expected[index], codes[index]); sounds.length = 0; });
  };
  const key = camera ? 'camera:owner' : 'owner';
  const shareFields = enabled => camera ? { cameraSharing: enabled, cameraShareId: enabled ? 'media-one' : '' } : { sharing: enabled, shareId: enabled ? 'media-one' : '' };
  roster = roster.map(item => item.code === 'owner' ? { ...item, ...shareFields(true) } : item);
  publish(); publish();
  effect(codes.map(() => ['StartScreen']));
  const watch = (code, enabled) => {
    roster = roster.map(item => item.code === code ? { ...item, viewingSharesSessionId: item.sessionId, viewingShares: enabled ? { [key]: 'media-one' } : {} } : item);
    publish(); publish();
  };
  watch('alice', true);
  effect([['StartWatching'], [], [], []]);
  watch('bob', true);
  effect([['StartWatching'], ['StartWatching'], [], []]);
  watch('alice', false);
  effect([['StopWatching'], [], ['StopWatching'], []]);
  roster = roster.map(item => item.code === 'owner' ? { ...item, ...shareFields(false) } : item);
  publish();
  effect(codes.map(() => ['EndScreen']));
});

for (const camera of [false, true]) test(`pre-existing ${camera ? 'cameras' : 'screens'} and reconnect snapshots are silent; replacing a share ends its old generation`, () => {
  const { App, sounds } = setup();
  const old = member('owner', camera ? { cameraSharing: true, cameraShareId: 'old' } : { sharing: true, shareId: 'old' });
  App.callStartNotificationSession('one', 'self-session', [member('self'), old]);
  sounds.length = 0;
  App.callObserveNotificationMembers('one', [member('self'), old]);
  assert.deepEqual(sounds, []);
  App.callObserveNotificationMembers('one', [member('self'), { ...old, [camera ? 'cameraShareId' : 'shareId']: 'new' }]);
  assert.deepEqual(sounds, ['EndScreen', 'StartScreen']);
  sounds.length = 0;
  App.callSetNotificationConnectionState('one', 'self-session', false);
  App.callObserveNotificationMembers('one', []);
  App.callSetNotificationConnectionState('one', 'self-session', true);
  App.callObserveNotificationMembers('one', [member('self'), old]);
  assert.deepEqual(sounds, []);
});

for (const camera of [false, true]) test(`local ${camera ? 'camera' : 'screen'} capture effects deduplicate realtime echoes and stop remains audible during leave`, () => {
  const { App, sounds } = setup();
  const self = member('self', { sessionId: 'self-session' });
  App.callStartNotificationSession('one', 'self-session', [self]);
  sounds.length = 0;
  const notify = camera ? App.callNotifyLocalCameraState : App.callNotifyLocalScreenState;
  notify('one', 'self-session', 'local-media');
  App.callObserveNotificationMembers('one', [{ ...self, ...(camera ? { cameraSharing: true, cameraShareId: 'local-media' } : { sharing: true, shareId: 'local-media' }) }]);
  assert.deepEqual(sounds, ['StartScreen']);
  App.callLeavePending = true;
  notify('one', 'self-session', '');
  App.callStopNotificationSession('one', 'self-session');
  assert.deepEqual(sounds, ['StartScreen', 'EndScreen', 'LeaveCall']);
  notify('one', 'self-session', 'stale-media');
  assert.equal(sounds.length, 3);
});

test('simultaneous screens and cameras keep separate viewers and end events', () => {
  const { App, sounds } = setup();
  const owner = member('self', { sessionId: 'self-session', sharing: true, shareId: 'screen', cameraSharing: true, cameraShareId: 'camera' });
  const viewer = member('viewer', { viewingSharesSessionId: 'session-viewer' });
  App.callStartNotificationSession('one', 'self-session', [owner, viewer]);
  sounds.length = 0;
  App.callObserveNotificationMembers('one', [owner, { ...viewer, viewingShares: { self: 'screen' } }]);
  assert.deepEqual(sounds, ['StartWatching']);
  sounds.length = 0;
  App.callObserveNotificationMembers('one', [owner, { ...viewer, viewingShares: { self: 'screen', 'camera:self': 'camera' } }]);
  assert.deepEqual(sounds, ['StartWatching']);
  sounds.length = 0;
  App.callNotifyLocalCameraState('one', 'self-session', 'camera');
  App.callNotifyLocalScreenState('one', 'self-session', 'screen');
  assert.deepEqual(sounds, [], 'late capture confirmation preserves already-published viewers');
  App.callNotifyLocalCameraState('one', 'self-session', '');
  assert.deepEqual(sounds, ['EndScreen'], 'stopping camera does not end the screen');
  sounds.length = 0;
  App.callObserveNotificationMembers('one', [owner, viewer]);
  assert.deepEqual(sounds, ['StopWatching'], 'stale camera echo is ignored while the screen remains active');
  App.callNotifyLocalScreenState('one', 'self-session', '');
  assert.deepEqual(sounds, ['StopWatching', 'EndScreen']);
});

test('camera watcher cues ignore old generations, old sessions, owners and disconnected viewers', () => {
  const { App, sounds } = setup();
  const owner = member('self', { sessionId: 'self-session', cameraSharing: true, cameraShareId: 'camera' });
  App.callStartNotificationSession('one', 'self-session', [owner]);
  sounds.length = 0;
  const invalid = [
    { ...owner, viewingSharesSessionId: 'self-session', viewingShares: { 'camera:self': 'camera' } },
    member('old-generation', { viewingSharesSessionId: 'session-old-generation', viewingShares: { 'camera:self': 'old-camera' } }),
    member('old-session', { viewingSharesSessionId: 'previous-session', viewingShares: { 'camera:self': 'camera' } }),
    member('offline', { connected: false, viewingSharesSessionId: 'session-offline', viewingShares: { 'camera:self': 'camera' } })
  ];
  App.callObserveNotificationMembers('one', invalid);
  assert.deepEqual(sounds, ['JoinCall', 'JoinCall', 'JoinCall'], 'only participant changes sound');
  sounds.length = 0;
  App.callObserveNotificationMembers('one', invalid.map(item => item.code === 'old-generation' ? { ...item, viewingShares: { 'camera:self': 'camera' } } : item));
  assert.deepEqual(sounds, ['StartWatching']);
});
