const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('clear cancels only unpinned upload scopes in the cleared room',()=>{
 for(const explicit of [true,false]) {
  const aborted=[];
  const scopes=[['kept','chat-message','room:one'],['gone','chat-message','room:one'],['other','chat-message','room:two'],['asset','sticker','room:one']];
  const a={register(){},currentRoomId:'one',msgDataByKey:new Map([['kept',{pinned:true}]]),
   activeFirebaseUploads:new Map(scopes.map(([messageKey,type,place])=>[messageKey,{messageKey,type,place,abort:()=>aborted.push(messageKey)}]))};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/chat/send.js'),'utf8'),{ChatApp:a,console,Date});
  a.cancelRoomMessageWork('one',explicit?new Set(['kept']):null);
  assert.deepEqual(aborted,['gone']);assert.equal(a.roomMessageWorkRevision.get('one'),1);
 }
});
test('attachment cleanup reads authenticated shallow keys and never requests file bodies',async()=>{
 const requests=[];
 const a={register(){},firebaseConfig:{databaseURL:'https://example.firebaseio.com'},firebase:{auth:()=>({currentUser:{getIdToken:async()=> 'test-token'}})}};
 const fetch=async(url,options)=>{requests.push({url:String(url),options});return {ok:true,json:async()=>({old:true,new:true})};};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/rooms/actions.js'),'utf8'),{ChatApp:a,console,URL,AbortController,setTimeout,clearTimeout,fetch});
 assert.deepEqual(Array.from(await a.readRoomAttachmentKeys('one')),['old','new']);
 const url=new URL(requests[0].url);
 assert.equal(url.pathname,'/attachmentBlobs/one.json');assert.equal(url.searchParams.get('shallow'),'true');assert.equal(url.searchParams.get('auth'),'test-token');
 assert.equal(requests[0].options.cache,'no-store');
});
test('detached attachment cleanup preserves pins, referenced owners, and post-clear messages with bounded deletes',async()=>{
 const reads=[],writes=[],keys=Array.from({length:70},(_,i)=>'gone'+i).concat(['pinned','referenced','new','late-clock','unknown']);
 const a={register(){},firebasePushKeyTimestamp:key=>key==='unknown'?0:key==='new'?1100:500,
  db:{ref(p=''){return {once:async()=>{reads.push(p);return {val:()=>p==='messages/one/late-clock/createdAt'?600:null};},update:async patch=>writes.push(patch)};}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/rooms/actions.js'),'utf8'),{ChatApp:a,console});
 await a.cleanupClearedAttachmentBlobs('one',keys,{pinned:{files:[{storagePath:'attachmentBlobs/one/referenced/files/0'}]}},1000);
 const deleted=writes.flatMap(patch=>Object.keys(patch));
 assert.equal(deleted.length,70);assert.equal(writes.length,3);assert(writes.every(patch=>Object.keys(patch).length<=32));
 assert(deleted.every(key=>key.startsWith('attachmentBlobs/one/gone')));
 assert(reads.every(p=>p.endsWith('/createdAt')||p.endsWith('/files/0/provider')),'Only compact identity and provider leaves are read');
 assert(!reads.some(p=>/\/(pinned|referenced|new|unknown)\//.test(p)),'Retained and post-cutoff keys are not touched');
});
function setup(){
 const timers=[];
 const a={register(){},currentUser:{code:'ME'},currentRoomId:'one',restoreDone:true,
  sanitizeRoomCode:String,getStoredPlace:()=>`room:${a.currentRoomId}`,views:{chat:{dataset:{active:'true'}}},
  notificationRoomHeads:new Map([['one','m'],['two','m']]),canSeeMessage:()=>true,
  roomsMetaCache:new Map([['one',{messageCount:10}],['two',{messageCount:3}]]),
  membershipMap:new Map([['one',{joinedAt:1,lastSeenCount:0}],['two',{joinedAt:2,lastSeenCount:0}]]),
  msgDataByKey:new Map(),updateRoomListItem(){},syncUnreadTaskbarBadge(){}};
 const context=vm.createContext({ChatApp:a,document:{hidden:false},window:{},console,Date,
  setTimeout:callback=>{const timer={callback};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.cancelled=true;}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/rooms/collections.js'),'utf8'),context);
 return {a,timers};
}
test('visible reads clear synchronously, save immediately, coalesce in-flight writes and keep rooms independent',async()=>{
 const {a}=setup(),writes=[];
 a._writeLastSeen=(id,count)=>new Promise(resolve=>writes.push({id,count,resolve}));
 a.scheduleLastSeenBump('one');
 assert.equal(a.getRoomMissedCount('one'),0);assert.equal(writes.length,1,'No debounce before saving');
 a.membershipMap.set('one',a.mergePendingRoomRead('one',{joinedAt:1,lastSeenCount:0}));
 assert.equal(a.getRoomMissedCount('one'),0,'Stale membership cannot restore unread');
 a.roomsMetaCache.get('one').messageCount=11;a.scheduleLastSeenBump('one');
 a.currentRoomId='two';a.scheduleLastSeenBump('two');
 assert.deepEqual(writes.map(w=>[w.id,w.count]),[['one',10],['two',3]]);
 writes[0].resolve({committed:true,snapshot:{val:()=>({lastSeenCount:10})}});await settle();
 assert.equal(writes[2].count,11,'New reads are flushed immediately after the prior write');
 writes[1].resolve({committed:true,snapshot:{val:()=>({lastSeenCount:3})}});
 writes[2].resolve({committed:true,snapshot:{val:()=>({lastSeenCount:11})}});await settle();
 assert.equal(a.pendingRoomReads.size,0);
});
test('cold Firebase membership retries null, preserves other fields and never recreates deleted membership',async()=>{
 const {a}=setup();a.firebase={database:{ServerValue:{TIMESTAMP:123}}};
 let member={joinedAt:1,lastSeenCount:0,ownReadMessages:{mine:5}};
 a.db={ref(){return {async transaction(update){assert.equal(update(null),null);const next=update(member);member=next;return {committed:true,snapshot:{val:()=>member}};}};}};
 a.scheduleLastSeenBump('one');await settle();assert.equal(member.lastSeenCount,10);assert.equal(member.ownReadMessages.mine,5);
 a.membershipMap.get('one').lastSeenCount=0;member=null;
 a.scheduleLastSeenBump('one');await settle();assert.equal(member,null);assert.equal(a.pendingRoomReads.size,0);
});
test('failed saves retain local read and retry without waiting for another message or scroll',async()=>{
 const {a,timers}=setup();let attempts=0;
 a._writeLastSeen=async(id,count)=>{if(++attempts===1)throw Error('set');return {committed:true,snapshot:{val:()=>({lastSeenCount:count})}};};
 a.scheduleLastSeenBump('one');await settle();assert.equal(a.getRoomMissedCount('one'),0);
 assert.equal(timers.length,1);timers[0].callback();await settle();assert.equal(attempts,2);assert.equal(a.pendingRoomReads.size,0);
});
test('room clears, leaving and account changes invalidate pending writes',async()=>{
 for(const invalidate of [a=>{a.roomsMetaCache.get('one').messagesClearedAt=99;},a=>a.membershipMap.delete('one'),a=>{a.currentUser={code:'OTHER'};},a=>a.clearPendingRoomReads()]){
  const {a}=setup();a.firebase={database:{ServerValue:{TIMESTAMP:123}}};let update,finish;
  a.db={ref(){return {transaction(fn){update=fn;return new Promise(resolve=>finish=resolve);}};}};
  a.scheduleLastSeenBump('one');invalidate(a);
  assert.equal(update({joinedAt:1,lastSeenCount:0}),undefined,'Invalid read cannot write into a different room/account lifetime');
  finish({committed:false,snapshot:{val:()=>null}});await settle();a.clearPendingRoomReads();
 }
});
test('hidden content never clears unread, and optimistic outgoing stubs are not counted as read messages',()=>{
 const {a}=setup();a.canSeeMessage=()=>false;a._writeLastSeen=()=>{throw Error('Must not write');};
 a.scheduleLastSeenBump('one');assert.equal(a.getRoomMissedCount('one'),10);
 a.canSeeMessage=()=>true;a.roomsMetaCache.get('one').messageCount=0;
 a.msgDataByKey.set('draft',{__stub:true});a.scheduleLastSeenBump('one');assert.equal(a.pendingRoomReads.size,0);
});

test('a read tail watermark clears phantom counts and still detects arrivals before metadata catches up',async()=>{
 const {a}=setup();a.notificationRoomTails=new Map([['one',new Map([['m',{userCode:'OTHER'}]])]]);
 a._writeLastSeen=async(_id,count)=>({committed:true,snapshot:{val:()=>({lastSeenCount:count})}});
 a.scheduleLastSeenBump('one');await settle();
 assert.equal(a.membershipMap.get('one').lastSeenMessageKey,'m');
 a.roomsMetaCache.get('one').messageCount=99;
 assert.equal(a.getRoomMissedCount('one'),0,'stale counters cannot restore a badge for a tail already read');
 a.notificationRoomTails.get('one').set('n',{userCode:'OTHER'});a.notificationRoomHeads.set('one','n');
 assert.equal(a.getRoomMissedCount('one'),1,'exact live tail excludes stale count drift');
 a.roomsMetaCache.get('one').messageCount=10;
 assert.equal(a.getRoomMissedCount('one'),1,'arrival is unread even before sender increments metadata');
 a.notificationRoomTails.get('one').delete('n');a.notificationRoomHeads.set('one','m');
 assert.equal(a.getRoomMissedCount('one'),0,'deleted unread messages clear immediately');
 a.notificationRoomTails.set('one',new Map());a.notificationRoomHeads.set('one','');
 assert.equal(a.getRoomMissedCount('one'),0,'an empty authoritative tail cannot contain unread messages');
});

test('a newly read message advances the watermark even when the room count is delayed',async()=>{
 const {a}=setup(),writes=[];
 a._writeLastSeen=async(_id,count,_code,state)=>{writes.push(state.key);return {committed:true,snapshot:{val:()=>({lastSeenCount:count})}};};
 a.scheduleLastSeenBump('one');await settle();
 a.notificationRoomHeads.set('one','n');
 a.scheduleLastSeenBump('one');await settle();
 assert.deepEqual(writes,['m','n']);assert.equal(a.membershipMap.get('one').lastSeenMessageKey,'n');
});
test('clear epochs reset all readers without a global membership rewrite or losing the first new unread',async()=>{
 const {a}=setup();a.roomsMetaCache.set('one',{messageCount:0,messagesClearedAt:1000});
 a.membershipMap.set('one',{joinedAt:1,lastSeenCount:8000,lastSeenAt:500});
 assert.equal(a.getRoomMissedCount('one'),0);
 a.roomsMetaCache.get('one').messageCount=1;
 assert.equal(a.getRoomMissedCount('one'),1,'old history read count cannot swallow new messages');
 let saved;a.firebase={database:{ServerValue:{TIMESTAMP:1100}}};
 a.db={ref(){return {async transaction(update){saved=update({joinedAt:1,lastSeenCount:8000,lastSeenAt:500});return {committed:true,snapshot:{val:()=>saved}};}};}};
 a.scheduleLastSeenBump('one');await settle();
 assert.equal(saved.lastSeenCount,1);assert.equal(saved.lastSeenEpoch,1000);
 a.membershipMap.set('one',saved);a.roomsMetaCache.get('one').messageCount=2;
 assert.equal(a.getRoomMissedCount('one'),1);
});
test('clear awaits file deletion but not auxiliary preferences, and never reopens the room',async()=>{
 const paths=[],writes=[];let invalidated='';
 const a={register(){},sanitizeRoomCode:String,isVinny:()=>true,pollNow:()=>123,
  invalidateRecentRoomMessages:id=>{invalidated=id;},
  db:{ref(p=''){paths.push(p);return {update:async patch=>{writes.push(patch);},once:()=>p.startsWith('pinnedMessages/')?Promise.resolve({val:()=>null}):new Promise(()=>{})};}},
  openRoom(){throw Error('Must not reopen');}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/rooms/actions.js'),'utf8'),{ChatApp:a,console});
 a.readRoomAttachmentKeys=async()=>[];
 assert.equal(await a.clearRoomMessages('one'),true);assert.equal(invalidated,'one');
 assert.equal(writes.length,1);assert.equal(writes[0]['messages/one'],null);assert.equal(writes[0]['readReceipts/one']._clearedAt,123);
 assert.equal(writes[0]['rooms/one/messagesClearedAt'],123);assert.deepEqual(paths,['pinnedMessages/one','','roomMembers/one']);
});

test('clear reports provider failures, retains the cleanup index, and a repeated clear deletes files while preserving pins',async()=>{
 const external=key=>({provider:'b2-worker-v1',objectKey:`attachments/one/${key}/0-unique`,size:3});
 const f=pinFixture({messages:{one:{gone:{createdAt:500,files:[external('gone')]},kept:{createdAt:500,pinned:true,files:[external('kept')]}}},
  pinnedMessages:{one:{kept:{createdAt:500,pinned:true,files:[external('kept')]}}},
  attachmentBlobs:{one:{gone:{files:[external('gone')]},kept:{files:[external('kept')]}}},roomMembers:{one:{}}});
 f.a.readRoomAttachmentKeys=async()=>Object.keys(f.get('attachmentBlobs/one')||{});
 f.a.firebasePushKeyTimestamp=()=>500;
 f.a.isExternalBlobDescriptor=file=>file?.provider==='b2-worker-v1';
 f.a.externalAttachmentPrefix=(room,key)=>`attachments/${room}/${key}/`;
 const deletions=[];let rejectDelete,failed=true;
 f.a.deleteExternalBlobPrefix=prefix=>{deletions.push(prefix);return failed?new Promise((resolve,reject)=>{rejectDelete=reject;}):Promise.resolve();};
 let resolved=false;
 const clearing=f.a.clearRoomMessages('one').then(()=>{resolved=true;});
 await settle();
 assert.equal(f.get('messages/one/gone'),null,'Visible messages clear before the provider response');
 assert.equal(resolved,false,'Success must wait for actual external deletion');
 rejectDelete(Error('Provider unavailable'));
 await assert.rejects(clearing,/Messages were cleared, but file cleanup failed.*Clear Messages again.*Provider unavailable/);
 assert.ok(f.get('attachmentBlobs/one/gone'),'Failed cleanup keeps its descriptor index for retry');
 failed=false;
 assert.equal(await f.a.clearRoomMessages('one'),true);
 assert.equal(f.get('attachmentBlobs/one/gone'),null);
 assert.ok(f.get('attachmentBlobs/one/kept'));assert.ok(f.get('messages/one/kept'));
 assert.deepEqual(deletions,['attachments/one/gone/','attachments/one/gone/']);
 assert(!f.reads.some(p=>p==='attachmentBlobs/one'||p.endsWith('/files')||p.endsWith('/files/0')),'Cleanup never downloads file bodies');
});

test('a failed shallow attachment listing does not clear messages or claim file cleanup succeeded',async()=>{
 const f=pinFixture({messages:{one:{keep:{text:'still here'}}}});
 f.a.readRoomAttachmentKeys=async()=>{throw Error('index offline');};
 await assert.rejects(f.a.clearRoomMessages('one'),/index offline/);
 assert.equal(f.get('messages/one/keep').text,'still here');assert.equal(f.writes.length,0);
});
test('room cache retains complete tails only and never shows one latest row from an oversized attachment tail',()=>{
 const a={register(){},currentUser:{code:'ME'},MSG_LIVE_TAIL:60,compareMessageKeys:(a,b)=>a.localeCompare(b)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/rooms/cache.js'),'utf8'),{ChatApp:a});
 a.cacheRecentRoomMessages('one',new Map([['a',{text:'earlier'}],['b',{text:'latest'}]]));
 assert.equal(a.getRecentRoomMessages('one').length,2);
 a.cacheRecentRoomMessages('one',new Map([['a',{text:'x'.repeat(1100000)}],['b',{text:'latest'}]]));
 assert.equal(a.getRecentRoomMessages('one').length,0,'cache cannot expose an incomplete tail');
});
test('delayed send metadata cannot restore a cleared room count or preview',async()=>{
 let commit,finish;let room={messageCount:12,lastMessagePreview:'old'};
 const a={register(){},sanitizeRoomCode:String,currentUser:{code:'ME'},roomsMetaCache:new Map(),formatRoomLastMessagePreview:()=> 'sent',
  db:{ref(p){return {
   once:async()=>({exists:()=>true,val:()=>p.startsWith('messages/')?{createdAt:500,text:'old send'}:{...room}}),
   transaction:fn=>{commit=fn;return new Promise(resolve=>finish=resolve);},
   update(){throw Error('Must use guarded transaction');}
  };}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/chat/send.js'),'utf8'),{ChatApp:a,console,Date});
 const pending=a.updateRoomLastMessage('one','old send','m');await settle();
 room={messageCount:0,messagesClearedAt:1000};
 assert.equal(commit(room),undefined,'clear epoch invalidates the delayed metadata transaction');
 finish({committed:false,snapshot:{val:()=>room}});await pending;
 assert.equal(room.messageCount,0);assert.equal(room.lastMessagePreview,undefined);
});

// Snapshot reads capture their value at read time. Hooks introduce real
// interleavings between that snapshot and a later update/transaction.
function pinFixture(initial){
 const data=structuredClone(initial),writes=[],reads=[],transactions=[],hooks={};
 const clone=value=>value==null?null:structuredClone(value);
 const get=p=>String(p||'').split('/').filter(Boolean).reduce((node,key)=>node?.[key],data)??null;
 const put=(p,value)=>{
  const keys=p.split('/').filter(Boolean),last=keys.pop();
  let parent=data;for(const key of keys)parent=parent[key]??={};
  if(value===null)delete parent[last];else parent[last]=clone(value);
 };
 const snapshot=value=>({val:()=>clone(value),exists:()=>value!==null&&value!==undefined});
 const a={register(){},currentUser:{code:'ME'},currentRoomId:'one',sanitizeRoomCode:String,isVinny:()=>true,pollNow:()=>1000,
  invalidateRecentRoomMessages(){},invalidateMessageHistory(){},db:{ref(p=''){
   return {
    once:async()=>{reads.push(p);return snapshot(clone(get(p)));},
    set:async value=>{put(p,value);},
    update:async patch=>{await hooks.beforeUpdate?.(patch);writes.push(clone(patch));for(const [key,value] of Object.entries(patch))put([p,key].filter(Boolean).join('/'),value);},
    transaction:async update=>{
     transactions.push(p);await hooks.beforeTransaction?.(p);
     if(hooks.coldTransaction)assert.equal(update(null),null,'Cold cache must request server comparison without recreating a deleted pin');
     let next=update(clone(get(p)));
     if(hooks.retryTransaction){await hooks.retryTransaction(p);next=update(clone(get(p)));}
     if(next!==undefined)put(p,next);
     return {committed:next!==undefined,snapshot:snapshot(clone(get(p)))};
    }
   };
  }}};
 const context=vm.createContext({ChatApp:a,console,AbortSignal,fetch:async()=>({ok:true,json:async()=>({})})});
 for(const file of ['chat/send','chat/message-menu','rooms/actions'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file+'.js'),'utf8'),context);
 a.pollNow=()=>1000;
 return {a,data,writes,reads,transactions,hooks,get,put};
}

test('room deletion retries only old file prefixes and cannot delete a recreated room or its new attachments',async()=>{
 const external=key=>({provider:'b2-worker-v1',objectKey:`attachments/one/${key}/0-unique`,size:3});
 const f=pinFixture({rooms:{one:{name:'one'}},roomNames:{one:'one'},messages:{one:{gone:{createdAt:500,files:[external('gone')]}}},
  attachmentBlobs:{one:{gone:{files:[external('gone')]}}}});
 f.a.currentRoomId='other';f.a.pinnedRoomIds=new Set();
 f.a.acquireRoomNameLock=async()=>({valid:()=>true,release:async()=>{}});
 f.a.firebaseConfig={databaseURL:'https://example.firebaseio.com'};
 f.a.assertExternalStorageConfigured=()=>true;
 f.a.readRoomAttachmentKeys=async()=>Object.keys(f.get('attachmentBlobs/one')||{});
 f.a.firebasePushKeyTimestamp=key=>key==='new'?1100:500;
 f.a.isExternalBlobDescriptor=file=>file?.provider==='b2-worker-v1';
 f.a.externalAttachmentPrefix=(room,key)=>`attachments/${room}/${key}/`;
 const originalRef=f.a.db.ref;
 f.a.db.ref=function(p=''){
  const ref=originalRef(p),update=ref.update;
  ref.update=async patch=>{
   await update(patch);
   if(Object.hasOwn(patch,'rooms/one')){
    // An old upload committed between initial key snapshot and room deletion;
    // then a new room with the same name was immediately created.
    f.put('attachmentBlobs/one/racing',{files:[external('racing')]});
    f.put('rooms/one',{name:'New room'});f.put('roomNames/one','one');
    f.put('messages/one/new',{createdAt:1100,files:[external('new')]});
    f.put('attachmentBlobs/one/new',{files:[external('new')]});
   }
  };return ref;
 };
 const deleted=[];let unavailable=true,error;
 f.a.deleteExternalBlobPrefix=async prefix=>{deleted.push(prefix);if(unavailable)throw Error('B2 unavailable');};
 try{await f.a.deleteRoomEverywhere('one');}catch(err){error=err;}
 assert.match(error.message,/Room deleted, but file cleanup failed/);
 assert.equal(typeof error.retryFileCleanup,'function');
 assert.ok(f.get('attachmentBlobs/one/gone'));assert.ok(f.get('attachmentBlobs/one/racing'));
 unavailable=false;await error.retryFileCleanup();
 assert.equal(f.get('attachmentBlobs/one/gone'),null);assert.equal(f.get('attachmentBlobs/one/racing'),null);
 assert.equal(f.get('rooms/one/name'),'New room');assert.equal(f.get('roomNames/one'),'one');
 assert.ok(f.get('messages/one/new'));assert.ok(f.get('attachmentBlobs/one/new'));
 assert(deleted.every(prefix=>prefix==='attachments/one/gone/'||prefix==='attachments/one/racing/'));
 assert(!f.writes.some(patch=>Object.hasOwn(patch,'attachmentBlobs/one')),'Never remove a recreated room\'s cleanup index');
});

test('pinning changes only the live pin flag and retains edits/media completed after its initial read',async()=>{
 const f=pinFixture({messages:{one:{m:{userCode:'ME',text:'Before',files:[{loading:true}],createdAt:10}}},pinnedMessages:{}});
 f.hooks.beforeTransaction=async()=>{f.hooks.beforeTransaction=null;f.put('messages/one/m/text','Concurrent Edit');f.put('messages/one/m/files',[{loading:false,dataURL:'data:complete'}]);};
 await f.a.toggleMessagePin({roomId:'one',key:'m'},true);
 assert.equal(f.get('messages/one/m').text,'Concurrent Edit');
 assert.equal(f.get('messages/one/m').files[0].dataURL,'data:complete');
 assert.equal(f.get('messages/one/m').pinned,true);
 assert.ok(f.transactions.includes('messages/one/m'),'Pinning retries against the current complete record');
 assert.equal(f.writes.length,0,'Pinning must never recreate a cleared record through a child-path update');
 assert.deepEqual(f.get('pinnedMessages/one/m'),f.get('messages/one/m'),'The retained copy reconciles the current message after pinning');
});

test('explicit unpin is idempotent and restores a retained-only message until the next clear',async()=>{
 const message={userCode:'ME',text:'Retained',pinned:true,createdAt:10,files:[{dataURL:'data:complete'}]};
 const f=pinFixture({messages:{one:{}},pinnedMessages:{one:{m:message}}});
 await f.a.toggleMessagePin({roomId:'one',key:'m'},false);
 assert.equal(f.get('pinnedMessages/one/m'),null);
 assert.equal(f.get('messages/one/m').pinned,false);
 assert.equal(f.get('messages/one/m').text,'Retained');
 await f.a.toggleMessagePin({roomId:'one',key:'m'},false);
 assert.equal(f.get('messages/one/m').pinned,false,'A stale Unpin button must not pin the message again');
 assert.equal(f.get('pinnedMessages/one/m'),null);
 await f.a.clearRoomMessages('one');await settle();
 assert.equal(f.get('messages/one'),null,'Only the next clear removes the explicitly unpinned message');
});

test('retained-pin reconciliation cannot recreate a pin removed during a transaction retry',async()=>{
 const f=pinFixture({messages:{one:{m:{text:'Edited',pinned:true}}},pinnedMessages:{one:{m:{text:'Before',pinned:true}}}});
 f.hooks.retryTransaction=async p=>{assert.equal(p,'pinnedMessages/one/m');f.put(p,null);f.put('messages/one/m/pinned',false);};
 await f.a.syncRetainedPinnedMessage('one','m');
 assert.equal(f.get('pinnedMessages/one/m'),null);
 assert.equal(f.get('messages/one/m').pinned,false);
 assert.equal(f.get('messages/one/m').text,'Edited');
});

test('retained-pin reconciliation retries a cold null snapshot and saves the current edit',async()=>{
 const f=pinFixture({messages:{one:{m:{text:'Edited',pinned:true}}},pinnedMessages:{one:{m:{text:'Before',pinned:true}}}});
 f.hooks.coldTransaction=true;
 await f.a.syncRetainedPinnedMessage('one','m');
 assert.equal(f.get('pinnedMessages/one/m').text,'Edited');
});

test('clearing preserves current pinned attachments and retained-only pins without reading unpinned history',async()=>{
 const latest={text:'Edited',pinned:true,createdAt:10,files:[{dataURL:'data:finished'}],poll:{endedAt:15}};
 const fallback={text:'Survived an older client clear',pinned:true,createdAt:9};
 const f=pinFixture({messages:{one:{keep:latest,unpin:{text:'Unpinned Elsewhere',pinned:false},remove:{text:'Ordinary'}}},
  pinnedMessages:{one:{keep:{text:'Before',pinned:true},fallback,unpin:{text:'Old Pin',pinned:true}}},rooms:{one:{}},roomMembers:{one:{}}});
 await f.a.clearRoomMessages('one');await settle();
 assert.deepEqual(f.get('messages/one/keep'),latest);
 assert.deepEqual(f.get('messages/one/fallback'),fallback);
 assert.equal(f.get('messages/one/remove'),null);
 assert.equal(f.get('messages/one/unpin'),null,'An unpin already visible at refresh is respected');
 assert.equal(f.get('pinnedMessages/one/unpin'),null,'A stale retained index cannot resurrect an unpinned message on another clear');
 assert.equal(f.get('rooms/one/messageCount'),2);
 assert.equal(f.get('readReceipts/one')._clearedAt,1000);
 assert.equal(f.reads.includes('messages/one'),false,'Clearing only reads exact pinned message records');
 assert.equal(f.reads.includes('messages/one/remove'),false);
});

test('clear history invalidation exits historical mode and resets only the active room tail',()=>{
 let resets=0;
 const a={register(){},msgHistoryRoomId:'one',msgHistoryRevision:4,msgLoadingOlder:true,msgLoadingNewer:true,msgHasNewerHistory:true,msgAllHistoryLoaded:true,
  messagePageCache:new Map([['old',{}]]),resetMessageWindowToTail:()=>{resets++;}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/chat/message-history.js'),'utf8'),{ChatApp:a});
 a.invalidateMessageHistory('other');assert.equal(resets,0);assert.equal(a.messagePageCache.size,1);
 a.invalidateMessageHistory('one',{resetTail:false});assert.equal(resets,0);
 assert.equal(a.msgHasNewerHistory,true,'Before the clear write, do not read the old tail or leave historical mode');
 assert.equal(a.msgHistoryRevision,5,'In-flight history reads are invalidated before the clear write');
 a.invalidateMessageHistory('one');assert.equal(resets,1);assert.equal(a.messagePageCache.size,0);
 assert.equal(a.msgHistoryRevision,6);assert.equal(a.msgLoadingOlder,false);assert.equal(a.msgLoadingNewer,false);
 assert.equal(a.msgHasNewerHistory,false);assert.equal(a.msgAllHistoryLoaded,false);
});

// Message clear/edit races use real shared helpers with in-memory transactions.
const sourceRoot = path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function appModel() {
  const App = { register() {}, sanitizeRoomCode: value => String(value || ''), currentUser: { code: 'author', username: 'Author' } };
  const context = vm.createContext({ ChatApp: App, console, setTimeout, clearTimeout, AbortController, Blob, URL, Map, Set });
  for (const file of ['js/media/uploads.js', 'js/chat/send.js', 'js/rooms/actions.js']) vm.runInContext(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), context, { filename: file });
  return App;
}
function refModel(initial, { conflict = false } = {}) {
  let stored = clone(initial), calls = 0, commitAttempts = [];
  const ref = {
    transaction: async change => {
      calls++;
      const candidate = change(clone(stored));
      commitAttempts.push(clone(candidate));
      // Firebase retries against null when a room clear wins after the first
      // local proposal but before the server commits that edit.
      if (conflict) { stored = null; conflict = false; }
      const next = change(clone(stored));
      commitAttempts.push(clone(next));
      if (next !== undefined) stored = clone(next);
      return { committed: next !== undefined, snapshot: { val: () => clone(stored) } };
    },
    once: async () => ({ val: () => clone(stored), exists: () => stored != null })
  };
  return { ref, get: () => clone(stored), calls: () => calls, commitAttempts };
}
const message = () => ({ t: 'text', userCode: 'author', username: 'Author', text: 'Before', createdAt: 123 });

test('edits atomically preserve message identity and unrelated attachments', async () => {
  const App = appModel();
  const original = { ...message(), files: [{ name: 'file.bin', storagePath: 'attachmentBlobs/r/k/files/0', encoding: 'base64-parts-v1', chunkCount: 1, size: 1 }] };
  const db = refModel(original);
  const result = await App.updateExistingMessage(db.ref, { text: 'After', editedAt: 456 }, { userCode: 'author' });
  assert.equal(result.committed, true);
  assert.deepEqual(db.get(), { ...original, text: 'After', editedAt: 456 });
  assert.equal(db.calls(), 1);
});

test('cleared messages cannot be reconstructed by late edits or attachment finalization', async () => {
  const App = appModel();
  for (const patch of [{ text: 'Late edit', editedAt: 456 }, { files: [{ name: 'file.bin', uploadProgress: 100 }], attachmentsSyncedAt: 456 }]) {
    const db = refModel(null);
    const result = await App.updateExistingMessage(db.ref, patch, { userCode: 'author' });
    assert.equal(result.snapshot.val(), null);
    assert.equal(db.get(), null);
  }
});

test('server clear wins a transaction retry after an optimistic edit proposal', async () => {
  const App = appModel();
  const db = refModel(message(), { conflict: true });
  const result = await App.updateExistingMessage(db.ref, { text: 'Late edit' }, { userCode: 'author' });
  assert.equal(db.commitAttempts[0].text, 'Late edit', 'edit begins against a real message');
  assert.equal(result.snapshot.val(), null, 'retry sees clear and leaves it absent');
  assert.equal(db.get(), null, 'deleted message stays absent');
});

test('cold local Firebase cache does not discard an edit before the server retry', async () => {
  const App = appModel();
  let stored = message();
  const ref = { transaction: async change => {
    assert.equal(change(null), null, 'null proposal requests a server conflict check');
    const next = change(clone(stored));
    if (next !== undefined) stored = next;
    return { committed: next !== undefined, snapshot: { val: () => stored } };
  } };
  const result = await App.updateExistingMessage(ref, { text: 'Saved from cold cache' }, { userCode: 'author' });
  assert.equal(result.committed, true);
  assert.equal(result.snapshot.val().text, 'Saved from cold cache');
  assert.equal(result.snapshot.val().userCode, 'author');
});

test('late updates reject wrong authors and preexisting partial ghost records', async () => {
  const App = appModel();
  for (const initial of [{ ...message(), userCode: 'another-author' }, { editedAt: 456 }, { files: [{ uploadProgress: 100 }] }]) {
    const db = refModel(initial);
    const result = await App.updateExistingMessage(db.ref, { text: 'After' }, { userCode: 'author' });
    assert.equal(result.committed, false);
    assert.deepEqual(db.get(), initial);
  }
});

test('record validity rejects blank User shells and retains supported real messages', () => {
  const App = appModel();
  for (const value of [null, {}, { editedAt: 42 }, { userCode: 'author', text: '' }, { text: '', files: [{ uploadProgress: 100 }] }]) assert.equal(App.isValidChatMessageRecord(value), false);
  for (const value of [message(), { ...message(), text: '', files: [{ name: 'file.bin', size: 12, uploadPending: 1 }] }, { ...message(), text: '', poll: { question: 'Ready?' } }]) assert.equal(App.isValidChatMessageRecord(value), true);
});

test('room clear invalidates queued sends, cancels only its unpinned uploads and preserves draft text', () => {
  const App = appModel(), aborted = [], edits = [], replies = [];
  App.currentRoomId = 'room';
  App.roomMessageWorkRevision = new Map([['room', 3], ['elsewhere', 7]]);
  App.activeFirebaseUploads = new Map([
    ['plain', { type: 'chat-message', place: 'room:room', messageKey: 'plain', abort: reason => aborted.push(['plain', reason]) }],
    ['pin', { type: 'chat-message', place: 'room:room', messageKey: 'pin', abort: reason => aborted.push(['pin', reason]) }],
    ['other-room', { type: 'chat-message', place: 'room:elsewhere', messageKey: 'other', abort: reason => aborted.push(['other', reason]) }],
    ['avatar', { type: 'avatar', place: 'room:room', abort: reason => aborted.push(['avatar', reason]) }]
  ]);
  App.cancelEditMessage = options => edits.push(options);
  App.clearReplyState = options => replies.push(options);
  App.cancelRoomMessageWork('room', new Set(['pin']));
  assert.deepEqual(aborted, [['plain', 'Chat cleared']]);
  assert.equal(App.roomMessageWorkRevision.get('room'), 4);
  assert.equal(App.roomMessageWorkRevision.get('elsewhere'), 7);
  assert.equal(edits.length, 1); assert.equal(edits[0].keepText, true);
  assert.equal(replies.length, 1);
});
