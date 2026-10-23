/* npm install; npm run test:browser. Uses fixtures; no production writes. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
const installFirebaseMock=require('./firebase-mock.js');
const root=path.resolve(__dirname,'..');
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'};
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(file,(err,data)=>{res.writeHead(err?404:200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(err?'Not found':data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 const results=[];
 try{
  for(const protocol of ['file','http']){
   const context=await browser.newContext({viewport:{width:1440,height:900}});
   await context.addInitScript(installFirebaseMock);
   await context.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
   const page=await context.newPage();const errors=[];
   page.on('pageerror',e=>errors.push(e.stack||e.message));
   page.on('console',msg=>{if(msg.type()==='error'&&!msg.text().startsWith('Failed to load resource'))errors.push(msg.text());});
   const entry=protocol==='file'?pathToFileURL(path.join(root,'index.html')).href:`http://127.0.0.1:${server.address().port}/index.html`;
   await page.goto(entry);
   await page.waitForFunction(()=>document.documentElement.dataset.appReady,{timeout:20000});
   assert.equal(await page.getAttribute('html','data-app-ready'),'true',errors.join('\n'));
   assert.equal(await page.locator('#view-home').getAttribute('data-active'),'true');
   assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').some(r=>/activities\/(?:bopl|merge)/.test(r.name))),false,'games must remain unloaded');
   await page.click('#btn-go-login');
   await page.fill('#login-code','TEST-USER');
   await page.click('#btn-login');
   await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER'&&document.querySelector('#view-chat').dataset.active==='true',{timeout:10000});
   await page.evaluate(()=>ChatApp.openRoom('test',{quiet:true}));
   await page.waitForFunction(()=>ChatApp.currentRoomId==='test'&&!ChatApp.bulkLoading);
   await page.evaluate(()=>ChatApp.closeToast());
   await page.fill('#msg-input','Modular app smoke test');
   await page.evaluate(()=>ChatApp.sendTextMessage());
   await page.waitForFunction(()=>document.querySelector('#messages-inner').textContent.includes('Modular app smoke test'));
   await page.evaluate(()=>ChatApp.openPollComposer());
   assert.equal(await page.locator('#modal').isVisible(),false,'Poll composition is a nonblocking composer menu');
   assert.equal(await page.locator('#poll-menu-title').textContent(),'Create Poll');
   assert.equal(await page.locator('#btn-poll').getAttribute('data-tooltip'),'Poll');
   assert.equal(await page.locator('#btn-poll .composer-action-label').textContent(),'Poll');
   await page.fill('#poll-question','Which activity should we play?');
   await page.locator('#poll-editor-answers input').nth(0).fill('🌮 Party games');
   await page.locator('#poll-editor-answers input').nth(1).fill('🎮 HTML games');
   await page.fill('#poll-duration-days','0');
   await page.fill('#poll-duration-hours','1');
   await page.check('#poll-multiple');
   if(process.env.POLL_REVIEW_DIR){fs.mkdirSync(process.env.POLL_REVIEW_DIR,{recursive:true});await page.waitForTimeout(300);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-editor-${protocol}.png`)});}
   await page.setViewportSize({width:700,height:420});
   await page.evaluate(()=>ChatApp.closeMobileDrawers());
   await page.waitForTimeout(200);
   assert.equal(await page.locator('#poll-popover').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=7&&r.bottom<=innerHeight-7&&r.left>=7&&r.right<=innerWidth-7&&el.scrollHeight>el.clientHeight}),true,'Short windows keep poll menus bounded and scrollable');
   if(process.env.POLL_REVIEW_DIR)await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-editor-short-${protocol}.png`)});
   await page.locator('#poll-attach').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('#poll-attach').evaluate(el=>{const r=el.getBoundingClientRect();const menu=el.closest('#poll-popover').getBoundingClientRect();return r.top>=menu.top&&r.bottom<=menu.bottom}),true,'Poll submit remains reachable in a short menu');
   await page.setViewportSize({width:1440,height:900});
   await page.click('#poll-attach');
   assert.equal(await page.evaluate(()=>ChatApp.pendingFiles.length),0,'Poll draft is never a file');
   if(process.env.POLL_REVIEW_DIR){await page.waitForTimeout(200);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-draft-${protocol}.png`)});}
   await page.evaluate(()=>ChatApp.sendTextMessage());
   await page.waitForFunction(()=>[...ChatApp.msgDataByKey.values()].some(message=>message.poll&&!message.__stub));
   const pollKey=await page.evaluate(()=>[...ChatApp.msgDataByKey].find(([,message])=>message.poll)[0]);
   const pollCard=page.locator('.message-poll').first();
   assert.equal(await page.locator('.att-gallery .message-poll').count(),0);
   await pollCard.locator('[data-option-id="a0"]').click();
   await pollCard.locator('[data-option-id="a1"]').click();
   await pollCard.getByRole('button',{name:'Vote',exact:true}).click();
   await page.waitForFunction(key=>ChatApp.msgDataByKey.get(key)?.poll?.votes?.['TEST-USER']?.options?.length===2,pollKey);
   assert.match(await pollCard.textContent(),/1 vote/);
   if(process.env.POLL_REVIEW_DIR){await page.waitForTimeout(200);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-card-${protocol}.png`)});}
   assert.equal(await pollCard.locator('[data-option-id="a0"]').isDisabled(),true,'Submitted answers require Change Vote before editing');
   await pollCard.locator('[data-option-id="a0"]').evaluate(button=>button.dispatchEvent(new MouseEvent('click',{bubbles:true})));
   assert.equal(await pollCard.getByRole('button',{name:'Change Vote',exact:true}).count(),1,'Synthetic option clicks cannot bypass the vote lock');
   assert.equal(await pollCard.locator('.poll-action-button').first().textContent(),'','Poll actions use custom icons');
   await pollCard.getByRole('button',{name:'Change Vote',exact:true}).click();
   await pollCard.locator('[data-option-id="a0"]').click();
   await pollCard.getByRole('button',{name:'Save Vote',exact:true}).click();
   await page.waitForFunction(key=>ChatApp.msgDataByKey.get(key)?.poll?.votes?.['TEST-USER']?.options?.length===1,pollKey);
   await pollCard.getByRole('button',{name:'1 vote',exact:true}).click();
   assert.match(await page.locator('.poll-voters').textContent(),/Tester/);
   assert.equal(await page.locator('.poll-voter .msg-avatar').count(),1);
   assert.equal(await page.locator('.poll-voters .mention-link').count(),0,'Voters use avatars and plain display names');
   assert.equal(await page.locator('#modal').isVisible(),false,'Poll voters are shown in a menu');
   if(process.env.POLL_REVIEW_DIR){await page.waitForTimeout(200);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-voters-${protocol}.png`)});}
   await page.locator('.poll-voter .msg-avatar').click();
   await page.waitForFunction(()=>ChatApp.userProfileOpen);
   await page.evaluate(()=>ChatApp.closeUserProfile(true));
   await page.click('#poll-close-votes');
   await pollCard.getByRole('button',{name:'End Poll',exact:true}).click();
   assert.equal(await page.locator('#modal').isVisible(),false,'Ending a poll uses a menu');
   await page.click('#poll-confirm-end');
   await page.waitForFunction(()=>document.querySelector('.system-message')?.textContent.includes('Winner: 🎮 HTML games'));
   assert.equal(await page.locator('.system-message .msg-avatar').count(),0);
   const systemCount=await page.locator('.system-message').count();
   await page.evaluate(key=>ChatApp.finishPoll('test',key),pollKey);
   assert.equal(await page.locator('.system-message').count(),systemCount,'Finalization retries do not duplicate logs');
   await page.evaluate(()=>ChatApp.writeRoomSystemMessage('test',{type:'member_joined',userCode:'TEST-USER',displayName:'Tester'},'test-member-joined'));
   await page.locator('.system-message .msg-avatar').waitFor({state:'visible'});
   assert.equal(await page.locator('.system-message .msg-avatar').count(),1,'Actor logs include an avatar');
   const logTime=page.locator('.system-message .bubble-time').last();
   await logTime.hover();
   await page.waitForFunction(()=>document.querySelector('#timestamp-tooltip')?.classList.contains('visible'));
   await page.mouse.move(2,2);
   await page.waitForFunction(()=>!document.querySelector('#timestamp-tooltip')?.classList.contains('visible'));
   assert.equal(await logTime.evaluate(el=>el.parentElement.className),'system-message-content','The timestamp stays beside the log text');
   await page.locator('.system-message-name').last().click();
   assert.equal(await page.evaluate(()=>ChatApp.userProfileOpen),false,'Actor names are plain text');
   await page.locator('.system-message-avatar').last().click();
   await page.waitForFunction(()=>ChatApp.userProfileOpen);
   await page.evaluate(()=>ChatApp.closeUserProfile(true));
   if(process.env.POLL_REVIEW_DIR){await page.evaluate(()=>ChatApp.closeToast());await page.waitForTimeout(250);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-results-${protocol}.png`)});await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await page.evaluate(()=>{ChatApp.closeMobileDrawers();ChatApp.membersListVisible=false;ChatApp.syncEmojiButtonVisibility();});await pollCard.scrollIntoViewIfNeeded();await page.waitForTimeout(250);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-mobile-${protocol}.png`)});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile poll must not overflow horizontally');await page.evaluate(()=>ChatApp.openPollComposer());await page.waitForTimeout(300);await page.screenshot({path:path.join(process.env.POLL_REVIEW_DIR,`poll-editor-mobile-${protocol}.png`)});await page.evaluate(()=>ChatApp.closePollPopover({immediate:true}));await page.setViewportSize({width:1440,height:900});}
   await page.evaluate(async()=>{
    const stamp=Date.now()-2000, alphabet='-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    let value=stamp,prefix='';for(let i=0;i<8;i++){prefix=alphabet[value%64]+prefix;value=Math.floor(value/64);}
    window.__legacyCallKey=prefix+'------------';
    await __testDatabase.ref('messages/test/'+__legacyCallKey).set({t:'system',createdAt:stamp+86400000,system:{type:'call_ended',createdAt:stamp+86400000}});
    await ChatApp.writeRoomSystemMessage('test',{type:'call_started',userCode:'TEST-USER',username:'Tester',createdAt:stamp+100},'smoke-call-start');
    await __testDatabase.ref('messages/test/latest-after-call').set({userCode:'TEST-USER',username:'Tester',text:'Conversation continues after the call',createdAt:Date.now()+1000});
   });
   await page.waitForFunction(()=>ChatApp.messagesListEl.lastElementChild?.dataset.msgkey==='latest-after-call');
   for(let retry=0;retry<3;retry++) await page.evaluate(async retry=>{
    await __testDatabase.ref('messages/test/'+__legacyCallKey).update({revision:retry});
    await ChatApp.writeRoomSystemMessage('test',{type:'call_started',userCode:'TEST-USER',createdAt:Date.now()+86400000},'smoke-call-start');
   },retry);
   await page.waitForFunction(()=>ChatApp.messagesListEl.lastElementChild?.dataset.msgkey==='latest-after-call');
   assert.equal(await page.locator('.system-message').filter({hasText:'started a call.'}).count(),1,'Call retries cannot duplicate the start log');
   await page.evaluate(()=>ChatApp.openRoom('test',{quiet:true}));
   await page.waitForFunction(()=>!ChatApp.bulkLoading&&ChatApp.messagesListEl.lastElementChild?.dataset.msgkey==='latest-after-call');
   assert.equal(await page.evaluate(()=>new Set([...ChatApp.messagesListEl.children].map(row=>row.dataset.msgkey)).size===ChatApp.messagesListEl.children.length),true,'Cached reopen retains one row per message');
   await page.evaluate(async()=>{const original=ChatApp.isVinny;ChatApp.isVinny=()=>true;try{await ChatApp.clearRoomMessages('test');}finally{ChatApp.isVinny=original;}});
   assert.equal(await page.locator('.msg-row').count(),0,'Clearing messages includes polls and logs');
   await page.evaluate(key=>ChatApp.finishPoll('test',key),pollKey);
   assert.equal(await page.locator('.msg-row').count(),0,'Expired poll retry cannot resurrect cleared messages');
   await page.click('#btn-side-settings');
   await page.waitForFunction(()=>!document.querySelector('#modal').hidden);
   assert.match(await page.locator('#modal-title').textContent(),/Settings/i);
   await page.evaluate(()=>ChatApp.closeModal());
   await page.locator('#modal').waitFor({state:'hidden'});
   await verifySchedules(page);
   await page.evaluate(()=>ChatApp.showLoggedInHome());
   assert.equal(page.url(),entry,'index.html must remain the entry page');
   const bootMs=await page.evaluate(()=>performance.getEntriesByName('chatapp:boot')[0].duration);
   await page.waitForTimeout(300);
   assert.deepEqual(errors,[],errors.join('\n'));
   results.push({protocol,bootMs:Math.round(bootMs),flows:['startup','login','room','send','poll-compose','poll-vote-change','poll-voters','poll-end','system-log-profile','settings','schedules','home'],errors:0});
   await context.close();
  }
  console.log(JSON.stringify(results,null,2));
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});

// Schedule editor shares the same isolated Firebase fixture as chat smoke.
async function verifySchedules(page) {
  await page.evaluate(async()=>{
   await __testDatabase.ref('users/TEST-USER').update({username:'Vinny',usernameLower:'vinny',displayName:'Vinny'});
   ChatApp.currentUser.username='Vinny';ChatApp.currentUser.displayName='Vinny';
   ChatApp.showSchedulesPage('Vinny');
  });
  await page.locator('[data-sched-edit]').waitFor();
  await page.locator('[data-sched-preview-day="M"]').click();
  assert.equal(await page.locator('.sched-grid-row').count(),9);
  assert.equal(await page.locator('.sched-person-view .sched-avatar').count(),1);
  assert.equal(await page.locator('.sched-card-times').count(),0);
  assert.equal(await page.locator('[data-sched-back]').innerText(),'✕');
  assert.equal(await page.locator('.sched-cell-class').first().innerText(),'Geometry HN');
  await page.evaluate(()=>{window.__scheduleNode=document.querySelector('.sched-grid-row');window.__scheduleScroll=ChatApp.messagesEl.scrollTop;});
  await page.evaluate(async()=>{await __testDatabase.ref('users/TEST-USER').update({lastActive:Date.now()});});
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>__scheduleNode===document.querySelector('.sched-grid-row')),true,'presence preserves DOM');
  for(const viewport of [{width:1440,height:900},{width:1024,height:768},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.waitForTimeout(200);
   const bounds=await page.evaluate(()=>{const g=document.querySelector('.sched-grid'),r=g.getBoundingClientRect();const p=document.querySelector('.sched-page').getBoundingClientRect();return {x:r.x,right:r.right,bottom:r.bottom,scroll:g.scrollWidth,width:g.clientWidth,viewWidth:innerWidth,viewHeight:innerHeight,pageBottom:p.bottom,viewport:ChatApp.messagesEl.getBoundingClientRect().bottom}});

   assert.ok(bounds.scroll<=bounds.width+1,'no horizontal table scroll');
   assert.ok(bounds.right<=bounds.viewWidth+1,'table stays in viewport');
   assert.ok(bounds.bottom<=bounds.viewport+1,'standard nine-period schedule fits visible viewport');
   if (process.env.SCHEDULE_REVIEW_DIR) await page.screenshot({path:path.join(process.env.SCHEDULE_REVIEW_DIR,`schedules-${viewport.width}.png`)});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.click('[data-sched-edit]');
  const classInput=page.locator('[data-sched-edit-row="0"] [data-sched-edit-field="className"]');
  await classInput.fill('Updated class');
  await page.locator('[data-sched-edit-row="0"] [data-sched-edit-field="time"]').fill('8:00 AM - 9:00 AM');
  await page.locator('[data-sched-edit-row="0"] [data-sched-copy-row]').click();
  await page.click('[data-sched-edit-save]');
  await page.locator('#modal').waitFor({state:'hidden'});
  await page.waitForFunction(()=>ChatApp.getScheduleRows('full','Vinny','M')[0].className==='Updated class');
  assert.equal(await page.evaluate(()=>ChatApp.getScheduleRows('full','Vinny','T')[0].className),'Updated class');
  assert.equal(await page.evaluate(()=>ChatApp.getScheduleRows('full','Vinny','M')[0].duration),'60 minutes');
  assert.equal(await page.locator('.sched-cell-class').first().innerText(),'Updated class');
  assert.equal(await page.evaluate(()=>__scheduleNode===document.querySelector('.sched-grid-row')),true,'live changes patch same table row');
  assert.equal(await page.evaluate(()=>ChatApp._getActiveScheduleBlockKeyAt('full','Vinny',480,'M')),'P1');
  assert.equal(await page.evaluate(()=>ChatApp.scheduleAsText('Vinny').includes('Monday (Day M)\nPeriod 1 | 8:00 AM - 9:00 AM | Updated class')),true);
  await page.click('[data-sched-edit]');
  await classInput.fill('Unsaved local draft');
  await classInput.focus();
  await page.evaluate(async()=>{
   const record=JSON.parse(JSON.stringify(__testDatabase.get('admin/schedules/vinny')));record.revision++;record.days.M[0].className='Another admin tab';
   await __testDatabase.ref('admin/schedules/vinny').set(record);
  });
  await page.waitForTimeout(100);
  assert.equal(await classInput.inputValue(),'Unsaved local draft','remote changes preserve draft');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.schedEditField),'className','remote changes preserve focus');
  await page.click('[data-sched-edit-save]');
  await page.waitForTimeout(100);
  assert.match(await page.locator('[data-sched-editor-status]').innerText(),/changed elsewhere/);
  await page.click('#btn-modal-close');await page.locator('#modal').waitFor({state:'hidden'});
  await page.click('[data-sched-edit]');await page.click('[data-sched-remove-week]');await page.click('[data-sched-remove-week]');
  await page.locator('#modal').waitFor({state:'hidden'});
  await page.waitForFunction(()=>ChatApp.getScheduleRows('full','Vinny','M').length===0);
  assert.equal(await page.locator('.sched-cell-empty').innerText(),'No schedule assigned');

}
