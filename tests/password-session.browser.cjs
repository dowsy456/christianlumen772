/* Credential lifecycle regression: isolated mock database, no live writes. */
const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const mock=require('./firebase-mock.js');
const {createSharedFirebaseBackend}=require('./shared-firebase-backend.cjs');
async function verifyPasswordAcrossDevices(browser) {
 const backend=createSharedFirebaseBackend(0),uid='uid_ACCOUNTIDENTITYNEVERAPASSWORD1234';
 const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
 backend.values.credentials={[hash('FIRST-PASSWORD')]:uid,[hash('TAKEN-PASSWORD')]:'uid_OTHER'};
 backend.values.users[uid]={username:'Alice',displayName:'Alice',displayNameLower:'alice',credentialHash:hash('FIRST-PASSWORD'),settings:{autoScroll:false}};
 backend.values.users.uid_OTHER={username:'Other',credentialHash:hash('TAKEN-PASSWORD')};
 backend.values.messages={test:{saved:{userCode:uid,text:'Keep this message'}}};
 backend.values.memberships[uid]={test:true};
 const contexts=[],pages=[],errors=[];
 try {
  for(const viewport of [{width:1360,height:900},{width:390,height:844}]) {
   const context=await browser.newContext({viewport});contexts.push(context);await backend.bind(context);
   await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',body:'null',headers:{'access-control-allow-origin':'*'}}));
   const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));
   await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
   await page.click('#btn-go-login');await page.fill('#login-code','first password');await page.click('#btn-login');
   await page.waitForFunction(id=>ChatApp.currentUser?.code===id,uid);
  }
  const [desktop,mobile]=pages;
  await desktop.evaluate(()=>{ChatApp.$('btn-side-settings').click();window.copiedPasswords=[];ChatApp.copyTextToClipboard=async text=>window.copiedPasswords.push(text);});
  await desktop.click('#settings-tab-account');await desktop.click('#btn-settings-toggle-eye');
  assert.equal(await desktop.inputValue('#settings-code-display'),'FIRST-PASSWORD','reveal shows login credential, never stable uid');
  await desktop.click('#btn-settings-copy');await desktop.click('#btn-settings-copy');
  assert.deepEqual(await desktop.evaluate(()=>window.copiedPasswords),['FIRST-PASSWORD','FIRST-PASSWORD']);
  await desktop.click('#btn-settings-change-code');await desktop.fill('#settings-code-input','next password');await desktop.press('#settings-code-input','Enter');
  await desktop.waitForFunction(()=>ChatApp.currentUser?.password==='NEXT-PASSWORD'&&!ChatApp.passwordChangeInFlight);
  assert.equal(await desktop.inputValue('#settings-code-display'),'NEXT-PASSWORD','revealed credential updates after the Firebase save');
  await desktop.click('#btn-settings-copy');assert.equal(await desktop.evaluate(()=>window.copiedPasswords.at(-1)),'NEXT-PASSWORD');
  await mobile.waitForFunction(()=>ChatApp.currentUser===null);
  assert.equal(backend.get(`users/${uid}/credentialHash`),hash('NEXT-PASSWORD'));
  assert.equal(backend.get(`credentials/${hash('NEXT-PASSWORD')}`),uid);
  assert.equal(backend.get('messages/test/saved/userCode'),uid);assert.equal(backend.get(`memberships/${uid}/test`),true);
  assert.equal(backend.get(`users/${uid}/settings/autoScroll`),false);
  assert.equal(JSON.stringify(backend.values).includes('NEXT-PASSWORD'),false,'Firebase stores a hash under the uid, never a plaintext password');
  await mobile.click('#btn-go-login');await mobile.fill('#login-code','FIRST-PASSWORD');await mobile.click('#btn-login');
  await mobile.waitForFunction(()=>document.querySelector('#login-error')?.textContent.includes('Account not found'));
  assert.equal(await mobile.evaluate(()=>ChatApp.currentUser),null);
  await mobile.fill('#login-code','NEXT-PASSWORD');await mobile.click('#btn-login');await mobile.waitForFunction(id=>ChatApp.currentUser?.code===id,uid);
  await mobile.evaluate(()=>ChatApp.$('btn-side-settings').click());await mobile.click('#settings-tab-account');await mobile.click('#btn-settings-toggle-eye');
  assert.equal(await mobile.inputValue('#settings-code-display'),'NEXT-PASSWORD');
  assert.equal(await mobile.evaluate(async()=>{try{await ChatApp.changePassword('TAKEN-PASSWORD');return '';}catch(error){return error.message;}}),'Error. Try a different password');
  assert.equal(backend.get('users/uid_OTHER/credentialHash'),hash('TAKEN-PASSWORD'));
  await desktop.reload();await desktop.waitForFunction(id=>ChatApp.currentUser?.code===id&&ChatApp.currentUser.password==='NEXT-PASSWORD',uid);
  await desktop.evaluate(()=>ChatApp.$('btn-side-settings').click());await desktop.click('#settings-tab-account');await desktop.click('#btn-settings-toggle-eye');
  assert.equal(await desktop.inputValue('#settings-code-display'),'NEXT-PASSWORD','password survives cached-session bootstrap and remote confirmation');
  await desktop.evaluate(()=>{delete ChatApp.currentUser.password;ChatApp.$('btn-settings-toggle-eye').click();ChatApp.$('btn-settings-toggle-eye').click();});
  assert.equal(await desktop.inputValue('#settings-code-display'),'','missing credentials never fall back to uid');
  assert.deepEqual(errors,[]);
  console.log('PASS independent desktop/mobile password login, reveal/copy, Firebase credential commit, stale-session revocation, collision privacy, refresh and stable account data');
 } finally {for(const context of contexts)await context.close();}
}
(async()=>{
 const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
 try {
  const context=await browser.newContext();await context.addInitScript(mock);
  await context.route(/^https?:\/\//,route=>route.fulfill({status:200,contentType:'application/json',body:'null',headers:{'access-control-allow-origin':'*'}}));
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
  await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
  await page.click('#btn-go-login');await page.fill('#login-code','TEST-USER');await page.click('#btn-login');
  await page.waitForFunction(()=>ChatApp.currentUser?.code==='TEST-USER'&&ChatApp.getStoredPlace()==='home');
  assert.equal(await page.evaluate(()=>ChatApp.liveUserListeners.has('TEST-USER')),false,'Home removes room-scoped profile listeners');
  assert.equal(await page.evaluate(()=>ChatApp.accountExistenceWatch?.code),'TEST-USER');
  const guard=await page.evaluate(async()=>{
    window.releasePendingSend=null;
    const pending=ChatApp.enqueueSendTask(()=>new Promise(resolve=>window.releasePendingSend=resolve));
    await Promise.resolve();
    let error='';try{await ChatApp.changePassword('NEW-PASS');}catch(failure){error=failure.message;}
    const beforeRelease={error,flag:!!ChatApp.passwordChangeInFlight,old:__testDatabase.get('users/TEST-USER')?.username,next:__testDatabase.get('users/NEW-PASS')};
    window.releasePendingSend();await pending;return beforeRelease;
  });
  assert.equal(guard.error,'Error. Try a different password');assert.equal(guard.flag,false);assert.equal(guard.old,'Tester');assert.equal(guard.next,null);
  const blocked=await page.evaluate(async()=>{
    await ChatApp.openRoom('test',{quiet:true});ChatApp.$('msg-input').value='Draft survives';
    ChatApp.passwordChangeInFlight=true;let ran=false;
    await ChatApp.enqueueSendTask(()=>{ran=true;});await ChatApp.sendTextMessage();await ChatApp.sendStickerMessage({id:'unused'});
    ChatApp.passwordChangeInFlight=false;
    return {ran,draft:ChatApp.$('msg-input').value,messages:__testDatabase.get('messages/test')};
  });
  assert.equal(blocked.ran,false);assert.equal(blocked.draft,'Draft survives');assert.equal(blocked.messages,null);
  await page.evaluate(()=>ChatApp.showLoggedInHome());
  await page.evaluate(async()=>{
    const original=ChatApp.logoutToLanding;
    ChatApp.logoutToLanding=async()=>{await new Promise(resolve=>window.finishRevokedLogout=resolve);return original();};
    await ChatApp.db.ref('users/TEST-USER').remove();
  });
  await page.waitForFunction(()=>ChatApp.accountSessionRevoked&&typeof window.finishRevokedLogout==='function');
  const revoked=await page.evaluate(()=>({session:ChatApp.appPresenceSession,roomPresence:ChatApp.myPresenceRef,settingsTimer:ChatApp.settingsSaveTimer,canChat:ChatApp.canChat()}));
  assert.equal(revoked.session,null);assert.equal(revoked.roomPresence,null);assert.ok(!revoked.settingsTimer);assert.equal(revoked.canChat,false);
  await page.evaluate(()=>window.finishRevokedLogout());await page.waitForFunction(()=>ChatApp.currentUser===null);
  assert.equal(await page.evaluate(()=>ChatApp.accountExistenceWatch),null);
  assert.equal(await page.evaluate(async()=>{await ChatApp.db.ref('users/TEST-USER/settings').set({soundEffectsEnabled:true});return ChatApp.loginWithCode('TEST-USER');}),null,'a leftover settings record cannot be logged in as a phantom account');
  assert.deepEqual(errors,[]);await context.close();
  console.log('PASS independent Home account watcher, immediate writer shutdown, pending-send/password exclusion, draft preservation, partial-account rejection');
  await verifyPasswordAcrossDevices(browser);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
