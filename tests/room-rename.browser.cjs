const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const captures = path.resolve(__dirname, '../../rename-checks');
  fs.mkdirSync(captures, { recursive: true });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 600, isMobile: width < 600 });
      await context.addInitScript(mock);
      await context.route(/^https?:\/\//, route => route.fulfill({status:200,contentType:'application/json',body:'null'}));
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
      await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
      await page.click('#btn-go-login'); await page.fill('#login-code','TEST-USER'); await page.click('#btn-login');
      await page.waitForFunction(()=>ChatApp.currentUser);
      await page.evaluate(async()=>{
        await __testDatabase.ref('rooms/1').set({name:'1',createdBy:'TEST-USER',createdAt:Date.now(),messageCount:1});
        await __testDatabase.ref('memberships/TEST-USER/1').set({joinedAt:Date.now()});
        await __testDatabase.ref('messages/1/m').set({text:'Keep this message',userCode:'TEST-USER',createdAt:Date.now()});
        await ChatApp.openRoom('1',{quiet:true}); ChatApp.closeMobileDrawers(); ChatApp.closeToast();
        window.activityRoomNames = [];
        window.__boplRoyaleLaunchConfig = { roomId: '1', roomName: '1' };
        ChatApp.selectedGame = { roomActivityId: 'bopl-royale', roomActivityRoomId: '1' };
        const activityFrame = document.createElement('iframe'); activityFrame.id = 'games-frame'; activityFrame.hidden = true; document.body.appendChild(activityFrame);
        activityFrame.contentWindow.__boplRoyale = { updateRoomDisplayName: name => activityRoomNames.push(name) };
        // Simulate the actual SDK's cold transaction callback and a pending server commit.
        const original=ChatApp.db.ref.bind(ChatApp.db);
        const gate=new Promise(resolve=>window.releaseRename=resolve);
        ChatApp.db.ref=p=>{
          const ref=original(p);
          if(p==='rooms/1') {
            const transaction=ref.transaction.bind(ref);
            ref.transaction=async(update,...args)=>{
              const cold=update(null);
              if(cold===undefined)return {committed:false,snapshot:{val:()=>null}};
              await gate;
              return transaction(update,...args);
            };
          }
          return ref;
        };
        ChatApp.openRoomNameEditor('1');
      });
      await page.waitForFunction(()=>document.querySelector('#modal').classList.contains('is-open'));
      assert.equal(await page.locator('#modal button').filter({hasText:/^(Cancel|Close)$/}).count(),0);
      assert.equal(await page.locator('#btn-modal-close').isVisible(),true);
      await page.fill('#room-name-edit','1f');
      await page.screenshot({path:path.join(captures,`${width}-edit-name.png`)});
      await page.click('#room-name-save');
      await page.waitForFunction(()=>ChatApp.pendingRoomNames.get('1')==='1f');
      assert.equal(await page.evaluate(()=>ChatApp.roomDisplayName('1')),'1f');
      assert.equal(await page.evaluate(()=>activityRoomNames.at(-1)),'1f','Optimistic room names reach an active activity through the existing host metadata flow');
      assert.equal(await page.evaluate(()=>__boplRoyaleLaunchConfig.roomName),'1f');
      assert.equal(await page.evaluate(()=>__boplRoyaleLaunchConfig.roomId),'1','The activity key stays unchanged');
      assert.equal(await page.evaluate(()=>__testDatabase.values.rooms['1'].name),'1','Optimistic label is separate from confirmed database data');
      await page.evaluate(()=>releaseRename());
      await page.waitForFunction(()=>__testDatabase.values.rooms['1'].name==='1f');
      await page.locator('#modal').waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>ChatApp.currentRoomId),'1');
      assert.equal(await page.evaluate(()=>__testDatabase.values.messages['1'].m.text),'Keep this message');
      assert.equal(await page.evaluate(async()=>(await ChatApp.findRoomByName('1F')).id),'1');
      assert.equal(await page.evaluate(()=>ChatApp.pendingRoomNames.size),0);
      await page.evaluate(async()=>{await __testDatabase.ref('rooms/other').set({name:'Taken',createdBy:'OTHER'});await __testDatabase.ref('roomNames/taken').set('other');ChatApp.openRoomNameEditor('1');});
      await page.waitForFunction(()=>document.querySelector('#modal').classList.contains('is-open'));
      await page.fill('#room-name-edit','taken');await page.click('#room-name-save');
      await page.waitForFunction(()=>document.querySelector('#room-name-error')?.textContent.includes('already exists'));
      assert.equal(await page.evaluate(()=>__testDatabase.values.rooms['1'].name),'1f');
      assert.equal(await page.evaluate(()=>activityRoomNames.at(-1)),'1f','A rejected rename restores the canonical name in the activity');
      await page.click('#btn-modal-close');await page.locator('#modal').waitFor({state:'hidden'});
      const ownerCheck=await page.evaluate(async()=>{
        const user=ChatApp.currentUser;
        ChatApp.currentUser={...user,code:'OTHER'};
        try {
          ChatApp.openRoomNameEditor('1');
          const editorHidden=ChatApp.modalEl.hidden;
          try {await ChatApp.renameRoom('1','Forbidden');return {editorHidden,error:''};}
          catch(error){return {editorHidden,error:error.message};}
        } finally {ChatApp.currentUser=user;}
      });
      assert.equal(ownerCheck.editorHidden,true);assert.match(ownerCheck.error,/creator/);
      await page.evaluate(()=>ChatApp.confirmLeaveRoom('1'));
      assert.equal(await page.locator('#toast button').filter({hasText:/^(Cancel|Close)$/}).count(),0);
      await page.click('#btn-toast-close');
      assert.ok(await page.evaluate(()=>__testDatabase.values.memberships['TEST-USER']['1']));
      assert.deepEqual(errors,[]);
      console.log(`PASS numeric rename, cold cache, instant preview, references, duplicates, creator-only edits and single X at ${width}`);
      await context.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
