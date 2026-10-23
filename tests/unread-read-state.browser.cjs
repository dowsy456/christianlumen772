const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const mock=require('./firebase-mock.js');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  for(const width of [1440,390]){
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600});
   await context.addInitScript(mock);
   await context.addInitScript(()=>{window.__badges=[];window.chatDesktopNotifications={setUnreadCount:n=>__badges.push(n)};});
   await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',body:'null'}));
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
   await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
   await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
   await page.waitForFunction(()=>ChatApp.currentUser&&ChatApp.membershipMap.has('test'));
   await page.evaluate(async()=>{
    await __testDatabase.ref('memberships/TEST-USER/test').set({joinedAt:1,lastSeenCount:0});
    await __testDatabase.ref('rooms/test/messageCount').set(8);
    await __testDatabase.ref('messages/test/poll').set({userCode:'PEER',createdAt:Date.now(),poll:{question:'Unread poll',options:[{id:'a',text:'Yes'},{id:'b',text:'No'}],endsAt:Date.now()+3600000}});
   window.__readWrites=[];
    // A focused visible chat is read; minimized, hidden and covered windows
    // remain unread. Focus behavior itself is covered by room-loading tests.
    Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>true});
    const original=ChatApp.db.ref.bind(ChatApp.db);
    const gate=new Promise(resolve=>window.releaseReads=resolve);
    ChatApp.db.ref=p=>{
     const ref=original(p);
     if(p==='memberships/TEST-USER/test'){
      const transaction=ref.transaction.bind(ref);
      ref.transaction=async(update,...args)=>{
       __readWrites.push(performance.now());
       if(update(null)===undefined)return {committed:false,snapshot:{val:()=>null}};
       await gate;return transaction(update,...args);
      };
     }
     return ref;
    };
    ChatApp.closeToast();await ChatApp.openRoom('test',{quiet:true});ChatApp.closeMobileDrawers();
   });
   await page.waitForFunction(()=>ChatApp.canSeeMessage('test','poll'));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.evaluate(()=>ChatApp.getRoomMissedCount('test')),0,'Opening an unread poll clears the badge within the next paint');
   assert.equal(await page.evaluate(()=>__readWrites.length),1,'Save starts without a 900ms debounce');
   assert.equal(await page.evaluate(()=>__testDatabase.values.memberships['TEST-USER'].test.lastSeenCount),0,'Server is intentionally held pending');
   await page.evaluate(async()=>{
    await __testDatabase.ref('rooms/other').set({name:'Other',messageCount:0});
    await __testDatabase.ref('memberships/TEST-USER/other').set({joinedAt:1,lastSeenCount:0});
   });
   assert.equal(await page.evaluate(()=>ChatApp.getRoomMissedCount('test')),0,'Unrelated membership update cannot restore a stale unread count');
   const incoming=async(key,message)=>{
    await page.evaluate(async({key,message})=>{
     await __testDatabase.ref(`messages/test/${key}`).set({...message,createdAt:Date.now()});
     await __testDatabase.ref('rooms/test/messageCount').transaction(n=>(n||0)+1);
    },{key,message});
    await page.waitForFunction(key=>ChatApp.canSeeMessage('test',key),key);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>ChatApp.getRoomMissedCount('test')),0,`${key} clears as soon as it is visible`);
    assert.equal(await page.locator('[data-room-row="test"] .room-new-messages').isVisible(),false);
    assert.equal(await page.evaluate(()=>ChatApp.syncUnreadTaskbarBadge()),0);
   };
   await incoming('q-text',{userCode:'PEER',text:'Visible incoming message'});
   await page.evaluate(()=>__testDatabase.ref('readReceipts/test/q-text/READER').set(Date.now()));
   await page.waitForFunction(()=>ChatApp.msgElByKey.get('q-text')?.querySelector('.message-seen-avatar[data-usercode="READER"]'));
   await incoming('r-event',{t:'system',system:{type:'poll_ended',question:'Unread poll',winners:[],total:0,pollMessageKey:'poll'}});
   await page.waitForTimeout(50);
   assert.equal(await page.evaluate(()=>__testDatabase.values.readReceipts?.test?.['r-event']?.['TEST-USER']),undefined,'Reading a log must not save a seen receipt');
   await page.evaluate(()=>__testDatabase.ref('readReceipts/test/r-event/READER').set(Date.now()));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.locator('.system-message .message-seen').count(),0,'Legacy poll-log receipts stay hidden');
   assert.equal(await page.locator('.message-seen').count(),0,'Previous message receipt is removed when a log becomes latest');
   await incoming('s-join',{t:'system',system:{type:'member_joined',userCode:'PEER',displayName:'Peer'}});
   await page.evaluate(()=>__testDatabase.ref('readReceipts/test/s-join/READER').set(Date.now()));
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.locator('.system-message .message-seen').count(),0,'Membership logs never show seen indicators either');
   await page.evaluate(()=>releaseReads());
   await page.waitForFunction(()=>__testDatabase.values.memberships['TEST-USER'].test.lastSeenCount===11&&ChatApp.pendingRoomReads.size===0);
   // An overlay must still protect actually unseen content.
   await page.evaluate(async()=>{
    const cover=document.createElement('div');cover.id='unread-cover';cover.style.cssText='position:fixed;inset:0;z-index:2147483646;background:black';document.body.append(cover);
    await __testDatabase.ref('messages/test/t-covered').set({createdAt:Date.now(),t:'system',system:{type:'member_left',userCode:'PEER',displayName:'Peer'}});
    await __testDatabase.ref('rooms/test/messageCount').set(12);
   });
   await page.waitForFunction(()=>ChatApp.msgElByKey.has('t-covered'));
   await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>ChatApp.canSeeMessage('test','t-covered')),false);
   assert.equal(await page.evaluate(()=>ChatApp.getRoomMissedCount('test')),1);
   await page.evaluate(()=>document.getElementById('unread-cover').remove());
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await page.evaluate(()=>ChatApp.getRoomMissedCount('test')),0);
   await page.waitForFunction(()=>__testDatabase.values.memberships['TEST-USER'].test.lastSeenCount===12);
   // Message delivery must drive remote previews and unread state even when
   // the separate sender-maintained metadata is delayed or never arrives.
   await page.evaluate(()=>__testDatabase.ref('messages/test/u-preview').set({createdAt:Date.now(),userCode:'PEER',username:'Peer',text:'Immediate Remote Preview'}));
   await page.waitForFunction(()=>ChatApp.canSeeMessage('test','u-preview')&&ChatApp.membershipMap.get('test')?.lastSeenMessageKey==='u-preview');
   assert.match(await page.locator('[data-room-row="test"] .room-preview').textContent(),/Immediate Remote Preview/);
   await page.evaluate(()=>__testDatabase.ref('rooms/test/messageCount').set(13));
   await page.waitForFunction(()=>ChatApp.getRoomMissedCount('test')===0&&ChatApp.pendingRoomReads.size===0);
   await page.evaluate(()=>ChatApp.showLoggedInHome());
   await page.evaluate(()=>__testDatabase.ref('messages/test/v-unseen').set({createdAt:Date.now(),userCode:'PEER',username:'Peer',text:'Unseen Remote Preview'}));
   await page.waitForFunction(()=>ChatApp.getRoomMissedCount('test')===1&&__badges.at(-1)===1);
   assert.match(await page.locator('[data-room-row="test"] .room-preview').textContent(),/Unseen Remote Preview/);
   await page.evaluate(()=>__testDatabase.ref('messages/test/v-unseen').remove());
   await page.waitForFunction(()=>ChatApp.getRoomMissedCount('test')===0&&__badges.at(-1)===0);
   assert.match(await page.locator('[data-room-row="test"] .room-preview').textContent(),/Immediate Remote Preview/);
   assert.deepEqual(errors,[]);
   console.log(`PASS ${width}: immediate unread clearing, normal message receipts, no log receipts, polls, delayed/stale Firebase state, taskbar and covered content`);
   await context.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
