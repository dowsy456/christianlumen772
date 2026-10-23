/* UI regressions use in-memory fixtures; remote requests are blocked. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const installFirebaseMock=require('./firebase-mock.js');
const captures=process.env.CHAT_UI_CAPTURES||path.resolve(__dirname,'../../ui-v3-checks');
async function checkChatReliability(browser) {
  for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    const context=await browser.newContext({viewport});
    await context.addInitScript(installFirebaseMock);
    await context.addInitScript(() => {
      const nativeFetch = window.fetch;
      window.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.href || input.url, location.href);
        if (url.hostname.endsWith('firebaseio.com') && url.searchParams.get('shallow') === 'true') {
          (window.__databaseReads ||= []).push(url.pathname);
          if (window.__databaseReadDelay) await new Promise(resolve => setTimeout(resolve, window.__databaseReadDelay));
          if (url.pathname === window.__databaseFailurePath) return new Response('Unavailable', {status:503});
          const value = __testDatabase.get(decodeURIComponent(url.pathname.replace(/^\//,'').replace(/\.json$/,'')));
          const shallow = value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key=>key!=='.info').map(key=>[key,true])) : value;
          return new Response(JSON.stringify(shallow), {status:200,headers:{'content-type':'application/json'}});
        }
        return nativeFetch(input,options);
      };
    });
    await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',body:'null'}));
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
    await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
    await page.click('#btn-go-login'); await page.fill('#login-code','TEST-USER'); await page.click('#btn-login');
    await page.waitForFunction(()=>ChatApp.currentUser);
    await page.evaluate(async()=>{
      await ChatApp.openRoom('test',{quiet:true}); ChatApp.closeToast(); ChatApp.closeMobileDrawers();
      await __testDatabase.ref('messages/test/formatting').set({userCode:'TEST-USER',username:'Tester',createdAt:Date.now(),text:'# Heading\n## Medium\n### Small\n-# Subtext\n#not-a-heading\nhttps://example.test/path?q=1&x=2.\n`https://example.test/code`\n<script>bad</script>'});
    });
    await page.locator('.message-heading-1').waitFor();
    assert.equal(await page.locator('.message-heading').count(),3);
    assert.equal(await page.locator('.message-subtext').textContent(),'Subtext');
    assert.equal(await page.locator('[data-message-url]').count(),1,'code URLs are inert and unsafe text is escaped');
    assert.equal(await page.locator('[data-message-url]').getAttribute('href'),null,'Message links have no browser navigation shortcut before confirmation');
    assert.equal(await page.evaluate(()=>{const div=document.createElement('div'); div.innerHTML=ChatApp.formatTextWithMentions('"https://example.test/quoted"'); return div.querySelector('[data-message-url]').dataset.messageUrl;}),'https://example.test/quoted');
    assert.equal(await page.locator('.bubble-text script').count(),0);
    await page.locator('[data-message-url]').click();
    await page.locator('.message-url-popup.open').waitFor();
    assert.equal(await page.locator('.message-url-popup .chat-popup-close').count(),1);
    assert.equal(await page.locator('[data-url-open]').getAttribute('href'),'https://example.test/path?q=1&x=2');
    await page.evaluate(()=>{ChatApp.copyTextToClipboard=async text=>{window.__copiedURL=text;};});
    await page.click('[data-url-copy]');
    assert.equal(await page.evaluate(()=>window.__copiedURL),'https://example.test/path?q=1&x=2');
    const linkBounds=await page.locator('.message-url-popup').boundingBox();
    assert.ok(linkBounds.x>=0&&linkBounds.x+linkBounds.width<=viewport.width+1);
    await page.screenshot({path:path.join(captures,viewport.width+'-url-confirmation.png')});
    await page.locator('.message-url-popup .chat-popup-close').click();
    await page.evaluate(async()=>{
      await __testDatabase.ref('users/TEST-USER/username').set('Vinny'); ChatApp.currentUser.username='Vinny';
      await __testDatabase.ref('editorFixture').set({greeting:'Hello',multiline:'Line 1\r\nLine 2\nLine 3',enabled:true,count:3,branch:{nested:'Visible'}});
      ChatApp.openAdminPanel();
    });
    assert.equal(await page.locator('#panel-save-update-url').count(),0);
    assert.equal(await page.locator('#btn-panel-refresh, #modal-body-actions').count(),0,'Admin Tools has no redundant Refresh footer');
    await page.fill('#panel-update-url','https://example.test/chat.exe');
    await page.waitForFunction(()=>__testDatabase.get('admin/desktopUpdate')?.url==='https://example.test/chat.exe');
    await page.fill('#panel-update-url','javascript:alert(1)');
    await page.waitForFunction(()=>document.querySelector('#panel-update-status').textContent.includes('HTTPS'));
    assert.equal(await page.evaluate(()=>__testDatabase.get('admin/desktopUpdate').url),'https://example.test/chat.exe');
    await page.fill('#panel-update-url','');
    await page.waitForFunction(()=>!__testDatabase.get('admin/desktopUpdate'));
    for (const failFirst of [false,true]) {
      await page.evaluate(failFirst=>{
        window.__realSetNativeURL=ChatApp.setNativeUpdateURL;
        window.__nativeURLWrites=[]; window.__releaseNativeURL=null;
        ChatApp.setNativeUpdateURL=async value=>{
          __nativeURLWrites.push(value);
          if(value==='https://example.test/held.exe') {
            await new Promise(resolve=>window.__releaseNativeURL=resolve);
            if(failFirst) throw new Error('Temporary Connection Failure');
          }
          return __realSetNativeURL(value);
        };
      },failFirst);
      await page.fill('#panel-update-url','https://example.test/held.exe'); await page.press('#panel-update-url','Enter');
      await page.waitForFunction(()=>typeof __releaseNativeURL==='function');
      await page.fill('#panel-update-url','https://example.test/closed-draft.exe'); await page.press('#panel-update-url','Enter');
      await page.click('#btn-modal-close'); await page.locator('#modal').waitFor({state:'hidden'});
      await page.evaluate(()=>ChatApp.openAdminPanel());
      assert.equal(await page.inputValue('#panel-update-url'),'https://example.test/closed-draft.exe','Reopening preserves the newest pending draft');
      await page.fill('#panel-update-url','https://example.test/newest.exe'); await page.press('#panel-update-url','Enter');
      await page.evaluate(()=>__releaseNativeURL());
      await page.waitForFunction(()=>__testDatabase.get('admin/desktopUpdate')?.url==='https://example.test/newest.exe'&&!ChatApp.nativeUpdateURLSaveState.running);
      assert.deepEqual(await page.evaluate(()=>__nativeURLWrites),['https://example.test/held.exe','https://example.test/newest.exe'],'The old editor cannot save an obsolete draft after the new editor, including after a failed first save');
      assert.equal(await page.inputValue('#panel-update-url'),'https://example.test/newest.exe','Acknowledgement of an older save cannot replace the current draft');
      assert.equal(await page.getAttribute('#panel-update-url','data-dirty'),'0');
      await page.evaluate(()=>{ChatApp.setNativeUpdateURL=__realSetNativeURL;});
    }
    await page.fill('#panel-update-url',''); await page.press('#panel-update-url','Enter');
    await page.waitForFunction(()=>!__testDatabase.get('admin/desktopUpdate'));
    const branch=page.locator('[data-db-node="editorFixture"]');
    await branch.locator(':scope > .database-row [data-db-action="toggle"]').click();
    const multiline=page.locator('[data-db-node="editorFixture/multiline"] > .database-row .database-value');
    await multiline.focus(); await multiline.press('Tab');
    assert.equal(await page.evaluate(()=>__testDatabase.get('editorFixture/multiline')),'Line 1\r\nLine 2\nLine 3','Focus and blur preserve exact multiline data without any write');
    const input=page.locator('[data-db-node="editorFixture/greeting"] > .database-row .database-value');
    await input.waitFor(); await input.fill('Edited Inline'); await input.press('Enter');
    await page.waitForFunction(()=>__testDatabase.get('editorFixture/greeting')==='Edited Inline');
    await input.focus(); await page.evaluate(()=>__testDatabase.ref('editorFixture/greeting').set('Concurrent Edit'));
    await input.fill('Stale Draft'); await input.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-db-status]').textContent.includes('changed elsewhere'));
    assert.equal(await page.evaluate(()=>__testDatabase.get('editorFixture/greeting')),'Concurrent Edit');
    await branch.locator(':scope > .database-row [data-db-action="add"]').click();
    await branch.locator(':scope > .database-add [name="key"]').fill('added');
    await branch.locator(':scope > .database-add [name="value"]').fill('New Value');
    await branch.locator(':scope > .database-add [type="submit"]').click();
    await page.waitForFunction(()=>__testDatabase.get('editorFixture/added')==='New Value');
    await page.waitForFunction(()=>ChatApp.adminDatabase.nodes.get('editorFixture/branch')?.loaded);
    await page.evaluate(async()=>{
      await __testDatabase.ref('editorFixture/branch/second').set('New collapsed child');
      window.__databaseReads=[]; window.__databaseReadDelay=75;
    });
    await page.click('[data-db-action="refresh"]');
    assert.equal(await page.locator('[data-db-status]').textContent(),'Refreshing…','Refresh shows immediate loading feedback');
    assert.equal(await page.locator('[data-db-action="refresh"]').isDisabled(),true);
    await page.waitForFunction(()=>!ChatApp.adminDatabase.refreshPromise);
    assert.equal(await page.locator('[data-db-status]').textContent(),'','Successful refresh leaves no timestamp or redundant status');
    assert.equal(await page.locator('[data-db-node="editorFixture/branch"] > .database-row .database-count').textContent(),'{2}','Refresh updates collapsed visible branches');
    assert.equal(await page.locator('[data-db-action="refresh"]').isEnabled(),true);
    assert.equal(await page.evaluate(()=>__databaseReads.some(path=>path.includes('/editorFixture/branch/'))),false,'Refresh never descends into a collapsed branch');
    await page.evaluate(()=>{window.__databaseReadDelay=0;});
    await page.click('[data-db-action="expand"]');
    assert.equal(await page.evaluate(()=>document.fullscreenElement),null,'Enlargement does not use browser fullscreen');
    const bounds=await page.locator('#modal .modal-card').boundingBox();
    assert.ok(bounds.width>=viewport.width-2&&bounds.height>=viewport.height-2,'database fills the app window');
    assert.deepEqual(await page.locator('.database-actions > button').evaluateAll(buttons=>buttons.map(button=>button.dataset.dbAction || button.id)),['refresh','expand','btn-modal-close'],'Expanded viewer has one toolbar with Close last');
    await page.screenshot({path:path.join(captures,viewport.width+'-database-expanded.png')});
    await page.click('[data-db-action="expand"]');
    assert.equal(await page.locator('#modal').evaluate(el=>el.classList.contains('database-expanded')),false);
    assert.equal(await page.locator('.modal-head-actions > #btn-modal-close').count(),1,'Collapse restores the standard modal close control');
    await page.evaluate(()=>{window.__databaseFailurePath='/editorFixture/branch.json';});
    await page.click('[data-db-action="refresh"]');
    await page.waitForFunction(()=>document.querySelector('[data-db-status]').textContent.startsWith('Refresh incomplete'));
    assert.equal(await page.locator('[data-db-action="refresh"]').isEnabled(),true,'Failed refresh can be retried');
    await page.evaluate(()=>{window.__databaseFailurePath='';});
    await page.click('[data-db-action="refresh"]');
    await page.waitForFunction(()=>!ChatApp.adminDatabase.refreshPromise);
    assert.equal(await page.locator('[data-db-status]').textContent(),'','A successful retry clears the earlier refresh error');
    await page.click('[data-db-action="expand"]');
    await page.click('#btn-modal-close');
    await page.waitForFunction(()=>!ChatApp.adminDatabase);
    assert.equal(await page.locator('.modal-head-actions > #btn-modal-close').count(),1,'Closing an expanded database preserves Close for the next modal');
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log('Heading/subtext, URL confirmation/copy, URL autosave, inline tree editing/conflicts/addition/enlargement passed at desktop/mobile sizes.');
}
(async()=>{
  fs.mkdirSync(captures,{recursive:true});
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  try {
    await checkChatReliability(browser);
    if(process.env.CHAT_RELIABILITY_ONLY==='1') return;
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
      const context=await browser.newContext({viewport,isMobile:viewport.width<821,hasTouch:viewport.width<821});
      await context.addInitScript(installFirebaseMock);
      await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
      const page=await context.newPage();
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
      await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
      await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
      await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
      await page.evaluate(async()=>{
        for(let i=0;i<8;i++) {
          const id=`visual-sticker-${i}`,color=['#60b3e8','#f5ac59','#8bceaa','#a69cdf'][i%4];
          const dataURL='data:image/svg+xml;base64,'+btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="45" fill="${color}"/><circle cx="45" cy="48" r="5" fill="#1b2937"/><circle cx="75" cy="48" r="5" fill="#1b2937"/><path d="M40 72q20 20 40 0" fill="none" stroke="#1b2937" stroke-width="5" stroke-linecap="round"/></svg>`);
          await __testDatabase.ref(`stickers/meta/${id}`).set({id,name:`Smile ${i+1}`,kind:'image',mimeType:'image/svg+xml',state:'ready',creatorCode:'TEST-USER',creatorUsername:'Tester',createdAt:i+1});
          await __testDatabase.ref(`stickers/assets/${id}`).set({dataURL});
          await __testDatabase.ref(`stickerCollections/TEST-USER/${id}`).set({savedAt:i+1});
        }
        await ChatApp.openRoom('test',{quiet:true});ChatApp.closeToast();ChatApp.closeMobileDrawers();ChatApp.prepareStickerPicker();
      });
      await page.waitForFunction(()=>ChatApp.stickerLibraryMeta.size===8&&!ChatApp.bulkLoading);
      await page.evaluate(async()=>{
        await __testDatabase.ref('htmlHub/meta/ui-title-case').set({title:'The story of Terror',ownerCode:'TEST-USER',ownerUsername:'Tester',fileName:'story.html',byteSize:1024,createdAt:Date.now()});
        await ChatApp.openHtmlHubModal();
      });
      await page.locator('.html-hub-card-title').waitFor();
      assert.equal(await page.locator('.html-hub-card-title').first().textContent(),'The Story of Terror');
      assert.equal(await page.evaluate(()=>__testDatabase.get('htmlHub/meta/ui-title-case').title),'The story of Terror','Title casing is presentation only and preserves the saved title');
      assert.deepEqual(await page.locator('.html-hub-nav-item > span:first-child').allTextContents(),['Shared Files','New HTML File','Open Unsaved File']);
      assert.equal(await page.locator('.html-hub-card-main').first().evaluate(el=>{
        const probe=document.createElement('div');probe.style.background='var(--ui-panel)';document.body.append(probe);
        const matches=getComputedStyle(el).backgroundColor===getComputedStyle(probe).backgroundColor;probe.remove();return matches;
      }),true,'Hub cards use the shared application panel surface');
      const hubBounds=await page.locator('#modal .modal-card').boundingBox();
      assert.ok(hubBounds.x>=0&&hubBounds.y>=0&&hubBounds.x+hubBounds.width<=viewport.width+1&&hubBounds.y+hubBounds.height<=viewport.height+1,'HTML Hub fits the viewport');
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('#modal')).opacity==='1'&&getComputedStyle(document.querySelector('#modal .modal-card')).opacity==='1');
      await page.screenshot({path:path.join(captures,`${viewport.width}-html-hub.png`)});
      await page.click('#html-hub-add-btn');
      await page.locator('#html-hub-title-input').waitFor();
      assert.equal(await page.locator('.html-hub-content-head h3').textContent(),'Add an HTML File');
      assert.equal(await page.locator('#html-hub-file-pick').textContent(),'Choose File');
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('#modal')).opacity==='1'&&getComputedStyle(document.querySelector('#modal .modal-card')).opacity==='1');
      await page.screenshot({path:path.join(captures,`${viewport.width}-html-hub-add.png`)});
      await page.click('#btn-modal-close');
      await page.locator('#modal').waitFor({state:'hidden'});
      // Pins and filters work without an active search, including retained pins
      // whose originals were removed when the room's history was cleared.
      await page.evaluate(async()=>{
        const message={userCode:'TEST-USER',username:'Tester',text:'Pinned navigation target',createdAt:Date.now()-60000,pinned:true};
        await __testDatabase.ref('messages/test/pin-target').set(message);
        await __testDatabase.ref('pinnedMessages/test/pin-target').set(message);
        ChatApp.openRoomSearch();
      });
      assert.equal(await page.locator('#room-search-status').textContent(),'Filters');
      const filtersFont=await page.locator('#room-search-status').evaluate(el=>{const s=getComputedStyle(el);return {size:s.fontSize,weight:s.fontWeight,color:s.color}});
      await page.evaluate(()=>{ChatApp.liveUserCache.set('FILTER-USER',{code:'FILTER-USER',username:'Filter User',photoDataURL:ChatApp.defaultStickmanDataURL()});});
      await page.locator('#room-search-filters [data-filter="from:"]').click();
      await page.locator('#room-search-suggestions button').first().waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>{
        const users=document.querySelector('#room-search-suggestions').getBoundingClientRect(),filters=document.querySelector('#room-search-filters').getBoundingClientRect();
        const button=document.querySelector('#room-search-suggestions button'),avatar=button.firstElementChild.getBoundingClientRect(),name=button.lastElementChild.getBoundingClientRect();
        return users.bottom<=filters.top && avatar.right<=name.left && Math.abs((avatar.top+avatar.bottom-name.top-name.bottom)/2)<1;
      }),true,'Filter suggestions precede categories and align avatars left of usernames');
      await page.waitForFunction(()=>getComputedStyle(document.getElementById('room-search-panel')).opacity==='1');
      await page.locator('#room-search-panel').screenshot({path:path.join(captures,`${viewport.width}-filter-users.png`)});
      await page.locator('#room-search-input').fill('');
      await page.waitForFunction(()=>getComputedStyle(document.getElementById('room-search-panel')).opacity==='1');
      await page.locator('#room-search-panel').screenshot({path:path.join(captures,`${viewport.width}-filters.png`)});
      for (const close of ['button','escape','outside']) {
        await page.locator('#room-search-input').fill('from: Tester');
        if(close==='button') await page.click('#room-search-close');
        else if(close==='escape') await page.locator('#room-search-input').press('Escape');
        else await page.click('#msg-input');
        assert.equal(await page.inputValue('#room-search-input'),'','Closing filters clears the search for '+close);
        assert.equal(await page.locator('#room-search-panel').isHidden(),true);
      }
      await page.locator('#room-search-input').focus();
      assert.equal(await page.locator('#room-search-status').textContent(),'Filters','Reopening filters starts with an empty query');
      await page.evaluate(()=>{ChatApp.closeRoomSearch();ChatApp.openPinnedMessages()});
      await page.locator('.pinned-message-jump').waitFor({state:'visible'});
      assert.deepEqual(await page.locator('.pinned-message-actions button').allTextContents(),['Jump','Unpin']);
      assert.equal(await page.locator('.pinned-message-actions').evaluate(actions=>{
        const [jump,unpin]=[...actions.children].map(button=>button.getBoundingClientRect()),preview=actions.previousElementSibling.getBoundingClientRect();
        return unpin.top>=jump.bottom && Math.abs(unpin.left-jump.left)<1 && actions.getBoundingClientRect().left>=preview.right;
      }),true,'Unpin sits directly beneath Jump in the right action column');
      assert.deepEqual(await page.locator('#pinned-messages-panel .room-search-panel-head strong').evaluate(el=>{const s=getComputedStyle(el);return {size:s.fontSize,weight:s.fontWeight,color:s.color}}),filtersFont,'Filters and Pinned Messages use matching heading typography');
      await page.locator('#pinned-messages-panel').screenshot({path:path.join(captures,`${viewport.width}-pins.png`)});
      await page.evaluate(()=>{ChatApp.msgElByKey.get('pin-target')?.remove();ChatApp.msgElByKey.delete('pin-target');ChatApp.msgDataByKey.delete('pin-target');ChatApp.renderedMsgKeys.delete('pin-target');});
      await page.locator('.pinned-message-jump').click();
      await page.locator('#pinned-messages-panel').waitFor({state:'hidden'});
      assert.equal(await page.locator('#messages-inner [data-msgkey="pin-target"]').count(),1);
      await page.evaluate(async()=>{
        await __testDatabase.ref('messages/test/pin-target').remove();
        ChatApp.openPinnedMessages();
      });
      await page.locator('.pinned-message-jump').waitFor({state:'visible'});
      await page.locator('.pinned-message-jump').click();
      await page.locator('#pinned-messages-panel').waitFor({state:'hidden'});
      await page.waitForTimeout(80);
      assert.equal(await page.locator('#messages-inner [data-msgkey="pin-target"]').count(),1,'retained pinned message can be displayed after its original was cleared');
      assert.equal(await page.evaluate(()=>__testDatabase.get('messages/test/pin-target')),null,'jump never restores a cleared message into the database');
      if(process.env.CHAT_REQUESTED_UI_ONLY==='1') {assert.deepEqual(errors,[]);await context.close();continue;}
      await page.evaluate(async()=>{
        const replyTo={key:'pin-target',userCode:'TEST-USER',username:'Tester',previewText:'Pinned navigation target'};
        await __testDatabase.ref('messages/test/reply-layout').set({userCode:'TEST-USER',username:'Tester',text:'Reply preview stays above the sender avatar.',createdAt:Date.now(),replyTo});
        await __testDatabase.ref('messages/test/audio-layout').set({userCode:'TEST-USER',username:'Tester',createdAt:Date.now()+1,files:[{kind:'audio',isVoiceMessage:true,fileName:'Voice Message',mimeType:'audio/webm;codecs=opus',dataURL:'data:audio/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC'}]});
      });
      await page.locator('#messages-inner [data-msgkey="reply-layout"]').waitFor();
      await page.locator('#messages-inner [data-msgkey="audio-layout"] .chat-audio-player').waitFor();
      assert.equal(await page.locator('.chat-audio-player-sub').count(),0,'audio controls never display raw MIME labels');
      const replyGeometry=await page.locator('#messages-inner [data-msgkey="reply-layout"]').evaluate(row=>{
        const avatar=row.querySelector(':scope > .msg-avatar').getBoundingClientRect(),preview=row.querySelector('.reply-preview').getBoundingClientRect(),line=getComputedStyle(row.querySelector('.reply-preview'),'::before');
        return {previewBottom:preview.bottom,avatarTop:avatar.top,connectorX:preview.left+parseFloat(line.left),avatarCenter:avatar.left+avatar.width/2};
      });
      assert.ok(replyGeometry.previewBottom<=replyGeometry.avatarTop,`${viewport.width}: reply sits above avatar: ${JSON.stringify(replyGeometry)}`);
      assert.ok(Math.abs(replyGeometry.connectorX-replyGeometry.avatarCenter)<1,'reply connector is centered over avatar');
      await page.locator('#messages-inner [data-msgkey="reply-layout"]').screenshot({path:path.join(captures,`${viewport.width}-reply.png`)});
      if(viewport.width===1440) {
        await page.locator('#messages-inner [data-msgkey="reply-layout"]').evaluate(row=>row.style.maxWidth='280px');
        const compact=await page.locator('#messages-inner [data-msgkey="reply-layout"]').evaluate(row=>{const avatar=row.querySelector(':scope > .msg-avatar').getBoundingClientRect(),preview=row.querySelector('.reply-preview').getBoundingClientRect();return preview.bottom<=avatar.top});
        assert.equal(compact,true,'compact replies stay above the sender avatar');
        await page.locator('#messages-inner [data-msgkey="reply-layout"]').screenshot({path:path.join(captures,'280-reply.png')});
        await page.locator('#messages-inner [data-msgkey="reply-layout"]').evaluate(row=>row.style.removeProperty('max-width'));
      }
      await page.evaluate(()=>ChatApp.openEmojiPopover());
      await page.locator('.emoji-choice').first().waitFor();
      await page.waitForTimeout(250);
      const emojiSwitch=await page.evaluate(async()=>{
        const buttons=[...document.querySelectorAll('.emoji-category')],first=document.querySelector('.emoji-choice'),scroll=document.querySelector('.emoji-results');
        const dimensions=scroll.getBoundingClientRect();let maximum=0;
        for(const button of buttons) {const started=performance.now();button.click();maximum=Math.max(maximum,performance.now()-started);await new Promise(requestAnimationFrame);}
        buttons[0].click();
        return {reused:first===document.querySelector('.emoji-choice'),maximum,height:scroll.getBoundingClientRect().height,initialHeight:dimensions.height};
      });
      assert.equal(emojiSwitch.reused,true,'category buttons are cached and reused');
      assert.ok(emojiSwitch.maximum<50,`emoji category switches avoid long tasks: ${JSON.stringify(emojiSwitch)}`);
      assert.equal(emojiSwitch.height,emojiSwitch.initialHeight,'category switches keep popover height stable');
      console.log(`${viewport.width}px emoji category maximum handler: ${emojiSwitch.maximum.toFixed(2)}ms`);
      await page.locator('.emoji-choice').nth(3).hover();
      const emojiGeometry=await page.locator('.emoji-choice').nth(3).evaluate(button=>{const b=button.getBoundingClientRect(),glyph=button.querySelector('.emoji-glyph').getBoundingClientRect();return {dx:Math.abs((b.left+b.right-glyph.left-glyph.right)/2),dy:Math.abs((b.top+b.bottom-glyph.top-glyph.bottom)/2)};});
      assert.ok(emojiGeometry.dx<.6&&emojiGeometry.dy<.6,`emoji is centered in its hover target: ${JSON.stringify(emojiGeometry)}`);
      await page.locator('#emoji-popover').screenshot({path:path.join(captures,`${viewport.width}-emoji-hover.png`)});
      await page.locator('.emoji-search').fill('dog');
      assert.ok(await page.locator('.emoji-choice').count()>0);
      await page.locator('.emoji-choice').first().click();
      assert.ok(await page.locator('#msg-input').inputValue(),'cached/search emoji insertion remains functional');
      await page.evaluate(()=>{ChatApp.closeEmojiPopover();ChatApp.$('msg-input').value='';});
      const roomHeader = await page.evaluate(() => {
        const buttons = ['btn-room-plus','rooms-mode-toggle'].map(id => {
          const button = document.getElementById(id), rect = button.getBoundingClientRect(), style = getComputedStyle(button);
          return {width:rect.width,height:rect.height,center:rect.top+rect.height/2,border:style.border,radius:style.borderRadius,background:style.backgroundColor};
        });
        return buttons;
      });
      assert.equal(roomHeader[0].width, roomHeader[1].width, 'room create/join and visibility buttons have matching widths');
      assert.equal(roomHeader[0].height, roomHeader[1].height, 'room header actions have matching heights');
      assert.ok(Math.abs(roomHeader[0].center-roomHeader[1].center)<.6, 'room header actions align vertically');
      assert.equal(roomHeader[0].border, roomHeader[1].border);
      assert.equal(roomHeader[0].radius, roomHeader[1].radius);
      assert.equal(roomHeader[0].background, roomHeader[1].background);
      if(viewport.width===1440) {
        await page.locator('#btn-members').hover();
        await page.locator('#sidebar-tooltip.is-visible').waitFor({state:'visible'});
        assert.equal(await page.locator('#sidebar-tooltip').textContent(), 'Members');
        assert.equal(await page.locator('#btn-members').evaluate(button=>getComputedStyle(button,'::after').display), 'none', 'toolbar uses only the shared tooltip');
        await page.mouse.move(1,1);
      }
      const iconGeometry=async selector=>{
        await page.locator(selector).waitFor({state:'visible'});
        const geometry=await page.locator(selector).evaluate(button=>{
          const b=button.getBoundingClientRect(),svg=button.querySelector('svg'),i=svg?.getBoundingClientRect();
          return {width:b.width,height:b.height,iconWidth:i?.width,iconHeight:i?.height,dx:i?Math.abs((b.left+b.right-i.left-i.right)/2):999,dy:i?Math.abs((b.top+b.bottom-i.top-i.bottom)/2):999,text:button.textContent.trim()};
        });
        const targetSize = selector.startsWith('#activity-chat-') ? 32 : 40;
        assert.ok(geometry.width>=targetSize&&geometry.height>=targetSize,`${selector} has a full-size click target`);
        assert.ok(geometry.iconWidth>=20&&geometry.iconHeight>=20,`${selector} uses a legible SVG`);
        assert.ok(geometry.dx<.6&&geometry.dy<.6,`${selector} centered: ${JSON.stringify(geometry)}`);
        assert.equal(geometry.text,'',`${selector} has no text-glyph fallback`);
      };
      for(const [open,menu,close] of [['openStickerPopover','#sticker-popover','#btn-sticker-menu-close'],['openVoicePopover','#voice-popover','#btn-voice-close'],['openRoomActivitiesModal','#room-activities-menu','#room-activities-close']]) {
        await page.evaluate(name=>ChatApp[name](),open);
        await page.waitForTimeout(250);await iconGeometry(close);
        await page.locator(menu).screenshot({path:path.join(captures,`${viewport.width}-${open}.png`)});
        assert.equal(await page.locator(menu+' .voice-subtitle, '+menu+' .chat-popup-heading-copy > span').count(),0,'sticker and voice headers do not include helper subtitles');
        await page.click(close);await page.locator(menu).waitFor({state:'hidden'});
      }
      if(process.env.CHAT_UI_FOCUSED==='1') {assert.deepEqual(errors,[]);await context.close();continue;}
      await page.evaluate(()=>{
        ChatApp.currentCallRoomId='test';ChatApp.callSessionId='ui-fixture';
        ChatApp.callMembersCache=[{code:'TEST-USER',username:'Tester',displayName:'Tester',joinedAt:Date.now()-60000,connected:true}];
        ChatApp.syncCallControlsUI();ChatApp.openCallMenu();
      });
      await page.waitForTimeout(250);
      {
        await page.evaluate(()=>{if(document.body.dataset.mobileUi==='1')document.body.dataset.mobileNav='1';});
        await page.waitForTimeout(300);
        const leave=await page.evaluate(()=>{
          const values=id=>{const b=document.getElementById(id),s=getComputedStyle(b),svg=b.querySelector('svg'),r=svg.getBoundingClientRect(),box=b.getBoundingClientRect();return {bg:s.backgroundColor,color:s.color,border:s.borderTopColor,width:r.width,dx:Math.abs((r.left+r.right-box.left-box.right)/2),dy:Math.abs((r.top+r.bottom-box.top-box.bottom)/2),path:svg.innerHTML};};
          return {call:values('btn-call-leave'),side:values('btn-sidebar-call-leave')};
        });
        assert.equal(leave.call.bg,leave.side.bg,'Leave has the same filled treatment in panel and dock');
        assert.equal(leave.call.color,leave.side.color,'Leave icon colors match');
        assert.equal(leave.call.path,leave.side.path,'Leave uses one receiver drawing');
        for(const icon of [leave.call,leave.side])assert.ok(icon.width>=20&&icon.dx<.6&&icon.dy<.6,'Leave icon remains legible and centered');
        if(viewport.width===1440)await page.locator('#sidebar-nav-surface').screenshot({path:path.join(captures,'sidebar-call.png')});
      }
      await page.evaluate(() => {
        ChatApp.callToggleShareScreen = async () => { ChatApp.callSharing=!ChatApp.callSharing; ChatApp.syncCallControlsUI(); };
        ChatApp.callToggleCamera = async () => { ChatApp.callCameraSharing=!ChatApp.callCameraSharing; ChatApp.syncCallControlsUI(); };
        ChatApp.toggleSidebarMediaMenu();
      });
      await page.locator('#sidebar-media-menu').waitFor({state:'visible'});
      assert.equal(await page.locator('#sidebar-media-menu [data-call-media]').count(),2);
      await page.locator('#sidebar-media-menu [data-call-media="share"]').click();
      assert.equal(await page.locator('#sidebar-media-menu [data-call-media="share"]').getAttribute('aria-checked'),'true');
      await page.evaluate(() => ChatApp.toggleSidebarMediaMenu());
      await page.locator('#sidebar-media-menu [data-call-media="camera"]').click();
      assert.equal(await page.locator('#sidebar-media-menu [data-call-media="camera"]').getAttribute('aria-checked'),'true');
      await page.evaluate(() => ChatApp.toggleSidebarMediaMenu());
      await page.locator('#sidebar-media-menu [data-call-media="share"]').click();
      assert.equal(await page.locator('#sidebar-media-menu [data-call-media="share"] .media-status').textContent(),'Off');
      await page.keyboard.press('Escape');
      await page.locator('#sidebar-media-menu').waitFor({state:'hidden'});
      assert.equal(await page.locator('#sidebar-media-menu').isVisible(),false);
      await page.evaluate(()=>{ChatApp.closeMobileDrawers();ChatApp.closeCallMenu();ChatApp.gamesStageOpen=true;ChatApp.selectedGame={roomActivityId:'merge-party',roomActivityRoomId:'test'};ChatApp.activityChatWidth=30;ChatApp.setActivityChatOpen(true);ChatApp.membersListVisible=true;ChatApp.syncEmojiButtonVisibility();ChatApp.syncActivityChatLayout();});
      await page.waitForTimeout(250);
      await iconGeometry('#activity-chat-close');
      assert.equal(await page.locator('#activity-chat-members-back').count(),0,'Companion chat uses the shared members toggle, without a duplicate back control');
      await page.locator('#members-sidebar').waitFor({state:'visible'});
      await page.evaluate(()=>ChatApp.toggleMembersListVisibility());
      await page.locator('#members-sidebar').waitFor({state:'hidden'});
      assert.equal(await page.locator('#btn-members').getAttribute('aria-expanded'),'false');
      const actions=await page.locator('.companion-toolbar-actions').evaluate(el=>{const r=el.getBoundingClientRect(),buttons=[...el.querySelectorAll('button')].filter(button=>!button.hidden&&button.getBoundingClientRect().width>0).map(button=>button.getBoundingClientRect());return buttons.every(b=>b.left>=r.left-.5&&b.right<=r.right+.5);});
      assert.equal(actions,true,'companion header actions stay inside their container');
      await page.locator('#room-toolbar').screenshot({path:path.join(captures,`${viewport.width}-companion-header.png`)});
      await page.evaluate(()=>{ChatApp.activityChatWidth=15;ChatApp.syncActivityChatLayout();});
      await page.waitForTimeout(200);
      await iconGeometry('#activity-chat-close');
      const fitsHeader=await page.locator('#room-toolbar').evaluate(el=>{const r=el.getBoundingClientRect();return [...el.querySelectorAll('button')].filter(button=>!button.hidden&&button.getBoundingClientRect().width>0).every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left-.5&&b.right<=r.right+.5&&b.top>=r.top-.5&&b.bottom<=r.bottom+.5;});});
      await page.locator('#room-toolbar').screenshot({path:path.join(captures,`${viewport.width}-companion-header-min.png`)});
      await page.evaluate(() => document.body.dataset.hasBg='1');
      assert.equal(await page.locator('.chat-main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(17, 23, 30)', 'side chat has an opaque base with backgrounds enabled');
      assert.equal(fitsHeader,true,`${viewport.width}: minimum-width companion header contains its full-size controls`);
      await page.locator('#activity-chat-close').click();
      assert.equal(await page.evaluate(()=>document.body.dataset.companionChat),'0','Close Chat closes the companion panel');
      assert.deepEqual(errors,[]);
      await context.close();
    }
    if(process.env.CHAT_REQUESTED_UI_ONLY==='1') {console.log('Admin database refresh/toolbar, Filters avatar/order, and pinned action labels/geometry passed at desktop/mobile sizes. Screenshots:',captures);return;}
    if(process.env.CHAT_UI_FOCUSED==='1') {console.log('Pins, retained history jumps, Filters, reply geometry, emoji performance/centering, and audio/menu labels passed. Screenshots:',captures);return;}
    // The room column scrolls natively while navigation and the account dock
    // remain independent of the list's height.
    const context=await browser.newContext({viewport:{width:1200,height:510}});
    await context.addInitScript(installFirebaseMock);
    await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',body:'null'}));
    const page=await context.newPage();await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
    await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
    await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
    await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER');
    await page.evaluate(async()=>{ChatApp.closeToast();for(let i=0;i<24;i++){await ChatApp.db.ref('rooms/wheel-'+i).set({name:'Wheel room '+i,createdBy:'TEST-USER'});await ChatApp.db.ref('memberships/TEST-USER/wheel-'+i).set(true);}window.__roomWheelPrevented=null;document.addEventListener('wheel',event=>{window.__roomWheelPrevented=event.defaultPrevented;},{passive:true});});
    await page.waitForFunction(()=>document.querySelectorAll('#rooms-list .room-row').length>=25);
    const before=await page.evaluate(()=>{const list=document.querySelector('#rooms-list'),scroll=document.querySelector('#side-scroll');list.scrollTop=0;return {listOverflow:list.scrollHeight-list.clientHeight,sidebarOverflow:scroll.scrollHeight-scroll.clientHeight};});
    assert.ok(before.listOverflow>10&&before.sidebarOverflow<=1,'rooms scroll in their own column');
    await page.locator('#rooms-list').hover();await page.mouse.wheel(0,120);
    await page.waitForFunction(()=>document.querySelector('#rooms-list').scrollTop>0);
    assert.equal(await page.evaluate(()=>window.__roomWheelPrevented),false,'room list preserves native wheel momentum');
    await context.close();
    console.log('Menu/companion icon centering, shared Leave controls, close actions, and native sidebar wheel behavior passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

