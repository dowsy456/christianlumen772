/* Shared composer menus and context menus, using only in-memory Firebase fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..');
const captures = path.resolve(root, '../popover-checks');
const mime = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.svg':'image/svg+xml' };
const server = http.createServer((req,res) => {
  const file=path.resolve(root, '.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if (!file.startsWith(root+path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(error?'':data);});
});
const failures=[];
(async()=>{
  fs.mkdirSync(captures,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  try {
    for (const viewport of [{width:1920,height:1080},{width:390,height:844}]) {
      const context=await browser.newContext({viewport,isMobile:viewport.width<821,hasTouch:viewport.width<821});
      await context.addInitScript(installFirebaseMock);
      await context.route(/^https?:\/\//,route=>route.request().url().startsWith(origin)?route.continue():route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
      const page=await context.newPage();
      page.setDefaultTimeout(4000);
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/index.html');
      await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
      await page.click('#btn-go-login');
      await page.fill('#login-code','TEST-USER');
      await page.click('#btn-login');
      await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
      await page.evaluate(async()=>{
        await __testDatabase.ref('messages/test/menu-fixture').set({userCode:'TEST-USER',username:'Tester',text:'A visible message for context menu checks.',createdAt:Date.now()});
        await ChatApp.openRoom('test',{quiet:true});
        ChatApp.closeToast();
        ChatApp.closeMobileDrawers?.();
        ChatApp.membersListVisible=false;
        ChatApp.syncEmojiButtonVisibility();
      });
      await page.waitForFunction(()=>!ChatApp.bulkLoading&&document.querySelector('.bubble-text'));
      const dismiss=async()=>{
        await page.evaluate(()=>{ChatApp.dismissChatPopovers();ChatApp.closeMsgMenu(true);ChatApp.closeMsgTextMenu(true);getSelection()?.removeAllRanges();});
        await page.waitForTimeout(180);
      };
      const check=async(label,fn)=>{
        try { await fn(); }
        catch(error){
          failures.push(`${label}: ${error.message}`);
          console.error(`${label}: ${error.message.split('\n')[0]}`);
          await page.screenshot({path:path.join(captures,label.replace(/[^\w-]/g,'-')+'.png')}).catch(()=>{});
        }
      };
      const bounds=async(selector)=>{
        await page.locator(selector).waitFor({state:'visible'});
        await page.waitForTimeout(200);
        const geometry=await page.locator(selector).evaluate(el=>{
          const r=el.getBoundingClientRect(),v=window.visualViewport;
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,vLeft:v?.offsetLeft||0,vTop:v?.offsetTop||0,vWidth:v?.width||innerWidth,vHeight:v?.height||innerHeight,pointerEvents:getComputedStyle(el).pointerEvents,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
        });
        assert.ok(geometry.width>0&&geometry.height>0,'menu has usable dimensions');
        assert.ok(geometry.left>=geometry.vLeft-1&&geometry.top>=geometry.vTop-1&&geometry.right<=geometry.vLeft+geometry.vWidth+1&&geometry.bottom<=geometry.vTop+geometry.vHeight+1,`menu fits viewport: ${JSON.stringify(geometry)}`);
        assert.notEqual(geometry.pointerEvents,'none','open menu accepts clicks');
        assert.ok(geometry.scrollWidth<=geometry.clientWidth+2,`no horizontal menu clipping: ${JSON.stringify(geometry)}`);
        return geometry;
      };
      const openTool=async(id)=>{
        await dismiss();
        if (await page.locator(id).getAttribute('data-composer-location')==='overflow') await page.click('#btn-composer-more');
        await page.click(id);
      };
      const surfaces=[];
      const cases=[{mode:'normal',position:'right',width:30},...['left','right'].flatMap(position=>[15,30].map(width=>({mode:'activity',position,width})))];
      for (const scenario of cases) {
        const label=`${viewport.width}-${scenario.mode}-${scenario.position}-${scenario.width}`;
        await dismiss();
        await page.evaluate(async scenario=>{
          ChatApp.applySidebarPosition(scenario.position);
          if(scenario.mode==='activity'&&!ChatApp.gamesStageOpen) await ChatApp.openMergePartyActivity('test');
          ChatApp.activityChatWidth=scenario.width;
          if(scenario.mode==='activity') ChatApp.setActivityChatOpen(true);
          ChatApp.closeToast();
          ChatApp.closeMobileDrawers?.();
          ChatApp.syncActivityChatLayout();
        },scenario);
        await page.waitForTimeout(250);
        if(scenario.mode==='activity') await page.waitForFunction(()=>document.querySelector('#games-frame')?.contentWindow?.__mergeParty);
        await check(label+'-more',async()=>{
          if(await page.locator('#btn-composer-more').isVisible()) {
            await page.click('#btn-composer-more');
            await bounds('#composer-more-menu');
            assert.ok(await page.locator('#composer-more-menu .composer-tool-btn:visible').count()>=2,'More Tools has at least two choices');
          }
        });
        for(const [button,menu,head] of [
          ['#btn-stickers','#sticker-popover','.chat-popup-heading'],
          ['#btn-emoji','#emoji-popover','.chat-popup-heading'],
          ['#btn-voice','#voice-popover','.voice-head'],
          ['#btn-activities','#room-activities-menu','.room-activities-menu-head']
        ]) {
          await check(label+menu,async()=>{
            await openTool(button);
            await bounds(menu);
            const style=await page.locator(menu).evaluate((el,headSelector)=>{
              const s=getComputedStyle(el),h=getComputedStyle(el.querySelector(headSelector));
              return {background:s.backgroundColor,border:s.borderTopColor,borderWidth:s.borderTopWidth,radius:s.borderTopLeftRadius,headBackground:h.backgroundColor,headBorder:h.borderBottomColor,headPadding:h.padding};
            },head);
            const previous=surfaces.find(item=>item.label===label);
            if(previous) assert.deepEqual(style,previous.style,'stickers, voice and activities use the same menu and header design');
            else surfaces.push({label,style});
            if(menu==='#emoji-popover') { assert.ok(await page.locator('.emoji-choice').count()>50); await page.locator('.emoji-search').fill('pizza'); assert.equal(await page.locator('.emoji-choice').count(),1); await page.locator('.emoji-choice').click({button:'right'}); await page.locator('#emoji-ctx-menu').waitFor({state:'visible'}); assert.equal(await page.locator('#emoji-ctx-menu').getAttribute('data-emoji'),'🍕'); await page.evaluate(()=>ChatApp.closeEmojiCtxMenu(true)); await page.locator('.emoji-choice').click(); assert.ok((await page.locator('#msg-input').inputValue()).includes('🍕')); await page.locator('.emoji-search').fill(''); await page.locator('#msg-input').fill(''); }
            if(menu==='#room-activities-menu') { const anchor=await page.locator('#btn-activities').boundingBox(), panel=await page.locator(menu).boundingBox(); assert.ok(panel.y>=anchor.y+anchor.height,'activities menu is anchored below its button');
              assert.ok(!(await page.locator(menu).textContent()).includes('Be the first to play'),'no empty participation filler');
              await page.evaluate(()=>{
                ChatApp.onlinePresenceCache.set('TEST-USER',{roomActivity:{id:'merge-party'}});
                ChatApp.appPresenceCache.set('TEST-USER','online');
                ChatApp.renderRoomActivitiesParticipants();
              });
              assert.equal(await page.locator('.room-activity-player').count(),0,'current user does not appear in own activity card');
              assert.equal(await page.locator('[data-activity-players]:visible').count(),0,'empty participant rows remain hidden');
            }
            if(viewport.width===1920&&scenario.mode==='activity'&&scenario.width===15) await page.screenshot({path:path.join(captures,label+menu+'.png')});
          });
        }
        await dismiss();
        await check(label+'-message-context',async()=>{
          const box=await page.locator('.msg-row').first().boundingBox();
          await page.locator('.msg-row').first().dispatchEvent('contextmenu',{clientX:scenario.position==='left'?1:viewport.width-1,clientY:Math.min(viewport.height-1,box.y+box.height/2)});
          await bounds('#msg-menu');
        });
        await dismiss();
        await check(label+'-text-context',async()=>{
          const selected=await page.locator('.bubble-text').first().evaluate(el=>{
            const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);
            const r=range.getClientRects()[0],point={clientX:r.left+Math.min(3,r.width/2),clientY:r.top+r.height/2};
            const selected=ChatApp.getMessageTextContextSelection(el,point);
            el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,...point}));
            return selected;
          });
          assert.ok(selected,'fixture selects text at the context click position');
          await bounds('#msg-text-menu');
        });
        await dismiss();
        await check(label+'-composer-focus',async()=>{
          await page.locator('#msg-input').click();
          await page.keyboard.type('Draft');
          assert.equal(await page.locator('#msg-input').inputValue(),'Draft','composer remains focusable after opening and dismissing menus');
          await page.locator('#msg-input').fill('');
        });
        console.log(JSON.stringify({scenario:label,failures:failures.length}));
      }
      assert.deepEqual(errors,[],'no runtime page errors');
      await context.close();
    }
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
  assert.deepEqual(failures,[],'popover checks');
  console.log('Shared menu appearance, viewport bounds, participant hiding, and composer focus passed.');
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
