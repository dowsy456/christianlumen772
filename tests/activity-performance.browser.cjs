/* Real DOM regression and optional old-release comparison; no production data. */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const mock=require('./firebase-mock.js');
(async()=>{
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const source=path.resolve(process.env.CHAT_PERF_SOURCE||path.join(__dirname,'..'));
  const baseline=!!process.env.CHAT_PERF_BASELINE;
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900}});
    await context.addInitScript(mock);
    await context.addInitScript(()=>{
      window.chatDesktopOverlay={version:1,publish(){}};
      window.chatDesktopGames={version:1,setEnabled(){},getSnapshot:async()=>({games:[]}),onChange(cb){window.__games=cb;}};
    });
    await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.join(source,'index.html')).href);
    await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
    await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
    await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
    await page.evaluate(async()=>{
      const A=ChatApp;
      for(let i=0;i<12;i++){
        const code='PEER'+i,name='Friend'+i;
        await A.db.ref('users/'+code).set({username:name,usernameLower:name.toLowerCase(),displayName:name,displayNameLower:name.toLowerCase(),gameActivitySessions:{device:{updatedAt:Date.now(),games:[{id:'game'+i,title:'Game '+i}]}}});
        await A.db.ref('memberships/'+code+'/test').set(true);
        await A.db.ref('roomMembers/test/'+code).set(true);
        await A.db.ref('displayNames/'+name.toLowerCase()).set(code);
      }
      await A.openRoom('test',{quiet:true});
      for(let i=0;i<12;i++)A.ensureLiveUserListener('PEER'+i);
    });
    await page.waitForFunction(()=>Array.from({length:12},(_,i)=>ChatApp.liveUserCache.get('PEER'+i)).every(Boolean));
    await page.waitForTimeout(150);
    const result=await page.evaluate(async()=>{
      const A=ChatApp,counters={};
      for(const name of ['ensureOwnedDisplayNameForUser','refreshRenderedAvatarForUser','renderCallMenu','renderOnlineIndicator','refreshMentionFormattingForRenderedMessages']){
        const fn=A[name];counters[name]=0;A[name]=function(...args){counters[name]++;return fn.apply(this,args);};
      }
      const started=performance.now();
      for(let round=0;round<10;round++){
        await Promise.all(Array.from({length:12},(_,i)=>A.db.ref('users/PEER'+i+'/gameActivitySessions/device/updatedAt').set(Date.now()+round)));
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      await new Promise(resolve=>setTimeout(resolve,80));
      return {heartbeats:120,elapsedMs:Math.round(performance.now()-started),counters};
    });
    if(!baseline){
      for(const name of ['ensureOwnedDisplayNameForUser','refreshRenderedAvatarForUser','renderCallMenu','refreshMentionFormattingForRenderedMessages','renderOnlineIndicator'])assert.equal(result.counters[name],0,`timestamp-only heartbeat must not invoke ${name}`);
      await page.evaluate(()=>ChatApp.db.ref('users/PEER0/gameActivitySessions/device/games').set([{id:'new',title:'Changed Game'}]));
      await page.waitForFunction(()=>ChatApp.getUserActivityItems(ChatApp.liveUserCache.get('PEER0')).some(x=>x.label==='Playing Changed Game'));
      await page.evaluate(()=>ChatApp.db.ref('users/PEER0').update({displayName:'New Name',displayNameLower:'new name'}));
      await page.waitForFunction(()=>ChatApp.liveUserCache.get('PEER0')?.displayName==='New Name');
      assert.match(await page.locator('.members-sidebar .online-ava[data-usercode="PEER0"]').innerText(),/New Name/);
      // A lease may expire while a peer is disconnected, then renew with the
      // same title. Expiration changes rendered state without a user snapshot.
      // Renewing only updatedAt must restore both game and HTML indicators.
      await page.evaluate(async()=>{
        const A=ChatApp;window.__activityClock=A.appPresenceNow;window.__activityNow=Date.now();A.appPresenceNow=()=>window.__activityNow;
        await A.db.ref('users/PEER1/gameActivitySessions/device/updatedAt').set(window.__activityNow-89800);
        await A.db.ref('users/PEER1/htmlActivities').set({browser:{updatedAt:window.__activityNow-89800,items:[{type:'hub',hubId:'resume-html',title:'Resumed HTML'}]}});
        await A.db.ref('users/PEER1/htmlActivitiesVersion').set(1);
      });
      const activity=page.locator('.members-sidebar .online-ava[data-usercode="PEER1"] .member-activity-primary');
      await page.waitForFunction(()=>document.querySelector('.member-row[data-usercode="PEER1"] .member-activity-primary')?.getAttribute('aria-label').includes('Resumed HTML'));
      assert.equal(await activity.isVisible(),true);
      await page.evaluate(()=>{window.__activityNow+=201;});
      await page.waitForFunction(()=>document.querySelector('.member-row[data-usercode="PEER1"] .member-sub')?.hidden===true);
      await page.evaluate(async()=>{
        const ref=ChatApp.db.ref('users/PEER1'),user=(await ref.once('value')).val();
        user.gameActivitySessions.device.updatedAt=window.__activityNow;
        user.htmlActivities.browser.updatedAt=window.__activityNow;
        await ref.set(user);
      });
      await page.waitForFunction(()=>{
        const icon=document.querySelector('.member-row[data-usercode="PEER1"] .member-activity-primary');
        return icon&&!icon.closest('.member-sub').hidden&&icon.getAttribute('aria-label').includes('Game 1')&&icon.getAttribute('aria-label').includes('Resumed HTML');
      });
      assert.equal(await activity.locator('.member-game-icon').count(),2,'HTML and desktop games retain their individual detail rows');
      await page.evaluate(()=>ChatApp.openUserProfileAt(document.querySelector('.member-row[data-usercode="PEER1"]'),'PEER1'));
      const playing=page.locator('.user-profile-activity[data-activity-kind="html"], .user-profile-activity[data-activity-kind="game"]');
      await playing.first().waitFor({state:'visible'});
      assert.equal(await playing.count(),2,'each activity retains its existing profile bubble');
      assert.match((await playing.allInnerTexts()).join(' '),/Game 1/);
      assert.match((await playing.allInnerTexts()).join(' '),/Resumed HTML/);
      assert.equal(await playing.locator('.html-activity-icon svg').count(),2);
      assert.equal(await page.locator('#btn-side-html-hub-icon svg path').getAttribute('d'),await playing.locator('.html-activity-icon svg path').first().getAttribute('d'),'sidebar and profile use the same controller icon');
      await page.evaluate(()=>ChatApp.closeUserProfile(true));
      await page.evaluate(()=>{ChatApp.appPresenceNow=window.__activityClock;});
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({release:baseline?'before':'after',...result},null,2));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
