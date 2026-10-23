/* Local integration: six real Chrome WebRTC participants, mocked signaling, fake media.
 * Run with Playwright installed: node tests/six-person-call.browser.cjs [report-directory]
 * External HTTP is blocked. ICE is restricted to host candidates for this local test.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { createSharedFirebaseBackend } = require("./shared-firebase-backend.cjs");
const root = path.resolve(__dirname, "..");
const reportDir = path.resolve(process.argv[2] || path.join(root, "test-results/calling"));
const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => { res.writeHead(error ? 404 : 200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" }); res.end(error ? "Not found" : data); });
});

async function inspect(page) {
  return page.evaluate(async () => {
    const peers = await Promise.all([...ChatApp.callPeerMap].map(async ([peer, pc]) => {
      const stats = [...(await pc.getStats()).values()];
      const inbound = stats.filter((item) => item.type === "inbound-rtp");
      const outbound = stats.filter((item) => item.type === "outbound-rtp");
      const media = (items, kind) => items.filter((item) => (item.kind || item.mediaType) === kind);
      return { peer, connection: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState,
        audioTransceiverMid: pc.__audioTx?.mid,
        transceivers: pc.getTransceivers().map((tx) => ({ mid: tx.mid, kind: tx.receiver.track.kind, direction: tx.direction, currentDirection: tx.currentDirection, senderTrack: tx.sender.track?.kind, senderTrackState: tx.sender.track?.readyState })),
        localSdpMedia: pc.localDescription?.sdp.split(/\r?\n/).filter((line) => /^(?:m=|a=(?:mid|sendrecv|sendonly|recvonly|inactive|msid|ice-ufrag))/.test(line)),
        remoteSdpMedia: pc.remoteDescription?.sdp.split(/\r?\n/).filter((line) => /^(?:m=|a=(?:mid|sendrecv|sendonly|recvonly|inactive|msid|ice-ufrag))/.test(line)),
        audioBytes: media(inbound, "audio").reduce((sum, item) => sum + (item.bytesReceived || 0), 0),
        audioPackets: media(inbound, "audio").reduce((sum, item) => sum + (item.packetsReceived || 0), 0),
        videoFrames: media(inbound, "video").reduce((sum, item) => sum + (item.framesDecoded || 0), 0),
        outboundVideoFrames: media(outbound, "video").reduce((sum, item) => sum + (item.framesEncoded || 0), 0),
        videoSenders: pc.getSenders().filter((sender) => sender.track?.kind === "video").length };
    }));
    return { code: ChatApp.currentUser?.code, room: ChatApp.currentCallRoomId, members: ChatApp.callMembersCache.length,
      peers, listenOnly: ChatApp.callListenOnly, sharing: ChatApp.callSharing,
      videos: [...document.querySelectorAll("#call-menu video")].map((video) => ({ readyState: video.readyState, currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight })) };
  });
}

async function waitUntil(check, timeout, message) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(message);
}

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const backend = createSharedFirebaseBackend(6);
  const errors = [];
  const pages = [];
  const result = { environment: "One local Chrome browser, six isolated contexts, host ICE, shared in-memory signaling, fake microphones and canvas screen", phases: [] };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
  try {
    const entry = `http://127.0.0.1:${server.address().port}/index.html`;
    for (let index = 1; index <= 6; index++) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["microphone", "camera"] });
      await backend.bind(context);
      await context.route(/^https?:\/\/(?!127\.0\.0\.1(?::|\/))/, (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "null" }));
      const page = await context.newPage();
      const code = `P${index}`;
      page.on("pageerror", (error) => errors.push({ code, message: error.message }));
      page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push({ code, message: message.text() }); });
      await page.goto(entry);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === "true", null, { timeout: 20000 });
      await page.evaluate((user) => {
        ChatApp.currentUser = user;
        ChatApp.currentRoomId = "test";
        document.body.dataset.mode = "chat";
        document.querySelectorAll(".view").forEach((view) => { view.dataset.active = String(view.id === "view-chat"); });
        // No STUN/TURN packets leave the machine in this integration fixture.
        ChatApp.callMakeRtcConfig = () => ({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", iceCandidatePoolSize: 0 });
        ChatApp.callRefreshIceServers = async () => [];
      }, backend.values.users[code]);
      pages.push(page);
    }
    console.log("Six clients booted; joining the room.");
    const joinStart = Date.now();
    await Promise.all(pages.map((page) => page.evaluate(() => ChatApp.joinCall("test", { openMenu: true }))));
    if (process.env.CALL_QA_DIAGNOSTIC) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      fs.writeFileSync(path.join(reportDir, "early-state.json"), JSON.stringify(await Promise.all(pages.map(inspect)), null, 2));
      throw new Error("Diagnostic early exit (CALL_QA_DIAGNOSTIC)");
    }
    await waitUntil(async () => {
      const states = await Promise.all(pages.map(inspect));
      return states.every((state) => state.peers.length === 5 && state.peers.every((peer) => peer.connection === "connected" && peer.audioBytes > 0));
    }, 45000, "All 30 peer endpoints must connect and receive audio");
    const initial = await Promise.all(pages.map(inspect));
    result.phases.push({ phase: "six-person audio established", elapsedMs: Date.now() - joinStart, states: initial });
    console.log(`All 30 endpoints receive audio after ${Date.now() - joinStart} ms; checking 35-second continuity.`);
    const sustainUntil = Date.now() + 35000;
    let continuitySamples = 0;
    while (Date.now() < sustainUntil) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const states = await Promise.all(pages.map(inspect));
      assert.ok(states.every((state) => state.peers.length === 5 && state.peers.every((peer) => peer.connection === "connected")), "Every participant remains connected through heartbeat intervals");
      continuitySamples++;
    }
    const sustained = await Promise.all(pages.map(inspect));
    for (let index = 0; index < sustained.length; index++) for (const peer of sustained[index].peers) {
      const before = initial[index].peers.find((item) => item.peer === peer.peer);
      assert.ok(peer.audioBytes > before.audioBytes && peer.audioPackets > before.audioPackets, `Audio continues for ${sustained[index].code} ← ${peer.peer}`);
    }
    result.phases.push({ phase: "35-second audio continuity", continuitySamples, states: sustained });
    console.log("Sustained audio passed; broadcasting canvas screen to five viewers.");
    await pages[0].evaluate(async () => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext("2d");
        let tick = 0;
        const paint = () => { ctx.fillStyle = `hsl(${tick++ % 360} 40% 24%)`; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = "white"; ctx.font = "56px sans-serif"; ctx.fillText(`Local shared screen ${tick}`, 70, 140); };
        paint();
        const timer = setInterval(paint, 1000 / 30);
        const stream = canvas.captureStream(30);
        stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer), { once: true });
        window.__screenCanvas = canvas;
        window.__screenTimer = timer;
        return stream;
      };
      await ChatApp.callToggleShareScreen();
    });
    await waitUntil(async () => (await Promise.all(pages.map((page) => page.evaluate(() => ChatApp.callMembersCache.find((member) => member.code === "P1")?.sharing)))).every(Boolean), 10000, "Share announcement must reach all participants");
    const beforeWatch = await inspect(pages[0]);
    assert.ok(beforeWatch.peers.every((peer) => peer.videoSenders === 0), "Unsubscribed peers must not receive screen encoding");
    const screenWatchStarted = Date.now();
    await Promise.all(pages.slice(1).map((page) => page.evaluate(() => ChatApp.openShareView("P1", "P1"))));
    await waitUntil(async () => {
      const viewers = await Promise.all(pages.slice(1).map(inspect));
      return viewers.every((state) => state.peers.find((peer) => peer.peer === "P1")?.videoFrames > 3 && state.videos.some((video) => video.width === 1280 && video.height === 720));
    }, 5000, "Five viewers must decode full-resolution 720p video within five seconds, without the old ten-second warmup");
    const screenStartupMs = Date.now() - screenWatchStarted;
    const shared = await Promise.all(pages.map(inspect));
    assert.ok(shared.every((state) => state.peers.length === 5 && state.peers.every((peer) => peer.connection === "connected")), "Screen sharing keeps every room peer connected");
    assert.ok(shared.slice(1).every(state => state.videos.some(video => video.width === 1280 && video.height === 720)), "Every healthy local viewer receives a 720p screen");
    const caps = await pages[0].evaluate(() => [...ChatApp.callPeerMap.values()].map(pc => pc.__screenTx.sender.getParameters().encodings[0].maxFramerate));
    assert.ok(caps.every(fps => fps === 30), "Five viewers retain the 30fps screen target without a participant-count penalty");
    const bitrates = await pages[0].evaluate(() => [...ChatApp.callPeerMap.values()].map(pc => pc.__screenTx.sender.getParameters().encodings[0].maxBitrate));
    assert.ok(bitrates.every(bps => bps === 2400000), "Five viewers share a bounded 12Mbps upload budget at 720p30");
    result.phases.push({ phase: "one screen broadcast to five subscribed viewers", startupMs: screenStartupMs, states: shared });
    console.log(`Five viewers reached 720p in ${screenStartupMs} ms.`);
    await Promise.all(pages.slice(1).map((page) => page.evaluate(() => { window.__retainedCallVideos = [...document.querySelectorAll("#call-menu video")]; })));
    for (let tick = 0; tick < 6; tick++) {
      await pages[0].evaluate((speaking) => ChatApp.myCallMemberRef.update({ speaking }), tick % 2 === 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const retained = await Promise.all(pages.slice(1).map((page) => page.evaluate(() => window.__retainedCallVideos.length > 0 && window.__retainedCallVideos.every((video) => video.isConnected && [...document.querySelectorAll("#call-menu video")].includes(video)))));
    assert.ok(retained.every(Boolean), "Speaking changes must retain live video elements");
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const duringScreen = await Promise.all(pages.map(inspect));
    for (let index = 0; index < duringScreen.length; index++) for (const peer of duringScreen[index].peers) {
      const before = shared[index].peers.find((item) => item.peer === peer.peer);
      assert.equal(peer.connection, "connected");
      assert.ok(peer.audioBytes > before.audioBytes, `Audio continues during screen sharing for ${duringScreen[index].code} ← ${peer.peer}`);
      if (peer.peer === "P1") assert.ok(peer.videoFrames > before.videoFrames, "Subscribed screen frames continue decoding");
    }
    result.phases.push({ phase: "audio and screen remain live together for 10 more seconds", states: duringScreen });
    await pages[0].evaluate(() => ChatApp.callToggleCamera());
    await waitUntil(async () => pages[1].evaluate(() => ChatApp.callMembersCache.find(member => member.code === 'P1')?.cameraSharing), 5000, 'Camera announcement reaches the viewer');
    const cameraWatchStarted = Date.now();
    await pages[1].evaluate(() => ChatApp.openShareView(ChatApp.callCameraKey('P1'), 'P1'));
    await waitUntil(async () => pages[1].evaluate(() => {
      const video = document.querySelector('.call-view-tile[data-share-kind="camera"] video');
      return video?.videoWidth === 1280 && video?.videoHeight === 720 && video.readyState >= 2;
    }), 5000, 'New camera viewer receives full-resolution 720p without the old ten-second warmup');
    const cameraStartupMs = Date.now() - cameraWatchStarted;
    const cameraState = await pages[1].evaluate(async () => {
      const pc = ChatApp.callPeerMap.get('P1');
      const video = [...(await pc.__cameraTx.receiver.getStats()).values()].find(report => report.type === 'inbound-rtp' && report.kind === 'video');
      return { width: video?.frameWidth, height: video?.frameHeight, frames: video?.framesDecoded, fps: video?.framesPerSecond };
    });
    assert.equal(await pages[1].locator('.call-view-tile[data-share-kind="camera"] .call-camera-icon').count(), 0, 'Camera video controls have the same text-only source title as screens');
    result.phases.push({ phase: 'new camera viewer reaches 720p', startupMs: cameraStartupMs, state: cameraState });
    console.log(`New camera viewer reached 720p in ${cameraStartupMs} ms.`);
    const dualMedia = () => pages[1].evaluate(async () => {
      const pc = ChatApp.callPeerMap.get('P1');
      const incoming = async tx => [...(await tx.receiver.getStats()).values()].find(report => report.type === 'inbound-rtp' && report.kind === 'video');
      const [screen, camera] = await Promise.all([incoming(pc.__screenTx), incoming(pc.__cameraTx)]);
      return {
        connection: pc.connectionState,
        screen: { width: screen?.frameWidth, height: screen?.frameHeight, frames: screen?.framesDecoded },
        camera: { width: camera?.frameWidth, height: camera?.frameHeight, frames: camera?.framesDecoded },
        watched: [...ChatApp.callWatchedShareCodes],
        visible: [...document.querySelectorAll('.call-view-tile video')].filter(video => video.videoWidth === 1280 && video.videoHeight === 720 && !video.paused).length
      };
    });
    const bothStarted = await dualMedia();
    assert.ok(bothStarted.watched.includes('P1') && bothStarted.watched.includes('camera:P1'), 'Opening a camera retains the screen without an eye toggle');
    assert.ok(bothStarted.visible >= 2, 'Both 720p media tiles remain visible and playing');
    await new Promise(resolve => setTimeout(resolve, 5000));
    const bothSustained = await dualMedia();
    assert.equal(bothSustained.connection, 'connected');
    for (const source of ['screen', 'camera']) {
      assert.equal(bothSustained[source].width, 1280);
      assert.equal(bothSustained[source].height, 720);
      assert.ok(bothSustained[source].frames > bothStarted[source].frames, `Simultaneous ${source} frames continue decoding`);
    }
    const dualCaps = await pages[0].evaluate(() => {
      const pc = ChatApp.callPeerMap.get('P2');
      return [pc.__screenTx.sender, pc.__cameraTx.sender].map(sender => ({ settings: sender.track.getSettings(), parameters: sender.getParameters() }));
    });
    for (const sender of dualCaps) {
      assert.equal(sender.settings.width, 1280);
      assert.equal(sender.settings.height, 720);
      assert.equal(sender.parameters.encodings[0].maxFramerate, 30);
      assert.equal(sender.parameters.encodings[0].maxBitrate, 2000000);
    }
    assert.equal(dualCaps[0].parameters.degradationPreference, 'maintain-resolution');
    assert.equal(dualCaps[1].parameters.degradationPreference, 'balanced');
    await pages[1].evaluate(() => ChatApp.callCloseWatchedShare('camera:P1'));
    await waitUntil(async () => pages[0].evaluate(() => {
      const pc = ChatApp.callPeerMap.get('P2');
      return !pc.__cameraTx.sender.track && !!pc.__screenTx.sender.track && !!pc.__audioTx.sender.track;
    }), 5000, 'Closing the camera detaches only its stream and retains screen and microphone');
    assert.equal(await pages[1].evaluate(() => ChatApp.callWatchedShareCodes.has('P1')), true);
    result.phases.push({ phase: 'simultaneous 720p30 screen and camera remain live; independent camera close preserves screen and voice', before: bothStarted, after: bothSustained, caps: dualCaps });
    await pages[0].evaluate(() => ChatApp.callStopCamera({ publish: true }));
    // P2 is the polite side of P1/P2. A fresh polite transport must negotiate
    // immediately, retain its watched screen, and restore real RTP both ways.
    await pages[1].evaluate(async () => {
      window.__beforeRecoveryPeer = ChatApp.callPeerMap.get('P1');
      await ChatApp.callHardRestartPeer('P1', 'test', 'integration-recovery');
    });
    await waitUntil(async () => {
      const viewer = await inspect(pages[1]);
      const peer = viewer.peers.find(item => item.peer === 'P1');
      return peer?.connection === 'connected' && peer.audioBytes > 0 && peer.videoFrames > 3;
    }, 20000, 'Polite transport replacement must recover real audio and watched screen');
    assert.equal(await pages[1].evaluate(() => ChatApp.callPeerMap.get('P1') !== window.__beforeRecoveryPeer), true);
    result.phases.push({ phase: 'polite transport replacement resumes audio and screen', state: await inspect(pages[1]) });
    await pages[5].evaluate(async () => {
      await ChatApp.leaveCall({ quiet: true });
      await ChatApp.joinCall('test');
      ChatApp.openShareView('P1', 'P1');
    });
    await waitUntil(async () => {
      const states = await Promise.all(pages.map(inspect));
      return states.every(state => state.peers.length === 5 && state.peers.every(peer => peer.connection === 'connected' && peer.audioBytes > 0)) && states[5].peers.find(peer => peer.peer === 'P1')?.videoFrames > 3;
    }, 25000, 'Rapid leave/rejoin must restore all peer sessions and the watched screen');
    result.phases.push({ phase: 'rapid leave/rejoin restores six-person audio and watched screen', states: await Promise.all(pages.map(inspect)) });
    await pages[1].screenshot({ path: path.join(reportDir, "six-person-screen-view.png") });
    result.phases.push({ phase: "speaking updates preserve five viewers' video elements", retained });
    // Dispatch the real pagehide lifecycle while the fixture has no automatic
    // onDisconnect implementation: only the app's explicit departure can work.
    const departureStarted = Date.now();
    await pages[5].evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await waitUntil(async () => (await Promise.all(pages.slice(0,5).map(page => page.evaluate(() => !ChatApp.callMembersCache.some(member => member.code === 'P6'))))).every(Boolean), 2000, 'Pagehide must remove the departed client without a heartbeat timeout');
    result.phases.push({ phase:'pagehide removes the remote member', elapsedMs:Date.now()-departureStarted });
    assert.deepEqual(errors, [], "No browser runtime errors");
    assert.deepEqual(backend.deliveryErrors, [], "No signaling fixture delivery errors");
    result.passed = true;
    console.log("PASS: six participants, sustained real audio RTP, five screen viewers, polite recovery and rapid leave/rejoin.");
  } catch (error) {
    result.passed = false;
    result.failure = error.stack;
    result.failureStates = await Promise.all(pages.map((page) => inspect(page).catch((error) => ({ error: error.message }))));
    throw error;
  } finally {
    result.errors = errors;
    result.signalingWrites = backend.writes.length;
    result.deliveryErrors = backend.deliveryErrors;
    fs.writeFileSync(path.join(reportDir, "six-person-call-report.json"), JSON.stringify(result, null, 2));
    await Promise.all(pages.map((page) => page.evaluate(async () => { clearInterval(window.__screenTimer); await ChatApp.leaveCall({ quiet: true }); }).catch(() => {})));
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
