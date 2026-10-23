const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const mock=require('./firebase-mock.js');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
for(const viewport of [{width:1360,height:900},{width:390,height:844}]){
const context=await browser.newContext({viewport});await context.addInitScript(mock);await context.route(/^https?:\/\//,r=>r.fulfill({status:200,contentType:'application/json',body:'null',headers:{'access-control-allow-origin':'*'}}));
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
await page.evaluate(async()=>{await ChatApp.openRoom('test',{quiet:true});ChatApp.closeToast();ChatApp.closeMobileDrawers();});await page.waitForFunction(()=>ChatApp.roomsMetaCache.has('test'));
await page.evaluate(()=>{const row=document.querySelector('[data-room="test"]')||ChatApp.$('btn-room-plus');ChatApp.openMsgMenuFor(row,{menu:'roomButton',roomId:'test',username:'Test Room',pointerX:120,pointerY:150});});
await page.locator('[data-menu-group="room"]').click();await page.locator('[data-act="editRoomName"]').waitFor({state:'visible'});await page.waitForTimeout(220);
assert.equal(await page.locator('[data-menu-group="room"]').getAttribute('aria-expanded'),'true');
await page.locator('[data-act="editRoomName"]').click();await page.fill('#room-name-edit','Renamed Room');await page.click('#room-name-save');await page.waitForFunction(()=>__testDatabase.values.rooms.test.name==='Renamed Room').catch(async error=>{console.log(await page.evaluate(()=>({error:document.querySelector('#room-name-error')?.textContent, room:__testDatabase.values.rooms.test, pending:[...ChatApp.pendingRoomNames], input:document.querySelector('#room-name-edit')?.value})));throw error;});
assert.equal(await page.evaluate(async()=> (await ChatApp.findRoomByName('RENAMED ROOM')).id),'test');
assert.equal(await page.evaluate(()=>ChatApp.currentRoomId),'test');
assert.equal(await page.evaluate(async()=>{const id=await ChatApp.createNamedRoom('test',{createdBy:ChatApp.currentUser.code});const found=await ChatApp.findRoomByName('TEST');return !!id&&id===ChatApp.sanitizeRoomCode(id)&&found.id===id&&id!=='test';}),true);

await page.evaluate(async()=>{await __testDatabase.ref('rooms/other').set({name:'Taken',createdBy:'OTHER'});await __testDatabase.ref('roomNames/taken').set('other');});
const rejected=await page.evaluate(async()=>{try{await ChatApp.renameRoom('test','taken');return false;}catch{return true;}});assert.equal(rejected,true);
await page.evaluate(()=>{const row=ChatApp.$('btn-room-plus');ChatApp.openMsgMenuFor(row,{menu:'avatar',username:'Tester',imageDataURL:'data:image/png;base64,AA==',bannerDataURL:'data:image/png;base64,AA==',pointerX:100,pointerY:100});});
await page.locator('[data-menu-group="assets"]').click();await page.waitForTimeout(220);assert.equal(await page.locator('[data-act="downloadBanner"]').isVisible(),true);
const box=await page.locator('#msg-menu').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1,JSON.stringify(box));
fs.mkdirSync(path.resolve(__dirname,'../../review'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,`../../review/menus-${viewport.width}.png`)});
await page.evaluate(()=>ChatApp.closeMsgMenu(true));
// Assets belongs to the profile that opened it, even though the menu is
// rendered in a body portal. Expanding and scrolling cannot dismiss its owner.
await page.evaluate(()=>ChatApp.openUserProfileAt(ChatApp.$('btn-composer-more'), 'TEST-USER'));
await page.locator('.user-profile-more:visible').click();await page.waitForTimeout(200);
const menuBefore=await page.locator('#msg-menu').boundingBox();
const sideBefore=await page.locator('#msg-menu').getAttribute('data-context-placement');
const anchorBefore=await page.locator('.user-profile-more:visible').boundingBox();
assert.equal(await page.locator('.msg-menu-chevron').count(),0,'Dropdown labels contain no arrows');
await page.locator('[data-menu-group="assets"]').click();await page.waitForTimeout(240);
assert.equal(await page.evaluate(()=>ChatApp.userProfileOpen&&!ChatApp.userProfileEl.hidden),true,'Expanding assets keeps its user profile open');
const expandedBox=await page.locator('#msg-menu').boundingBox();
const spaceBefore={below:viewport.height-anchorBefore.y-anchorBefore.height-22,above:anchorBefore.y-22,right:viewport.width-anchorBefore.x-anchorBefore.width-22,left:anchorBefore.x-22}[sideBefore];
const needed=sideBefore==='above'||sideBefore==='below'?expandedBox.height:expandedBox.width;
if(needed<=spaceBefore){
 assert.equal(await page.locator('#msg-menu').getAttribute('data-context-placement'),sideBefore,'Menu retains its side when its expanded contents fit');
 if(menuBefore.x+expandedBox.width<=viewport.width-10)assert.ok(Math.abs(expandedBox.x-menuBefore.x)<1,'Expansion preserves horizontal placement when space allows');
}else assert.notEqual(await page.locator('#msg-menu').getAttribute('data-context-placement'),sideBefore,'Growing menu moves to available space instead of retaining a clipped side');
assert.ok(expandedBox.x>=0&&expandedBox.y>=0&&expandedBox.x+expandedBox.width<=viewport.width+1&&expandedBox.y+expandedBox.height<=viewport.height+1);
await page.locator('#msg-menu').evaluate(menu=>menu.scrollTop=menu.scrollHeight);await page.waitForTimeout(60);
assert.equal(await page.evaluate(()=>ChatApp.userProfileOpen),true,'Scrolling profile actions preserves the profile');
await page.evaluate(()=>{ChatApp.closeMsgMenu(true);ChatApp.closeUserProfile(true);});
const changed=await page.evaluate(async()=>{await __testDatabase.ref('calendarReminders/TEST-USER').set({day:{note:true}});await __testDatabase.ref('displayNames/tester').set({code:'TEST-USER'});return await ChatApp.changePassword('NEW-PASS');});assert.equal(changed,'NEW-PASS');
await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER'&&ChatApp.currentUser.password==='NEW-PASS');
const state=await page.evaluate(()=>({old:__testDatabase.values.users['TEST-USER'],member:__testDatabase.values.memberships['TEST-USER']?.test,reminder:__testDatabase.values.calendarReminders['TEST-USER']?.day?.note,display:__testDatabase.values.displayNames.tester.code,flag:ChatApp.passwordChangeInFlight,room:ChatApp.currentRoomId}));
assert.equal(state.old.username,'Tester');assert.ok(state.member);assert.ok(state.reminder);assert.equal(state.display,'TEST-USER');assert.equal(state.flag,false);assert.equal(state.room,'test');
await page.evaluate(async()=>{const hash=await ChatApp.sha256Hex('TAKEN-PASS');await __testDatabase.ref('users/OTHER').set({username:'Other',credentialHash:hash});await __testDatabase.ref(`credentials/${hash}`).set('OTHER');});
assert.equal(await page.evaluate(async()=>{try{await ChatApp.changePassword('TAKEN-PASS');return '';}catch(e){return e.message;}}),'Error. Try a different password');
assert.deepEqual(errors,[]);await context.close();console.log(`PASS room menus, rename, duplicate, stable password update at ${viewport.width}`);
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});

