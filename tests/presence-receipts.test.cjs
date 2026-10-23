const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function setup() {
  const App = {register(){}, ROOM_IDLE_MS:300000, lastAppInputAt:Date.now(), currentUser:{code:'me'}, currentRoomId:'room'};
  const document = {hidden:false,hasFocus:()=>true};
  const ctx = vm.createContext({ChatApp:App,document,Date,setTimeout:()=>1,clearTimeout(){},setInterval:()=>2,clearInterval(){}});
  for (const name of ['app-presence','read-receipts']) vm.runInContext(fs.readFileSync(path.join(__dirname,`../js/chat/${name}.js`),'utf8'),ctx);
  return {App,document,ctx};
}

function liveProfiles() {
  const callbacks = new Map();
  const App = {
    register() {}, liveUserListeners: new Map(), liveUserCache: new Map(),
    db: { ref(path) { return { on(_event, callback) { callbacks.set(path, callback); }, off() {} }; } },
    ensureOwnedDisplayNameForUser: async () => null,
    defaultStickmanDataURL: () => '', normalizeTransformToRel: value => value,
    getUserHtmlActivity: () => null, normalizeAdminGhostRooms: () => ({}),
    renderOnlineIndicator() {}, renderCallMenu() {}, refreshMentionFormattingForRenderedMessages() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/profiles/avatars.js'), 'utf8'), {
    ChatApp: App, document: { querySelectorAll: () => [] }
  });
  App.refreshRenderedAvatarForUser = () => {};
  const emit = async (code, value) => {
    for (const field of App.PUBLIC_PROFILE_FIELDS) callbacks.get(`users/${code}/${field}`)?.({ val: () => value?.[field] ?? null });
    await Promise.resolve(); await Promise.resolve();
  };
  return { App, emit };
}

test('orphaned and malformed profiles never become generic users; valid username-only profiles recover', async () => {
  const { App, emit } = liveProfiles();
  App.ensureLiveUserListener('orphan');
  await emit('orphan', null);
  assert.equal(App.liveUserCache.get('orphan'), null);
  await emit('orphan', { calendarReminders: { note: true } });
  assert.equal(App.liveUserCache.get('orphan'), null, 'non-account records cannot produce User profiles');
  await emit('orphan', { username: 'Mira' });
  assert.equal(App.liveUserCache.get('orphan').username, 'Mira');
  assert.equal(App.liveUserCache.get('orphan').displayName, 'Mira', 'display name is optional');
  await emit('orphan', { username: 'User' });
  assert.equal(App.liveUserCache.get('orphan').username, 'User', 'a real account named User remains valid');
  await emit('orphan', null);
  assert.equal(App.liveUserCache.get('orphan'), null, 'deleted accounts evict cached identities');
});

test('profile reads render immediately without writing or waiting for name ownership', async () => {
  const { App, emit } = liveProfiles();
  let claims = 0;
  App.ensureOwnedDisplayNameForUser = () => { claims++; return new Promise(() => {}); };
  App.ensureLiveUserListener('peer');
  await emit('peer', { username: 'Old' });
  assert.equal(App.liveUserCache.get('peer').username, 'Old');
  await emit('peer', null);
  assert.equal(App.liveUserCache.get('peer'), null);
  await emit('peer', { username: 'New' });
  assert.equal(App.liveUserCache.get('peer').username, 'New');
  App.stopLiveUserListeners();
  await emit('peer', { username: 'Old' });
  assert.equal(App.liveUserCache.size, 0, 'logout invalidates pending listener work');
  assert.equal(claims, 0, 'reading profiles never mutates their names');
});

test('deleted own credentials end the session unless this tab is migrating its password', async () => {
  const {App,emit}=liveProfiles();
  let logouts=0;
  App.currentUser={code:'self'};
  App.logoutToLanding=async()=>{logouts++;};
  App.ensureLiveUserListener('self');
  App.passwordChangeInFlight=true;
  await emit('self',null);
  assert.equal(logouts,0);
  App.passwordChangeInFlight=false;
  await emit('self',null);
  assert.equal(logouts,1,'another tab cannot keep using the previous credential');
});

test('desktop focus and minimize events immediately change idle without confusing browser iframe focus', () => {
  const {App,document,ctx}=setup();
  document.hasFocus=()=>false;
  assert.equal(App.isAppIdleNow(),false,'web/touch browsers remain active while using an iframe');
  ctx.chatDesktopRings={version:1};
  assert.equal(App.isAppIdleNow(),true,'native fallback respects a background window');
  App.setDesktopPresenceFocus(true);
  assert.equal(App.isAppIdleNow(),false,'native focus wins over transient DOM focus');
  App.setDesktopPresenceFocus(false);
  assert.equal(App.isAppIdleNow(),true);
  App.lastAppInputAt=1;
  App.markAppInputActive();
  assert.equal(App.lastAppInputAt,1,'background mouse movement cannot clear desktop idle');
});

test('a lost local connection becomes offline immediately while another live device remains online', () => {
  const {App}=setup();
  App.renderOnlineIndicator=()=>{};
  App.appPresenceCache=new Map();
  App.appPresenceConnections={me:{own:{idle:false,updatedAt:Date.now()}}};
  App.appPresenceSession={code:'me',id:'own',connected:false,ready:false};
  App.refreshAppPresenceStatuses();
  assert.equal(App.appPresenceCache.get('me'),'offline');
  App.appPresenceConnections.me.phone={idle:false,updatedAt:Date.now()};
  App.refreshAppPresenceStatuses();
  assert.equal(App.appPresenceCache.get('me'),'online');
});

test('newest receipt cleanup is atomic, preserves current viewers, and rejects delayed older writes', async () => {
  const {App}=setup();
  let value={older:{alice:1},oldest:{bob:1},latest:{carol:3}};
  App.firebase={database:{ServerValue:{TIMESTAMP:4}}};
  App.db={ref(){return {async transaction(fn){const next=fn(value);if(next!==undefined)value=next;return {committed:next!==undefined};}};}};
  const message={_key:'latest',createdAt:30};
  await App.pruneReadReceipts('room',message);
  assert.deepEqual(Object.keys(value).sort(),['_latest','latest']);
  assert.equal(value.latest.carol,3);
  App.readReceiptState={room:'room',key:'latest',message}; App.currentUser={code:'dave'}; App.canSeeLatestMessage=()=>true;
  await App.saveLatestReadReceipt(App.readReceiptState,'dave');
  assert.equal(value.latest.dave,4);
  await App.pruneReadReceipts('room',{_key:'newest',createdAt:40});
  App.currentUser={code:'late'};
  const stale=await App.saveLatestReadReceipt(App.readReceiptState,'late');
  assert.equal(stale.committed,false);
  assert.deepEqual(Object.keys(value),['_latest']);
  assert.equal(value._latest.key,'newest');
});
test('presence aggregates independent tabs and devices; a focused session wins over idle',()=>{
  const {App}=setup();
  assert.equal(App.getAppPresenceStatus({}),'offline');
  const updatedAt=Date.now();
  assert.equal(App.getAppPresenceStatus({phone:{idle:true,updatedAt}}),'idle');
  assert.equal(App.getAppPresenceStatus({phone:{idle:true,updatedAt},desktop:{idle:false,updatedAt}}),'online');
  assert.equal(App.getAppPresenceStatus({desktop:{idle:false,updatedAt}}),'online');
});
test('idle follows activity and visibility even when a device reports no focus',()=>{
  const {App,document}=setup();
  App.currentRoomId=null; // Home, tools and settings retain presence.
  assert.equal(App.isAppIdleNow(),false);
  App.lastAppInputAt=Date.now()-300001;
  assert.equal(App.isAppIdleNow(),true);
  App.lastAppInputAt=Date.now(); document.hidden=true;
  assert.equal(App.isAppIdleNow(),true);
  document.hidden=false; document.hasFocus=()=>false;
  assert.equal(App.isAppIdleNow(),false);
});
test('stale and malformed sessions expire and server offset handles device clock skew',()=>{
  const {App}=setup();
  const now=Date.now();
  assert.equal(App.getAppPresenceStatus({ghost:{idle:false,updatedAt:now-App.APP_PRESENCE_TTL_MS}},now),'offline');
  assert.equal(App.getAppPresenceStatus({ghost:{idle:false},bad:{idle:false,updatedAt:'invalid'}},now),'offline');
  assert.equal(App.getAppPresenceStatus({ghost:{idle:false,updatedAt:now-3600000},phone:{idle:true,updatedAt:now}},now),'idle');
  App.appPresenceServerOffsetMs=-7200000;
  assert.equal(App.getAppPresenceStatus({phone:{idle:false,updatedAt:now-7200000}}),'online');
});

test('cached status expires without receiving another database event',()=>{
  const {App}=setup();
  App.appPresenceCache=new Map([['ghost','online'],['phone','online']]);
  App.appPresenceConnections={ghost:{tab:{idle:false,updatedAt:Date.now()-App.APP_PRESENCE_TTL_MS-1}},phone:{tab:{idle:false,updatedAt:Date.now()}}};
  let renders=0;
  App.renderOnlineIndicator=()=>renders++;
  App.refreshAppPresenceStatuses();
  assert.equal(App.appPresenceCache.get('ghost'),'offline');
  assert.equal(App.appPresenceCache.get('phone'),'online');
  assert.equal(renders,1);
  App.refreshAppPresenceStatuses();
  assert.equal(renders,1,'unchanged heartbeats do not rebuild the UI');
});

test('registration failures retry, reconnect republishes, and stopping one tab preserves another',async()=>{
  const {App}=setup();
  const writes=[];
  const records=new Map([['appPresence/me/other-tab',{idle:false,updatedAt:Date.now()}]]);
  let rejectCleanup=true;
  App.appPresenceCache=new Map(); App.appPresenceConnections={};
  App.renderOnlineIndicator=()=>{};
  App.firebase={database:{ServerValue:{TIMESTAMP:{'.sv':'timestamp'}}}};
  App.db={ref(path){return {
    on(){},off(){},
    set(value){writes.push(path);records.set(path,value);return Promise.resolve();},
    remove(){records.delete(path);return Promise.resolve();},
    onDisconnect(){return {remove(){return rejectCleanup?Promise.reject(new Error('temporary')):Promise.resolve();},cancel(){return Promise.resolve();}};}
  };}};
  const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
  App.startAppPresence();
  const session=App.appPresenceSession;
  session.connectionCb({val:()=>true});
  await settle();
  assert.equal(writes.length,0,'a failed cleanup registration cannot publish a ghost');
  rejectCleanup=false;
  App.pulseAppPresence();
  await settle();
  assert.equal(session.ready,true,'heartbeat retries the failed registration');
  assert.equal(writes.length,1);
  const ownPath=writes[0];
  session.connectionCb({val:()=>false});
  records.delete(ownPath);
  App.pulseAppPresence();
  await settle();
  assert.equal(writes.length,1,'no heartbeat writes queue while disconnected');
  session.connectionCb({val:()=>true});
  await settle();
  assert.equal(records.has(ownPath),true,'reconnecting publishes again after arming cleanup');
  App.stopAppPresence();
  await settle();
  assert.equal(records.has(ownPath),false);
  assert.equal(records.has('appPresence/me/other-tab'),true,'one tab never removes another tab or device');
});

test('logout during an in-flight presence write cannot resurrect that session',async()=>{
  const {App}=setup();
  let finishWrite;
  let present=false;
  const ref={
    set(){return new Promise(resolve=>{finishWrite=()=>{present=true;resolve();};});},
    remove(){present=false;return Promise.resolve();},
    onDisconnect(){return {cancel(){return Promise.resolve();}};}
  };
  App.firebase={database:{ServerValue:{TIMESTAMP:1}}};
  App.appPresenceSession={code:'me',ready:true,connected:true,ref,generation:1};
  const pending=App.writeAppPresence();
  App.stopAppPresence();
  finishWrite();
  await pending;
  assert.equal(present,false);
});

test('seen viewers exclude the author for every viewer, include recipients, and respect ghost privacy',()=>{
  const {App}=setup();
  App.isGhostModeEnabledForRoom=(_,code)=>code==='ghost';
  assert.deepEqual(Array.from(App.getReceiptViewerCodes({me:1,alice:1,ghost:1},'me')),['alice']);
  assert.deepEqual(Array.from(App.getReceiptViewerCodes({me:1,alice:1,ghost:1},'alice')),['me']);
  App.currentUser={code:'bob'};
  assert.deepEqual(Array.from(App.getReceiptViewerCodes({me:1,alice:1,ghost:1},'alice')),['me']);
  App.currentUser=null;
  assert.deepEqual(Array.from(App.getReceiptViewerCodes({me:1,alice:1},'alice')),['me']);
  assert.deepEqual(Array.from(App.getReceiptViewerCodes({},'me')),[]);
});
test('latest receipt owner follows chronology, including a pending newest message',()=>{
  const {App}=setup();
  App.compareMessagesChronologically=(a,b)=>a.createdAt-b.createdAt || a._key.localeCompare(b._key);
  App.msgDataByKey=new Map([['b',{createdAt:2}],['a',{createdAt:1}],['c',{createdAt:2}]]);
  assert.equal(App.getLatestReceiptMessage()._key,'c');
  App.msgDataByKey.set('pending',{createdAt:3,__stub:true});
  assert.equal(App.getLatestReceiptMessage()._key,'pending');
  App.msgDataByKey.clear(); assert.equal(App.getLatestReceiptMessage(),null);
});

test('repeated app focus pulses write changes once and renew only the timestamp', async () => {
  const {App}=setup(), writes=[];
  App.firebase={database:{ServerValue:{TIMESTAMP:1}}};
  App.myRoomIdle=false;
  const session={code:'me',ready:true,connected:true,generation:1,ref:{
    set:async value=>writes.push({kind:'set',value}),
    update:async value=>writes.push({kind:'update',value}), remove:async()=>{}
  }};
  App.appPresenceSession=session;
  await App.writeAppPresence();
  await App.writeAppPresence();
  await App.writeAppPresence();
  assert.equal(writes.length,1,'unchanged input/focus events produce no database writes');
  session.lastWriteAt=Date.now()-App.APP_PRESENCE_HEARTBEAT_MS-1;
  await App.writeAppPresence();
  assert.equal(writes[1].kind,'update');
  assert.deepEqual(Object.keys(writes[1].value),['updatedAt']);
  App.myRoomIdle=true; await App.writeAppPresence();
  assert.equal(writes[2].value.idle,true,'idle transitions still publish immediately');
  session.connected=false; await App.writeAppPresence();
  assert.equal(writes.length,3,'offline heartbeats do not build a write backlog');
});

test('schedule leases arm once per connection, dedupe navigation, and recover after disconnect', async () => {
  const writes=[], callbacks=new Map(), arms=[];
  const App={register(_name,init){this.init=init;},currentUser:{code:'me'},CLIENT_INSTANCE_ID:'tab',
    firebase:{database:{ServerValue:{TIMESTAMP:1}}},sleep:()=>new Promise(()=>{}),
    db:{ref(path){return {toString:()=>path,on(_event,cb){callbacks.set(path,cb);},off(){},
      onDisconnect:()=>({remove:async()=>arms.push(path),cancel:async()=>{}}),
      set:async value=>writes.push({kind:'set',path,value}),update:async value=>writes.push({kind:'update',path,value}),remove:async()=>writes.push({kind:'remove',path})};}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/schedules/presence.js'),'utf8'),{
    ChatApp:App,window:{addEventListener(){}},setInterval:()=>1,clearInterval(){},Date
  });
  App.init();
  const drain=()=>new Promise(resolve=>setImmediate(resolve));
  await App.syncMySchedulePresence(true);
  assert.equal(writes.length,0,'no writes before the connection is established');
  callbacks.get('.info/connected')({val:()=>true}); await drain();
  await App.syncMySchedulePresence(true); await App.writeMySchedulePresence();
  assert.equal(arms.length,1); assert.equal(writes.length,1);
  App.mySchedulePresenceConnectionState.lastWriteAt=Date.now()-45001;
  await App.writeMySchedulePresence();
  assert.equal(arms.length,1,'heartbeats reuse the acknowledged cleanup registration');
  assert.equal(writes[1].kind,'update'); assert.deepEqual(Object.keys(writes[1].value),['updatedAt']);
  callbacks.get('.info/connected')({val:()=>false}); await App.writeMySchedulePresence();
  assert.equal(writes.length,2);
  callbacks.get('.info/connected')({val:()=>true}); await drain();
  assert.equal(arms.length,2); assert.equal(writes[2].kind,'set','reconnect rebuilds the removed record');
  await App.syncMySchedulePresence(false); assert.equal(writes.at(-1).kind,'remove');
});

test('a delayed room presence acknowledgement cannot remove a newer visit to the same room', async () => {
  const values=new Map(); let finishOldWrite,sets=0,id=0;
  const App={register(){},currentUser:{code:'me',username:'Me'},sanitizeRoomCode:String,
    startAppPresence(){},syncAppIdle(){},scheduleRoomIdleCheck(){},isGhostModeEnabledForRoom:()=>false,getCurrentRoomActivityPayload:()=>null,
    firebase:{database:{ServerValue:{TIMESTAMP:1}}},db:{ref(path){return {
      on(_event,cb){queueMicrotask(()=>cb({val:()=>true}));},off(){},onDisconnect:()=>({remove:async()=>{}}),
      set(value){values.set(path,value);return ++sets===1?new Promise(resolve=>{finishOldWrite=resolve;}):Promise.resolve();},
      transaction:async update=>{const next=update(values.get(path));if(next!==undefined){if(next===null)values.delete(path);else values.set(path,next);}},
      remove:async()=>values.delete(path)
    };}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/chat/presence.js'),'utf8'),{
    ChatApp:App,document:{hidden:false},crypto:{randomUUID:()=>`visit-${++id}`},clearTimeout(){},queueMicrotask
  });
  const drain=()=>new Promise(resolve=>setImmediate(resolve));
  App.startRoomPresence('room');await drain();
  App.startRoomPresence('room');await drain();
  const current=values.get('rooms/room/online/me').sessionId;
  finishOldWrite();await drain();
  assert.equal(values.get('rooms/room/online/me').sessionId,current);
  App.stopRoomPresence();await drain();
  assert.equal(values.has('rooms/room/online/me'),false);
});


test('live identity resolution refreshes old room previews without changing saved message snapshots', async () => {
  const { App, emit } = liveProfiles();
  const message={userCode:'peer',username:'Before',displayName:'Before',text:'hello'};
  const updated=[];
  App.roomsMetaCache=new Map([['room',{name:'Room',lastMessagePreview:'Before: hello'}]]);
  App.notificationRoomTails=new Map([['room',new Map([['message',message]])]]);
  App.updateRoomListItem=id=>updated.push(id);
  App.ensureLiveUserListener('peer');await emit('peer',{username:'AfterUsername',displayName:'After Name'});
  assert.equal(App.getUserDisplayName('peer',message),'After Name');assert.equal(App.getUserIdentity('peer',message).username,'AfterUsername');assert.ok(updated.includes('room'));
  assert.equal(message.displayName,'Before','History snapshots stay intact; current profile is canonical');
  await emit('peer',{username:'NewUsernameOnly'});assert.equal(App.getUserDisplayName('peer',message),'NewUsernameOnly','A current username wins over a stale display name');
});
