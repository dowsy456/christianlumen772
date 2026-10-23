/* Real Chrome click/tap regression coverage for focused screen controls.
 * Uses an in-memory Firebase fixture and live canvas media; all external HTTP is blocked.
 * Run: node tests/screen-focus.browser.cjs [report-directory]
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const mock = require("./firebase-mock.js");
const reportDir = path.resolve(process.argv[2] || path.join(__dirname, "../../screen-focus-v2-checks"));

async function controls(page) {
  return page.evaluate(() => {
    const visible = node => {
      if (!node || !node.getBoundingClientRect().width || !node.getBoundingClientRect().height) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const menu = document.querySelector("#call-menu");
    return {
      toggled: menu.classList.contains("is-focus-controls-visible"),
      header: visible(menu.querySelector(".call-menu-head")),
      footer: visible(menu.querySelector(".call-menu-foot")),
      screen: visible(menu.querySelector(".call-view-tile.is-focused .call-view-head")),
      viewers: visible(menu.querySelector(".call-view-tile.is-focused .call-viewers-eye")),
    };
  });
}

async function expectControls(page, visible, label) {
  // Permit CSS transitions but require all four surfaces to reach the same state.
  for (let attempt = 0; attempt < 20; attempt++) {
    const actual = await controls(page);
    if (Object.values(actual).every(value => value === visible)) return;
    await page.waitForTimeout(50);
  }
  assert.deepEqual(await controls(page), { toggled: visible, header: visible, footer: visible, screen: visible, viewers: visible }, label);
}

async function screenGeometry(page) {
  return page.locator(".call-view-tile.is-focused video").evaluate(video => {
    const rect = video.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const left = rect.x + (rect.width - width) / 2;
    const top = rect.y + (rect.height - height) / 2;
    const letterbox = rect.width - width > 12
      ? { x: rect.x + 4, y: rect.y + rect.height / 2 }
      : rect.height - height > 12
        ? { x: rect.x + rect.width / 2, y: rect.y + 4 }
        : null;
    return { x: left + width / 2, y: top + height / 2, width, height, letterbox };
  });
}

async function clickScreen(page, touch = false) {
  const point = await screenGeometry(page);
  assert.ok(point.width > 0 && point.height > 0, "A real video frame is displayed");
  await (touch ? page.touchscreen.tap(point.x, point.y) : page.mouse.click(point.x, point.y));
}

async function settleTransforms(page) {
  await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
}

async function wheelTile(page, selector, count, direction = -100) {
  await page.locator(selector).evaluate((tile, args) => {
    for (let i = 0; i < args.count; i++) tile.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: args.direction }));
  }, { count, direction });
  await settleTransforms(page);
}

async function dragTile(page, selector, dx, dy) {
  const rect = await page.locator(selector + " .call-view-body").boundingBox();
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await settleTransforms(page);
  return rect;
}

async function tileStyle(page) {
  // Roster fitting runs on animation frames after expand/unfocus. Sample only
  // after its geometry and border have settled, rather than a transient scale.
  await page.locator('.call-view-tile[data-share-code="ALICE"]').evaluate(async tile => {
    let previous = "", stableFrames = 0;
    for (let attempt = 0; attempt < 180; attempt++) {
      await new Promise(requestAnimationFrame);
      const bounds = tile.getBoundingClientRect();
      const style = getComputedStyle(tile);
      const current = [bounds.x, bounds.y, bounds.width, bounds.height, style.border, style.borderRadius].join("|");
      stableFrames = current === previous ? stableFrames + 1 : 0;
      if (stableFrames >= 3) return;
      previous = current;
    }
    throw new Error("Screen tile geometry did not settle before the style comparison");
  });
  return page.locator('.call-view-tile[data-share-code="ALICE"]').evaluate(tile => {
    const bounds = tile.getBoundingClientRect();
    const style = getComputedStyle(tile);
    const body = getComputedStyle(tile.querySelector(".call-view-body"));
    const video = getComputedStyle(tile.querySelector("video"));
    return { width: bounds.width, height: bounds.height, radius: style.borderRadius,
      border: style.border, background: style.backgroundColor, body: body.backgroundColor,
      video: video.backgroundColor, fit: video.objectFit,
      head: getComputedStyle(tile.querySelector(".call-view-head")).display };
  });
}

async function bootstrap(browser, viewport, mobile = false) {
  const context = await browser.newContext({ viewport, hasTouch: mobile, isMobile: mobile });
  await context.addInitScript(mock);
  await context.route(/^https?:\/\//, route => route.fulfill({ status: 200,
    contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "null" }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve(__dirname, "../index.html")).href);
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
  await page.click("#btn-go-login");
  await page.fill("#login-code", "TEST-USER");
  await page.click("#btn-login");
  await page.waitForFunction(() => ChatApp.currentUser);
  await page.evaluate(async () => {
    await ChatApp.openRoom("test", { quiet: true });
    ChatApp.closeToast();
    // Fixture ownership of member updates avoids joining a remote/media call.
    ChatApp.detachCallObserver();
    ChatApp.attachCallObserver = () => {};
    ChatApp.currentCallRoomId = "test";
    ChatApp.callSessionId = "screen-focus-fixture";
    ChatApp.callMembersCache = [
      { code: "TEST-USER", username: "Tester", displayName: "Tester", connected: true, sessionId: "self-session" },
      { code: "ALICE", username: "Alice", displayName: "Alice", connected: true, sessionId: "alice-session", sharing: true, shareId: "alice-screen" },
      { code: "BOB", username: "Bob", displayName: "Bob", connected: true, sessionId: "bob-session", sharing: true, shareId: "bob-screen" },
    ];
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const pen = canvas.getContext("2d");
    let frame = 0;
    const paint = () => {
      pen.fillStyle = "#355c78";
      pen.fillRect(0, 0, 1280, 720);
      pen.fillStyle = "#47c9a1";
      pen.fillRect(40, 40, 1200, 640);
      pen.fillStyle = "#102d42";
      pen.fillRect(70, 70, 1140, 580);
      pen.fillStyle = "white";
      pen.font = "48px sans-serif";
      pen.fillText("Shared screen - live test " + frame++, 150, 330);
    };
    paint();
    window.__focusTestTimer = setInterval(paint, 100);
    window.__focusTestCanvas = canvas;
    window.__focusTestStream = canvas.captureStream(10);
    ChatApp.callRemoteVideoStreams.set("ALICE", window.__focusTestStream);
    ChatApp.callRemoteVideoStreams.set("BOB", window.__focusTestStream);
    ChatApp.callWatchedShareCodes = new Set(["ALICE", "BOB"]);
    ChatApp.callMultiViewEnabled = true;
    ChatApp.openCallMenu();
    ChatApp.syncShareViewStream();
  });
  await page.waitForFunction(() => [...document.querySelectorAll("#call-menu video")].length === 2 &&
    [...document.querySelectorAll("#call-menu video")].every(video => video.videoWidth === 1280 && video.readyState >= 2));
  return { page, context, errors };
}

if (require.main === module) (async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"] });
  const result = { cases: [], passed: false };
  try {
    for (const testCase of [
      { name: "desktop", viewport: { width: 1440, height: 900 }, expanded: false },
      { name: "expanded", viewport: { width: 1440, height: 900 }, expanded: true },
      { name: "mobile", viewport: { width: 390, height: 844 }, expanded: true, mobile: true },
    ]) {
      const { page, context, errors } = await bootstrap(browser, testCase.viewport, testCase.mobile);
      try {
        if (testCase.expanded) await page.click("#btn-call-menu-expand");
        const original = await tileStyle(page);
        assert.equal(original.fit, "contain", "Unfocused screen keeps contained video");
        assert.notEqual(original.head, "none", "Unfocused screen controls remain displayed");
        assert.equal(await page.locator(".call-view-live-dot").count(), 0, "The screen-label green dot is removed");
        assert.equal(await page.locator(".call-screen-zoom").count(), 0, "Unfocused tiles have no zoom display");
        await wheelTile(page, '.call-view-tile[data-share-code="ALICE"]', 4);
        assert.equal(await page.locator('.call-view-tile[data-share-code="ALICE"] video').evaluate(video => video.style.transform), "", "Unfocused tiles ignore zoom input");
        await page.screenshot({ path: path.join(reportDir, `${testCase.name}-unfocused.png`) });
        await page.locator('.call-view-tile[data-share-code="ALICE"] .call-view-focus').click();
        assert.equal(await page.locator(".call-viewers-floating").isVisible(), false, "Focusing immediately removes the thumbnail viewers tooltip");
        await expectControls(page, true, "Focusing shows every control surface by default");
        const focused = await tileStyle(page);
        for (const field of ["background", "body", "video"]) assert.equal(focused[field], "rgba(0, 0, 0, 0)", `Focused ${field} has no black fill`);
        if (testCase.name === "expanded") {
          const upper = await page.locator(".call-view-tile.is-focused video").evaluate(video => {
            const rect = video.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + 12 };
          });
          assert.equal(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.tagName, upper), "VIDEO", "Empty screen-header space does not intercept the upper frame");
          await page.mouse.click(upper.x, upper.y);
          await expectControls(page, false, "Clicking the upper frame under the header hides controls");
        } else {
          await clickScreen(page, testCase.mobile);
        }
        await expectControls(page, false, "A screen click hides the initially visible controls");
        await page.screenshot({ path: path.join(reportDir, `${testCase.name}-focused-hidden.png`) });

        const point = await screenGeometry(page);
        await page.mouse.move(point.x, point.y);
        await expectControls(page, false, "Hovering over the screen never reveals controls");
        assert.ok(point.letterbox, "Fixture exposes letterbox space for hit testing");
        await page.mouse.click(point.letterbox.x, point.letterbox.y);
        await expectControls(page, false, "Clicking outside the actual frame does not reveal controls");

        if (!testCase.mobile) {
          await page.locator(".call-view-tile.is-focused .call-view-body").focus();
          await page.keyboard.press("Enter");
          await expectControls(page, true, "Keyboard users can reveal the controls from the focused screen");
          await page.keyboard.press("Space");
          await expectControls(page, false, "Keyboard users can hide the controls from the focused screen");
        }

        await clickScreen(page, testCase.mobile);
        await expectControls(page, true, "Clicking/tapping the actual frame reveals all controls");
        await page.screenshot({ path: path.join(reportDir, `${testCase.name}-focused-visible.png`) });
        await page.locator(".call-view-tile.is-focused .call-viewers-eye").click();
        await expectControls(page, true, "The viewers control cannot toggle the screen");
        await page.locator(".call-view-tile.is-focused .call-viewers-eye").hover();
        await page.waitForFunction(() => document.querySelector(".call-viewers-floating.is-visible .call-viewers-label")?.textContent === "Viewers");
        assert.equal(await page.locator(".is-focused .call-view-readouts").evaluate(row => row.children[0].classList.contains("call-screen-zoom") && row.children[1].classList.contains("call-viewers-eye")), true, "Viewer eye follows zoom in the same readout row");
        await page.click("#btn-call-mute");
        await expectControls(page, true, "Call controls cannot toggle the screen");
        await page.evaluate(() => {
          window.__retainedFocusVideo = document.querySelector(".call-view-tile.is-focused video");
          ChatApp.callMembersCache[1].speaking = true;
          ChatApp.renderCallMenu();
        });
        await expectControls(page, true, "A live roster rerender retains the selected visibility");
        assert.equal(await page.evaluate(() => window.__retainedFocusVideo === document.querySelector(".call-view-tile.is-focused video")), true, "Roster rerenders preserve the playing video node");
        await clickScreen(page, testCase.mobile);
        await expectControls(page, false, "A second screen click/tap hides every control surface");
        await page.evaluate(() => ChatApp.renderCallMenu());
        await expectControls(page, false, "Hidden controls remain hidden after rerender");
        await clickScreen(page, testCase.mobile);
        await page.locator(".call-view-tile.is-focused .call-view-focus").click();
        assert.deepEqual(await tileStyle(page), original, "Unfocusing restores the original thumbnail appearance and geometry");
        assert.equal(await page.locator("#call-menu").evaluate(menu => menu.classList.contains("is-focus-controls-visible")), false, "The focused visibility class clears on exit");
        await page.locator('.call-view-tile[data-share-code="BOB"] .call-view-focus').click();
        await expectControls(page, true, "Focusing a different share resets to visible controls");
        await page.locator(".call-view-tile.is-focused .call-view-close").click();
        assert.equal(await page.locator(".call-view-tile.is-focused").count(), 0, "Closing a focused screen exits focus");
        assert.ok(await page.locator(".call-menu-head").isVisible(), "Closing a focused screen restores the top bar");
        assert.ok(await page.locator(".call-menu-foot").isVisible(), "Closing a focused screen restores call controls");
        assert.deepEqual(errors, [], "No browser runtime errors");
        result.cases.push({ name: testCase.name, passed: true, original, focused });
        console.log(`PASS ${testCase.name}: focus defaults, frame-only click/tap, controls, rerender, transparency, restoration`);
      } catch (error) {
        await page.screenshot({ path: path.join(reportDir, `${testCase.name}-failure.png`) });
        result.cases.push({ name: testCase.name, passed: false, failure: error.stack, controls: await controls(page), errors });
        throw error;
      } finally {
        await context.close();
      }
    }
    // New presentation features exercise real browser fullscreen and live media.
    {
      const { page, context, errors } = await bootstrap(browser, { width: 1440, height: 900 });
      try {
        assert.equal(await page.locator("#btn-call-multi-view").isVisible(), false, "Multi view is unavailable in the small call menu");
        await page.click("#btn-call-menu-expand");
        assert.equal(await page.locator("#btn-call-multi-view").isVisible(), true);
        await page.evaluate(() => {
          const app = ChatApp;
          app.callMembersCache[1].cameraSharing = true;
          app.callMembersCache[1].cameraShareId = "alice-camera";
          app.callRemoteVideoStreams.set("camera:ALICE", window.__focusTestStream);
          app.callWatchedShareCodes.add("camera:ALICE");
          app.callSharing = true;
          app.callScreenStream = window.__focusTestStream;
          app.callScreenTrack = window.__focusTestStream.getVideoTracks()[0];
          app.callScreenShareId = "self-screen";
          app.callWatchedShareCodes.add("TEST-USER");
          app.callPreparePauseCapture(window.__focusTestStream);
          app.renderCallMenu();
        });
        await page.click("#btn-call-multi-view");
        assert.deepEqual(await page.locator(".call-stage-multi .call-screen-tile").evaluateAll(tiles => tiles.map(tile => tile.dataset.shareCode)),
          ["ALICE", "camera:ALICE", "BOB"], "Multi view groups alphabetically, keeps an owner's sources adjacent and excludes local capture");
        assert.equal(await page.locator(".call-stage-multi :is(.call-view-focus,.call-view-fullscreen,.call-view-close)").count(), 0, "Multi tiles expose no independent view controls");
        assert.equal(await page.locator(".call-stage-multi .call-view-readouts .call-viewers-eye").count(), 3, "Every multi label has viewers beside zoom");
        assert.equal(await page.locator(".call-camera-icon").count(), 0, "Watched cameras have no extra camera icon before their label");
        assert.equal(await page.locator(".call-stage-multi .call-screen-zoom").count(), 3, "Each source has independent zoom status");
        assert.equal(await page.locator("#btn-call-multi-view").evaluate(button => button.nextElementSibling.id), "btn-call-menu-chat", "Multi button is immediately left of Show Chat");
        const multiStyle = await page.locator(".call-stage-multi .call-view-tile").first().evaluate(tile => [tile, tile.querySelector(".call-view-body"), tile.querySelector("video")].map(node => getComputedStyle(node).backgroundColor));
        assert.deepEqual(multiStyle, ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
        await wheelTile(page, '.call-stage-multi [data-share-code="ALICE"]', 4);
        await wheelTile(page, '.call-stage-multi [data-share-code="camera:ALICE"]', 1);
        assert.deepEqual(await page.locator(".call-stage-multi .call-screen-zoom").allTextContents(), ["300%", "150%", "100%"]);
        await wheelTile(page, '.call-stage-multi [data-share-code="camera:ALICE"]', 22);
        assert.equal(await page.locator('[data-share-code="camera:ALICE"] .call-screen-zoom-canvas').isVisible(), true, "Multi-view cameras use the bounded renderer at maximum zoom");
        assert.equal(await page.locator('[data-share-code="camera:ALICE"] video').evaluate(video => video.style.transform), "");
        const multiRect = await dragTile(page, '.call-stage-multi [data-share-code="ALICE"]', 80, 45);
        const multiPan = await page.evaluate(() => ({ ...ChatApp.callScreenTransformState("ALICE") }));
        assert.ok(Math.abs(multiPan.x - 80) < 2 && Math.abs(multiPan.y - 45) < 2, "Drag follows the pointer precisely in multi view");
        assert.deepEqual(await page.locator('.call-stage-multi [data-share-code="ALICE"] .call-view-body').boundingBox(), multiRect, "Pan never changes the viewport");
        assert.equal(await page.locator(".call-menu-foot").isVisible(), true, "Drag release does not toggle multi controls");
        await page.evaluate(() => {
          window.__multiBody = document.querySelector('.call-stage-multi [data-share-code="ALICE"] .call-view-body');
          for (let i = 0; i < 8; i++) { ChatApp.callMembersCache[1].speaking = !!(i % 2); ChatApp.renderCallMenu(); }
        });
        assert.equal(await page.evaluate(() => window.__multiBody === document.querySelector('.call-stage-multi [data-share-code="ALICE"] .call-view-body')), true, "Presence preserves multi video, viewport and gesture nodes");
        await page.screenshot({ path: path.join(reportDir, "multi-screen-view.png") });
        await page.locator(".call-stage-multi .call-view-body").first().click();
        assert.equal(await page.locator(".call-menu-foot").isVisible(), false, "Multi screen click hides call controls");
        await page.locator(".call-stage-multi .call-view-body").first().click();
        assert.equal(await page.locator(".call-menu-foot").isVisible(), true);
        await page.click("#btn-call-multi-view");
        await page.click("#btn-call-multi-view");
        await settleTransforms(page);
        assert.deepEqual(await page.locator(".call-stage-multi .call-screen-zoom").allTextContents(), ["100%", "100%", "100%"], "Reopening multi resets every source");
        await wheelTile(page, '.call-stage-multi [data-share-code="camera:ALICE"]', 2);
        await page.evaluate(() => {
          ChatApp.callMembersCache[1].cameraSharing = false;
          ChatApp.renderCallMenu();
        });
        assert.equal(await page.locator(".call-stage-multi .call-screen-tile").count(), 2, "Ending a source updates multi layout immediately");
        assert.equal(await page.evaluate(() => ChatApp.callScreenTransforms.has("camera:ALICE")), false, "Ended sources discard saved transforms");
        await page.setViewportSize({ width: 1600, height: 900 });
        await settleTransforms(page);
        const visibleMulti = await page.locator(".call-stage-multi .call-view-body").first().boundingBox();
        await page.locator(".call-stage-multi .call-view-body").first().click();
        await settleTransforms(page);
        const hiddenMulti = await page.locator(".call-stage-multi .call-view-body").first().boundingBox();
        await page.screenshot({ path: path.join(reportDir, "multi-screen-hidden.png") });
        const fittedArea = rect => Math.min(rect.width, rect.height * 16 / 9) ** 2 * 9 / 16;
        assert.ok(fittedArea(hiddenMulti) >= fittedArea(visibleMulti), "Hiding two-source multi controls cannot shrink visible media");
        await page.locator(".call-stage-multi .call-view-body").first().click();
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => { ChatApp.callMembersCache[2].sharing = false; ChatApp.renderCallMenu(); });
        assert.equal(await page.locator(".call-stage-multi").count(), 0, "Multi view closes below two remote watched sources");
        assert.equal(await page.locator("#btn-call-multi-view").isVisible(), false);
        await page.locator('[data-share-code="ALICE"] .call-view-focus').click();
        await page.evaluate(() => {
          const tile = document.querySelector('.call-view-tile.is-focused');
          for (let i = 0; i < 8; i++) tile.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
        });
        await settleTransforms(page);
        assert.equal(await page.locator(".is-focused .call-screen-zoom").textContent(), "500%");
        await wheelTile(page, ".call-view-tile.is-focused", 1);
        assert.equal(await page.locator(".is-focused .call-screen-zoom").textContent(), "600%");
        assert.equal(await page.locator(".is-focused video").evaluate(video => video.style.transform), "", "High zoom never enlarges the decoded video layer");
        assert.equal(await page.locator(".is-focused .call-screen-zoom-canvas").isVisible(), true, "High zoom displays only a bounded source crop");
        await wheelTile(page, ".call-view-tile.is-focused", 2, 100);
        assert.equal(await page.locator(".is-focused .call-screen-zoom").textContent(), "450%");
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".is-focused .call-screen-zoom")).opacity === "0.7");
        await page.screenshot({ path: path.join(reportDir, "focused-screen-zoom.png") });
        const beforeDragReads = await page.evaluate(() => ChatApp.callScreenTransformMetrics.measurements);
        const focusedRect = await dragTile(page, ".call-view-tile.is-focused", 125, 75);
        assert.equal(await page.evaluate(() => ChatApp.callScreenTransformMetrics.measurements), beforeDragReads, "Pointer moves reuse cached geometry without layout reads");
        const focusedPan = await page.evaluate(() => ({ ...ChatApp.callScreenTransformState("ALICE") }));
        assert.ok(Math.abs(focusedPan.x - 125) < 2 && Math.abs(focusedPan.y - 75) < 2, "Focused drag follows the pointer precisely");
        assert.deepEqual(await page.locator(".call-view-tile.is-focused .call-view-body").boundingBox(), focusedRect, "Focused viewport stays fixed");
        await expectControls(page, true, "Focused drag release leaves controls alone");
        await clickScreen(page);
        await expectControls(page, false, "A fresh click immediately after dragging still toggles controls");
        await clickScreen(page);
        await expectControls(page, true, "Another click restores controls");
        await page.locator(".is-focused .call-screen-zoom").click();
        await settleTransforms(page);
        const wheelRect = await page.locator(".is-focused .call-view-body").boundingBox();
        await page.mouse.move(wheelRect.x + wheelRect.width / 2 + 80, wheelRect.y + wheelRect.height / 2 + 40);
        await page.mouse.wheel(0, -100);
        await page.waitForFunction(() => ChatApp.callScreenTransformState("ALICE").percent === 150);
        await settleTransforms(page);
        assert.ok(await page.evaluate(() => Math.abs(ChatApp.callScreenTransformState("ALICE").x + 40) < 2), "Physical wheel input anchors zoom at the pointer");
        await wheelTile(page, ".call-view-tile.is-focused", 10, 100);
        assert.equal(await page.locator(".is-focused .call-screen-zoom").textContent(), "100%", "Zoom cannot shrink below the original frame");
        await wheelTile(page, ".call-view-tile.is-focused", 19);
        await settleTransforms(page);
        const performanceCheck = await page.evaluate(async () => {
          const app = ChatApp, tile = document.querySelector(".call-view-tile.is-focused"), video = tile.querySelector("video");
          const before = { ...app.callScreenTransformMetrics }, body = tile.querySelector(".call-view-body");
          let mediaFrames = 0, trackFrames = true, renders = 0, presenceWrites = 0, globalZoomPasses = 0;
          const originalRender = app.renderCallMenu, originalPresence = app.callSyncViewerPresence, originalZoom = app.callApplyScreenZoom;
          app.renderCallMenu = function (...args) { renders++; return originalRender.apply(this, args); };
          app.callSyncViewerPresence = function (...args) { presenceWrites++; return originalPresence.apply(this, args); };
          app.callApplyScreenZoom = function (...args) { globalZoomPasses++; return originalZoom.apply(this, args); };
          const decoded = () => { mediaFrames++; if (trackFrames) video.requestVideoFrameCallback(decoded); };
          video.requestVideoFrameCallback(decoded);
          const started = performance.now();
          for (let i = 0; i < 100; i++) tile.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: i % 2 ? 100 : -100 }));
          const handlerMs = performance.now() - started;
          await new Promise(requestAnimationFrame);
          const burstFrames = app.callScreenTransformMetrics.frames - before.frames;
          for (let i = 0; i < 30; i++) {
            tile.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: i % 2 ? 100 : -100 }));
            await new Promise(requestAnimationFrame);
          }
          trackFrames = false;
          app.renderCallMenu = originalRender; app.callSyncViewerPresence = originalPresence; app.callApplyScreenZoom = originalZoom;
          const canvas = tile.querySelector("canvas");
          return { handlerMs, elapsedMs: performance.now() - started, burstFrames, mediaFrames,
            cropFrames: app.callScreenTransformMetrics.cropFrames - before.cropFrames,
            backingPixels: canvas.width * canvas.height, percent: app.callScreenTransformState("ALICE").percent,
            geometryReads: app.callScreenTransformMetrics.measurements - before.measurements,
            wheelEvents: app.callScreenTransformMetrics.wheels - before.wheels, renders, presenceWrites, globalZoomPasses,
            sameVideo: video === tile.querySelector("video"), sameBody: body === tile.querySelector(".call-view-body") };
        });
        assert.equal(performanceCheck.geometryReads, 0, "Wheel bursts never measure layout");
        assert.ok(performanceCheck.burstFrames <= 1, "One hundred wheel events coalesce to one compositor frame");
        assert.equal(performanceCheck.wheelEvents, 130);
        assert.deepEqual([performanceCheck.renders, performanceCheck.presenceWrites, performanceCheck.globalZoomPasses], [0, 0, 0], "Zoom does not rebuild media, publish presence or run global layout passes");
        assert.ok(performanceCheck.mediaFrames >= 2, "Live decoded frames continue during sustained zoom");
        assert.ok(performanceCheck.percent > 500 && performanceCheck.cropFrames >= 2, "Zoom above 500% keeps rendering live cropped frames");
        assert.ok(performanceCheck.backingPixels <= 3690000, "The high-zoom surface is bounded independently of magnification");
        assert.ok(performanceCheck.sameVideo && performanceCheck.sameBody);
        result.cases.push({ name: "compositor-performance", passed: true, ...performanceCheck });
        console.log("Call zoom performance:", JSON.stringify(performanceCheck));
        await page.evaluate(() => {
          ChatApp.callResetScreenZoom();
          const portrait = document.createElement("canvas");
          portrait.width = 720; portrait.height = 1280;
          portrait.getContext("2d").fillRect(0, 0, 720, 1280);
          window.__portraitZoomStream = portrait.captureStream(1);
          ChatApp.callRemoteVideoStreams.set("ALICE", window.__portraitZoomStream);
          ChatApp.syncShareViewStream();
        });
        await page.waitForFunction(() => document.querySelector(".call-view-tile.is-focused video").videoWidth === 720);
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".is-focused .call-screen-zoom")).opacity === "1");
        assert.equal(await page.locator(".is-focused .call-screen-zoom").evaluate(el => el.classList.contains("over-content")), false, "Portrait letterbox keeps the badge fully visible outside the actual frame");
        await page.evaluate(() => { ChatApp.callRemoteVideoStreams.set("ALICE", window.__focusTestStream); ChatApp.syncShareViewStream(); });
        await page.locator(".is-focused .call-view-fullscreen").click();
        await page.waitForFunction(() => document.fullscreenElement?.id === "call-menu");
        await page.evaluate(async () => {
          window.__fullscreenHost = document.fullscreenElement;
          for (let i = 0; i < 12; i++) {
            ChatApp.callMembersCache[1].displayName = "Alice " + i;
            ChatApp.renderCallMenu();
            await new Promise(requestAnimationFrame);
            if (document.fullscreenElement !== window.__fullscreenHost) throw new Error("Presence detached fullscreen host");
          }
        });
        assert.equal(await page.locator(".is-focused video").evaluate(video => video.controls), false, "Screen fullscreen never enables Chrome video controls");
        assert.equal(await page.locator(".is-focused .call-screen-zoom").isVisible(), false, "Fullscreen keeps zoom UI hidden");
        const fullscreenControls = await page.evaluate(() => ChatApp.callFocusedControlsVisible);
        await clickScreen(page);
        assert.equal(await page.evaluate(() => ChatApp.callFocusedControlsVisible), fullscreenControls, "Fullscreen clicks never toggle UI state");
        await wheelTile(page, ".call-view-tile.is-focused", 1);
        assert.equal(await page.evaluate(() => ChatApp.callScreenZoom), 150, "Wheel zoom still works fullscreen");
        await dragTile(page, ".call-view-tile.is-focused", 70, 35);
        assert.ok(await page.evaluate(() => ChatApp.callScreenTransformState("ALICE").x > 60), "Fullscreen supports precise drag panning");
        assert.equal(await page.evaluate(() => ChatApp.callFocusedControlsVisible), fullscreenControls, "Fullscreen drag never toggles UI state");
        await wheelTile(page, ".call-view-tile.is-focused", 22);
        assert.equal(await page.evaluate(() => ChatApp.callScreenZoom), 2000);
        const fullscreenCrop = await page.locator(".is-focused .call-screen-zoom-canvas").evaluate(canvas => ({ pixels: canvas.width * canvas.height, transform: canvas.parentElement.querySelector("video").style.transform }));
        assert.ok(fullscreenCrop.pixels <= 3690000);
        assert.equal(fullscreenCrop.transform, "", "Fullscreen at maximum zoom retains a viewport-sized video layer");
        await page.evaluate(() => document.exitFullscreen());
        await page.waitForFunction(() => !ChatApp.callFullscreenCode);
        assert.equal(await page.evaluate(() => ChatApp.callScreenZoom), 100, "Fullscreen exit resets zoom");
        await page.locator(".is-focused .call-view-focus").click();
        await page.evaluate(() => ChatApp.openCallScreenContextMenu("TEST-USER", 500, 300));
        await page.locator("[data-screen-pause]").click();
        await page.waitForFunction(() => ChatApp.callScreenPaused);
        assert.equal(await page.locator('[data-share-code="TEST-USER"] .call-screen-paused').isVisible(), true, "Owner sees pause immediately");
        assert.equal(await page.evaluate(() => ChatApp.callGetSendingScreenTrack() === ChatApp.callScreenTrack), false, "Paused sender no longer publishes live capture");
        await page.evaluate(() => {
          const state = ChatApp.callScreenPausePayload();
          state.shareId = "alice-screen";
          ChatApp.callReceiveScreenPause("ALICE", state);
        });
        assert.equal(await page.locator('[data-share-code="ALICE"] .call-screen-paused').isVisible(), true, "Direct peer pause updates without a presence render");
        await page.evaluate(() => {
          const state = ChatApp.callGetScreenPauseState("ALICE");
          ChatApp.callMembersCache[1].sharePaused = true;
          ChatApp.callMembersCache[1].sharePauseVersion = state.version;
          ChatApp.callMembersCache[1].sharePauseFrame = state.frame;
          ChatApp.callRemotePauseStates.clear();
          ChatApp.callCloseWatchedShare("ALICE");
          ChatApp.openShareView("ALICE", "Alice");
        });
        assert.equal(await page.locator('[data-share-code="ALICE"] .call-screen-paused').isVisible(), true, "Opening an already-paused share reconstructs its overlay from durable presence");
        await page.locator('[data-share-code="ALICE"] .call-view-focus').click();
        await wheelTile(page, ".call-view-tile.is-focused", 4);
        await dragTile(page, ".call-view-tile.is-focused", 80, 40);
        assert.equal(await page.locator(".is-focused .call-screen-paused-frame").evaluate(frame => frame.style.transform), await page.locator(".is-focused video").evaluate(video => video.style.transform), "Paused imagery follows the same pan/zoom as the live frame");
        await page.screenshot({ path: path.join(reportDir, "paused-screen-view.png") });
        await page.locator(".is-focused .call-view-focus").click();
        await page.evaluate(() => ChatApp.callSetScreenPaused(false));
        assert.equal(await page.locator('[data-share-code="TEST-USER"] .call-screen-paused').count(), 0);
        assert.equal(await page.evaluate(() => ChatApp.callGetSendingScreenTrack() === ChatApp.callScreenTrack), true, "Resume returns to the original live capture");
        await page.evaluate(() => ChatApp.openCallUserContextMenu("ALICE", 300, 200));
        await page.locator("[data-call-user-mute]").click();
        assert.equal(await page.locator("[data-call-volume-slider]").inputValue(), "0");
        await page.locator("[data-call-user-mute]").click();
        await page.locator("[data-call-volume-slider]").focus();
        await page.keyboard.press("Home");
        assert.equal(await page.locator("[data-call-user-mute] .msg-menu-label").textContent(), "Unmute");
        await page.locator("[data-call-user-mute]").click();
        assert.equal(await page.locator("[data-call-volume-slider]").inputValue(), "100");
        assert.deepEqual(errors, []);
        result.cases.push({ name: "multi-fullscreen-zoom-pause-mute", passed: true });
      } finally { await context.close(); }
    }
    {
      const { page, context, errors } = await bootstrap(browser, { width: 390, height: 844 }, true);
      try {
        await page.click("#btn-call-menu-expand");
        await page.evaluate(() => ChatApp.toggleExpandedCallChat());
        assert.equal(await page.locator("#btn-call-menu-chat").getAttribute("data-tooltip"), "Hide Chat");
        const layout = await page.evaluate(() => {
          const call = document.querySelector("#call-menu").getBoundingClientRect();
          const chat = document.querySelector(".chat-main").getBoundingClientRect();
          return { call: { bottom: call.bottom, width: call.width }, chat: { top: chat.top, width: chat.width, height: chat.height }, viewport: innerWidth };
        });
        assert.ok(layout.chat.width >= layout.viewport - 2, "Mobile chat occupies full width");
        assert.ok(layout.chat.top >= layout.call.bottom - 2, "Mobile call and chat are vertically separated");
        assert.ok(layout.chat.height >= 400, "Mobile chat has room for messages and a composer");
        await page.screenshot({ path: path.join(reportDir, "mobile-companion-chat.png") });
        assert.deepEqual(errors, []);
        result.cases.push({ name: "mobile-companion", passed: true, layout });
      } finally { await context.close(); }
    }
    result.passed = true;
    console.log("Screen-focus browser checks passed; screenshots:", reportDir);
  } finally {
    fs.writeFileSync(path.join(reportDir, "screen-focus-report.json"), JSON.stringify(result, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { bootstrap, controls, expectControls, screenGeometry };
