/* UI and real iframe keyboard checks against a local database fixture. */
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');const mock=require('./firebase-mock.js');
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(mock);
 await context.route(/^https?:\/\//,r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const captures=path.resolve(__dirname,'../../refinement-v4');fs.mkdirSync(captures,{recursive:true});
 try {
  await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
  await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
  await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
  await page.waitForFunction(()=>ChatApp.currentUser);
  const sideStyles=[];
  for(const side of ['left','right']) {
   await page.evaluate(side=>{ChatApp.applySidebarPosition(side);ChatApp.showLoggedInHome()},side);
   const style=await page.evaluate(()=>{
    const nav=document.querySelector('#sidebar-nav-surface'),active=nav.querySelector('.side-btn.is-selected');
    const indicator=getComputedStyle(active,'::before');
    return {left:indicator.left,right:indicator.right,accountColumns:getComputedStyle(nav.querySelector('.sidebar-account')).gridTemplateColumns,actionDirection:getComputedStyle(nav.querySelector('.sidebar-account-actions')).flexDirection,clockColumns:getComputedStyle(nav.querySelector('.time-display-card')).gridTemplateColumns};
   });
   assert.equal(style.left,'0px');assert.ok(parseFloat(style.right)>100);sideStyles.push(style);
  }
  assert.deepEqual(sideStyles[0],sideStyles[1],'both sidebar positions share internal geometry');
  await page.evaluate(async()=>{
   await __testDatabase.ref('messages/test/one').set({userCode:'TEST-USER',username:'Tester',text:'UI preview',createdAt:Date.now()});
   await ChatApp.openRoom('test',{quiet:true});ChatApp.openTimeDisplayModal();
  });
  await page.locator('#btn-time-display-chat').waitFor({state:'visible'});
  await page.waitForTimeout(300);
  const appearance=()=>page.evaluate(()=>['btn-time-display-chat','btn-time-display-expand','btn-modal-close'].map(id=>{
   const el=document.getElementById(id),s=getComputedStyle(el),r=el.getBoundingClientRect();
   return {width:r.width,height:r.height,bg:s.backgroundColor,border:s.border,radius:s.borderRadius,shadow:s.boxShadow,color:s.color};
  }));
  const controls=await appearance();assert.deepEqual(controls[0],controls[1]);assert.deepEqual(controls[0],controls[2]);
  await page.locator('#modal .modal-card').screenshot({path:path.join(captures,'time-modal.png')});
  await page.click('#btn-modal-close');await page.locator('#modal').waitFor({state:'hidden'});
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:900});await page.evaluate(()=>ChatApp.openRoomActivitiesModal());
   await page.locator('#room-activities-menu').waitFor({state:'visible'});
   const thumbs=await page.locator('.room-activity-thumbnail').evaluateAll(nodes=>nodes.map(el=>{
    const r=el.getBoundingClientRect();return {ratio:r.width/r.height,width:r.width,font:parseFloat(getComputedStyle(el,'::before').fontSize),size:getComputedStyle(el).backgroundSize};
   }));
   assert.ok(thumbs.every(r=>Math.abs(r.ratio-225/126)<.02),'art retains its complete aspect ratio');
   assert.equal(thumbs[0].size,'contain');assert.ok(thumbs[1].font<=thumbs[1].width*.2,'Merge lettering scales with thumbnail');
   await page.locator('#room-activities-menu').screenshot({path:path.join(captures,`activities-${width}.png`)});
   await page.evaluate(()=>ChatApp.closeRoomActivitiesMenu());
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{
   const app=ChatApp;
   app.closeToast();
   app.currentUser.bio='A short profile bio.';app.liveUserCache.set('TEST-USER',app.currentUser);
   app.getScheduleClassmatesForUsername=()=>[{code:'ALICE',username:'Alice'},{code:'BOB',username:'Bob'}];
   app.getConfiguredScheduleUser=username=>({code:username.toUpperCase(),username,displayName:username});
   app.getUserActivityItems=()=>[{kind:'html',label:'Playing Merge Party'}];
   app.openUserProfileAt(document.querySelector('.msg-avatar'),'TEST-USER');
  });
  await page.locator('.user-profile-classmates').waitFor({state:'visible'});
  const profile=await page.evaluate(()=>{
   const block=document.querySelector('.user-profile-classmates'),s=getComputedStyle(block),a=getComputedStyle(document.querySelector('.user-profile-activity'));
   return {padding:parseFloat(s.paddingLeft),background:s.backgroundColor,activityBackground:a.backgroundColor,border:s.borderColor,activityBorder:a.borderColor};
  });
  assert.ok(profile.padding>=12);assert.equal(profile.background,profile.activityBackground);assert.equal(profile.border,profile.activityBorder);
  await page.locator('.user-profile-shell').screenshot({path:path.join(captures,'profile.png')});
  await page.evaluate(()=>ChatApp.closeUserProfile(true));
  await page.evaluate(()=>ChatApp.openMergePartyActivity('test'));
  await page.waitForFunction(()=>document.querySelector('#games-frame')?.contentWindow?.__mergeParty);
  const frame=page.frameLocator('#games-frame');await frame.locator('#playBtn').click();
  await page.keyboard.press('3');
  await page.waitForFunction(()=>document.querySelector('#games-frame').contentWindow.__mergeParty.debug.getState().cup.wallsActive);
  await page.waitForTimeout(1100);await page.keyboard.press('4');
  await page.waitForFunction(()=>document.querySelector('#games-frame').contentWindow.__mergeParty.debug.getState().snipeMode);
  await page.keyboard.press('4');
  // Leave focus in the host as it can be immediately after opening the activity.
  await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus()});await page.keyboard.press('1');
  await page.waitForFunction(()=>document.querySelector('#games-frame').contentWindow.__mergeParty.debug.getState().abilityCounts.swap===1);
  await frame.locator('#activityChatBtn').click();await page.locator('#msg-input').fill('1234');
  assert.equal(await page.evaluate(()=>document.querySelector('#games-frame').contentWindow.__mergeParty.debug.getState().snipeMode),false,'typing in chat cannot activate abilities');
  await page.evaluate(()=>ChatApp.closeGamesStage({preserve:false}));
  assert.deepEqual(errors,[]);console.log('V4 UI and game keyboard checks passed; screenshots:',captures);
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
