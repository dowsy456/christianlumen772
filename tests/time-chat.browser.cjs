/* Time Display uses the mounted room, tested against an isolated local database. */
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const mock=require('./firebase-mock.js');
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 const captures=path.resolve(__dirname,'../../time-chat-v3');fs.mkdirSync(captures,{recursive:true});
 try {
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
   const context=await browser.newContext({viewport});
   await context.addInitScript(mock);
   await context.route(/^https?:\/\//,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
   await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
   await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
   await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
   await page.evaluate(()=>ChatApp.openTimeDisplayModal());
   assert.equal(await page.locator('#btn-time-display-chat').isVisible(),false,'home has no room-chat action');
   await page.evaluate(async()=>{
    await __testDatabase.ref('messages/test/timemessage').set({userCode:'OTHER',username:'Other',text:'Visible while reading the clock',createdAt:Date.now()});
    await ChatApp.openRoom('test',{quiet:true});
   });
   await page.waitForFunction(()=>!ChatApp.bulkLoading);
   assert.equal(await page.locator('#btn-time-display-chat').isVisible(),true,'room entry updates action without reopening clock');
   await page.evaluate(()=>{
    window.__roomRef=ChatApp.roomOnlineRef;window.__row=document.querySelector('.msg-row');window.__messages=ChatApp.messagesListEl;
    window.__openCalls=0;const open=ChatApp.openRoom;ChatApp.openRoom=function(...args){__openCalls++;return open.apply(this,args)};
    document.getElementById('msg-input').value='Retained draft';
   });
   await page.locator('#btn-time-display-chat').click();
   await page.waitForFunction(()=>document.body.dataset.companionMode==='time'&&document.body.dataset.companionChat==='1');
   assert.equal(await page.locator('#msg-input').inputValue(),'Retained draft');
   assert.equal(await page.locator('#members-sidebar').isVisible(),false);
   for(const side of ['left','right']) for(const percent of [15,30]) {
    await page.evaluate(({side,percent})=>{ChatApp.applySidebarPosition(side);ChatApp.activityChatWidth=percent;ChatApp.syncActivityChatLayout()}, {side,percent});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const geometry=await page.evaluate(()=>{
     const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
     return {chat:rect(document.querySelector('.chat-main')),clock:rect(document.getElementById('modal')),text:rect(document.getElementById('time-display-modal-time')),head:rect(document.querySelector('#modal .modal-head')),close:rect(document.getElementById('activity-chat-close'))};
    });
    assert.ok(Math.abs(geometry.chat.width-viewport.width*percent/100)<1);
    assert.ok(Math.abs(geometry.chat.width+geometry.clock.width-viewport.width)<1);
    assert.ok(Math.abs(geometry.chat.x-(side==='left'?0:geometry.clock.width))<1);
    assert.ok(geometry.head.x>=geometry.clock.x&&geometry.head.right<=geometry.clock.right+1,'clock controls stay in clock pane');
    assert.ok(geometry.text.x>=geometry.clock.x-1&&geometry.text.right<=geometry.clock.right+1,'clock digits fit remaining pane');
    assert.ok(geometry.close.x>=geometry.chat.x&&geometry.close.right<=geometry.chat.right+1,'chat close fits even minimum mobile width');
    await page.locator('#msg-input').click();await page.keyboard.type('!');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'msg-input','modal does not steal typing focus');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.getElementById('modal').contains(document.activeElement)),false,'clock does not trap chat keyboard focus');
    await page.evaluate(()=>{ChatApp.membersListVisible=true;ChatApp.syncEmojiButtonVisibility()});
    await page.locator('#activity-chat-members-back').waitFor({state:'visible'});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const members=await page.locator('#members-sidebar').boundingBox();
    const head=await page.locator('#room-toolbar').boundingBox();
    assert.ok(Math.abs(members.y-head.height)<1,'member overlay starts under responsive header');
    assert.ok(Math.abs(members.width-geometry.chat.width)<1);
    await page.locator('#activity-chat-members-back').click();
    assert.equal(await page.locator('#members-sidebar').isVisible(),false);
    await page.locator('#activity-chat-close').click();
    assert.equal(await page.locator('.chat-main').isVisible(),false);
    assert.equal(await page.evaluate(()=>ChatApp.canSeeLatestMessage()),false,'closed time chat cannot mark a receipt');
    await page.locator('#btn-time-display-chat').click();
    await page.screenshot({path:path.join(captures,`${viewport.width}-${side}-${percent}.png`)});
   }
   assert.deepEqual(await page.evaluate(()=>({row:__row===document.querySelector('.msg-row'),messages:__messages===ChatApp.messagesListEl,ref:__roomRef===ChatApp.roomOnlineRef,opens:__openCalls})),{row:true,messages:true,ref:true,opens:0});
   // At a readable width the clock surface does not suppress actual visibility.
   await page.evaluate(()=>{ChatApp.activityChatWidth=30;ChatApp.syncActivityChatLayout()});
   await page.locator('#msg-input').click();
   assert.equal(await page.evaluate(()=>ChatApp.canSeeLatestMessage()),true,'visible time companion content can be read');
   await page.evaluate(()=>{
    window.__clockNode=document.getElementById('time-display-modal-time');
    ChatApp.openModal({title:'Chat viewer',bodyHTML:'<p>A viewer opened from the clock chat</p>'});
   });
   assert.equal(await page.locator('#time-display-stage').isVisible(),true,'clock remains mounted behind another dialog');
   assert.equal(await page.evaluate(()=>ChatApp.canSeeLatestMessage()),false,'new dialog still blocks receipts');
   await page.locator('#btn-modal-close').click();
   await page.locator('#modal').waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>__clockNode===document.getElementById('time-display-modal-time')),true);
   await page.locator('#msg-input').click();
   assert.equal(await page.evaluate(()=>ChatApp.canSeeLatestMessage()),true,'closing viewer restores clock chat visibility');
   await page.locator('#btn-time-stage-chat').click();
   assert.equal(await page.locator('.chat-main').isVisible(),false);
   await page.locator('#btn-time-stage-chat').click();
   assert.equal(await page.locator('.chat-main').isVisible(),true);
   await page.locator('#btn-time-stage-expand').click();
   assert.equal(await page.locator('#time-display-stage').count(),0);
   await page.locator('#btn-time-display-chat').click();
   await page.locator('#btn-time-display-expand').click();
   assert.equal(await page.evaluate(()=>document.body.dataset.timeChatMode),'0');
   assert.equal(await page.evaluate(()=>ChatApp.timeChatOpen),false);
   await page.locator('#btn-time-display-chat').click();
   await page.evaluate(()=>ChatApp.showLoggedInHome());
   assert.equal(await page.locator('#btn-time-display-chat').isVisible(),false,'leaving room hides action live');
   assert.equal(await page.locator('.chat-main').isVisible(),false);
   await page.locator('#btn-modal-close').click();
   await page.locator('#modal').waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>document.body.dataset.companionMode),'none');
   await page.evaluate(async()=>{
    await ChatApp.openRoom('test',{quiet:true});
    await ChatApp.openMergePartyActivity('test');
   });
   await page.waitForFunction(()=>document.querySelector('#games-frame')?.contentWindow?.__mergeParty);
   await page.evaluate(()=>{ChatApp.openTimeDisplayModal();ChatApp.enlargeTimeDisplay()});
   await page.waitForFunction(()=>document.body.dataset.companionMode==='time');
   await page.waitForFunction(()=>document.getElementById('modal').classList.contains('is-open'));
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   assert.equal(await page.evaluate(()=>document.getElementById('modal').contains(document.elementFromPoint(innerWidth*.4,innerHeight*.5))),true,'clock paints above an already-open activity');
   await page.locator('#btn-modal-close').click();
   await page.locator('#modal').waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>document.body.dataset.companionMode),'activity','closing clock restores the retained activity');
   await page.evaluate(()=>ChatApp.closeGamesStage({preserve:false}));
   assert.deepEqual(errors,[]);
   console.log(`${viewport.width}: time chat both sides/15–30%, original room, typing, members, visibility and live eligibility passed`);
   await context.close();
  }
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
