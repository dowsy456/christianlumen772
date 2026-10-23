'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const reportDirectory=path.resolve(process.argv[2] || path.join(root,'../room-loading-report')); fs.mkdirSync(reportDirectory,{recursive:true});
const {chromium}=require('playwright');
const fixture=require(path.join(root,'tests/room-loading-fixture.cjs'));
const report=[];
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream'});res.end(e?'Missing':b);});});
async function ready(page,room){await page.waitForFunction(room=>ChatApp.currentRoomId===room&&!ChatApp.msgInitialTailPending&&!ChatApp.bulkLoading&&!ChatApp.roomLoadingActive,room);}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'chrome',headless:true});try{
for(const mode of ['http','file']){
 const context=await browser.newContext({viewport:{width:1280,height:840}});
 await context.addInitScript(fixture,{count:12000,latencyMs:120,blockedStorage:true});
 if(mode==='file')await context.addInitScript(()=>{window.chatDesktopRings={version:1};});
 await context.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/,r=>r.fulfill({status:503,body:'null',headers:{'access-control-allow-origin':'*'}}));
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(mode==='http'?`http://127.0.0.1:${server.address().port}/index.html`:pathToFileURL(path.join(root,'index.html')).href);
 await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
 await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
 await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER'&&ChatApp.membershipMap.has('test'));
 await page.evaluate(()=>{window.__loaderSeen=false;window.__rowCounts=[];new MutationObserver(()=>{__loaderSeen ||=!!document.querySelector('#room-loading-state');__rowCounts.push(ChatApp.messagesListEl.querySelectorAll('.msg-row').length);}).observe(ChatApp.messagesListEl,{childList:true});});
 const start=Date.now();await page.evaluate(()=>ChatApp.openRoom('test',{quiet:true}));await ready(page,'test');
 const cold=await page.evaluate(()=>({rows:ChatApp.msgElByKey.size,loader:__loaderSeen,first:[...ChatApp.msgElByKey.keys()].sort()[0],counts:__rowCounts}));
 assert.equal(cold.rows,50);assert.equal(cold.first,'k00011950');assert.equal(cold.loader,true);assert.ok(Math.max(...cold.counts)<=50);
 const coldMs=Date.now()-start;await page.waitForTimeout(180);
 assert.equal(await page.evaluate(()=>__roomLoadFixture.traces.some(t=>t.kind==='once'&&t.path==='messages/test'&&t.query.endAt!=null)),false,'opening a room does not prefetch unrequested older history');
 const old=await page.evaluate(async()=>{ChatApp.stopChatBottomFollowing();const t=performance.now();const old=ChatApp.msgOldestKey;await ChatApp.loadOlderMessagesPage();return {elapsed:performance.now()-t,old,now:ChatApp.msgOldestKey,count:ChatApp.msgElByKey.size};});
 assert.equal(old.count,100);assert.equal(Number(old.old.slice(1))-Number(old.now.slice(1)),50);assert.ok(old.elapsed<1000,'requested history page stays responsive with simulated 120 ms latency');
 for(let i=0;i<3;i++){await page.waitForTimeout(150);await page.evaluate(()=>ChatApp.loadOlderMessagesPage());assert.equal(await page.evaluate(()=>ChatApp.msgElByKey.size),150);}
 await page.evaluate(()=>__roomLoadFixture.ref(`messages/test/${ChatApp.msgOldestKey}/text`).set('Live history edit'));
 await page.waitForFunction(()=>ChatApp.msgDataByKey.get(ChatApp.msgOldestKey)?.text==='Live history edit');
 for(let i=0;i<10&&await page.evaluate(()=>ChatApp.msgHasNewerHistory);i++){await page.evaluate(()=>ChatApp.loadNewerMessagesPage());assert.ok(await page.evaluate(()=>ChatApp.msgElByKey.size<=150));}
 assert.ok(await page.evaluate(()=>ChatApp.msgElByKey.has('k00011999')));
 // Arriving at an already-clamped top edge must page even without a scroll
 // event; retain the original visible message instead of replacing its page.
 const edge=await page.evaluate(()=>{ChatApp.stopChatBottomFollowing();ChatApp.suppressHistoryAutoLoadUntil=Date.now()+10000;ChatApp.messagesEl.scrollTop=0;return ChatApp.msgOldestKey;});
 await page.waitForTimeout(30);
 await page.evaluate(()=>ChatApp.messagesEl.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true})));
 await page.waitForFunction(key=>!ChatApp.msgLoadingOlder&&ChatApp.msgOldestKey<key,edge);
 assert.equal(await page.evaluate(key=>Number(key.slice(1))-Number(ChatApp.msgOldestKey.slice(1)),edge),50);
 assert.ok(await page.evaluate(key=>ChatApp.msgElByKey.has(key)&&ChatApp.messagesEl.scrollTop>0,edge),'paging preserves the message at the old top while exposing 50 older rows above');
 // A pending old-room page cannot populate the next room.
 await page.evaluate(()=>{ChatApp.messagePageCache.clear();__roomLoadFixture.holdHistory=true;window.__pending=ChatApp.loadOlderMessagesPage();});
 await page.waitForFunction(()=>__roomLoadFixture.pendingHistory()>0);await page.evaluate(()=>ChatApp.openRoom('second',{quiet:true}));await ready(page,'second');
 await page.evaluate(async()=>{__roomLoadFixture.releaseHistory();await __pending;});
 assert.ok(await page.evaluate(()=>[...ChatApp.msgDataByKey.values()].every(m=>m.text.startsWith('second history'))));
 await page.evaluate(()=>{__roomLoadFixture.holdHistory=false;return ChatApp.openRoom('test',{quiet:true});});await ready(page,'test');
 // Pin state changes live; the retained record and timeline copy survive clear.
 await page.evaluate(()=>ChatApp.toggleMessagePin({roomId:'test',key:'k00011999'}));
 await page.waitForFunction(()=>ChatApp.msgDataByKey.get('k00011999')?.pinned);
 await page.click('#btn-pinned-messages');await page.waitForFunction(()=>document.querySelector('#pinned-messages-panel .msg-row'));
 assert.equal(await page.locator('#pinned-messages-panel .msg-row').count(),1);
 await page.evaluate(()=>__roomLoadFixture.ref('messages/test/k00011999/text').set('Pinned live edit'));
 await page.waitForFunction(()=>document.querySelector('#pinned-messages-panel')?.textContent.includes('Pinned live edit'));
 // Clearing while reading old history must restore a retained pin outside the
 // visible window, and an in-flight old page must not repopulate deleted rows.
 await page.evaluate(()=>{ChatApp.closePinnedMessages();ChatApp.stopChatBottomFollowing();ChatApp.chatScrollUserReading=true;ChatApp.suppressHistoryAutoLoadUntil=Date.now()+30000;});
 await page.waitForFunction(()=>!ChatApp.msgLoadingOlder&&!ChatApp.msgLoadingNewer);
 for(let i=0;i<3;i++)await page.evaluate(()=>ChatApp.loadOlderMessagesPage());
 assert.equal(await page.evaluate(()=>ChatApp.msgElByKey.has('k00011999')),false);
 assert.equal(await page.evaluate(()=>ChatApp.msgHasNewerHistory),true);
 await page.evaluate(()=>{ChatApp.messagePageCache.clear();__roomLoadFixture.holdHistory=true;window.__clearPending=ChatApp.loadOlderMessagesPage();});
 await page.waitForFunction(()=>__roomLoadFixture.pendingHistory()>0).catch(async error=>{console.log(await page.evaluate(()=>({older:ChatApp.msgLoadingOlder,newer:ChatApp.msgLoadingNewer,all:ChatApp.msgAllHistoryLoaded,hasNewer:ChatApp.msgHasNewerHistory,oldest:ChatApp.msgOldestKey,tail:__roomLoadFixture.traces.slice(-6)})));throw error;});
 await page.evaluate(async()=>{await __roomLoadFixture.ref('pinnedMessages/test/k00011999/text').set('Pinned live edit');ChatApp.isVinny=()=>true;await ChatApp.clearRoomMessages('test');});
 await page.waitForFunction(()=>ChatApp.msgElByKey.size===1&&ChatApp.msgElByKey.has('k00011999'));
 await page.evaluate(async()=>{__roomLoadFixture.releaseHistory();await __clearPending;});
 assert.equal(await page.evaluate(()=>ChatApp.msgHasNewerHistory),false);
 assert.equal(await page.evaluate(()=>ChatApp.msgElByKey.size),1);
 await page.evaluate(()=>__roomLoadFixture.ref('messages/test/z-after-clear').set({text:'After Clear',createdAt:Date.now(),userCode:'TEST-USER'}));
 await page.waitForFunction(()=>ChatApp.msgElByKey.has('z-after-clear'));
 assert.ok(await page.evaluate(()=>__roomLoadFixture.get('pinnedMessages/test/k00011999')?.pinned));
 assert.equal(await page.evaluate(()=>__roomLoadFixture.get('messages/test/k00011999/text')),'Pinned live edit');
 await page.evaluate(()=>ChatApp.toggleMessagePin({roomId:'test',key:'k00011999'}));
 await page.waitForFunction(()=>!__roomLoadFixture.get('pinnedMessages/test/k00011999'));
 assert.ok(await page.evaluate(()=>__roomLoadFixture.get('messages/test/k00011999')),'unpin retains message until another clear');
 await page.evaluate(()=>ChatApp.clearRoomMessages('test'));await page.waitForFunction(()=>ChatApp.msgElByKey.size===0);
 await page.evaluate(()=>ChatApp.closePinnedMessages());
 // Read receipts require continuous focused visibility, including after async cleanup.
 await page.evaluate(()=>ChatApp.openRoom('second',{quiet:true}));await ready(page,'second');
 await page.evaluate(()=>{ChatApp.membersListVisible=false;ChatApp.syncEmojiButtonVisibility();ChatApp.setMessagesScrollBottom();document.hasFocus=()=>false;});
 assert.equal(await page.evaluate(()=>ChatApp.canSeeMessage('second',[...ChatApp.msgElByKey.keys()].sort().at(-1))),false);
 await page.waitForTimeout(650);
 assert.equal(await page.evaluate(()=>__roomLoadFixture.get('readReceipts/second')?.[ChatApp.getLatestReceiptMessage()?._key]?.['TEST-USER']||null),null);
 await page.evaluate(()=>{delete document.hasFocus;});
 // A wrapped receipt row must never change avatar size on a narrow device.
 await page.setViewportSize({width:360,height:740});
 await page.evaluate(()=>{ChatApp.membersListVisible=false;ChatApp.syncEmojiButtonVisibility();const row=ChatApp.msgElByKey.get([...ChatApp.msgElByKey.keys()].sort().at(-1));const top=row.querySelector('.bubble-top');const seen=document.createElement('span');seen.className='message-seen';seen.textContent='Seen by: One Two Three Four Five Six';top.append(seen);ChatApp.queueMessageAvatarAlignment(row);ChatApp.setMessagesScrollBottom();ChatApp.chatScrollFollowing=true;ChatApp.chatScrollUserReading=false;});
 await page.waitForTimeout(250);
 const sizes=await page.locator('#messages-inner .msg-avatar').evaluateAll(nodes=>nodes.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
 assert.ok(sizes.length);assert.ok(sizes.every(s=>Math.abs(s.w-s.h)<1&&s.w<=42));
 await page.locator('#msg-input').fill('A message that grows as I type. '.repeat(4));await page.waitForTimeout(300);
 assert.ok(await page.evaluate(()=>ChatApp.isNearBottom(30)),'typing preserves latest message position');
 const traces=await page.evaluate(()=>__roomLoadFixture.traces.filter(t=>['on','once'].includes(t.kind)&&t.path.split('/').length===2));
 assert.ok(traces.every(t=>t.query.limitToLast||t.query.limitToFirst||t.query.startAt!=null&&t.query.endAt!=null),'every history query is bounded');
 assert.ok(traces.every(t=>t.records<=51),'history requests have at most 50 messages plus their cursor: '+JSON.stringify(traces.filter(t=>t.records>51)));
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(reportDirectory,`verified-chat-${mode}.png`)});
 report.push({mode,coldMs,requestedOlderMs:old.elapsed,initialRows:cold.rows,checks:'50-message pages, 150-row bound, loader, old/new paging, realtime history, navigation race, pin retention/unpin/reclear, inactive receipts, narrow avatars, typing scroll'});
 console.log(JSON.stringify(report.at(-1)));await context.close();
}
}finally{await browser.close();server.close();fs.writeFileSync(path.join(reportDirectory,'room-verification.json'),JSON.stringify(report,null,2));}})().catch(e=>{console.error(e);process.exitCode=1;});
