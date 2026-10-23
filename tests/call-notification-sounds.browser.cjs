'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');
(async () => {
  const backend = createSharedFirebaseBackend(7);
  backend.values.rooms.other = { name:'Other room',createdBy:'P1' };
  for (const code of ['P1','P2']) backend.values.memberships[code].other = true;
  const browser = await chromium.launch({ channel:process.env.BROWSER_CHANNEL || 'chrome',headless:true });
  const errors = [];
  const contexts = [];
  const member = code => ({ code,sessionId:`session-${code}`,username:code,connected:true,joinedAt:Date.now(),lastSeenAt:Date.now() });
  async function client(code, desktop) {
    const context = await browser.newContext({ viewport:{width:1280,height:900} }); contexts.push(context);
    await backend.bind(context);
    if (desktop) await context.addInitScript(() => { window.chatDesktopOverlay = {version:1,publish() {}}; });
    await context.route(/^https?:\/\//, route => route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'null'}));
    const page = await context.newPage();
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    await page.evaluate(() => {
      ChatApp.callRequestMicPermission = async () => new MediaStream();
      ChatApp.callRefreshIceServers = async () => [];
      ChatApp.callPrimePlaybackContextFromGesture = () => null;
      ChatApp.callStartWebRTC = () => {};
      ChatApp.callEnsurePeers = async () => {};
      ChatApp.callResumeRemoteAudio = async () => true;
      window.__callSounds = [];
      window.__screenSounds = [];
      ChatApp.playNotificationSound = name => {
        if (name === 'JoinCall' || name === 'LeaveCall') __callSounds.push(name);
        if (['StartScreen','EndScreen','StartWatching','StopWatching'].includes(name)) __screenSounds.push(name);
      };
    });
    await page.click('#btn-go-login'); await page.fill('#login-code',code); await page.click('#btn-login');
    await page.waitForFunction(code => ChatApp.currentUser?.code === code && ChatApp.membershipMap.has('test'),code);
    await page.evaluate(() => ChatApp.openRoom('test',{quiet:true}));
    return page;
  }
  const sounds = page => page.evaluate(() => [...__callSounds]);
  const waitCount = (page,count) => page.waitForFunction(count => __callSounds.length === count,count);
  async function set(page,path,value) { await page.evaluate(({path,value}) => ChatApp.db.ref(path).set(value),{path,value}); }
  try {
    const web = await client('P1',false), desktop = await client('P2',true);
    await set(web,'calls/test',{instanceId:'existing-call',members:{P3:member('P3')}});
    await web.evaluate(() => ChatApp.joinCall('test'));
    assert.deepEqual(await sounds(web),['JoinCall'],'existing roster is a quiet baseline for the joining client');
    await desktop.evaluate(() => ChatApp.joinCall('test'));
    await waitCount(web,2);
    assert.deepEqual(await sounds(desktop),['JoinCall'],'desktop joining hears one cue, not one per existing member');
    const screenSounds = page => page.evaluate(() => [...__screenSounds]);
    const waitScreens = (page, count) => page.waitForFunction(count => __screenSounds.length === count, count);
    await web.evaluate(async () => {
      ChatApp.callSharing = true; ChatApp.callScreenShareId = 'sound-share';
      ChatApp.callNotifyLocalScreenState('test', ChatApp.callSessionId, 'sound-share');
      await ChatApp.myCallMemberRef.update({sharing:true,shareId:'sound-share'});
    });
    await waitScreens(desktop,1);
    assert.deepEqual(await screenSounds(web),['StartScreen'],'local screen start deduplicates the realtime echo');
    assert.deepEqual(await screenSounds(desktop),['StartScreen'],'another caller hears screen start');
    await desktop.evaluate(() => ChatApp.openShareView('P1','P1'));
    await waitScreens(web,2);
    assert.deepEqual(await screenSounds(desktop),['StartScreen'],'new watcher does not hear their own watch event');
    await set(web,'calls/test/members/P3/viewingSharesSessionId','session-P3');
    await set(web,'calls/test/members/P3/viewingShares',{P1:'sound-share'});
    await waitScreens(web,3); await waitScreens(desktop,2);
    await set(web,'calls/test/members/P3/viewingShares',null);
    await waitScreens(web,4); await waitScreens(desktop,3);
    assert.deepEqual(await screenSounds(desktop),['StartScreen','StartWatching','StopWatching'],'existing watcher hears another watcher start and stop');
    await desktop.evaluate(() => ChatApp.callCloseWatchedShare('P1'));
    await waitScreens(web,5);
    await web.evaluate(() => ChatApp.callStopShareScreen(true));
    await waitScreens(web,6); await waitScreens(desktop,4);
    assert.deepEqual(await screenSounds(web),['StartScreen','StartWatching','StartWatching','StopWatching','StopWatching','EndScreen']);
    assert.deepEqual(await screenSounds(desktop),['StartScreen','StartWatching','StopWatching','EndScreen']);
    await web.evaluate(async () => {
      __screenSounds.length = 0;
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(1);
      ChatApp.callCaptureScreenPreview = async () => null;
      await ChatApp.callToggleCamera({ deviceId: '__default_camera__' });
    });
    await waitScreens(web,1); await waitScreens(desktop,5);
    assert.deepEqual(await screenSounds(web),['StartScreen'],'actual camera capture uses the screen category once after publication');
    const cameraId = await web.evaluate(() => ChatApp.callCameraShareId);
    await desktop.evaluate(() => ChatApp.openShareView('camera:P1','P1 camera'));
    await waitScreens(web,2);
    await set(web,'calls/test/members/P3/viewingShares',{'camera:P1':cameraId});
    await waitScreens(web,3); await waitScreens(desktop,6);
    await set(web,'calls/test/members/P3/viewingShares',null);
    await waitScreens(web,4); await waitScreens(desktop,7);
    await desktop.evaluate(() => ChatApp.callCloseWatchedShare('camera:P1'));
    await waitScreens(web,5);
    await web.evaluate(() => ChatApp.callToggleCamera());
    await waitScreens(web,6); await waitScreens(desktop,8);
    assert.deepEqual(await screenSounds(web),['StartScreen','StartWatching','StartWatching','StopWatching','StopWatching','EndScreen'],'camera owner has the same sound events as the screen owner');
    assert.deepEqual((await screenSounds(desktop)).slice(4),['StartScreen','StartWatching','StopWatching','EndScreen'],'desktop camera viewers hear the same screen category and audience rules');
    // The harness disables WebRTC. Model an established P3 peer so the next
    // signaling disconnect exercises the same reconnect grace as a live call.
    for (const page of [web,desktop]) await page.evaluate(() => ChatApp.callPeerMap.set('P3',{
      __peerSessionId:'session-P3',connectionState:'connected',iceConnectionState:'connected',close() {},
      getSenders:() => [],getReceivers:() => [],getTransceivers:() => [],getStats:async () => new Map()
    }));
    await set(web,'calls/test/members/P3/muted',true);
    await set(web,'calls/test/members/P3/speaking',true);
    await set(web,'calls/test/members/P3/connected',false);
    await set(web,'calls/test/members/P3/disconnectedAt',Date.now());
    await set(web,'calls/test/members/P3/connected',true);
    await set(web,'calls/test/rings/P4',{id:'invitation',to:'P4',from:'P1',createdAt:Date.now(),instanceId:'existing-call'});
    await set(web,'calls/test/members/P4',{...member('P4'),joinConfirmed:false});
    await set(web,'calls/test/members/P4',null);
    await web.waitForTimeout(80);
    assert.deepEqual(await sounds(web),['JoinCall','JoinCall'],'metadata, reconnect grace, rings, and abandoned pending joins are silent');
    await web.evaluate(() => ChatApp.openRoom('other',{quiet:true}));
    await desktop.evaluate(() => ChatApp.leaveCall({quiet:true}));
    await waitCount(web,3);
    assert.deepEqual(await sounds(desktop),['JoinCall','LeaveCall']);
    assert.equal((await sounds(web)).at(-1),'LeaveCall','current call sounds continue while another room is viewed');
    await desktop.evaluate(() => ChatApp.joinCall('test'));
    await waitCount(web,4);
    await web.evaluate(() => ChatApp.callConnCb({val:() => false}));
    await set(desktop,'calls/test/members/P3',null);
    await set(desktop,'calls/test/members/P5',member('P5'));
    await web.waitForTimeout(80);
    assert.equal((await sounds(web)).length,4,'offline cached roster is quiet');
    await web.evaluate(() => ChatApp.callConnCb({val:() => true}));
    await web.waitForTimeout(150);
    assert.equal((await sounds(web)).length,4,'restoring the same session rebases without replaying outage events');
    await set(desktop,'calls/test/members/P6',member('P6'));
    await waitCount(web,5);
    await web.evaluate(() => ChatApp.leaveCall({quiet:true}));
    await set(web,'calls/other',{instanceId:'other-existing',members:{P7:member('P7')}});
    await web.evaluate(() => ChatApp.joinCall('other'));
    await waitCount(web,7);
    await set(desktop,'calls/test/members/P6',null);
    await web.waitForTimeout(80);
    assert.equal((await sounds(web)).length,7,'old call callbacks cannot sound after switching calls');
    await set(web,'calls/other/members/P7',null);
    await waitCount(web,8);
    await web.evaluate(() => ChatApp.leaveCall({quiet:true}));
    assert.equal((await sounds(web)).length,9);
    await web.evaluate(async () => {
      const original = ChatApp.callCommitMembership;
      ChatApp.callCommitMembership = async () => { throw new Error('Local test denied call membership'); };
      await ChatApp.joinCall('other');
      ChatApp.callCommitMembership = original;
    });
    assert.equal((await sounds(web)).length,9,'failed join after optimistic UI produces no self cue');
    await web.evaluate(() => {
      ChatApp.callRequestMicPermission = () => new Promise(resolve => { window.__resolveCallMic = resolve; });
      window.__pendingCallJoin = ChatApp.joinCall('other');
    });
    await web.waitForFunction(() => ChatApp.callJoinPending && typeof __resolveCallMic === 'function');
    await web.evaluate(async () => {
      await ChatApp.leaveCall({roomId:'other',quiet:true});
      __resolveCallMic(new MediaStream()); await __pendingCallJoin;
      ChatApp.callRequestMicPermission = async () => new MediaStream();
    });
    assert.equal((await sounds(web)).length,9,'cancelled join produces no join or leave cue');
    await web.evaluate(async () => { await ChatApp.joinCall('other'); await ChatApp.logoutToLanding(); });
    assert.deepEqual((await sounds(web)).slice(-2),['JoinCall','LeaveCall']);
    assert.equal((await sounds(web)).length,11,'logout emits exactly one self leave');
    assert.deepEqual(errors,[]);
    assert.deepEqual(backend.deliveryErrors,[]);
    console.log('Call sounds browser passed: web/desktop call, screen and camera events, watcher audiences, quiet initial roster, metadata/reconnect, room switches, failed/cancelled joins and logout.');
  } finally { for (const context of contexts) await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
