/* Room-entry scrolling has an independent, generation-scoped loading anchor. */
const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');const mock=require('./firebase-mock.js');
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 try {for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900}});await context.addInitScript(mock);
  await context.addInitScript(()=>{
   const messages=Object.fromEntries(Array.from({length:120},(_,i)=>[`old-${String(i).padStart(4,'0')}`,{userCode:'TEST-USER',username:'Tester',text:`Message ${i}: `+'wrapped history '.repeat(12),createdAt:Date.now()-100000+i}]));
   __testDatabase.values.messages={test:messages,second:{...messages}};
   __testDatabase.values.rooms.second={name:'Second',createdBy:'TEST-USER'};
  });
  // Disable the independent REST fallback so the deferred snapshot controls the race.
  await context.route(/^https?:\/\//,r=>r.fulfill({status:/messages\//.test(r.request().url())?503:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
  await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
  await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
  await page.waitForFunction(()=>ChatApp.currentUser);
  await page.evaluate(()=>{
   ChatApp.autoScrollEnabled=false;
   // This specifically tests a cold room-entry fence. Background prewarming
   // has its own warm-entry coverage in room-loading.browser.cjs.
   ChatApp.detachRoomMessageNotifications();ChatApp.clearRecentRoomMessages();
   const original=ChatApp.db.ref.bind(ChatApp.db);window.__releases={};
   ChatApp.db.ref=p=>{
    const ref=original(p);
    if(/^messages\/(test|second)$/.test(p)){
     const once=ref.once.bind(ref);
     ref.once=()=>new Promise(resolve=>{once('value').then(snap=>{__releases[p]=()=>resolve(snap)})});
    }
    return ref;
   };
   const finish=ChatApp.finishRoomEntryScroll;
   ChatApp.finishRoomEntryScroll=function(seq){
    finish(seq);
    // A live callback enters the queue just after the initial batch commits.
    __testDatabase.ref(`messages/${ChatApp.currentRoomId}/zz-during-commit`).set({userCode:'OTHER',username:'Other',text:'Newest during commit '.repeat(50),createdAt:Date.now()+2});
   };
   ChatApp.openRoom('test',{quiet:true});
  });
  await page.waitForFunction(()=>window.__releases['messages/test']);
  assert.equal(await page.evaluate(()=>ChatApp.bulkLoading),true);
  await page.evaluate(()=>ChatApp.messagesEl.dispatchEvent(new WheelEvent('wheel',{deltaY:-120})));
  await page.evaluate(async()=>{
   await __testDatabase.ref('messages/test/zz-during-load').set({userCode:'OTHER',username:'Other',text:'Arrived while opening '.repeat(50),createdAt:Date.now()+1});
   __releases['messages/test']();
  });
  await page.waitForFunction(()=>!ChatApp.bulkLoading&&!ChatApp.roomEntryScroll&&ChatApp.msgElByKey.has('zz-during-commit'));
  const bottom=()=>page.evaluate(()=>{const el=ChatApp.messagesEl;return el.scrollHeight-el.clientHeight-el.scrollTop});
  assert.ok(await bottom()<=1,'opening with Auto Scroll off reaches the latest live row');
  assert.equal(await page.evaluate(()=>document.querySelector('.msg-row:last-child').dataset.msgkey),'zz-during-commit');
  assert.equal(await page.evaluate(()=>document.querySelectorAll('[data-msgkey="zz-during-load"]').length),1,'incoming row is not duplicated');
  const top=await page.evaluate(()=>ChatApp.messagesEl.scrollTop);
  await page.evaluate(()=>__testDatabase.ref('messages/test/zz-after-open').set({userCode:'OTHER',username:'Other',text:'Later message '.repeat(100),createdAt:Date.now()+10}));
  await page.waitForFunction(()=>ChatApp.msgElByKey.has('zz-after-open'));
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>ChatApp.messagesEl.scrollTop),top,'Auto Scroll remains off after room opening settles');
  assert.ok(await bottom()>10);
  // A snapshot resolving after navigation cannot drag the new room to old data.
  await page.evaluate(()=>{delete __releases['messages/test'];ChatApp.openRoom('test',{quiet:true})});
  await page.waitForFunction(()=>__releases['messages/test']);
  await page.evaluate(()=>ChatApp.openRoom('second',{quiet:true}));
  await page.waitForFunction(()=>__releases['messages/second']);
  await page.evaluate(()=>{__releases['messages/second']();__releases['messages/test']()});
  await page.waitForFunction(()=>ChatApp.currentRoomId==='second'&&!ChatApp.bulkLoading&&!ChatApp.roomEntryScroll);
  assert.ok(await bottom()<=1);assert.equal(await page.evaluate(()=>ChatApp.msgElByKey.has('zz-after-open')),false);
  assert.equal(await page.evaluate(()=>ChatApp.autoScrollEnabled),false);
  assert.deepEqual(errors,[]);console.log(`${width}: Auto Scroll off, live load/commit races, later reading, and rapid room switches passed`);
  await context.close();
 }} finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
