/* Isolated design/behavior checks; all remote requests are intercepted. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium,devices}=require('playwright');
const mock=require('./firebase-mock.js');
const root=path.resolve(__dirname,'..');
const shots=path.resolve(root,'../qa');
(async()=>{
 fs.mkdirSync(shots,{recursive:true});
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 const results=[];
 try{
  for(const [name,options] of [['desktop',{viewport:{width:1440,height:960}}],['ios',{...devices['iPhone 13']}],['android',{...devices['Pixel 7']}]]){
   const ctx=await browser.newContext(options);
   await ctx.addInitScript(mock);
   await ctx.route(/^https?:\/\//,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
   const page=await ctx.newPage(); page.setDefaultTimeout(12000); const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(pathToFileURL(path.join(root,'index.html')).href);
   await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
   await page.click('#btn-go-login'); await page.fill('#login-code','TEST-USER'); await page.click('#btn-login');
   await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER' && ChatApp.views.chat.dataset.active==='true' && ChatApp.membershipMap.has('test'));
   await page.evaluate(async()=>{
    const db=window.__testDatabase;
    const people=[['MIRA','Mira'],['JULES','Jules'],['NOAH','Noah'],['SAGE','Sage'],['AVERY','Avery']];
    for(const [code,name] of people){
     await db.ref(`users/${code}`).set({username:name,displayName:name,usernameLower:name.toLowerCase()});
     await db.ref(`memberships/${code}/test`).set(true);
    }
    await db.ref('appPresence/MIRA').set({phone:{idle:true,updatedAt:Date.now()},desktop:{idle:false,updatedAt:Date.now()}});
    await db.ref('appPresence/JULES').set({phone:{idle:true,updatedAt:Date.now()}});
    for(let i=0;i<18;i++) await db.ref(`rooms/room${i}`).set({name:`Room ${i+1}`,createdAt:Date.now()});
    for(let i=0;i<18;i++) await db.ref(`memberships/TEST-USER/room${i}`).set(true);
    await db.ref('messages/test/first').set({userCode:'MIRA',username:'Mira',text:'The new space is ready. How does it feel?',createdAt:Date.now()-1000});
    await ChatApp.openRoom('test',{quiet:true});
   });
   await page.waitForFunction(()=>!ChatApp.bulkLoading&&ChatApp.readReceiptState?.key==='first');
   await page.waitForFunction(()=>window.__testDatabase.get('readReceipts/test/first/TEST-USER'));
   assert.equal(await page.locator('.message-seen').count(),1);
   assert.equal(await page.locator('.message-seen-avatar[data-usercode="TEST-USER"]').count(),1);
   assert.equal(await page.evaluate(()=>ChatApp.appPresenceCache.get('MIRA')),'online');
   assert.equal(await page.evaluate(()=>ChatApp.appPresenceCache.get('JULES')),'idle');
   await page.evaluate(async()=>{
    await window.__testDatabase.ref('messages/test/second').set({userCode:'TEST-USER',username:'Tester',text:'Feels good. Let’s try the call controls.',createdAt:Date.now()});
   });
   await page.waitForFunction(()=>ChatApp.readReceiptState?.key==='second');
   assert.equal(await page.locator('[data-msgkey="first"] .message-seen').count(),0);
   await page.waitForFunction(()=>window.__testDatabase.get('readReceipts/test/second/TEST-USER'));
   assert.equal(await page.locator('.message-seen').count(),0,'own receipt remains hidden');
   await page.evaluate(()=>window.__testDatabase.ref('readReceipts/test/second/MIRA').set(Date.now()));
   await page.waitForSelector('[data-msgkey="second"] .message-seen-avatar[data-usercode="MIRA"]');
   await page.screenshot({path:path.join(shots,`${name}-chat.png`)});
   await page.evaluate(()=>{
    ChatApp.currentCallRoomId='test'; ChatApp.callSessionId='qa'; ChatApp.callMuted=false;
    ChatApp.callMembersCache=[{code:'TEST-USER',username:'Tester',connected:true,joinedAt:Date.now()-65000}];
    ChatApp.syncCallButton();ChatApp.syncCallControlsUI();ChatApp.openCallMenu();
   });
   if(name!=='desktop') await page.click('#btn-mobile-nav');
   await page.waitForSelector('.sidebar-dock');
   await page.screenshot({path:path.join(shots,`${name}-sidebar.png`)});
   const dock=await page.locator('.sidebar-dock').boundingBox();
   await page.evaluate(()=>document.querySelector('#side-scroll').scrollTop=99999);
   const after=await page.locator('.sidebar-dock').boundingBox();
   assert.ok(Math.abs(dock.y-after.y)<1,'dock does not scroll with navigation');
   assert.ok(dock.y+dock.height<=options.viewport.height+1,'dock fits viewport');
   assert.equal(await page.locator('#btn-side-collapse').count(),0,'minimized navigation is removed');
   assert.equal(await page.locator('.sidebar-icon-rail .side-label').count(),0,'navigation buttons retain icons without labels');
   const settings=page.locator('#btn-side-settings'); assert.ok(await settings.isVisible());
   await settings.click();
   await page.waitForSelector('#modal:not([hidden])');
   assert.equal(await page.evaluate(()=>ChatApp.callMenuOpen),true,'modals preserve call menu');
   await page.screenshot({path:path.join(shots,`${name}-settings.png`)});
   assert.ok(await page.locator('#settings-tab-profile').isVisible());
   for(const tab of ['appearance','preferences','account']){
    await page.click(`#settings-tab-${tab}`);
    assert.equal(await page.locator(`#settings-pane-${tab}`).getAttribute('hidden'),null);
   }
   await page.evaluate(async()=>{
    await window.__testDatabase.ref('messages/test/third').set({userCode:'MIRA',username:'Mira',text:'This stays unread behind settings.',createdAt:Date.now()+100});
   });
   await page.waitForFunction(()=>ChatApp.readReceiptState?.key==='third');
   await page.waitForTimeout(450);
   assert.equal(await page.evaluate(()=>window.__testDatabase.get('readReceipts/test/third/TEST-USER')),null);
   await page.evaluate(()=>{ChatApp.closeModal();ChatApp.closeCallMenu();ChatApp.closeMobileDrawers();});
   await page.waitForFunction(()=>window.__testDatabase.get('readReceipts/test/third/TEST-USER'));
   await page.evaluate(()=>ChatApp.showSchedulesPage());
   assert.ok(await page.evaluate(()=>Object.keys(window.__testDatabase.get('appPresence/TEST-USER')||{}).length),'presence stays on schedules');
   await page.evaluate(()=>ChatApp.showLoggedInHome());
   assert.ok(await page.evaluate(()=>Object.keys(window.__testDatabase.get('appPresence/TEST-USER')||{}).length),'presence stays on home');
   await page.evaluate(()=>{ChatApp.currentCallRoomId=null;ChatApp.logoutToLanding();});
   await page.waitForFunction(()=>ChatApp.currentUser===null);
   assert.equal(await page.evaluate(()=>Object.keys(window.__testDatabase.get('appPresence/TEST-USER')||{}).length),0);
   assert.deepEqual(errors,[]);
   results.push({name,checks:'presence, receipts, fixed dock, icon navigation, settings, call persistence',errors:0});
   await ctx.close();
  }
 }finally{await browser.close();}
 console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
