const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');

function nativeUpdateModel(globals={}) {
 const app={register(){}};
 vm.runInNewContext(read('js/core/config.js'),{ChatApp:app,URL,...globals});
 return app;
}

test('desktop upload retries transient failures, preserves web behavior, and stops on cancellation', async () => {
 const app = nativeUpdateModel({chatDesktopRings:{version:1}, setTimeout, clearTimeout});
 let attempts=0;
 assert.equal(await app.retryDesktopFileTransfer(async()=>{if(++attempts<3)throw Object.assign(new Error('network'),{transient:true}); return 'stored';}), 'stored');
 assert.equal(attempts,3);
 attempts=0;
 await assert.rejects(app.retryDesktopFileTransfer(async()=>{attempts++;throw Object.assign(new Error('forbidden'),{status:403});}),/forbidden/);
 assert.equal(attempts,1);
 const web = nativeUpdateModel(); attempts=0;
 await assert.rejects(web.retryDesktopFileTransfer(async()=>{attempts++;throw Object.assign(new Error('network'),{transient:true});}),/network/);
 assert.equal(attempts,1);
 const controller = new AbortController(); attempts=0;
 const cancelled = app.retryDesktopFileTransfer(async()=>{attempts++;throw Object.assign(new Error('network'),{transient:true});},controller.signal);
 controller.abort(); await assert.rejects(cancelled, error=>error.name==='AbortError' || controller.signal.aborted);
 assert.equal(attempts,1);
});
test('cloak settings normalize aliases without replacing intentional saved bindings', () => {
 const app={register(){},SETTINGS_DEFAULTS:{blackoutCloakKeys:['Shift','Z']}};
 vm.runInNewContext(read('js/core/session.js'),{ChatApp:app});
 const keys=value=>Array.from(app.normalizeCloakKeysSetting(value));
 assert.deepEqual(keys(null),['Shift','Z']);
 assert.deepEqual(keys(['shift','z']),['Shift','Z']);
 assert.deepEqual(keys('s+x'),['S','X']);
 assert.deepEqual(keys('["Esc","Esc"]'),['Escape','Escape']);
 assert.deepEqual(keys(['ctrl','Spacebar']),['Control','Space']);
 assert.deepEqual(keys([' ', 'x']),['Space','X']);
 assert.deepEqual(keys(['Process','Dead','Unidentified']),['Shift','Z']);
});

test('Caden screenshot schedule keeps lunch and Period 1 before homeroom', () => {
 const app={register(_id,init){init();}};
 vm.runInNewContext(read('js/schedules/people-and-data.js'),{ChatApp:app});
 assert.deepEqual(Array.from(app.SCHEDULE_BLOCKS, item=>item.key),['P1','HR','P2','P3','P4','P5','P5A','P6','P7']);
 const expected={M:['Personal Dev/Career Research I','Kara Anthony','A14','Music Appreciation','Adam Burdett','F11'],T:['Art I','Kara Anthony','A14','Gen Ind Arts','Frank Victor','B10'],W:['Study','Cathryn Turner','B15','Study','Holly Homschek','A10'],R:['Physical Ed 9-10','Kyle Turonis','GYM','Study','Holly Homschek','A10'],F:['Study','Amanda Bauman','C07','Study','Holly Homschek','A10']};
 for (const [day, values] of Object.entries(expected)) {
  const schedule=app.SCHEDULES.Caden[day];
  assert.deepEqual([...Object.values(schedule.P1),...Object.values(schedule.P5A)],values);
  assert.equal(schedule.P5.className,'Lunch');
  assert.equal(schedule.P2.className,'Spanish I');
  assert.equal(schedule.P6.className,'English I');
  assert.ok(Object.values(schedule).every(period=>period.className!=='Open Period' && !period.room.startsWith('H')));
 }
});
test('Escape leaves open modals intact and shortcut editing bypasses modal handlers', () => {
 const app={register(){},modalEl:{hidden:false,dataset:{},contains:()=>true},modalClosing:false};
 vm.runInNewContext(read('js/ui/modals.js'),{ChatApp:app});
 let closed=0,collapsed=0,menuClosed=0;
 app.closeModal=()=>closed++;app.collapseTimeDisplay=()=>collapsed++;app.closeHtmlHubContextMenu=()=>menuClosed++;
 const escape={key:'Escape',preventDefault(){},stopPropagation(){}};
 app.handleModalKeydown(escape);assert.equal(closed,0);
 app.htmlHubMenuEl={hidden:false};app.handleModalKeydown(escape);assert.equal(menuClosed,1);assert.equal(closed,0);
 app.cloakHotkeyEditing=true;app.modalEl.dataset.timeDisplayExpanded='1';
 app.handleModalKeydown(escape);assert.equal(collapsed,0);assert.equal(menuClosed,1);assert.equal(closed,0);
});
test('fresh project enables signup by default and preserves explicit disable', () => {
 const app = scheduleModel();
 assert.equal(app._normalizeAccountCreationEnabled(null), true);
 assert.equal(app._normalizeAccountCreationEnabled(undefined), true);
 assert.equal(app._normalizeAccountCreationEnabled(true), true);
 assert.equal(app._normalizeAccountCreationEnabled(false), false);
});
test('Firebase initialization uses only the requested v6 project', () => {
 let config;
 const app = { register(_id, init) { init(); }, startNativeUpdateListener() {} };
 const firebase = { apps: [], initializeApp(value) { config = value; }, database() { return {ref() { return { on() {} }; }}; } };
 vm.runInNewContext(read('js/core/config.js'), {ChatApp:app, firebase, URL, window:{addEventListener(){}}, document:{addEventListener(){}}});
 assert.equal(config.databaseURL, 'https://chatappv6-e9da9-default-rtdb.firebaseio.com');
 assert.equal(config.projectId, 'chatappv6-e9da9');
 assert.equal(config.appId, '1:355141406495:web:78d50a2fca39eae1fb6a2a');
 assert.equal(app.DATABASE_SCHEMA_VERSION, 6);
});
test('admin payload edits retry a cold SDK cache without recreating deleted values', async () => {
 for (const server of ['before', null, 'another edit']) {
  const app = { register() {} }, statuses = [];
  vm.runInNewContext(read('js/admin/panel.js'), {ChatApp:app});
  app.adminDatabase = {}; app.adminDatabaseCurrent = () => true;
  app.adminDatabaseStatus = value => statuses.push(value); app.renderAdminDatabaseNode = () => {};
  let stored = server;
  app.db = {ref: path => ({transaction: async change => {
   assert.equal(path, 'htmlHub/files/example/html');
   assert.equal(change(null), null, 'cold cache must retry at server');
   const result = change(stored);
   if (result !== undefined) stored = result;
   return {committed: result !== undefined, snapshot: {val: () => stored}};
  }})};
  const node = {path:'htmlHub/files/example/html', expected:'before', value:'before'};
  await app.saveAdminDatabaseValue(node, 'after');
  if (server === 'before') { assert.equal(stored, 'after'); assert.equal(statuses.at(-1), 'Saved'); }
  else { assert.equal(stored, server); assert.match(statuses.at(-1), /changed elsewhere/); }
 }
});
test('native update policy distinguishes installed EXEs, current builds and ordinary web browsers',()=>{
 const policy={url:'https://drive.google.com/uc?export=download&id=fixture',minimumVersion:'1.7.0'};
 const web=nativeUpdateModel({location:{protocol:'https:'}});
 assert.equal(web.needsNativeUpdate(policy),false);
 const old=nativeUpdateModel({location:{protocol:'chatapp:'},chatDesktopPreferences:{version:1}});
 assert.equal(old.needsNativeUpdate(policy),true,'known pre-1.7 bridge can be identified conservatively');
 assert.equal(nativeUpdateModel({location:{protocol:'chatapp:'}}).needsNativeUpdate(policy),false,'unknown is not version zero');
 for(const nativeVersion of ['', '0.0.0', 'invalid']) assert.equal(nativeUpdateModel({location:{protocol:'chatapp:'},chatDesktopPreferences:{version:1},chatDesktopBuild:{nativeVersion}}).needsNativeUpdate(policy),false,'a present but invalid bridge is not legacy');
 for(const chatDesktopBuild of [null,undefined]) assert.equal(nativeUpdateModel({location:{protocol:'chatapp:'},chatDesktopPreferences:{version:1},chatDesktopBuild}).needsNativeUpdate(policy),false,'an explicitly pending or failed build bridge is not legacy');
 assert.equal(old.needsNativeUpdate({...policy,minimumVersion:'1.6.0'}),false,'legacy upper bound cannot establish requirements below 1.7');
 for(const version of ['1.7.0','1.7.1','1.10.0','2.0.0']) {
  const current=nativeUpdateModel({location:{protocol:'chatapp:'},chatDesktopBuild:{nativeVersion:version}});
  assert.equal(current.needsNativeUpdate(policy),false,version);
 }
 const current=nativeUpdateModel({location:{protocol:'chatapp:'},chatDesktopBuild:{nativeVersion:'1.7.0'}});
 assert.equal(current.needsNativeUpdate({...policy,minimumVersion:'1.8.0'}),true);
 assert.equal(old.needsNativeUpdate(null),false);
 assert.equal(old.needsNativeUpdate({...policy,url:''}),false);
});
test('native update URL validation rejects executable URL schemes and malformed versions',()=>{
 const app=nativeUpdateModel();
 for(const url of ['javascript:alert(1)','file:///app.exe','http://example.test/app.exe','https://user:pass@example.test/app.exe','not a url']) {
  assert.throws(()=>app.normalizeNativeUpdateURL(url));
  assert.equal(app.normalizeNativeUpdatePolicy({url,minimumVersion:'1.7.0'}),null);
 }
 assert.equal(app.normalizeNativeUpdatePolicy({url:'https://example.test',minimumVersion:'latest'}),null);
 assert.equal(app.normalizeNativeUpdateURL('  https://example.test/app.exe  '),'https://example.test/app.exe');
});
test('only Vinny can save native download URLs; the same URL retains its binary identity and clearing disables it',async()=>{
 const app=nativeUpdateModel();let stored=null,writes=0;
 app.db={ref:key=>{assert.equal(key,'admin/desktopUpdate');return {transaction:async change=>{
  const next=change(stored);if(next!==undefined){stored=next;writes++;}return {committed:next!==undefined};
 }}}};
 app.nativeUpdatePolicyLoaded=true;app.isVinny=()=>false;
 await assert.rejects(app.setNativeUpdateURL('https://example.test/app.exe'),/Only Vinny/);assert.equal(writes,0);
 app.isVinny=()=>true;app.nativeUpdatePolicyLoaded=false;
 await assert.rejects(app.setNativeUpdateURL('https://example.test/app.exe'),/still loading/);assert.equal(writes,0);
 app.nativeUpdatePolicyLoaded=true;
 await app.setNativeUpdateURL('https://example.test/app.exe');assert.equal(stored.minimumVersion,app.NATIVE_RELEASE_VERSION);
 stored.minimumVersion='1.7.0';await app.setNativeUpdateURL('https://example.test/app.exe');assert.equal(stored.minimumVersion,'1.7.0','same URL keeps its binary identity');
 stored.minimumVersion='1.8.0';await app.setNativeUpdateURL('https://example.test/new.exe');assert.equal(stored.minimumVersion,app.NATIVE_RELEASE_VERSION,'a new URL uses this actual native release');
 await app.setNativeUpdateURL('');assert.equal(stored,null);
});
test('file upload policy defaults to 100 MB and supports positive decimal limits above or below it',()=>{
 const app=nativeUpdateModel();
 assert.equal(app.FILE_UPLOAD_LIMIT_PATH,'admin/fileUploadLimitMB');
 assert.equal(app.FILE_UPLOAD_LIMIT_DEFAULT_MB,100);
 assert.equal(app.fileUploadLimitMB,100);
 for(const value of [null,undefined,'',false,{},0,-1,'-1','junk','Infinity',Infinity,NaN,'0x10',Number.MAX_SAFE_INTEGER]) {
  assert.equal(app.parseFileUploadLimitMB(value),null, String(value));
  assert.equal(app.normalizeFileUploadLimitMB(value),100, String(value));
 }
 for(const value of [0.5,100,250.25,' 512 ','1e3']) {
  const amount=Number(value);
  assert.equal(app.parseFileUploadLimitMB(value),amount);
  app.applyFileUploadLimitMB(value);
  assert.equal(app.fileUploadLimitMB,amount);
  assert.equal(app.CHAT_FILE_MAX_BYTES,Math.floor(amount*1024*1024));
  assert.equal(app.CHAT_FILE_MAX_LABEL,`${amount} MB`);
 }
 app.applyFileUploadLimitMB(null);assert.equal(app.CHAT_FILE_MAX_BYTES,100*1024*1024);
});
test('only Vinny saves a numeric upload limit after policy load; invalid values and failed writes do not replace it',async()=>{
 const app=nativeUpdateModel();const writes=[];
 app.db={ref:key=>{assert.equal(key,app.FILE_UPLOAD_LIMIT_PATH);return {set:async value=>{writes.push(value);}};}};
 app.fileUploadLimitLoaded=true;app.isVinny=()=>false;
 await assert.rejects(app.setFileUploadLimitMB(250),/Only Vinny/);assert.deepEqual(writes,[]);
 app.isVinny=()=>true;app.fileUploadLimitLoaded=false;
 await assert.rejects(app.setFileUploadLimitMB(250),/loading/i);assert.deepEqual(writes,[]);
 app.fileUploadLimitLoaded=true;
 for(const value of ['',0,-1,'ten',Infinity]) await assert.rejects(app.setFileUploadLimitMB(value));
 assert.deepEqual(writes,[]);
 await app.setFileUploadLimitMB('250.25');assert.deepEqual(writes,[250.25]);
 const before=app.fileUploadLimitMB;
 app.db.ref=()=>({set:async()=>{throw new Error('permission denied');}});
 await assert.rejects(app.setFileUploadLimitMB(50),/permission denied/);
 assert.equal(app.fileUploadLimitMB,before,'failed writes must not apply the unsaved limit');
});
test('upload policy streams Firebase changes to clients and resolves initial loading once',async()=>{
 const app=nativeUpdateModel();let listener,errorListener,subscriptions=0,syncs=0;
 app.syncFileUploadLimitInput=()=>syncs++;
 app.db={ref:key=>{assert.equal(key,app.FILE_UPLOAD_LIMIT_PATH);return {on(event,callback,onError){assert.equal(event,'value');subscriptions++;listener=callback;errorListener=onError;}};}};
 app.startFileUploadLimitListener();app.startFileUploadLimitListener();
 assert.equal(subscriptions,1,'one shared realtime listener per client');
 let ready=false;const loading=app.ensureFileUploadLimitLoaded().then(()=>{ready=true;});
 await Promise.resolve();assert.equal(ready,false,'uploads wait for first server value');
 listener({val:()=>null});await loading;
 assert.equal(app.fileUploadLimitLoaded,true);assert.equal(app.fileUploadLimitMB,100);
 listener({val:()=>512.5});assert.equal(app.fileUploadLimitMB,512.5);assert.equal(app.CHAT_FILE_MAX_BYTES,512.5*1024*1024);
 listener({val:()=>1});assert.equal(app.CHAT_FILE_MAX_BYTES,1024*1024);
 listener({val:()=>({invalid:true})});assert.equal(app.fileUploadLimitMB,100);
 assert.ok(syncs>=4,'an open admin input is refreshed with each policy value');
 errorListener(new Error('realtime denied'));assert.match(app.fileUploadLimitError,/realtime denied/);
});
test('initial upload policy read errors reject waiting uploads and stored larger files remain readable after lowering',async()=>{
 const app=nativeUpdateModel({CHAT_FILE_CONFIG:{endpoint:'https://files.example'}});let rejectListener;
 app.db={ref:()=>({on(_event,_callback,onError){rejectListener=onError;}})};
 const loaded=app.ensureFileUploadLimitLoaded();rejectListener(new Error('policy unavailable'));
 await assert.rejects(loaded,/policy unavailable/);
 app.applyFileUploadLimitMB(1);
 const record={provider:'b2-worker-v1',objectKey:'attachments/room/message/file',size:250*1024*1024};
 assert.equal(app.isExternalBlobDescriptor(record),true);
 assert.equal(app.getExternalBlobURL(record),'https://files.example/objects/attachments/room/message/file');
 for(const size of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.equal(app.isExternalBlobDescriptor({...record,size}),false);
});
test('cancelled upload policy subscriptions retry with fresh readiness and ignore stale callbacks',async()=>{
 const app=nativeUpdateModel(),subscriptions=[],ui=[];
 app.syncFileUploadLimitInput=()=>ui.push({loaded:app.fileUploadLimitLoaded,error:app.fileUploadLimitError});
 app.db={ref:()=>({on(_event,callback,onError){
  subscriptions.push({callback,onError});
  if(subscriptions.length===2)callback({val:()=>250});
 }})};
 const original=app.ensureFileUploadLimitLoaded(),firstReady=app.fileUploadLimitReady;
 subscriptions[0].onError(new Error('permission denied'));
 await assert.rejects(original,/permission denied/);
 assert.equal(app.fileUploadLimitListener,null);assert.equal(app.fileUploadLimitLoaded,false);
 assert.equal(app.CHAT_FILE_MAX_BYTES,100*1024*1024,'failed initial load preserves the default');
 assert.deepEqual(ui.at(-1),{loaded:false,error:'permission denied'});
 app.startFileUploadLimitListener();
 assert.notEqual(app.fileUploadLimitReady,firstReady,'panel reopen replaces the rejected readiness promise');
 assert.equal(await app.ensureFileUploadLimitLoaded(),250,'synchronous recovery snapshots settle the fresh readiness');
 subscriptions[0].callback({val:()=>1});subscriptions[0].onError(new Error('stale cancellation'));
 assert.equal(app.fileUploadLimitMB,250);assert.equal(app.fileUploadLimitError,'');
 subscriptions[1].onError(new Error('permission revoked'));
 assert.equal(app.fileUploadLimitLoaded,false);
 assert.equal(app.CHAT_FILE_MAX_BYTES,250*1024*1024,'cancellation preserves the last effective limit');
 let resolved=false;const retry=app.ensureFileUploadLimitLoaded().then(value=>{resolved=true;return value;});
 assert.equal(subscriptions.length,3);await Promise.resolve();assert.equal(resolved,false);
 assert.deepEqual(ui.at(-1),{loaded:false,error:''},'an explicit retry keeps the input disabled while loading');
 subscriptions[1].callback({val:()=>1000});assert.equal(app.fileUploadLimitMB,250);
 subscriptions[2].callback({val:()=>2.5});assert.equal(await retry,2.5);
 assert.equal(app.fileUploadLimitLoaded,true);assert.equal(app.CHAT_FILE_MAX_BYTES,2.5*1024*1024);
});
test('each source folder fits one GitHub browser upload', () => {
 const generated = new Set(['node_modules', '.git', 'dist', 'test-results']);
 function files(dir) {
  return fs.readdirSync(dir, {withFileTypes:true}).reduce((count, entry) =>
   count + (entry.isDirectory() ? (generated.has(entry.name) ? 0 : files(path.join(dir,entry.name))) : 1), 0);
 }
 for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  if (entry.isDirectory() && !generated.has(entry.name)) {
   assert.ok(files(path.join(root,entry.name)) <= 100, `${entry.name} exceeds GitHub's 100-file upload limit`);
  }
 }
});
function context(){
 const events=[];
 const ctx=vm.createContext({document:{documentElement:{dataset:{}}},window:{dispatchEvent:e=>events.push(e.type)},Event:class{constructor(type){this.type=type;}}});
 vm.runInContext(read('js/runtime/application.js'),ctx);
 return {ctx,events};
}

function scheduleModel() {
 const app = {register(_id, initialize) { initialize(); }, getAccurateNow:()=>new Date('2026-10-05T12:15:00Z'),
   getESTParts:()=>({year:2026,month:10,day:5,hour:8,minute:15,second:0}),
   _getESTWeekdayIndexAt:()=>1, currentUser:{code:'ADMIN',username:'Vinny'},
   isVinny:()=>true, refreshSchedulesPeople(){}, updateClockClassUI(){}, refreshOnlineIndicatorStatusTexts(){}};
 const ctx=vm.createContext({ChatApp:app,document:{querySelector:()=>null},console,Date});
 for(const file of ['js/schedules/people-and-data.js','js/schedules/admin.js','js/schedules/render.js','js/ui/clock.js']) {
   if(file.endsWith('clock.js')) app.register=()=>{};
   vm.runInContext(read(file),ctx);
 }
 app.refreshSchedulesPeople=()=>{};app.scheduleRenderSchedulesUI=()=>{};app.updateClockClassUI=()=>{};
 return app;
}
test('schedule overrides preserve all shipped defaults and do not resurrect removed schedules',()=>{
 const app=scheduleModel(),defaults=JSON.stringify(app.SCHEDULES);
 const rows=app.getScheduleRows('full','Vinny','M');assert.equal(rows.length,9);assert.equal(rows[0].className,'Geometry HN');
 app.applyScheduleOverrides(null);assert.equal(JSON.stringify(app.SCHEDULES),defaults);
 const days=Object.fromEntries(app.SCHEDULE_WEEKDAYS.map(({key})=>[key,app.getScheduleRows('full','Vinny',key).map(row=>({...row}))]));
 days.M[0].time='8:00 AM - 9:00 AM';days.M[0].className='Edited class';
 app.applyScheduleOverrides({vinny:{username:'Vinny',days,revision:1}});
 assert.equal(app.getScheduleRows('full','vinny','M')[0].className,'Edited class');
 assert.equal(app.getScheduleRows('full','Vinny','M')[0].duration,'60 minutes');
 for(const [name,record] of Object.entries(JSON.parse(defaults))) if(name!=='Vinny') assert.equal(JSON.stringify(app.SCHEDULES[name]),JSON.stringify(record));
 app.applyScheduleOverrides({vinny:{username:'Vinny',removed:true,revision:2}});
 assert.equal(app._findConfiguredScheduleUsername('Vinny'),null);assert.equal(app.getScheduleRows('full','Vinny','M').length,0);
 app.applyScheduleOverrides(null);assert.equal(JSON.stringify(app.SCHEDULES),defaults);
});
test('schedule validation rejects invalid periods, clamps text and resolves duplicate keys',()=>{
 const app=scheduleModel();
 assert.throws(()=>app.normalizeScheduleDays({M:[{time:'13:99 AM - 2:00 PM'}]}),/valid start and end/);
 assert.throws(()=>app.normalizeScheduleDays({M:[{time:'9:00 AM - 8:00 AM'}]}),/valid start and end/);
 assert.throws(()=>app.normalizeScheduleDays({M:Array.from({length:25},()=>({}))}),/at most 24/);
 const rows=app.normalizeScheduleDays({M:[{key:'P1',className:'x'.repeat(300)},{key:'P1'},{key:'bad/key'}]}).M;
 assert.equal(rows[0].className.length,180);assert.equal(new Set(rows.map(row=>row.key)).size,3);
 assert.ok(rows.every(row=>!row.key.includes('/')));
});
test('schedule writes reject non-admin sessions and concurrent edits without replacing stored data',async()=>{
 const app=scheduleModel();let writes=0,current={username:'Vinny',revision:3,days:{}};
 app.scheduleDataLoaded=true;app.db={ref:()=>({transaction:async fn=>{const next=fn(current);if(next!==undefined){writes++;current=next;}return {committed:next!==undefined};}})};
 app.isVinny=()=>false;await assert.rejects(app.savePersonSchedule('Vinny',{}),/Only Vinny/);assert.equal(writes,0);
 app.isVinny=()=>true;await assert.rejects(app.savePersonSchedule('Vinny',{}, {expectedRevision:2}),/changed elsewhere/);assert.equal(writes,0);
 await app.savePersonSchedule('Vinny',{}, {expectedRevision:3});assert.equal(writes,1);assert.equal(current.revision,4);
});
test('No School displays no active classes without erasing schedules or the copied full week',()=>{
 const app=scheduleModel(), before=JSON.stringify(app.SCHEDULES);
 app.scheduleType='noschool';
 assert.equal(app._normalizeScheduleType('noschool'),'noschool');
 assert.equal(app._scheduleTypeLabel('noschool'),'No School');
 assert.equal(app.getScheduleRows('noschool','Vinny','M').length,0);
 assert.equal(app._getActiveScheduleBlockKey('noschool','Vinny'),null);
 assert.match(app.scheduleAsText('Vinny'),/Geometry HN/);
 assert.equal(JSON.stringify(app.SCHEDULES),before);
 assert.equal(app.getScheduleRows('full','Vinny','M').length,9);
});
test('database explorer accepts direct child paths and rejects ambiguous or invalid keys',()=>{
 const app={register(){}};
 vm.runInNewContext(read('js/admin/panel.js'),{ChatApp:app});
 assert.equal(app.normalizeDatabasePath('/messages/test/'),'messages/test');
 assert.equal(app.normalizeDatabasePath('/'),'');
 for(const value of ['users//test','users/a.b','users/a#b','users/a$b','users/[a]','users/a\u0000b']) assert.throws(()=>app.normalizeDatabasePath(value),/valid database path/);
});
test('all editable scripts parse and every declared module exists',()=>{
 let count=0;
 function walk(dir){for(const file of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,file.name);
  if(file.isDirectory()){if(!['node_modules','.git'].includes(file.name))walk(full);}
  else if(file.name.endsWith('.js')){new vm.Script(fs.readFileSync(full,'utf8'),{filename:full});count++;}
 }}walk(root);
 assert.ok(count>80);
 const {ctx}=context();vm.runInContext(read('js/module-manifest.js'),ctx);
 assert.equal(new Set(ctx.ChatAppModules.map(e=>e.id)).size,ctx.ChatAppModules.length);
 for(const item of ctx.ChatAppModules)assert.ok(fs.existsSync(path.join(root,item.src)),item.src);
 assert.ok(read('app.js').split('\n').length<100,'entry script must remain a small bootstrap');
});
test('runtime defers side effects, initializes in manifest order, and starts once',()=>{
 const {ctx,events}=context();ctx.order=[];
 vm.runInContext(`ChatApp.register('second',()=>order.push(2));ChatApp.register('first',()=>order.push(1));`,ctx);
 assert.equal(ctx.order.length,0);
 ctx.ChatApp.initialize([{id:'first'},{id:'second'}]);ctx.ChatApp.initialize([{id:'first'},{id:'second'}]);
 assert.equal(JSON.stringify(ctx.order),'[1,2]');assert.deepEqual(events,['chatapp:ready']);
});
test('missing or duplicate modules fail before startup side effects',()=>{
 const {ctx}=context();ctx.touched=false;
 vm.runInContext(`ChatApp.register('first',()=>touched=true)`,ctx);
 assert.throws(()=>ctx.ChatApp.initialize([{id:'first'},{id:'missing'}]),/did not register/);
 assert.equal(ctx.touched,false);
 assert.throws(()=>ctx.ChatApp.register('first',()=>{}),/Duplicate/);
});
test('formatter reuse preserves timezone and DST output with a bounded cache',()=>{
 const {ctx}=context();vm.runInContext(read('js/core/formatters.js'),ctx);
 ctx.ChatApp.initialize([{id:'core/formatters'}]);
 const app=ctx.ChatApp;
 const opts={timeZone:'America/New_York',hour:'numeric',minute:'2-digit',hour12:true};
 const first=app.getDateTimeFormatter('en-US',opts);
 assert.equal(first,app.getDateTimeFormatter('en-US',{...opts}));
 for(const ts of ['2026-03-08T06:59:00Z','2026-03-08T07:01:00Z','2026-11-01T05:59:00Z','2026-11-01T06:01:00Z']){
  assert.equal(first.format(new Date(ts)),new Intl.DateTimeFormat('en-US',opts).format(new Date(ts)));
 }
 const zones=Intl.supportedValuesOf('timeZone').slice(0,80);
 for(const timeZone of zones)app.getDateTimeFormatter('en-US',{timeZone});
 assert.equal(app.dateTimeFormatterCache.size,64);
});
test('stable message timestamps avoid repeated DOM work and update at midnight',()=>{
 const {ctx}=context();
 vm.runInContext(read('js/core/formatters.js'),ctx);ctx.ChatApp.initialize([{id:'core/formatters'}]);
 vm.runInContext(read('js/rooms/home.js'),ctx);
 let refreshes=0;let date={year:2026,month:9,day:7};
 ctx.document.visibilityState='visible';ctx.document.querySelectorAll=()=>[{_refreshTimestamp:()=>refreshes++}];
 ctx.ChatApp.getAccurateNow=()=>new Date();ctx.ChatApp.getESTParts=()=>date;
 ctx.ChatApp.updateLiveMessageTimestamps();
 for(let i=0;i<1800;i++)ctx.ChatApp.updateLiveMessageTimestamps();
 assert.equal(refreshes,1);
 date={year:2026,month:9,day:8};ctx.ChatApp.updateLiveMessageTimestamps();assert.equal(refreshes,2);
 ctx.document.visibilityState='hidden';date.day=9;ctx.ChatApp.updateLiveMessageTimestamps();assert.equal(refreshes,2);
 ctx.document.visibilityState='visible';ctx.ChatApp.updateLiveMessageTimestamps();assert.equal(refreshes,3);
});

function searchApp() {
 const App={register(){},currentUser:{code:'SELF'},liveUserCache:new Map([
  ['SELF',{username:'Tester',displayName:'Current User'}],
  ['ALICE',{username:'alice',displayName:'Alice Jones'}],
  ['REGEX',{username:'a+b',displayName:'Regex User'}]
 ])};
 vm.runInNewContext(read('js/chat/header.js'),{ChatApp:App,Date,Map,Set,setTimeout,clearTimeout,performance});
 return App;
}
test('room search combines quoted sender, date and attachment filters using real message records',()=>{
 const App=searchApp(),match=(message,query)=>App.roomSearchMatches(message,App.parseRoomSearch(query));
 const message={userCode:'ALICE',username:'alice',text:'A map for @Tester',createdAt:+new Date('2026-10-05T12:00:00'),files:[null,{fileName:'World map.png',mimeType:'image/png'}]};
 assert.equal(match(message,'from:"Alice Jones" has:image mentions:me during:2026-10-05 "world map"'),true);
 assert.equal(match(message,'from:me'),false);
 assert.equal(match(message,'during:2026-02-31'),false,'invalid dates must not silently normalize to March');
 assert.equal(match({...message,t:'file',files:undefined,fileName:'Archive.zip'},'has:file archive.zip'),true);
 assert.equal(match({...message,text:'@a+b',files:[]},'mentions:a+b'),true,'mention names are escaped as text');
 assert.equal(match({...message,text:'@ab',files:[]},'mentions:a+b'),false);
 assert.equal(match({...message,text:'',mentions:{SELF:true}},'mentions:me'),true);
 App.liveUserCache.set('QUOTED',{username:'The "Quote" User'});
 assert.equal(match({userCode:'QUOTED',text:'Hello'},'from:'+JSON.stringify('The "Quote" User')),true,'autocomplete safely represents usernames containing spaces and quotes');
});
test('room search builds member lookup once per query instead of scanning members for each message',()=>{
 const App=searchApp(),cache=App.liveUserCache,entries=cache.entries.bind(cache);let scans=0;
 cache.entries=()=>{scans++;return entries();};
 const query=App.parseRoomSearch('from:Alice mentions:me');
 for(let i=0;i<2000;i++) assert.equal(App.roomSearchMatches({userCode:'ALICE',text:'Hello @{SELF}'},query),true);
 assert.equal(scans,1);
 App.liveUserCache.get('ALICE').displayName='New Display Name';
 assert.equal(App.roomSearchMatches({userCode:'ALICE',text:'Hello'},App.parseRoomSearch('from:"New Display Name"')),true,'a new render picks up live identity changes');
});
test('room search sees delayed older-key additions, edits and deletions, then releases its listeners',async()=>{
 const App=searchApp(),listeners=[],records=new Map([['z-latest',{text:'Newest message'}]]);
 const child=key=>({key,val:()=>records.get(key)});
 const node={hidden:true,classList:{contains:()=>false,add(){},remove(){}},setAttribute(){},replaceChildren(){}};
 App.$=()=>node;App.currentRoomId='test';App.msgDataByKey=new Map();
 let scheduled=0;App.renderRoomSearch=()=>{};App.scheduleRoomSearchRender=()=>{scheduled++;};
 const ref=(query={})=>({
  orderByKey(){return ref(query);},endAt(key){return ref({...query,endAt:key});},startAt(key){return ref({...query,startAt:key});},limitToLast(limit){return ref({...query,limit});},child(key){return {once:async()=>({...child(key),exists:()=>records.has(key)})};},
  on(event,callback){listeners.push({event,callback,query});},
  off(event,callback){const index=listeners.findIndex(item=>item.event===event&&item.callback===callback);if(index>=0)listeners.splice(index,1);},
  once:async()=>({forEach(callback){const keys=[...records.keys()].sort().filter(key=>!query.endAt||key<=query.endAt).slice(-(query.limit||records.size));keys.forEach(key=>callback(child(key)));}})
 });
 App.db={ref:()=>ref()};App.openRoomSearch();assert.equal(listeners.length,0,"focusing empty search does not download room history");App.loadRoomSearchHistory(App.roomSearchState);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(App.roomSearchState.loading,false);assert.equal(App.roomSearchState.messages.has('z-latest'),true);
 function emit(event,key){for(const item of [...listeners])if(item.event===event){const inQuery=!item.query.limit||[...records.keys()].sort().slice(-item.query.limit).includes(key);if(inQuery)item.callback(child(key));}}
 records.set('a-delayed',{text:'Offline message committed later'});emit('child_added','a-delayed');
 assert.equal(App.roomSearchState.messages.get('a-delayed')?.text,'Offline message committed later');
 records.set('a-delayed',{text:'Edited after reconnect'});emit('child_changed','a-delayed');
 assert.equal(App.roomSearchState.messages.get('a-delayed')?.text,'Edited after reconnect');
 records.delete('a-delayed');emit('child_removed','a-delayed');assert.equal(App.roomSearchState.messages.has('a-delayed'),false);
 assert.ok(scheduled>=3);App.closeRoomSearch();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(listeners.length,0);assert.equal(App.roomSearchState,null);
});

// External provider contract and the exact deployable Worker embedded in README.
function externalWorkerFixture(fetchImpl,policyFetch=async()=>new Response('null',{headers:{'Content-Type':'application/json'}})) {
 const source=read('README.md').split('<!-- BEGIN STORAGE WORKER -->')[1].split('<!-- END STORAGE WORKER -->')[0].replace(/^\s*```javascript\s*\n/,'').replace(/\n```\s*$/,'');
 const fetch=(url,options)=>new URL(url).pathname==='/admin/fileUploadLimitMB.json'?policyFetch(url,options):fetchImpl(url,options);
 const scope={crypto:require('node:crypto').webcrypto,TextEncoder,TextDecoder,URL,Response,Request,Headers,fetch};
 vm.runInNewContext(source.replace('export default {','globalThis.worker = {'),scope);
 return scope.worker;
}
const externalTestEnv={B2_KEY_ID:'test-key-id',B2_APP_KEY:'test-secret-not-published',B2_REGION:'us-west-004',B2_BUCKET:'fixture-bucket',ALLOWED_ORIGINS:'https://chat.example,null'};
const externalWorkerRequest=(route,body,origin='https://chat.example')=>new Request('https://files.example'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});

test('external Worker signs 100 MiB binary PUT, rejects oversize/invalid origins, and verifies persisted bytes',async()=>{
 const network=[];
 const worker=externalWorkerFixture(async(url,options)=>{network.push({url,options});return new Response(null,{status:200,headers:{'Content-Length':'17'}});});
 const signed=await worker.fetch(externalWorkerRequest('/sign',{path:'attachments/cm9vbQ/bXNn/0',size:100*1024*1024,mimeType:'video/mp4'}),externalTestEnv);
 assert.equal(signed.status,200); const plan=await signed.json(),url=new URL(plan.uploadURL);
 assert.equal(url.hostname,'s3.us-west-004.backblazeb2.com');
 assert.equal(plan.contentType,'video/mp4'); assert.match(plan.objectKey,/^attachments\/cm9vbQ\/bXNn\/0-/);
 assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'content-type;host');
 assert.equal(url.searchParams.get('X-Amz-Expires'),'300'); assert.match(url.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(plan).includes(externalTestEnv.B2_APP_KEY),false); assert.equal(network.length,0,'file bodies never pass through the signing request');
 for(const body of [{path:'attachments/room/msg/0',size:100*1024*1024+1},{path:'attachments/../other/0',size:17}]) assert.equal((await worker.fetch(externalWorkerRequest('/sign',body),externalTestEnv)).status,400);
 assert.equal((await worker.fetch(externalWorkerRequest('/sign',{path:'html/item/content',size:17},'https://unlisted.example'),externalTestEnv)).status,403);
 assert.equal((await worker.fetch(externalWorkerRequest('/sign',{path:'html/item/content',size:17},'null'),externalTestEnv)).status,200,'file-origin uploads supported when explicitly enabled');
 assert.equal((await worker.fetch(externalWorkerRequest('/complete',{objectKey:plan.objectKey,size:17}),externalTestEnv)).status,200);
 assert.equal(network.at(-1).options.method,'HEAD');
 assert.equal((await worker.fetch(externalWorkerRequest('/complete',{objectKey:plan.objectKey,size:18}),externalTestEnv)).status,409);
});
test('external Worker enforces the live Firebase upload limit for health, signing and completion',async()=>{
 let policy=null,policyFailure=false,storedSize=0;const policyRequests=[],storageRequests=[];
 const worker=externalWorkerFixture(async(url,options)=>{
  storageRequests.push({url,options});return new Response(null,{headers:{'Content-Length':String(storedSize)}});
 },async(url,options)=>{
  policyRequests.push({url,options});
  if(policyFailure)throw new Error('Firebase unavailable');
  return new Response(JSON.stringify(policy),{headers:{'Content-Type':'application/json'}});
 });
 const health=()=>worker.fetch(new Request('https://files.example/health'),externalTestEnv);
 assert.equal((await (await health()).json()).maxFileBytes,100*1024*1024);
 for(const invalid of [0,-1,{},'bad']) {
  policy=invalid;assert.equal((await (await health()).json()).maxFileBytes,100*1024*1024);
 }
 policy=250.5;storedSize=200*1024*1024;
 assert.equal((await (await health()).json()).maxFileBytes,250.5*1024*1024);
 const signed=await worker.fetch(externalWorkerRequest('/sign',{path:'attachments/room/message/file',size:storedSize}),externalTestEnv);
 assert.equal(signed.status,200);const plan=await signed.json();
 assert.equal((await worker.fetch(externalWorkerRequest('/complete',{objectKey:plan.objectKey,size:storedSize}),externalTestEnv)).status,200);
 policy=1.5;
 assert.equal((await worker.fetch(externalWorkerRequest('/sign',{path:'attachments/room/message/file',size:2*1024*1024}),externalTestEnv)).status,400);
 const storageCount=storageRequests.length;
 assert.equal((await worker.fetch(externalWorkerRequest('/complete',{objectKey:plan.objectKey,size:storedSize}),externalTestEnv)).status,400);
 assert.equal(storageRequests.length,storageCount,'oversized completion is rejected before reading storage');
 assert.equal((await (await health()).json()).maxFileBytes,1.5*1024*1024,'policy changes are read on the next request');
 assert.equal(policyRequests.length,11,'each upload/health request reads the current policy');
 for(const request of policyRequests) {
  assert.equal(new URL(request.url).origin,'https://chatappv6-e9da9-default-rtdb.firebaseio.com');
  assert.equal(request.options.cache,'no-store','Firebase policy bypasses intermediary caches');
 }
 policyFailure=true;
 assert.equal((await health()).status,503);
 assert.equal((await worker.fetch(externalWorkerRequest('/sign',{path:'attachments/room/message/file',size:1}),externalTestEnv)).status,503);
});

test('external Worker streams video ranges without exposing B2 secrets',async()=>{
 let upstream;
 const worker=externalWorkerFixture(async(url,options)=>{upstream={url,options};return new Response(new Uint8Array([2,3]),{status:206,headers:{'Content-Type':'video/mp4','Content-Range':'bytes 1-2/4','Content-Length':'2','Accept-Ranges':'bytes'}});});
 const response=await worker.fetch(new Request('https://files.example/objects/attachments/room/msg/file',{headers:{Range:'bytes=1-2'}}),externalTestEnv);
 assert.equal(response.status,206); assert.equal(upstream.options.headers.Range,'bytes=1-2');
 assert.equal(response.headers.get('Content-Type'),'video/mp4'); assert.equal(response.headers.get('Content-Range'),'bytes 1-2/4');
 assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*'); assert.equal(response.headers.has('Authorization'),false);
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[2,3]);
});

test('external Worker permanently deletes all object versions with bounded pages and preserves pins',async()=>{
 const versions=[];const removed=[];let requests=0;
 for(let i=0;i<42;i++)versions.push({key:'attachments/room/removed/file'+String(i).padStart(2,'0'),version:'v'+i});
 versions.push({key:'attachments/room/pinned/file',version:'keep'});
 versions.push({key:'attachments/other/msg/file',version:'other'});
 const worker=externalWorkerFixture(async(raw,options)=>{
  requests++; const url=new URL(raw),key=decodeURIComponent(url.pathname.slice('/fixture-bucket/'.length));
  if(options.method==='DELETE'){
   const version=url.searchParams.get('versionId'); assert.ok(version,'delete markers alone do not free storage');
   const index=versions.findIndex(value=>value.key===key&&value.version===version);assert.notEqual(index,-1);
   removed.push(versions.splice(index,1)[0]); return new Response(null,{status:204});
  }
  const marker=url.searchParams.get('key-marker');
  const matching=versions.filter(value=>value.key.startsWith(url.searchParams.get('prefix'))&&(!marker||value.key>marker)).sort((a,b)=>a.key.localeCompare(b.key));
  const page=matching.slice(0,16),last=page.at(-1);
  return new Response('<ListVersionsResult>'+page.map(value=>`<Version><Key>${value.key}</Key><VersionId>${value.version}</VersionId></Version>`).join('')+`<IsTruncated>${matching.length>16}</IsTruncated>`+(matching.length>16?`<NextKeyMarker>${last.key}</NextKeyMarker><NextVersionIdMarker>${last.version}</NextVersionIdMarker>`:'')+'</ListVersionsResult>');
 });
 let cursor=null,pages=0;
 do{
  requests=0;
  const response=await worker.fetch(externalWorkerRequest('/delete',{prefix:'attachments/room/',keepPrefixes:['attachments/room/pinned/'],cursor}),externalTestEnv);
  assert.equal(response.status,200);cursor=(await response.json()).cursor; assert.ok(requests<=17);assert.ok(++pages<8);
 }while(cursor);
 assert.equal(removed.length,42); assert.deepEqual(versions.map(value=>value.version).sort(),['keep','other']);
});

test('external browser uploader sends raw Blob, waits for completion, and cleans failed uploads without RTDB fallback',async()=>{
 for(const failure of [false,true]) {
  const requests=[],puts=[];let completed=false;
  const app=nativeUpdateModel({CHAT_FILE_CONFIG:{endpoint:'https://files.example'},Blob,AbortController,
   fetch:async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    if(url.endsWith('/sign'))return new Response(JSON.stringify({objectKey:'attachments/room/msg/0-uuid',contentType:'video/mp4',uploadURL:'https://s3.us-west-004.backblazeb2.com/fixture-bucket/file?signed=fixture'}));
    if(url.endsWith('/complete')){completed=true;return new Response(JSON.stringify(failure?{error:'size mismatch'}:{complete:true}),{status:failure?409:200});}
    if(url.endsWith('/delete'))return new Response(JSON.stringify({cursor:null}));
    throw new Error('Unexpected network request');
   },
   XMLHttpRequest:class{
    constructor(){this.upload={};this.headers={};}
    open(method,url){this.method=method;this.url=url;}
    setRequestHeader(name,value){this.headers[name]=value;}
    send(body){puts.push({body,method:this.method,headers:this.headers});this.status=200;queueMicrotask(()=>this.onload());}
    abort(){this.onabort?.();}
   }
  });
  app.fileUploadLimitLoaded=true;
  const file=new Blob([new Uint8Array([0,1,2,3])],{type:'video/mp4'});
  if(failure)await assert.rejects(app.uploadExternalBlob(file,{path:'attachments/room/msg/0'}),/size mismatch/);
  else {const descriptor=await app.uploadExternalBlob(file,{path:'attachments/room/msg/0'});assert.equal(app.isExternalBlobDescriptor(descriptor),true);assert.equal(descriptor.downloadURL,'https://files.example/objects/attachments/room/msg/0-uuid');}
  assert.equal(puts[0].body,file,'no base64 conversion or full-file JS buffer');assert.equal(puts[0].method,'PUT');assert.equal(puts[0].headers['Content-Type'],'video/mp4');assert.equal(completed,true);
  assert.equal(requests.some(value=>value.url.endsWith('/delete')),failure);
  await assert.rejects(app.uploadExternalBlob({size:100*1024*1024+1},{path:'attachments/room/msg/0'}),/100 MB/);
  if(!failure) {
   app.applyFileUploadLimitMB(250);
   const large={size:200*1024*1024,type:'video/mp4'};
   assert.equal((await app.uploadExternalBlob(large,{path:'attachments/room/msg/0'})).size,large.size,'raising the live limit removes the former 100 MB upload cap');
   assert.equal(puts.at(-1).body,large);
   app.applyFileUploadLimitMB(1.5);const before=requests.length;
   await assert.rejects(app.uploadExternalBlob({size:2*1024*1024},{path:'attachments/room/msg/0'}),/1.5 MB/);
   assert.equal(requests.length,before,'lowered limits stop an upload before signing');
  }
 }
 const unconfigured=nativeUpdateModel();assert.throws(()=>unconfigured.assertExternalStorageConfigured(),/needs setup/);
});

