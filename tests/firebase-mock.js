/* In-memory Firebase-compatible fixture. Never connects to a remote project. */
function installFirebaseMock() {
  const values = {
    '.info': { connected: true, serverTimeOffset: 0 },
    admin: { accountCreationEnabled: true, scheduleType: 'full' },
    credentials: { '2959471ec9b8257bf8064f372f5c3e22ba83d04594114827a47aeb797b3907bd': 'TEST-USER' },
    roomNames: { 'test room': 'test' },
    users: { 'TEST-USER': { credentialHash: '2959471ec9b8257bf8064f372f5c3e22ba83d04594114827a47aeb797b3907bd', username: 'Tester', usernameLower: 'tester', displayName: 'Tester', displayNameLower: 'tester', createdAt: Date.now() } },
    usernames: { tester: 'TEST-USER' }, displayNames: { tester: 'TEST-USER' },
    rooms: { test: { name:'Test Room', createdBy:'TEST-USER', createdAt:Date.now(), messageCount:0 } },
    memberships: { 'TEST-USER': { test: true } }, roomMembers: { test: { 'TEST-USER':true } }
  };
  const listeners = [];
  const writes = [];
  let seq=0;
  const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
  const parts=p=>String(p||'').split('/').filter(Boolean);
  const get=p=>parts(p).reduce((obj,key)=>obj?.[key],values)??null;
  const stamp=value=>value&&typeof value==='object'?(value['.sv']==='timestamp'?Date.now():Array.isArray(value)?value.map(stamp):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,stamp(v)]))):value;
  function snapshot(p,value=get(p)) { return { key:parts(p).at(-1)||null, val:()=>clone(value), exists:()=>value!=null, numChildren:()=>Object.keys(value||{}).length, child:key=>snapshot(p+'/'+key,value?.[key]??null), forEach:cb=>Object.entries(value||{}).some(([k,v])=>cb(snapshot(p+'/'+k,v))===true), ref:ref(p) }; }
  function put(p,value) {
    // Root multi-path updates are equivalent to ref('messages/room').set(...).
    // Normalize the leading slash before matching listener paths, as Firebase
    // does; otherwise the fixture silently skips all root-update callbacks.
    p=parts(p).join('/');
    const before=clone(values);const keys=parts(p);let obj=values;
    keys.slice(0,-1).forEach(k=>obj=obj[k]??={});
    if (!keys.length) { for (const key of Object.keys(values)) if (key !== '.info') delete values[key]; Object.assign(values, stamp(clone(value)) || {}); }
    else if(value===null) delete obj[keys.at(-1)]; else obj[keys.at(-1)]=stamp(clone(value));
    writes.push({path:p,value:clone(value)});
    for(const entry of [...listeners]) {
      if(!(p===''||p===entry.path||p.startsWith(entry.path+'/')||entry.path.startsWith(p+'/'))) continue;
      const old=parts(entry.path).reduce((o,k)=>o?.[k],before)??null;
      const next=get(entry.path);
      if(JSON.stringify(old)===JSON.stringify(next))continue;
      if(entry.event==='value')queueMicrotask(()=>entry.cb(snapshot(entry.path)));
      else for(const k of new Set([...Object.keys(old||{}),...Object.keys(next||{})])) {
        const event=old?.[k]==null?'child_added':next?.[k]==null?'child_removed':'child_changed';
        if(entry.event===event&&JSON.stringify(old?.[k])!==JSON.stringify(next?.[k]))queueMicrotask(()=>entry.cb(snapshot(entry.path+'/'+k,event==='child_removed'?old[k]:next[k])));
      }
    }
  }
  function ref(p='') {
    return { key:parts(p).at(-1)||null, child:k=>ref(p+'/'+k), toString:()=>p,
      set:v=>{put(p,v);return Promise.resolve();}, update:patch=>{for(const[k,v]of Object.entries(patch))put(p+'/'+k,v);return Promise.resolve();}, remove:()=>{put(p,null);return Promise.resolve();},
      once:()=>Promise.resolve(snapshot(p)), get:()=>Promise.resolve(snapshot(p)),
      on:(event,cb)=>{listeners.push({path:p,event,cb});if(event==='value')queueMicrotask(()=>cb(snapshot(p)));if(event==='child_added')for(const[k,v]of Object.entries(get(p)||{}))queueMicrotask(()=>cb(snapshot(p+'/'+k,v)));return cb;},
      off:(event,cb)=>{for(let i=listeners.length-1;i>=0;i--)if(listeners[i].path===p&&(!event||listeners[i].event===event)&&(!cb||listeners[i].cb===cb))listeners.splice(i,1);},
      onDisconnect:()=>({set:()=>Promise.resolve(),remove:()=>Promise.resolve(),cancel:()=>Promise.resolve(),update:()=>Promise.resolve()}),
      transaction:(fn,cb)=>{const value=fn(clone(get(p)));const committed=value!==undefined;if(committed)put(p,value);const snap=snapshot(p);cb?.(null,committed,snap);return Promise.resolve({committed,snapshot:snap});},
      push:value=>{const child=ref(p+'/-TEST'+String(++seq).padStart(14,'0'));if(value!==undefined)child.set(value);return child;},
      orderByKey(){return this;},orderByChild(){return this;},limitToLast(){return this;},limitToFirst(){return this;},startAt(){return this;},endAt(){return this;},equalTo(){return this;}
    };
  }
  const database=()=>({ref,goOffline(){},goOnline(){}});
  database.ServerValue={TIMESTAMP:{'.sv':'timestamp'},increment:n=>n};
  window.firebase={apps:[],initializeApp(){this.apps.push({});},database};
  window.__testDatabase={values,writes,ref,get};
}
if(typeof module!=='undefined')module.exports=installFirebaseMock;
