/* Three real Chromium endpoints; two independent synthetic screen/audio shares.
 * Browser capture consent is mocked, RTP negotiation and audio playback are real.
 * Run: node tests/screen-audio.browser.cjs [report-directory]
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createSharedFirebaseBackend } = require('./shared-firebase-backend.cjs');
const root = path.resolve(__dirname, '..');
const reportDir = path.resolve(process.argv[2] || path.join(root, 'test-results/screen-audio'));
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    res.writeHead(error ? 404 : 200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] || 'application/octet-stream' });
    res.end(error ? 'Not found' : data);
  });
});
async function waitUntil(check, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error(message);
}
async function inspect(page) {
  return page.evaluate(async () => {
    const bytes = async receiver => receiver ? [...(await receiver.getStats()).values()].filter(r => r.type === 'inbound-rtp').reduce((sum, r) => sum + (r.bytesReceived || 0), 0) : 0;
    return { code: ChatApp.currentUser.code, sharing: ChatApp.callSharing, shareId: ChatApp.callScreenShareId,
      screens: [...ChatApp.callRemoteScreenAudioStreams.keys()],
      peers: await Promise.all([...ChatApp.callPeerMap].map(async ([code, pc]) => ({ code, connected: pc.connectionState,
        mic: await bytes(pc.__audioTx?.receiver), screen: await bytes(pc.__screenAudioTx?.receiver),
        txCount: pc.getTransceivers().length, sendingVideo: !!pc.__screenTx?.sender.track, sendingScreenAudio: !!pc.__screenAudioTx?.sender.track,
        voiceTrack: pc.__audioTx?.receiver.track.id, screenTrack: pc.__screenAudioTx?.receiver.track.id }))) };
  });
}

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const backend = createSharedFirebaseBackend(3);
  const pages = [];
  const errors = [];
  const phases = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  try {
    for (let index = 1; index <= 3; index++) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ['microphone', 'camera'] });
      await backend.bind(context);
      await context.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.evaluate(user => {
        ChatApp.currentUser = user;
        ChatApp.currentRoomId = 'test';
        document.body.dataset.mode = 'chat';
        document.querySelectorAll('.view').forEach(view => view.dataset.active = String(view.id === 'view-chat'));
        ChatApp.callMakeRtcConfig = () => ({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
        ChatApp.callRefreshIceServers = async () => [];
        window.__captures = [];
        navigator.mediaDevices.getDisplayMedia = async options => {
          window.__captureOptions = options;
          const canvas = document.createElement('canvas');
          canvas.width = 1280; canvas.height = 720;
          const paint = canvas.getContext('2d');
          paint.scale(2, 2);
          let tick = 0;
          const draw = () => {
            paint.fillStyle = '#17293b'; paint.fillRect(0, 0, 640, 360);
            paint.fillStyle = '#557c9f'; paint.fillRect(20, 20, 600, 45);
            paint.fillStyle = '#244c68'; paint.fillRect(20, 80, 170, 260);
            paint.fillStyle = '#8ab6c5'; paint.fillRect(210, 80, 410, 110);
            paint.fillStyle = '#477b74'; paint.fillRect(210, 205, 410, 135);
            paint.fillStyle = 'white'; paint.font = '24px sans-serif'; paint.fillText('Example shared desktop', 32, 51);
            paint.fillStyle = `hsl(${tick++ % 360} 85% 70%)`; paint.fillRect(220 + tick % 320, 230, 48, 48);
          };
          draw();
          const timer = setInterval(draw, 33);
          const audio = new AudioContext();
          await audio.resume();
          const tone = audio.createOscillator();
          tone.frequency.value = user.code === 'P1' ? 330 : 660;
          const gain = audio.createGain(); gain.gain.value = 0.04;
          const destination = audio.createMediaStreamDestination();
          tone.connect(gain).connect(destination); tone.start();
          const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...destination.stream.getAudioTracks()]);
          // This fixture models a selected browser tab, whose audio contains
          // only the generated media tone. Real OS exclusion has a native test.
          const videoTrack = stream.getVideoTracks()[0];
          const getSettings = videoTrack.getSettings.bind(videoTrack);
          videoTrack.getSettings = () => ({ ...getSettings(), displaySurface: 'browser' });
          window.__captures.push({ stream, audio, tone, timer });
          return stream;
        };
      }, backend.values.users[`P${index}`]);
      pages.push(page);
    }
    await Promise.all(pages.map(page => page.evaluate(() => ChatApp.joinCall('test', { openMenu: true }))));
    await waitUntil(async () => (await Promise.all(pages.map(inspect))).every(state => state.peers.length === 2 && state.peers.every(peer => peer.connected === 'connected' && peer.mic > 0)), 'All voice endpoints connect');
    console.log('Voice connected; starting two independently captured audio/video shares.');
    await Promise.all(pages.slice(0, 2).map(page => page.evaluate(() => ChatApp.callToggleShareScreen())));
    await waitUntil(() => pages[2].evaluate(() => ChatApp.callMembersCache.filter(m => m.sharing).length === 2), 'Both share announcements arrive');
    await waitUntil(() => pages[2].evaluate(() => ['P1', 'P2'].every(code => !!ChatApp.callGetSharePreview(code))), 'Unwatched participants receive the one-shot blurred previews');
    const originalPreview = await pages[2].evaluate(() => ChatApp.callGetSharePreview('P1'));
    assert.equal(await pages[2].locator('.call-share-watch').count(), 0, 'There is no separate Watch button');
    assert.equal((await inspect(pages[0])).peers.find(peer => peer.code === 'P3').sendingVideo, false, 'Preview requires no live video subscription');
    const posterGeometry = await pages[2].locator('.call-share-offer[data-share-code="P1"]').evaluate(tile => {
      const rect = node => node.getBoundingClientRect();
      const outer = rect(tile), avatar = rect(tile.querySelector('.call-share-avatar')), label = rect(tile.querySelector('.call-share-name'));
      const art = tile.querySelector('.call-share-art'), icon = rect(art);
      return { groupCenter: (avatar.top + label.bottom) / 2, tileCenter: outer.top + outer.height / 2,
        iconLeft: icon.left - outer.left, iconTop: icon.top - outer.top, iconWidth: icon.width,
        iconBackground: getComputedStyle(art).backgroundColor, preview: !!tile.querySelector('.call-share-preview') };
    });
    assert.ok(Math.abs(posterGeometry.groupCenter - posterGeometry.tileCenter) < 2, 'Avatar and label are centered together');
    assert.ok(posterGeometry.iconLeft < 20 && posterGeometry.iconTop < 20 && posterGeometry.iconWidth <= 22);
    assert.equal(posterGeometry.iconBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(posterGeometry.preview, true);
    await pages[2].evaluate(() => ChatApp.closeToast());
    await pages[2].locator('#call-menu').screenshot({ path: path.join(reportDir, 'unwatched-previews.png') });
    await pages[2].evaluate(() => {
      window.__firstWatch = { started: performance.now(), frames: [] };
      const frame = (now, metadata) => {
        window.__firstWatch.frames.push({ ms: now - window.__firstWatch.started, mediaTime: metadata.mediaTime });
        if (window.__firstWatch.frames.length < 15) video.requestVideoFrameCallback(frame);
      };
      let video;
      const observer = new MutationObserver(() => {
        video = document.querySelector('.call-view-tile[data-share-code="P1"] video');
        if (video) { observer.disconnect(); video.requestVideoFrameCallback(frame); }
      });
      observer.observe(document.querySelector('#call-menu-list'), { childList: true, subtree: true });
    });
    // Click a corner of the placeholder, well outside its avatar/name group.
    await pages[2].locator('.call-share-offer[data-share-code="P1"] .call-share-open').click({ position: { x: 15, y: 50 } });
    await pages[2].locator('.call-share-offer[data-share-code="P2"] .call-share-open').click();
    await waitUntil(() => pages[2].evaluate(() => window.__firstWatch.frames.length === 15), 'The first watch decodes moving frames promptly', 5000);
    const startup = await pages[2].evaluate(() => window.__firstWatch.frames);
    assert.ok(startup[0].ms < 3000, `First decoded frame took ${startup[0].ms}ms`);
    assert.ok(startup.at(-1).ms - startup[0].ms < 2000, 'First 15 frames arrive smoothly during startup');
    assert.ok(startup.at(-1).mediaTime > startup[0].mediaTime, 'Startup frames advance in the real RTP stream');
    phases.push({ phase: 'One-shot unwatched preview, full-tile click and responsive first-watch frames', posterGeometry, startup });
    await waitUntil(async () => (await inspect(pages[2])).peers.every(peer => peer.screen > 500 && peer.mic > 0), 'Both screen audio receivers get real RTP');
    const before = await inspect(pages[2]);
    assert.deepEqual(before.screens.sort(), ['P1', 'P2']);
    assert.ok(before.peers.every(peer => peer.txCount === 4 && peer.voiceTrack !== peer.screenTrack));
    const options = await pages[0].evaluate(() => window.__captureOptions);
    assert.equal(options.audio.echoCancellation, false);
    assert.equal(options.audio.restrictOwnAudio, true, 'screen audio requests exclusion of the calling document');
    assert.equal(options.audio.suppressLocalAudioPlayback, false, 'call playback is not muted for the sharer');
    assert.equal(options.video.frameRate.ideal, 30);
    assert.equal(options.video.width.ideal, 1280);
    assert.equal(options.video.height.ideal, 720);
    phases.push({ phase: 'Two simultaneous screen audio streams received independently', state: before });
    // Temporarily withhold the durable write to verify the real negotiated
    // channel delivers pause independently of the Firebase member listener.
    await waitUntil(() => pages[0].evaluate(() => ChatApp.callPeerMap.get('P3').__screenStateChannel?.readyState === 'open'), 'Screen state data channel opens');
    await pages[0].evaluate(async () => {
      window.__pauseOriginalUpdate = ChatApp.myCallMemberRef.update;
      ChatApp.myCallMemberRef.update = async () => {};
      await ChatApp.callSetScreenPaused(true);
    });
    await waitUntil(() => pages[2].evaluate(() => ChatApp.callGetScreenPauseState('P1').paused && !!ChatApp.callRemotePauseStates.get('P1')), 'Direct RTC pause reaches an existing viewer without a database update');
    assert.equal(await pages[0].evaluate(() => {
      const pc = ChatApp.callPeerMap.get('P3');
      return !ChatApp.callScreenTrack.enabled && pc.__screenTx.sender.track === ChatApp.callScreenPauseTrack && !pc.__screenAudioTx.sender.track && !!pc.__audioTx.sender.track;
    }), true, 'Manual pause freezes screen, silences screen audio and keeps the microphone');
    await pages[0].evaluate(async () => {
      ChatApp.myCallMemberRef.update = window.__pauseOriginalUpdate;
      await ChatApp.myCallMemberRef.update({ sharePaused: true, sharePauseFrame: ChatApp.callScreenPauseFrame, sharePauseVersion: ChatApp.callScreenPauseVersion });
    });
    await pages[1].evaluate(() => ChatApp.openShareView('P1', 'P1'));
    await waitUntil(() => pages[1].evaluate(() => !!document.querySelector('[data-share-code="P1"] .call-screen-paused')), 'Late viewer sees paused overlay');
    await pages[2].locator('#call-menu').screenshot({ path: path.join(reportDir, 'realtime-paused-screen.png') });
    await pages[0].evaluate(() => ChatApp.callSetScreenPaused(false));
    await waitUntil(() => pages[2].evaluate(() => !ChatApp.callGetScreenPauseState('P1').paused && !document.querySelector('[data-share-code="P1"] .call-screen-paused')), 'Resume removes remote overlay immediately');
    await waitUntil(() => pages[0].evaluate(() => {
      const pc = ChatApp.callPeerMap.get('P3');
      return pc.__screenTx.sender.track === ChatApp.callScreenTrack && pc.__screenAudioTx.sender.track === ChatApp.callScreenAudioTrack;
    }), 'Resume restores the original live video and audio sender');
    await pages[1].evaluate(() => ChatApp.callCloseWatchedShare('P1'));
    phases.push({ phase: 'Real RTC pause signal, frozen sender, durable late viewer overlay and manual resume', passed: true });
    console.log('Both screen audio streams received; checking independent volume, mute and focus.');
    const independence = await pages[2].evaluate(async () => {
      await ChatApp.callResumeRemoteAudio({ fromGesture: true });
      ChatApp.callSetScreenVolume('P1', 350, { smooth: false, fromGesture: true });
      ChatApp.callSetScreenVolume('P2', 65, { smooth: false, fromGesture: true });
      const amplifiedGain = ChatApp.callRemoteWebAudioSources.get('screen/P1')?.gain.gain.value;
      ChatApp.callSetScreenMuted('P1', true, { smooth: false, fromGesture: true });
      const voice = ChatApp.callGetUserVolumePercent('P1');
      const firstElement = ChatApp.callRemoteAudioEls.get('screen/P1');
      const secondElement = ChatApp.callRemoteAudioEls.get('screen/P2');
      ChatApp.callFocusedShareCode = 'P1'; ChatApp.renderCallMenu();
      ChatApp.callFocusedShareCode = 'P2'; ChatApp.renderCallMenu();
      return { volume1: ChatApp.callGetScreenVolume('P1'), volume2: ChatApp.callGetScreenVolume('P2'),
        muted1: ChatApp.callIsScreenMuted('P1'), muted2: ChatApp.callIsScreenMuted('P2'), voice,
        retained: firstElement === ChatApp.callRemoteAudioEls.get('screen/P1') && secondElement === ChatApp.callRemoteAudioEls.get('screen/P2'),
        distinct: firstElement !== secondElement, videoMuted: [...document.querySelectorAll('.call-view-video')].every(video => video.muted),
        amplifiedGain, mutedGain: ChatApp.callRemoteWebAudioSources.get('screen/P1')?.gain.gain.value,
        secondVolume: ChatApp.callRemoteWebAudioSources.get('screen/P2')?.gain.gain.value ?? secondElement.volume };
    });
    assert.equal(independence.amplifiedGain, 3.5);
    assert.equal(independence.mutedGain, 0);
    assert.ok(Math.abs(independence.secondVolume - 0.65) < 0.001);
    assert.deepEqual({ ...independence, secondVolume: 0.65 }, { volume1: 350, volume2: 65, muted1: true, muted2: false, voice: 100, retained: true, distinct: true, videoMuted: true, amplifiedGain: 3.5, mutedGain: 0, secondVolume: 0.65 });
    phases.push({ phase: 'Volume, mute and focus remain independent from voice and the other share', independence });
    const deafened = await pages[2].evaluate(async () => {
      ChatApp.callToggleDeafen();
      // Exercise the same refresh used for arriving screen audio/autoplay.
      ChatApp.callSyncScreenAudioPlayback();
      await ChatApp.callResumeRemoteAudio({ fromGesture: true });
      return { gains: [...ChatApp.callRemoteWebAudioSources.values()].map(entry => entry.gain.gain.value),
        nativeMuted: [...ChatApp.callRemoteAudioEls.values()].every(audio => audio.muted),
        screens: ['P1', 'P2'].map(code => ChatApp.callGetPlaybackGain(`screen/${code}`)) };
    });
    assert.ok(deafened.gains.length >= 2);
    assert.ok(deafened.gains.every(gain => gain === 0), 'deafen silences both actual Web Audio screen paths');
    assert.equal(deafened.nativeMuted, true);
    assert.deepEqual(deafened.screens, [0, 0]);
    const restored = await pages[2].evaluate(() => {
      ChatApp.callToggleDeafen();
      return ['P1', 'P2'].map(code => ChatApp.callRemoteWebAudioSources.get(`screen/${code}`)?.gain.gain.value);
    });
    assert.equal(restored[0], 0, 'undeafen preserves the individually muted screen');
    assert.ok(Math.abs(restored[1] - 0.65) < 0.001, 'undeafen restores the other screen volume');
    phases.push({ phase: 'Deafen silences both screen transports across playback recovery', deafened, restored });
    await pages[2].evaluate(() => ChatApp.callCloseWatchedShare('P1'));
    await waitUntil(async () => !(await inspect(pages[0])).peers.find(peer => peer.code === 'P3').sendingScreenAudio && !(await inspect(pages[0])).peers.find(peer => peer.code === 'P3').sendingVideo, 'Unsubscribe pauses both senders');
    assert.equal((await inspect(pages[1])).peers.find(peer => peer.code === 'P3').sendingScreenAudio, true, 'Other screen continues sending');
    const firstShareId = await pages[0].evaluate(() => ChatApp.callScreenShareId);
    await pages[0].evaluate(async () => { ChatApp.callStopShareScreen(true); await ChatApp.callToggleShareScreen(); });
    await waitUntil(() => pages[2].evaluate(previous => ChatApp.callMembersCache.find(m => m.code === 'P1')?.shareId !== previous, firstShareId), 'New share generation arrives');
    await pages[2].evaluate(() => ChatApp.openShareView('P1', 'P1', { multi: true }));
    await waitUntil(async () => (await inspect(pages[0])).peers.find(peer => peer.code === 'P3').sendingScreenAudio, 'New capture reuses screen audio sender');
    await pages[2].evaluate(async () => { ChatApp.callSetScreenMuted('P1', false, { smooth: false, fromGesture: true }); await ChatApp.callResumeRemoteAudio({ fromGesture: true }); });
    await waitUntil(() => pages[2].evaluate(() => {
      const audio = ChatApp.callRemoteAudioEls.get('screen/P1');
      const graph = ChatApp.callRemoteWebAudioSources.get('screen/P1');
      const video = document.querySelector('.call-view-tile[data-share-code="P1"] .call-view-video');
      return !!ChatApp.callRemoteScreenAudioStreams.get('P1') && !!audio?.srcObject && !audio.paused &&
        audio.srcObject.getAudioTracks().some(track => !track.muted && track.readyState === 'live') && graph?.gain.gain.value === 3.5 &&
        !!video?.srcObject && video.videoWidth > 0 && video.srcObject.getVideoTracks().some(track => !track.muted && track.readyState === 'live');
    }), 'Replacement capture restores actual video and amplified audio playback');
    const end = await inspect(pages[2]);
    assert.equal(await pages[2].evaluate(() => ChatApp.callGetSharePreview('P1')), originalPreview, 'The first preview remains identical after watching and restarting capture');
    assert.ok(end.peers.every(peer => peer.mic > before.peers.find(old => old.code === peer.code).mic));
    assert.ok(end.peers.every(peer => peer.txCount === 4));
    phases.push({ phase: 'Unsubscribe and replacement share preserve microphone and stable transceivers', state: end });
    // A separate camera RTP sender must coexist with the same user's screen.
    console.log('Checking camera and screen sharing together.');
    await pages[0].click('#btn-call-camera');
    await waitUntil(() => pages[2].evaluate(() => !!ChatApp.callGetSharePreview('camera:P1')), 'Camera advertises one blurred preview');
    assert.equal(await pages[2].locator('.call-participant[data-usercode="P1"] .call-participant-state.camera').count(), 1);
    assert.equal(await pages[2].locator('[id^="btn-sidebar-call"][id*="camera"]').count(), 0);
    assert.equal(await pages[0].locator('#btn-call-camera').evaluate(button => button.previousElementSibling.id), 'btn-call-share');
    const camera = pages[2].locator('.call-screen-tile[data-share-code="camera:P1"]');
    assert.match(await camera.innerText(), /P1's Camera|Person 1's Camera/);
    await pages[2].locator('#call-menu').screenshot({ path: path.join(reportDir, 'camera-and-screen-offer.png') });
    await camera.click({ button: 'right' });
    assert.equal(await pages[2].locator('#call-screen-context-menu:visible').count(), 0, 'Cameras have no right-click menu');
    await camera.locator('.call-share-open').click();
    await waitUntil(() => pages[2].evaluate(() => {
      const cameraVideo = document.querySelector('.call-view-tile[data-share-code="camera:P1"] video');
      const screenVideo = document.querySelector('.call-view-tile[data-share-code="P1"] video');
      return cameraVideo?.videoWidth > 0 && screenVideo?.videoWidth > 0 && cameraVideo.srcObject !== screenVideo.srcObject;
    }), 'Screen and camera decode independently');
    await waitUntil(() => pages[0].evaluate(() => ChatApp.callGetShareViewerUsers('camera:P1').some(user => user.code === 'P3')), 'Camera viewers reach the publisher');
    assert.equal(await pages[0].evaluate(() => {
      const pc = ChatApp.callPeerMap.get('P3');
      return pc.__screenTx.sender.track === ChatApp.callScreenTrack && pc.__cameraTx.sender.track === ChatApp.callCameraTrack && pc.__screenTx !== pc.__cameraTx;
    }), true);
    const cameraBudget = await pages[0].evaluate(() => ({ capture: ChatApp.callCameraTrack.getSettings(), sender: ChatApp.callPeerMap.get('P3').__cameraTx.sender.getParameters().encodings[0] }));
    assert.ok(cameraBudget.capture.width <= 1280 && cameraBudget.capture.height <= 720 && cameraBudget.capture.frameRate <= 30);
    assert.equal(cameraBudget.sender.maxFramerate, 30);
    await camera.locator('.call-view-focus').click();
    assert.equal(await camera.getAttribute('class').then(classes => classes.includes('is-focused')), true);
    assert.equal(await camera.locator('.call-camera-icon').count(), 1);
    await camera.locator('.call-viewers-eye').hover();
    await camera.click({ button: 'right' });
    assert.equal(await pages[2].locator('#call-screen-context-menu:visible').count(), 0);
    await camera.locator('.call-viewers-eye').hover();
    await pages[2].waitForTimeout(250);
    await pages[2].locator('#call-menu').screenshot({ path: path.join(reportDir, 'focused-camera.png') });
    const cameraPreview = await pages[2].evaluate(() => ChatApp.callGetSharePreview('camera:P1'));
    await pages[2].waitForTimeout(250);
    assert.equal(await pages[2].evaluate(() => ChatApp.callGetSharePreview('camera:P1')), cameraPreview, 'Camera poster remains one frame');
    await pages[0].click('#btn-call-camera');
    await waitUntil(() => pages[2].evaluate(() => !ChatApp.callShareIsAvailable('camera:P1') && !ChatApp.callWatchedShareCodes.has('camera:P1')), 'Stopping camera prunes its watch');
    assert.equal(await pages[0].evaluate(() => ChatApp.callSharing && ChatApp.callScreenTrack.readyState === 'live' && !ChatApp.callCameraStream), true, 'Stopping camera preserves screen capture');
    await pages[0].click('#btn-call-camera');
    await waitUntil(() => pages[2].evaluate(() => ChatApp.callShareIsAvailable('camera:P1')), 'Camera can restart');
    await pages[2].evaluate(() => ChatApp.openShareView('camera:P1', 'P1', { multi: true }));
    await waitUntil(() => pages[2].evaluate(() => document.querySelector('.call-view-tile[data-share-code="camera:P1"] video')?.videoWidth > 0), 'Restart reuses live camera receiver');
    assert.equal(await pages[0].evaluate(() => ChatApp.callPeerMap.get('P3').getTransceivers().length), 4, 'Camera restart never adds transceivers');
    await pages[0].evaluate(() => { window.__cameraBeforeLeave = ChatApp.callCameraTrack; return ChatApp.leaveCall({ quiet: true }); });
    assert.equal(await pages[0].evaluate(() => __cameraBeforeLeave.readyState), 'ended', 'Leaving releases the camera');
    phases.push({ phase: 'Simultaneous camera/screen RTP, 720p30, viewers, focus, no menus, stop/restart and leave', cameraBudget });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify({ phases, errors }, null, 2));
    console.log('Screen audio transport integration passed.');
  } catch (error) {
    fs.writeFileSync(path.join(reportDir, 'failure.json'), JSON.stringify({ message: error.stack, errors, states: await Promise.all(pages.map(page => inspect(page).catch(e => ({ error: e.message })))) }, null, 2));
    throw error;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
