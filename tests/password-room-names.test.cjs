const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'), fs=require('node:fs'), path=require('node:path');
function app(globals={}){const ChatApp={register(){}}; const ctx=vm.createContext({ChatApp,setTimeout,clearTimeout,...globals}); for(const file of ['core/validation','accounts/codes','accounts/password','rooms/names'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',file+'.js'),'utf8'),ctx);return ChatApp;}
test('room labels preserve metadata capitalization when menus only have normalized IDs',()=>{
 const a=app();a.roomsMetaCache=new Map([['night room',{name:'Night Room'}]]);
 assert.equal(a.roomDisplayName('night room'),'Night Room');
 assert.equal(a.roomDisplayName('NIGHT ROOM',{}),'Night Room');
 assert.equal(a.roomDisplayName('night room',{name:'Updated CASE'}),'Updated CASE');
 assert.equal(a.roomDisplayName('Unknown Room'),'Unknown Room');
});
test('password migration preserves personal data and all identity references without editing content',()=>{
 const a=app(), old='OLD-PASS', next='NEW-PASS';
 const root={users:{[old]:{username:'Alice',settings:{customSoundEffects:{message:{dataURL:'data:audio/mp3;base64,AAAA'}}},prefs:{pinnedRooms:{room:true}},htmlLibrary:{file:{ownerCode:old}}}},
 usernames:{alice:{code:old}},displayNames:{alice:{code:old}},rooms:{room:{name:old,createdBy:old,password:old,online:{[old]:{state:'online'}}}},memberships:{[old]:{room:true}},
 messages:{room:{m:{text:old,userCode:old,replyTo:{userCode:old},sticker:{creatorCode:old}}}},
 pings:{[old]:{room:{ping:{from:old}}}},readReceipts:{room:{_latest:{key:'m',createdAt:1},m:{[old]:1}}},
 calendarReminders:{[old]:{date:{note:true}}},stickerCollections:{[old]:{sticker:true}},stickerSavers:{sticker:{[old]:true}},stickers:{byOwner:{[old]:{sticker:true}},meta:{sticker:{creatorCode:old}}},
 htmlHub:{byOwner:{[old]:{file:true}},files:{file:{ownerCode:old}},meta:{file:{ownerCode:old}}},
 calls:{room:{startedBy:old,members:{[old]:{code:old}},rings:{[old]:{fromCode:old,toCode:old}},screenViewers:{[old]:{[old]:{session:true}}},webrtc:{[old]:{session:{[old]:{session:{offer:true}}}}}}},appPresence:{[old]:{session:{status:'online'}}}};
 const out=a.migratePasswordData(root,old,next);
 assert.ok(out.users[next].settings.customSoundEffects.message);
 assert.equal(out.users[old],undefined);assert.equal(root.users[old].username,'Alice');
 for(const node of ['memberships','calendarReminders','stickerCollections','pings']){assert.ok(out[node][next]);assert.equal(out[node][old],undefined);}
 assert.equal(out.messages.room.m.userCode,next);assert.equal(out.messages.room.m.text,old);assert.equal(out.rooms.room.name,old);assert.equal(out.rooms.room.password,old);
 assert.equal(out.displayNames.alice.code,next);assert.equal(out.htmlHub.files.file.ownerCode,next);assert.equal(out.readReceipts.room.m[next],1);
 assert.ok(out.calls.room.screenViewers[next][next]);assert.ok(out.calls.room.webrtc[next].session[next]);
 assert.equal(out.appPresence[next],undefined);assert.equal(out.rooms.room.online[next],undefined);
});
test('password collision and stale source abort without changing either account',()=>{const a=app(),root={users:{OLD:{username:'a'},NEW:{username:'b'}}};assert.throws(()=>a.migratePasswordData(root,'OLD','NEW'),/Error. Try a different password/);assert.equal(root.users.OLD.username,'a');assert.throws(()=>a.migratePasswordData(root,'MISSING','OTHER'));});
test('room rename preserves stable message/call IDs, updates labels, checks owner and case-insensitive duplicates',()=>{
 const a=app(),root={rooms:{old:{name:'Old',createdBy:'OWNER'},other:{name:'Taken',createdBy:'B'}},messages:{old:{m:{text:'Old'}}},memberships:{OWNER:{old:true}},calls:{old:{rings:{B:{roomName:'Old'}}}},pings:{B:{old:{p:{roomName:'Old'}}}}};
 const out=a.renameRoomData(root,'old','New Name','OWNER');assert.equal(out.rooms.old.name,'New Name');assert.equal(out.calls.old.rings.B.roomName,'New Name');assert.equal(out.pings.B.old.p.roomName,'New Name');assert.equal(out.messages.old.m.text,'Old');assert.ok(out.memberships.OWNER.old);
 assert.throws(()=>a.renameRoomData(root,'old','taken','OWNER'),/already exists/);assert.throws(()=>a.renameRoomData(root,'old','New','B'),/creator/);assert.throws(()=>a.renameRoomData(root,'old','Bad/Name','OWNER'));
});
test('legacy name repair visits only this room label leaves and shallow notification indexes',async()=>{
 const data={calls:{room:{roomName:'Before',rings:{USER:{roomName:'Before'}}}},pings:{USER:{room:{p:{roomDisplayName:'Before'}}}},messages:{room:{m:{text:'Before'}}}};
 const reads=[],get=p=>p.split('/').reduce((value,key)=>value?.[key],data)??null;
 const a=app({URL,AbortController,fetch:async input=>{const url=new URL(input);assert.equal(url.searchParams.get('shallow'),'true');const p=decodeURIComponent(url.pathname.slice(1,-5));reads.push(p);const value=get(p);return {ok:true,json:async()=>value&&typeof value==='object'?Object.fromEntries(Object.keys(value).map(key=>[key,true])):value};}});
 a.firebaseConfig={databaseURL:'https://example.firebaseio.com'};
 a.db={ref(p){assert.match(p,/\/(roomName|roomDisplayName)$/);return {once:async()=>({val:()=>get(p)}),transaction:async fn=>{const next=fn(get(p));if(next!==undefined){const keys=p.split('/'),leaf=keys.pop();keys.reduce((value,key)=>value[key],data)[leaf]=next;}return {committed:next!==undefined};}};}};
 await a.syncRenamedRoomReferences('room','After','Before');
 assert.equal(data.calls.room.roomName,'After');assert.equal(data.calls.room.rings.USER.roomName,'After');assert.equal(data.pings.USER.room.p.roomDisplayName,'After');assert.equal(data.messages.room.m.text,'Before');
 assert.deepEqual(reads.sort(),['calls/room/rings','pings','pings/USER/room']);
});
function smallRoomDatabase(a, rooms, hooks={}) {
 const data={rooms,roomNames:Object.fromEntries(Object.entries(rooms).filter(([,r])=>r).map(([id,r])=>[a.sanitizeRoomCode(r.name||id),id]))};
 const access=[];let lockSeq=0;
 const get=p=>p.split('/').reduce((v,k)=>v?.[k],data)??null;
 const put=(p,v)=>{const keys=p.split('/'),last=keys.pop();let obj=data;for(const k of keys)obj=obj[k]??={};if(v===null)delete obj[last];else obj[last]=structuredClone(v);};
 a.db={ref(p){if(p==='.info/connected')return {};if(p==='roomNameLocks')return {push:()=>({key:'lock'+(++lockSeq)})};assert.ok(p.startsWith('roomNameLocks/')||p.startsWith('rooms/')||p.startsWith('roomNames/'),`Broad read forbidden: ${p}`);access.push(p);return {
  remove:async()=>{put(p,null);if(p.startsWith('roomNameLocks/')){const parent=p.split('/').slice(0,-1).join('/');if(!Object.keys(get(parent)||{}).length)put(parent,null);}},
  once:async()=>({val:()=>structuredClone(get(p)),exists:()=>get(p)!==null}),
  transaction:async update=>{hooks.before?.(p,data); const next=update(structuredClone(get(p))); if(next!==undefined)put(p,next);return {committed:next!==undefined,snapshot:{val:()=>structuredClone(get(p))}};}
 };}};
 return {data,access};
}
test('live rename touches one room and name reservations, surviving concurrent presence updates',async()=>{
 const a=app(),rooms={room:{name:'Before',createdBy:'OWNER',online:{OWNER:{state:'online'}},messageCount:3},other:{name:'Other',createdBy:'B'}};
 a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map([['room',rooms.room]]);let attempts=0;
 const {data,access}=smallRoomDatabase(a,rooms,{before(p){if(p==='rooms/room'&&++attempts===1){rooms.room.messageCount=4;rooms.room.online.OWNER.state='away';throw new Error('set');}}});
 assert.equal(await a.renameRoom('room','After'),'After');assert.equal(data.rooms.room.nameLower,'after');assert.equal(data.rooms.room.messageCount,4);assert.equal(data.rooms.room.online.OWNER.state,'away');
 assert.equal(data.roomNames.after,'room');assert.equal(data.roomNames.before,undefined);assert.ok(access.every(p=>!p.startsWith('rooms/other')));
 await assert.rejects(a.renameRoom('room','OTHER'),/already exists/);
 a.currentUser.code='B';await assert.rejects(a.renameRoom('room','New'),/creator/);
});
test('concurrent ownership changes and deletion abort rename and release its claimed name',async()=>{
 for(const change of [data=>{data.rooms.room.createdBy='OTHER';},data=>{delete data.rooms.room;}]){
  const a=app();a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map();
  const {data}=smallRoomDatabase(a,{room:{name:'Before',createdBy:'OWNER'}},{before(p,data){if(p==='rooms/room')change(data);}});
  await assert.rejects(a.renameRoom('room','After'),/creator|no longer exists/);
  assert.equal(data.roomNames.after,undefined);
 }
});
test('numeric room rename preserves stable IDs and isolates uniqueness from room metadata',async()=>{
 const a=app();a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map([['1',{name:'1',createdBy:'OWNER'}]]);
 const {data}=smallRoomDatabase(a,{'1':{name:'1',createdBy:'OWNER',messageCount:2}});
 const save=a.renameRoom('1','1f');assert.equal(a.roomDisplayName('1'),'1f');
 assert.equal(await save,'1f');assert.equal(data.rooms['1'].messageCount,2);assert.equal(data.roomNames['1f'],'1');assert.equal(data.roomNames['1'],undefined);assert.equal(a.pendingRoomNames.size,0);
});
test('rejected rename restores latest visible label and releases name reservation',async()=>{
 const a=app();a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map([['room',{name:'Before',createdBy:'OWNER'}]]);
 const {data}=smallRoomDatabase(a,{room:{name:'Before',createdBy:'OWNER'}},{before(p){if(p==='rooms/room'){a.roomsMetaCache.set('room',{name:'Server name',createdBy:'OWNER'});throw Object.assign(new Error('permission_denied'),{code:'PERMISSION_DENIED'});}}});
 await assert.rejects(a.renameRoom('room','After'),/permissions/);assert.equal(a.roomDisplayName('room'),'Server name');assert.equal(data.roomNames.after,undefined);assert.equal(a.pendingRoomNames.size,0);
});
test('a stalled rename releases its UI wait without queuing a late write',async()=>{
 const a=app({setTimeout:fn=>setTimeout(fn,5)});let writes=0,finish;
 a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map();
 a.db={ref(p){if(p==='.info/connected')return {};if(p==='roomNameLocks')return {push:()=>({key:'lock'})};if(p.startsWith('roomNameLocks/'))return {transaction:async()=>({committed:true}),remove:async()=>{}};return {once:()=>new Promise(resolve=>{finish=resolve;}),transaction:async()=>{writes++;}};}};
 await assert.rejects(a.renameRoom('room','After'),/not confirmed/);
 finish({val:()=>({name:'Before',createdBy:'OWNER'})});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(writes,0);
});
test('admin-panel joining writes one join log, preserves existing membership, and stops on failure',async()=>{
 const a=app(),logs=[],opened=[],toasts=[];let membership=null,fail=false;
 for(const file of ['rooms/management','rooms/actions'])vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js',file+'.js'),'utf8'),{ChatApp:a,console});
 a.currentUser={code:'ADMIN',username:'Admin',displayName:'Admin'};a.isVinny=()=>true;
 a.firebase={database:{ServerValue:{TIMESTAMP:1234}}};a.membershipMap=new Map();a.roomsMetaCache=new Map();
 a.renderRoomsList=a.closeModal=()=>{};a.showToast=toast=>toasts.push(toast);a.openRoom=id=>opened.push(id);
 a.writeRoomSystemMessage=async(...args)=>logs.push(args);
 a.db={ref(p){if(p==='roomMembers/private/ADMIN')return {set:async value=>assert.equal(value,true)};if(p==='rooms/private')return {once:async()=>({exists:()=>true,val:()=>({name:'Private',private:true,messageCount:12})})};assert.equal(p,'memberships/ADMIN/private');return {async transaction(update){if(fail)throw Error('permission_denied');const next=update(membership);if(next!==undefined)membership=next;return {committed:next!==undefined,snapshot:{val:()=>membership}};}};}};
 await a.joinRoomFromPanel('private');await a.joinRoomFromPanel('private');
 assert.equal(logs.length,1);assert.equal(logs[0][1].type,'member_joined');assert.equal(logs[0][2],'member-joined:ADMIN:1234');
 assert.equal(membership.joinedAt,1234);assert.equal(a.membershipMap.get('private').lastSeenCount,12);assert.deepEqual(opened,['private','private']);
 fail=true;await a.joinRoomFromPanel('private');assert.equal(opened.length,2);assert.equal(toasts.at(-1).title,'Join failed');assert.equal(logs.length,1);
});

function credentialApp() {
 const a=app(),hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 const oldHash=hash('OLD-PASS');
 const data={credentials:{[oldHash]:'ACCOUNT'},users:{ACCOUNT:{username:'Alice',displayName:'Alice',displayNameLower:'alice',credentialHash:oldHash}},messages:{room:{message:{userCode:'ACCOUNT',text:'kept'}}},calls:{room:{members:{ACCOUNT:true}}}};
 const access=[];a.currentUser={code:'ACCOUNT',password:'OLD-PASS',credentialHash:oldHash};a.sha256Hex=async value=>hash(value);
 a.startAccountExistenceWatch=a.stopAccountExistenceWatch=()=>{};a.setStoredAccountCode=value=>{a.savedCredential=value;};
 const get=p=>p.split('/').reduce((v,k)=>v?.[k],data)??null;
 a.db={ref(p){assert.ok(p==='users/ACCOUNT'||p==='users/ACCOUNT/credentialHash'||p.startsWith('credentials/'),`Unexpected database access: ${p}`);access.push(p);return {
  once:async()=>({exists:()=>get(p)!==null,val:()=>structuredClone(get(p))}),
  transaction:async fn=>{const value=fn(structuredClone(get(p)));if(value!==undefined){const keys=p.split('/'),key=keys.pop();let obj=data;for(const k of keys)obj=obj[k]??={};if(value===null)delete obj[key];else obj[key]=value;}return {committed:value!==undefined,snapshot:{val:()=>structuredClone(get(p))}};}
 };}};
 return {a,data,hash,access};
}
test('password change keeps immutable account IDs, messages and live calls and rejects the old login',async()=>{
 const {a,data,hash,access}=credentialApp();const original=JSON.stringify({messages:data.messages,calls:data.calls});
 assert.equal(await a.changePassword('NEW-PASS'),'NEW-PASS');assert.equal(a.currentUser.code,'ACCOUNT');assert.equal(a.currentUser.password,'NEW-PASS');assert.equal(a.savedCredential,'NEW-PASS');
 assert.equal(data.credentials[hash('OLD-PASS')],'ACCOUNT');assert.equal(data.credentials[hash('NEW-PASS')],'ACCOUNT');assert.equal(data.users.ACCOUNT.credentialHash,hash('NEW-PASS'));
 assert.equal(JSON.stringify({messages:data.messages,calls:data.calls}),original);assert.ok(access.every(p=>p!=='users/ACCOUNT'),'Changing credentials never downloads a profile or content');
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/accounts/login.js'),'utf8'),{ChatApp:a});
 a.ensureOwnedDisplayNameForUser=async(_code,rec)=>({displayName:rec.displayName,displayNameLower:rec.displayNameLower});a.normalizeTransformToRel=value=>value||{};a.defaultStickmanDataURL=()=>'';a.cloneDefaultSettings=()=>({});a.normalizeSettings=value=>value;a.getUserHtmlActivity=()=>null;
 assert.equal(await a.loginWithCode('OLD-PASS'),null);const loggedIn=await a.loginWithCode('NEW-PASS');assert.equal(loggedIn.code,'ACCOUNT');assert.equal(loggedIn.password,'NEW-PASS');
 // Even an interrupted index cleanup cannot restore access with the old secret.
 data.credentials[hash('OLD-PASS')]='ACCOUNT';assert.equal(await a.loginWithCode('OLD-PASS'),null);
});
test('credential collisions and a concurrent password change preserve the authoritative account and harmless reservations',async()=>{
 const {a,data,hash}=credentialApp();data.credentials[hash('TAKEN')]='OTHER';await assert.rejects(a.changePassword('TAKEN'),/Error/);assert.equal(a.currentUser.password,'OLD-PASS');
 data.users.ACCOUNT.credentialHash=hash('CONCURRENT');await assert.rejects(a.changePassword('NEW-PASS'),/Error/);
 assert.equal(data.users.ACCOUNT.credentialHash,hash('CONCURRENT'));assert.equal(data.credentials[hash('NEW-PASS')],'ACCOUNT');assert.equal(a.passwordChangeInFlight,false);
});

test('simultaneous same-password changes and switching back never erase the active credential alias',async()=>{
 const {a,data,hash}=credentialApp();const b=app();b.db=a.db;b.currentUser={...a.currentUser};b.sha256Hex=a.sha256Hex;b.setStoredAccountCode=()=>{};b.stopAccountExistenceWatch=b.startAccountExistenceWatch=()=>{};
 assert.deepEqual(await Promise.all([a.changePassword('SHARED-PASS'),b.changePassword('SHARED-PASS')]),['SHARED-PASS','SHARED-PASS']);
 assert.equal(data.credentials[hash('SHARED-PASS')],'ACCOUNT');assert.equal(data.users.ACCOUNT.credentialHash,hash('SHARED-PASS'));
 assert.equal(await b.changePassword('OLD-PASS'),'OLD-PASS');assert.equal(data.credentials[hash('OLD-PASS')],'ACCOUNT');assert.equal(data.users.ACCOUNT.credentialHash,hash('OLD-PASS'));
});

test('password changes survive Firebase cold-cache retries without replacing immutable account data',async()=>{
 const {a,data,hash}=credentialApp(),originalRef=a.db.ref;
 a.db.ref=p=>{const ref=originalRef(p);if(p==='users/ACCOUNT/credentialHash'){const transaction=ref.transaction;ref.transaction=async update=>{assert.equal(update(null),null,'Firebase retries a cold credential value at the server');return transaction(update);};}return ref;};
 await a.changePassword('new pass');assert.equal(a.currentUser.password,'NEW-PASS');assert.equal(data.users.ACCOUNT.credentialHash,hash('NEW-PASS'));assert.equal(data.users.ACCOUNT.username,'Alice');
});

test('an account switch while a password reservation is pending cannot commit or change the new session',async()=>{
 const {a,data,hash}=credentialApp(),originalRef=a.db.ref;let release,started;
 const startedPromise=new Promise(resolve=>started=resolve);
 a.db.ref=p=>{const ref=originalRef(p);if(p===`credentials/${hash('NEXT-PASS')}`){const transaction=ref.transaction;ref.transaction=async update=>{const result=await transaction(update);started();await new Promise(resolve=>release=resolve);return result;};}return ref;};
 const operation=a.changePassword('NEXT-PASS');await startedPromise;
 a.currentUser={code:'OTHER',password:'OTHER-PASSWORD'};a.accountSessionGeneration=1;release();
 await assert.rejects(operation,/^Error: Error\. Try a different password$/);
 assert.equal(data.users.ACCOUNT.credentialHash,hash('OLD-PASS'));assert.equal(a.currentUser.password,'OTHER-PASSWORD');assert.equal(a.savedCredential,undefined);
});

test('a confirmed password write finishing after sign-out never restores the signed-out credential cache',async()=>{
 const {a,data,hash}=credentialApp(),originalRef=a.db.ref;let release,started,stopped=0;
 const startedPromise=new Promise(resolve=>started=resolve);
 a.stopAccountExistenceWatch=()=>stopped++;
 a.db.ref=p=>{const ref=originalRef(p);if(p==='users/ACCOUNT/credentialHash'){const transaction=ref.transaction;ref.transaction=async update=>{const result=await transaction(update);started();await new Promise(resolve=>release=resolve);return result;};}return ref;};
 const operation=a.changePassword('NEXT-PASS');await startedPromise;a.currentUser=null;a.accountSessionGeneration=1;release();
 assert.equal(await operation,'NEXT-PASS');assert.equal(data.users.ACCOUNT.credentialHash,hash('NEXT-PASS'));assert.equal(a.savedCredential,undefined);assert.equal(a.currentUser,null);assert.equal(stopped,0);assert.equal(a.passwordChangeInFlight,false);
});
test('different tabs serialize room renames until name cleanup completes and rapid switch-back keeps the index',async()=>{
 const a=app();a.currentUser={code:'OWNER'};a.roomsMetaCache=new Map();const {data}=smallRoomDatabase(a,{room:{name:'Before',createdBy:'OWNER'}});
 const b=app();b.currentUser={code:'OWNER'};b.roomsMetaCache=new Map();b.db=a.db;
 const results=await Promise.allSettled([a.renameRoom('room','After'),b.renameRoom('room','After')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/another device/);
 assert.equal(data.roomNames.after,'room');assert.equal(data.rooms.room.name,'After');
 await b.renameRoom('room','Before');assert.equal(data.roomNames.before,'room');assert.equal(data.roomNames.after,undefined);
});


function identityDatabase() {
 const window={};vm.runInNewContext(`(${require('./firebase-mock.js').toString()})();`,{window,queueMicrotask});
 return window.__testDatabase;
}
function identityClient(database) {
 const a=app({crypto:require('node:crypto').webcrypto,TextEncoder});
 const access=[];
 a.db={ref(p){assert.ok(p && p!=='users' && p!=='messages',`Broad identity read forbidden: ${p}`);access.push(p);return database.ref(p);}};
 Object.assign(a,{DISPLAY_NAME_INDEX_NODE:'displayNames',currentUser:{code:'TEST-USER',username:'Tester',displayName:'Tester',displayNameLower:'tester'},liveUserCache:new Map(),defaultStickmanDataURL:()=>'',normalizeTransformToRel:x=>x||{},showToast(){},writeCurrentUserBootstrapCache(){},setMeHeader(){},refreshMentionFormattingForRenderedMessages(){}});
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/profiles/edit.js'),'utf8'),{ChatApp:a,document:{querySelectorAll:()=>[]}});
 return {a,access};
}
test('new signups use an independent permanent ID and show only the separate login password',async()=>{
 const db=identityDatabase(),{a}=identityClient(db),handlers={},elements={'create-username':{value:'Vinny'},'btn-create-account':{addEventListener:(event,callback)=>handlers.create=callback}};
 const toasts=[],errors=[];
 Object.assign(a,{$:id=>elements[id],hideError(){},setError:(_type,text)=>errors.push(text),showView(){},pfpState:{dataURL:''},pfpInput:{value:''},setDefaultPfp(){},firebase:{database:{ServerValue:{TIMESTAMP:123}}},showToast:value=>toasts.push(value),register:(_name,init)=>init()});
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/accounts/create.js'),'utf8'),{ChatApp:a,console});
 await handlers.create();assert.deepEqual(errors,[]);assert.equal(toasts.length,1);
 const password=toasts[0].code,id=Object.keys(db.values.users).find(key=>key!=='TEST-USER');
 assert.match(id,/^uid_[A-Z0-9]{32}$/);assert.match(password,/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);assert.notEqual(id,password);
 const credentialHash=await a.sha256Hex(password);assert.equal(db.values.credentials[credentialHash],id);assert.equal(db.values.users[id].credentialHash,credentialHash);
 assert.equal(db.values.usernames[await a.sha256Hex('vinny')].code,id);assert.equal(db.values.displayNames[await a.sha256Hex('vinny')].code,id);
 assert.equal(JSON.stringify(db.values).includes(password),false,'Ownership and indexes never store the generated password');
});
test('exact display-name claims reject concurrent owners and database failures',async()=>{
 const db=identityDatabase(),{a}=identityClient(db);
 const results=await Promise.all([a.claimDisplayName('Shared Name','one'),a.claimDisplayName('shared name','two')]);
 assert.equal(results.filter(result=>result.ok).length,1);assert.equal(db.values.displayNames[await a.sha256Hex('shared name')].code,'one');
 a.db={ref:()=>({transaction:async()=>{throw Error('permission denied');}})};
 assert.equal((await a.claimDisplayName('Unverified','one')).ok,false,'A failed write cannot report a reserved name');
});
test('failed or conflicting profile edits preserve the existing name reservation',async()=>{
 const db=identityDatabase(),{a}=identityClient(db);
 await a.claimDisplayName('Tester','TEST-USER');await a.claimDisplayName('Taken','OTHER');
 assert.equal(await a.updateMyDisplayName('Taken'),false);assert.equal(db.values.displayNames[await a.sha256Hex('tester')].code,'TEST-USER');
 const original=a.db.ref;a.db.ref=p=>{const ref=original(p);if(p==='users/TEST-USER/displayName')ref.transaction=async()=>{throw Error('permission denied');};return ref;};
 assert.equal(await a.updateMyDisplayName('After'),false);assert.equal(db.values.users['TEST-USER'].displayName,'Tester');
 assert.equal(db.values.displayNames[await a.sha256Hex('tester')].code,'TEST-USER');assert.equal(db.values.displayNames[await a.sha256Hex('after')],undefined);
});
test('profile changes serialize across devices and rapid switch-back preserves current ownership',async()=>{
 const db=identityDatabase(),{a,access}=identityClient(db),{a:b}=identityClient(db);
 await a.claimDisplayName('Tester','TEST-USER');
 const results=await Promise.all([a.updateMyDisplayName('After'),b.updateMyDisplayName('After')]);assert.equal(results.filter(Boolean).length,1);
 assert.equal(db.values.users['TEST-USER'].displayName,'After');assert.equal(db.values.displayNames[await a.sha256Hex('after')].code,'TEST-USER');
 assert.equal(await b.updateMyDisplayName('Tester'),true);assert.equal(db.values.displayNames[await a.sha256Hex('tester')].code,'TEST-USER');assert.equal(db.values.displayNames[await a.sha256Hex('after')],undefined);
 assert.ok(access.every(p=>!p.startsWith('messages/')&&!p.startsWith('rooms/')),'Changing a label never rewrites history or room ownership');
});


test('display-name saves retry cold caches and reject stale expected names using only two leaves',async()=>{
 const db=identityDatabase(),{a}=identityClient(db),ref=a.db.ref;
 let cold=true;
 a.db.ref=p=>{const handle=ref(p);if(p==='users/TEST-USER/displayName'){const transaction=handle.transaction;handle.transaction=async update=>{if(cold){cold=false;assert.equal(update(null),null,'Cold cache proposes no deletion of real server data');}return transaction(update);};}return handle;};
 await a.saveUserDisplayName('TEST-USER','Tester','After');assert.equal(db.values.users['TEST-USER'].displayName,'After');assert.equal(db.values.users['TEST-USER'].displayNameLower,'after');
 await assert.rejects(a.saveUserDisplayName('TEST-USER','Tester','Stale'),/another device/);assert.equal(db.values.users['TEST-USER'].displayName,'After');
 await assert.rejects(a.saveUserDisplayName('TEST-USER','After','Offline',()=>false),/another device/);assert.equal(db.values.users['TEST-USER'].displayName,'After');
});
