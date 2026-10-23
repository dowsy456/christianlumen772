const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function fixture({ armGate = null, writeGate = null } = {}) {
  const writes = [], timers = new Map(), connections = [], events = {}, data = new Map(); let timer = 0, current = null, armed = 0, sets = 0;
  const app = { currentUser: {code:'one'}, firebase:{database:{ServerValue:{TIMESTAMP:1}}},
    liveUserCache: new Map(), accountSessionGeneration: 1,
    getCurrentHtmlActivityPayload:()=>current, syncMyHtmlActivityPresence:async()=>{},
    register:(_id,fn)=>{app.initialize=fn;}, db:{ref:key=>({
      on(_event, cb){connections.push(cb);queueMicrotask(()=>cb({val:()=>true}));},off(){},onDisconnect:()=>({remove:async()=>{if(++armed===1&&armGate)await armGate.promise;},cancel:async()=>{}}),
      set:async value=>{if(key.includes('/htmlActivities/')&&++sets===1&&writeGate)await writeGate.promise;data.set(key,value);writes.push({key,value});},
      update:async value=>{data.set(key,{...data.get(key),...value});writes.push({key,value,kind:'update'});},remove:async()=>{data.delete(key);writes.push({key,value:null});}
    })}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../activity-modules/activity-presence.js'),'utf8'), {
    ChatApp:app,window:{addEventListener:(type, cb)=>events[type]=cb},console,crypto:{randomUUID:()=>`session-${++timer}`},
    setInterval:fn=>{const id=++timer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id)
  });
  app.initialize();
  return {app,writes,timers,connections,events,data,setCurrent:value=>{current=value;}};
}
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
test('multiple HTML and desktop games share one indicator with separate escaped profile activities', () => {
  const escape = value => String(value).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
  const app = {register(){}, escapeHtml: escape, escapeAttr: escape, spotifyProfileMarkup: () => '<aside>music</aside>'};
  const context = vm.createContext({ChatApp: app});
  for (const file of ['activity-modules/html-library.js', 'js/profiles/popover.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const items = [
    {kind:'schedule',label:'Viewing Schedules'},
    {kind:'html',activity:{title:'First'},label:'Playing First'},
    {kind:'html',activity:{title:'<Second>'},label:'Playing <Second>'},
    {kind:'game',activity:{title:'Third'},label:'Playing Third'},
    {kind:'spotify',activity:{title:'Song'}}
  ];
  const icons = app.userActivityIconsMarkup(items);
  assert.equal((icons.match(/class="html-activity-icon/g)||[]).length, 1);
  assert.equal((icons.match(/class="schedule-activity-icon/g)||[]).length, 1);
  assert.match(icons, /<svg/); assert.doesNotMatch(icons, /&lt;\/&gt;/);
  const profile = app.userProfileActivitiesMarkup(items);
  assert.equal((profile.match(/data-activity-kind="html"/g)||[]).length, 2);
  assert.equal((profile.match(/data-activity-kind="game"/g)||[]).length, 1);
  assert.match(profile, /Playing First/);
  assert.match(profile, /Playing &#60;Second&#62;/);
  assert.match(profile, /Playing Third/);
  assert.doesNotMatch(profile, /<Second>/);
  assert.match(profile, /<aside>music<\/aside>/);
  assert.equal(app.userActivityIconsMarkup([]), '');
  app.appPresenceNow = () => Date.now() + 3600000;
  const startedAt = app.appPresenceNow() - 120000;
  assert.equal(app.getUserHtmlActivity({htmlActivity:{title:'Clock-adjusted game',startedAt}}).startedAt, startedAt, 'HTML profile duration uses the shared server-adjusted clock');
});
test('multiple HTML windows stack, duplicate titles collapse, closed windows disappear', async()=>{
  const f=fixture(), a={closed:false}, b={closed:false};
  f.setCurrent({type:'hub',title:'First',hubId:'first'});
  f.app.trackHtmlActivityPopup(a,{hubId:'second',label:'Second'});
  f.app.trackHtmlActivityPopup(b,{hubId:'first',label:'First'});
  assert.deepEqual(Array.from(f.app.getHtmlActivityStackItems(),x=>x.title),['First','Second']);
  a.closed=true;
  assert.deepEqual(Array.from(f.app.getHtmlActivityStackItems(),x=>x.title),['First']);
  await f.app.syncHtmlActivityStackPresence();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.writes.some(w=>w.key.startsWith('users/one/htmlActivities/session-')&&w.value?.items.length));
  f.app.stopHtmlActivityStackPresence();
  assert.equal(f.timers.size,0);
  assert.equal(f.app.htmlActivityPopups.size,0);
});
test('closing stage preserves a running popup; logout removes only this session',async()=>{
  const f=fixture(),popup={closed:false};
  f.app.trackHtmlActivityPopup(popup,{uploadFileName:'local.html'});
  await f.app.syncMyHtmlActivityPresence();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.app.getHtmlActivityStackItems()[0].title,'local.html');
  const key=f.app.htmlActivityStackSession.ref;
  assert.ok(key);
  f.app.stopHtmlActivityStackPresence();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.writes.at(-1).key.startsWith('users/one/htmlActivities/session-'));
  assert.equal(f.writes.at(-1).value,null);
  assert.equal(f.app.htmlActivityStackSession,null);
});

test('HTML elapsed timestamps remain stable through heartbeats and are published for remote profiles', async () => {
  const f = fixture();
  f.setCurrent({ type: 'hub', title: 'Example', hubId: 'example' });
  await f.app.syncHtmlActivityStackPresence(); await drain();
  const first = f.app.getHtmlActivityStackItems()[0];
  assert.ok(Number.isFinite(first.startedAt) && first.startedAt > 0);
  await f.app.syncHtmlActivityStackPresence(); await drain();
  assert.equal(f.app.getHtmlActivityStackItems()[0].startedAt, first.startedAt);
  assert.equal(f.writes.at(-1).value.items[0].startedAt, first.startedAt);
  f.setCurrent(null); assert.equal(f.app.getHtmlActivityStackItems().length, 0); assert.equal(f.app.htmlActivityStartedAt.size, 0);
  f.app.stopHtmlActivityStackPresence();
});

test('a stale reconnect acknowledgement cannot publish a stopped session or recreate it from a queued connection callback', async () => {
  const armGate = deferred(), f = fixture({ armGate });
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'old.html'});
  await drain();
  const oldConnection = f.connections[0];
  f.app.stopHtmlActivityStackPresence();
  oldConnection({val:()=>true});
  armGate.resolve(); await drain();
  assert.equal(f.app.htmlActivityStackSession,null);
  assert.equal(f.writes.some(write=>write.value),false);
});

test('disconnection during registration requires fresh registration before publishing', async () => {
  const armGate = deferred(), f = fixture({ armGate });
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'active.html'});
  await drain();
  f.connections[0]({val:()=>false});
  armGate.resolve(); await drain();
  assert.equal(f.writes.some(write=>write.value),false);
  assert.equal(f.app.htmlActivityStackSession.ready,false);
  f.connections[0]({val:()=>true}); await drain();
  assert.equal(f.writes.some(write=>write.value?.items?.[0]?.title==='active.html'),true);
});

test('back-forward cache restores still-open popup tracking; changing account drops only the old account popups', async () => {
  const f=fixture();
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'one.html'});
  await drain();
  f.events.pagehide({persisted:true}); await drain();
  assert.equal(f.app.htmlActivityPopups.size,1);
  f.events.pageshow(); await drain();
  assert.equal(f.app.getHtmlActivityStackItems()[0].title,'one.html');
  assert.equal(f.app.htmlActivityStackSession.code,'one');
  f.app.currentUser={code:'two'}; ++f.app.accountSessionGeneration;
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'two.html'});
  await drain();
  assert.deepEqual(Array.from(f.app.getHtmlActivityStackItems(),x=>x.title),['two.html']);
  assert.equal(f.app.htmlActivityStackSession.code,'two');
  assert.equal(f.writes.at(-1).value.items[0].title,'two.html');
});

test('local self records stack without a Firebase user listener and closing removes only this window session',async()=>{
  const f=fixture(), other={updatedAt:100,items:[{type:'hub',title:'Other PC',hubId:'remote'}]};
  f.app.currentUser.htmlActivities={remote:other};
  f.app.liveUserCache.set('one',{code:'one'});
  f.setCurrent({type:'hub',title:'Inline',hubId:'inline'});
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'popup.html'});
  await drain();
  const id=f.app.htmlActivityStackSession.id;
  assert.deepEqual(Array.from(f.app.currentUser.htmlActivities[id].items,x=>x.title),['Inline','popup.html']);
  assert.equal(f.app.currentUser.htmlActivities.remote,other);
  assert.equal(f.app.currentUser.htmlActivitiesVersion,1);
  assert.equal(f.app.liveUserCache.get('one').htmlActivitiesVersion,1);
  assert.equal(f.app.liveUserCache.get('one').htmlActivities,f.app.currentUser.htmlActivities);
  f.app.stopHtmlActivityStackPresence();
  assert.deepEqual(Object.keys(f.app.currentUser.htmlActivities),['remote']);
  assert.equal(f.data.get('users/one/htmlActivitiesVersion'),1,'marker remains after removing only this window session');
});

test('delayed old session writes are removed and cannot change a new account’s self data',async()=>{
  const writeGate=deferred(),f=fixture({writeGate});
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'old.html'});
  await drain();
  const oldId=f.app.htmlActivityStackSession.id;
  f.app.stopHtmlActivityStackPresence();
  f.app.currentUser={code:'two'};++f.app.accountSessionGeneration;
  f.app.trackHtmlActivityPopup({closed:false},{uploadFileName:'new.html'});
  await drain();
  writeGate.resolve();await drain();
  assert.equal(f.data.has(`users/one/htmlActivities/${oldId}`),false);
  assert.deepEqual(Object.values(f.app.currentUser.htmlActivities).flatMap(session=>Array.from(session.items,item=>item.title)),['new.html']);
});

test('legacy compatibility writes capture the account and compare-delete only their own delayed payload',async()=>{
  const gate=deferred(),records=new Map();let id=0,sets=0;
  const app={currentUser:{code:'one'},accountSessionGeneration:1,liveUserCache:new Map(),register(){},
    firebase:{database:{ServerValue:{TIMESTAMP:1}}},renderOnlineIndicator(){},refreshOpenUserProfileCard(){},
    defaultStickmanDataURL:()=>'',normalizeTransformToRel:()=>null,
    db:{ref:key=>({onDisconnect:()=>({remove:async()=>{},cancel:async()=>{}}),
      set:async value=>{if(++sets===1)await gate.promise;records.set(key,value);},remove:async()=>records.delete(key),
      transaction:async update=>{const next=update(records.get(key));if(next!==undefined){if(next===null)records.delete(key);else records.set(key,next);}}
    })}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../activity-modules/window-controls.js'),'utf8'),{ChatApp:app,crypto:{randomUUID:()=>`legacy-${++id}`}});
  app.getCurrentHtmlActivityPayload=()=>({type:'upload',title:app.currentUser.code+'.html'});
  const old=app.syncMyHtmlActivityPresence();await drain();
  app.currentUser={code:'two'};++app.accountSessionGeneration;
  await app.syncMyHtmlActivityPresence();
  gate.resolve();await old;
  assert.equal(records.has('users/one/htmlActivity'),false);
  assert.equal(app.currentUser.htmlActivity.title,'two.html');
  assert.equal(records.get('users/two/htmlActivity').title,'two.html');
});

test('unchanged HTML activities renew only the lease and schema six skips the duplicate legacy writer', async () => {
  const f=fixture();
  f.app.DATABASE_SCHEMA_VERSION=6;
  f.setCurrent({type:'hub',title:'Example',hubId:'example'});
  await f.app.syncMyHtmlActivityPresence(); await drain();
  const session=f.app.htmlActivityStackSession, count=f.writes.length;
  await f.app.syncMyHtmlActivityPresence(); await drain();
  assert.equal(f.writes.length,count,'same stack does not republish metadata');
  session.lastWriteAt=Date.now()-30001;
  await f.app.syncHtmlActivityStackPresence();
  assert.equal(f.writes.at(-1).kind,'update');
  assert.deepEqual(Object.keys(f.writes.at(-1).value),['updatedAt']);
  assert.equal(f.data.get(`users/one/htmlActivities/${session.id}`).items[0].title,'Example');
  f.connections[0]({val:()=>false}); await f.app.syncHtmlActivityStackPresence();
  const offlineCount=f.writes.length;
  f.connections[0]({val:()=>true}); await drain();
  assert.equal(f.writes.length,offlineCount+1,'reconnect republishes the stack after onDisconnect removed it');
  assert.equal(f.writes.at(-1).value.items[0].title,'Example');
  f.app.stopHtmlActivityStackPresence();
});
