/* Screen context menus and duplicate-stage regression checks in real Chrome. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { bootstrap, controls, screenGeometry } = require("./screen-focus.browser.cjs");
const reportDir = path.resolve(process.argv[2] || path.join(__dirname, "../../screen-menu-v2-checks"));

async function assertRoster(page, message) {
  const state = await page.evaluate(() => {
    const list = document.querySelector("#call-menu-list");
    return { stages: list.querySelectorAll(".call-stage").length,
      people: [...list.querySelectorAll(".call-participant")].map(tile => tile.dataset.usercode).sort(),
      screens: [...list.querySelectorAll(".call-screen-tile")].map(tile => tile.dataset.shareCode).sort() };
  });
  assert.deepEqual(state, { stages: 1, people: ["ALICE", "BOB", "TEST-USER"], screens: ["ALICE", "BOB"] }, message);
}

async function openMenu(page, code) {
  await page.locator(`.call-screen-tile[data-share-code="${code}"] video`).click({ button: "right" });
  await page.locator("#call-screen-context-menu").waitFor({ state: "visible" });
  await page.waitForTimeout(170);
}

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"] });
  const report = { passed: false, cases: [] };
  try {
    for (const mobile of [false, true]) {
      const name = mobile ? "mobile" : "desktop";
      const { context, page, errors } = await bootstrap(browser, mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, mobile);
      try {
        if (!mobile) {
          await page.evaluate(() => {
            window.__captureChoices = [];
            window.chatDesktopCapture = { version: 1, listSources: async () => [
              { id: 'screen:1:0', name: 'Screen 1', thumbnail: document.querySelector('canvas')?.toDataURL() || '' },
              { id: 'screen:2:0', name: 'Screen 2', thumbnail: '' },
              { id: 'window:3:0', name: 'Project workspace', thumbnail: '' }
            ], selectSource: async id => { window.__captureChoices.push(id); return true; } };
            window.__originalScreenToggle = ChatApp.callToggleShareScreen;
            window.__originalCameraToggle = ChatApp.callToggleCamera;
            Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable:true, value:async () => [
              { kind:'videoinput', deviceId:'integrated', label:'Integrated camera' },
              { kind:'videoinput', deviceId:'usb', label:'USB camera' }
            ] });
            ChatApp.syncSidebarCallDock();
          });
          await page.locator('#btn-sidebar-call-open').click();
          assert.equal(await page.locator('#call-menu').isVisible(), false, 'Sidebar summary closes the current call menu');
          await page.locator('#btn-sidebar-call-open').click();
          assert.equal(await page.locator('#call-menu').isVisible(), true, 'Sidebar summary opens it again');
          assert.equal(await page.locator('#btn-sidebar-call-open').getAttribute('aria-expanded'), 'true');
          await page.locator('#btn-sidebar-call-share').click();
          const sidebarMedia = page.locator('#sidebar-media-menu');
          await sidebarMedia.waitFor({ state: 'visible' });
          await page.waitForTimeout(180);
          assert.deepEqual(await sidebarMedia.locator('.media-label').allTextContents(), ['Screen Share', 'Camera']);
          const mediaBounds = await sidebarMedia.boundingBox(), triggerBounds = await page.locator('#btn-sidebar-call-share').boundingBox();
          assert.ok(mediaBounds.width <= 260 && mediaBounds.y + mediaBounds.height <= triggerBounds.y, 'Screen/camera menu stays above its dock button at the composer-menu width');
          assert.equal(await sidebarMedia.evaluate(node => getComputedStyle(node).transitionDuration), '0.14s');
          await page.screenshot({ path: path.join(reportDir, 'sidebar-screen-camera.png') });
          await page.keyboard.press('Escape');
          await page.evaluate(() => ChatApp.closeSidebarMediaMenu());
          await sidebarMedia.waitFor({ state: 'hidden' });
          await page.locator('#btn-call-share').click();
          await page.waitForFunction(() => document.querySelectorAll('#call-capture-picker .call-capture-choice').length === 3);
          const picker = page.locator('#call-capture-picker');
          assert.equal(await picker.getAttribute('aria-modal'), 'false');
          assert.equal(await picker.locator('.chat-popup-close').count(), 1);
          assert.equal(await picker.evaluate(node => getComputedStyle(node).transitionDuration), '0.14s');
          await page.waitForTimeout(200);
          await page.screenshot({ path:path.join(reportDir, 'screen-picker.png') });
          await page.evaluate(() => { ChatApp.callToggleShareScreen = options => window.__captureChoices.push(options.sourceId); });
          await picker.locator('[data-source-id="screen:2:0"]').click();
          await picker.waitFor({ state:'hidden' });
          assert.deepEqual(await page.evaluate(() => __captureChoices), ['screen:2:0']);
          await page.evaluate(() => { ChatApp.callToggleShareScreen = window.__originalScreenToggle; });
          await page.locator('#btn-call-camera').click();
          await page.waitForFunction(() => document.querySelectorAll('#call-capture-picker .call-capture-choice').length === 2);
          assert.equal(await picker.locator('.call-capture-name').last().textContent(), 'USB camera');
          await page.waitForTimeout(200);
          await page.screenshot({ path:path.join(reportDir, 'camera-picker.png') });
          await page.evaluate(() => { ChatApp.callToggleCamera = options => window.__captureChoices.push(options.deviceId); });
          await picker.locator('[data-source-id="usb"]').click();
          await picker.waitFor({ state:'hidden' });
          assert.deepEqual(await page.evaluate(() => __captureChoices), ['screen:2:0', 'usb']);
          await page.evaluate(() => {
            ChatApp.callToggleCamera = window.__originalCameraToggle;
            ChatApp.callOpenCapturePicker('camera');
          });
          await page.keyboard.press('Escape');
          await picker.waitFor({ state:'hidden' });
          assert.equal(await page.locator('#call-menu').isVisible(), true, 'Escape dismisses only the capture menu');
          await page.evaluate(() => {
            ChatApp.callCloseWatchedShare('ALICE'); ChatApp.callCloseWatchedShare('BOB');
          });
          assert.equal(await page.locator('.call-share-multi').count(), 0, 'The extra multi-view eye control is removed');
          await page.locator('.call-share-offer[data-share-code="ALICE"] .call-share-open').click();
          await page.locator('.call-share-offer[data-share-code="BOB"] .call-share-open').click();
          assert.deepEqual(await page.evaluate(() => [...ChatApp.callWatchedShareCodes].sort()), ['ALICE', 'BOB'], 'Ordinary clicks retain both streams');
          await page.screenshot({ path:path.join(reportDir, 'independent-viewers.png') });
          await page.evaluate(() => { delete window.chatDesktopCapture; });
        }
        await page.evaluate(() => {
          document.addEventListener("contextmenu", event => { window.__lastScreenContextPrevented = event.defaultPrevented; });
          // Cached database delivery can call render again before the first
          // render returns. The original append-based renderer made two stages.
          const prune = ChatApp.callPruneWatchedShares;
          let nested = false;
          ChatApp.callPruneWatchedShares = (...args) => {
            const result = prune(...args);
            if (!nested) {
              nested = true;
              ChatApp.renderCallMenu();
            }
            return result;
          };
          ChatApp.renderCallMenu();
          ChatApp.callPruneWatchedShares = prune;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await assertRoster(page, "A synchronous nested presence render cannot append a second roster");
        await page.evaluate(() => {
          ChatApp.callMembersCache.push({ ...ChatApp.callMembersCache[1] });
          ChatApp.renderCallMenu();
        });
        await assertRoster(page, "Duplicate source records cannot duplicate a user's avatar or screen");
        await page.evaluate(() => { ChatApp.callMembersCache.pop(); });
        for (let iteration = 0; iteration < 8; iteration++) {
          await page.evaluate(() => {
            ChatApp.callToggleShareFocus("ALICE");
            ChatApp.renderCallMenu();
            ChatApp.callToggleShareFocus("ALICE");
            ChatApp.callCloseWatchedShare("BOB");
            ChatApp.openShareView("BOB", "Bob", { multi: true });
          });
          await assertRoster(page, "Repeated focus, close, and multiview actions keep one instance of each tile");
        }

        // Own previews expose only manual Pause/Resume, never audio controls.
        await page.evaluate(() => {
          ChatApp.callSharing = true;
          ChatApp.callScreenStream = window.__focusTestStream;
          ChatApp.callScreenShareId = "own-screen";
          ChatApp.callWatchedShareCodes.add("TEST-USER");
          ChatApp.renderCallMenu();
          ChatApp.syncShareViewStream();
        });
        const ownScreen = page.locator('.call-screen-tile[data-share-code="TEST-USER"]');
        const screenMenu = page.locator("#call-screen-context-menu");
        await ownScreen.locator("video").click({ button: "right" });
        assert.equal(await screenMenu.isVisible(), true, "Own thumbnail opens the pause menu");
        assert.equal(await screenMenu.locator("[data-screen-pause]").isVisible(), true);
        assert.equal(await screenMenu.locator("[data-screen-mute]").isVisible(), false);
        await page.evaluate(() => ChatApp.closeCallScreenContextMenu(true));
        assert.equal(await page.evaluate(() => window.__lastScreenContextPrevented), true, "Own screen also suppresses the browser menu");
        await ownScreen.locator(".call-view-focus").click();
        await ownScreen.locator("video").click({ button: "right" });
        assert.equal(await screenMenu.isVisible(), true, "Own focused screen opens the pause menu");
        assert.equal(await screenMenu.locator("[data-screen-volume-slider]").isVisible(), false);
        await page.evaluate(async () => {
          ChatApp.openCallScreenContextMenu("ALICE", 100, 100);
          const ownBody = document.querySelector('.call-screen-tile[data-share-code="TEST-USER"] .call-view-body');
          ownBody.focus();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          if (document.activeElement !== ownBody) throw new Error("Opening a screen menu must not steal subsequent keyboard focus");
          ChatApp.closeCallScreenContextMenu(true);
        });
        for (const key of ["Shift+F10", "ContextMenu"]) {
          await page.evaluate(() => ChatApp.openCallScreenContextMenu("ALICE", 100, 100));
          await screenMenu.waitFor({ state: "visible" });
          await ownScreen.locator(".call-view-body").focus();
          await page.keyboard.press(key);
          assert.equal(await screenMenu.isVisible(), true, "Own-screen keyboard menu exposes manual Pause");
          assert.equal(await page.evaluate(() => ChatApp.callScreenContextMenuCtx.peerCode), "TEST-USER");
          assert.equal(await screenMenu.locator("[data-screen-mute]").isVisible(), false);
          await page.evaluate(() => ChatApp.closeCallScreenContextMenu(true));
        }
        if (mobile) {
          const beforeHold = await controls(page);
          const point = await screenGeometry(page);
          const session = await context.newCDPSession(page);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
          await page.waitForTimeout(600);
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await session.detach();
          assert.equal(await screenMenu.isVisible(), true, "Long pressing your own screen opens Pause/Resume");
          assert.deepEqual(await controls(page), beforeHold, "Own-screen long press leaves focus controls unchanged");
        }
        await page.evaluate(() => {
          ChatApp.callToggleShareFocus("TEST-USER");
          ChatApp.callSharing = false;
          ChatApp.callScreenStream = null;
          ChatApp.callScreenShareId = "";
          ChatApp.callWatchedShareCodes.delete("TEST-USER");
          ChatApp.renderCallMenu();
        });
        await assertRoster(page, "Removing the local preview restores the original roster");
        await openMenu(page, "ALICE");
        const menu = page.locator("#call-screen-context-menu");
        const slider = menu.locator("[data-screen-volume-slider]");
        assert.equal(await page.evaluate(() => window.__lastScreenContextPrevented), true, "Screen right-click replaces the native browser menu");
        assert.equal(await menu.locator("[data-screen-volume-username]").textContent(), "Alice", "The screen menu shows the owner's username");
        assert.equal(await slider.inputValue(), "100", "Screen volume defaults to 100 percent");
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "false", "Screens default to unmuted");
        await slider.focus();
        await page.keyboard.press("End");
        assert.equal(await menu.locator("[data-screen-volume-value]").textContent(), "400%", "The real range input reaches 400 percent");
        await menu.locator("[data-screen-mute]").click();
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "true");
        assert.equal(await slider.inputValue(), "0", "Muted screen slider displays effective silence");
        assert.equal(await menu.locator("[data-screen-volume-value]").textContent(), "0%");
        assert.equal(await page.evaluate(() => ChatApp.callGetScreenVolume("ALICE")), 400, "Unmute retains the chosen volume");
        assert.equal(await page.locator(".call-viewers-floating").isVisible(), false, "A screen context menu suppresses the thumbnail hover tooltip");
        await page.screenshot({ path: path.join(reportDir, `${name}-thumbnail-menu.png`) });
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });

        await openMenu(page, "BOB");
        assert.equal(await menu.locator("[data-screen-volume-username]").textContent(), "Bob");
        assert.equal(await slider.inputValue(), "100", "The second screen has independent volume");
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "false", "Muting one screen leaves the other unmuted");
        await slider.focus();
        await page.keyboard.press("Home");
        assert.equal(await menu.locator("[data-screen-volume-value]").textContent(), "0%", "The real range input reaches zero percent");
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "true", "Zero screen volume is marked muted");
        assert.equal(await menu.locator("[data-screen-mute] .msg-menu-label").textContent(), "Unmute");
        await menu.locator("[data-screen-mute]").click();
        assert.equal(await slider.inputValue(), "100", "Unmute restores audible screen volume");
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "false");
        await slider.focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Escape");
        await openMenu(page, "ALICE");
        assert.equal(await slider.inputValue(), "0", "Reopening a muted screen shows effective silence");
        assert.equal(await menu.locator("[data-screen-mute]").getAttribute("aria-pressed"), "true", "Reopening preserves this screen's mute state");
        await page.keyboard.press("Escape");

        // Keyboard menu openings have no outside pointerdown event to close
        // the previous menu, so the shared open methods must enforce it.
        await openMenu(page, "ALICE");
        if (!mobile) {
          await page.locator(".members-sidebar .member-row[data-usercode]").first().focus();
          await page.keyboard.press("Shift+F10");
          await page.locator("#msg-menu").waitFor({ state: "visible" });
          await menu.waitFor({ state: "hidden" });
          await page.evaluate(() => ChatApp.openCallScreenContextMenu("ALICE", 100, 100));
          await menu.waitFor({ state: "visible" });
          await page.locator("#msg-menu").waitFor({ state: "hidden" });
        }
        for (const other of [
          { kind: "text", selector: "#msg-text-menu" },
          { kind: "emoji", selector: "#emoji-ctx-menu" },
          { kind: "activity", selector: "#html-hub-menu" },
        ]) {
          await page.evaluate(kind => {
            if (kind === "text") ChatApp.openMsgTextMenu({ x: 100, y: 100, text: "Local fixture text", word: "", username: "Tester" });
            if (kind === "emoji") ChatApp.openEmojiCtxMenu({ x: 100, y: 100, emoji: "😀" });
            if (kind === "activity") {
              ChatApp.htmlHubItemsCache.push({ id: "screen-menu-fixture", title: "Fixture", ownerCode: "TEST-USER" });
              ChatApp.openHtmlHubContextMenu("screen-menu-fixture", 100, 100);
            }
          }, other.kind);
          await menu.waitFor({ state: "hidden" });
          await page.locator(other.selector).waitFor({ state: "visible" });
          await page.evaluate(() => ChatApp.openCallScreenContextMenu("ALICE", 100, 100));
          await menu.waitFor({ state: "visible" });
          await page.locator(other.selector).waitFor({ state: "hidden" });
        }
        await page.keyboard.press("Escape");

        await page.locator('.call-screen-tile[data-share-code="ALICE"] .call-view-focus').click();
        await page.click("#btn-call-menu-expand");
        let before = await controls(page);
        if (mobile) {
          const point = await screenGeometry(page);
          const session = await context.newCDPSession(page);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
          await page.waitForTimeout(600);
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await menu.waitFor({ state: "visible" });
          await session.detach();
          assert.deepEqual(await controls(page), before, "A real long press opens the menu without toggling focus controls");
        } else {
          await openMenu(page, "ALICE");
        }
        assert.deepEqual(await controls(page), before, "Right-clicking a focused screen leaves screen controls unchanged");
        await page.waitForTimeout(170);
        const bounds = await menu.boundingBox();
        const viewport = page.viewportSize();
        assert.ok(bounds.x >= 9 && bounds.y >= 9 && bounds.x + bounds.width <= viewport.width - 9 && bounds.y + bounds.height <= viewport.height - 9, "The menu keeps its margin inside the viewport after opening animation");
        await page.screenshot({ path: path.join(reportDir, `${name}-focused-menu.png`) });
        await page.keyboard.press("Escape");
        await page.locator(".call-view-tile.is-focused .call-view-body").focus();
        await page.keyboard.press("Shift+F10");
        await menu.waitFor({ state: "visible" });
        assert.equal(await slider.inputValue(), "0", "Keyboard opening shows the focused screen's muted volume");
        await page.keyboard.press("Escape");
        await page.locator(".call-view-tile.is-focused .call-view-body").focus();
        await page.keyboard.press("Enter");
        before = await controls(page);
        assert.equal(before.header, false);
        await openMenu(page, "ALICE");
        assert.deepEqual(await controls(page), before, "The screen menu also works while focused controls are hidden");
        await menu.locator("[data-screen-mute]").click();
        assert.equal(await page.evaluate(() => ChatApp.callIsScreenMuted("ALICE")), false);
        assert.equal(await page.evaluate(() => ChatApp.callGetScreenVolume("ALICE")), 400);
        assert.equal(await page.evaluate(() => ChatApp.callGetScreenVolume("BOB")), 0);
        await page.evaluate(() => ChatApp.closeCallMenu());
        await menu.waitFor({ state: "hidden" });
        assert.deepEqual(errors, [], "Screen menus and repeated call actions have no browser errors");
        report.cases.push({ name, passed: true });
        console.log(`PASS ${name}: nested render, duplicate records, repeated actions, per-screen menus, mute, 0–400 percent, focus and keyboard/touch`);
      } catch (error) {
        await page.screenshot({ path: path.join(reportDir, `${name}-failure.png`) });
        report.cases.push({ name, passed: false, failure: error.stack, errors });
        throw error;
      } finally {
        await context.close();
      }
    }
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(reportDir, "screen-menu-report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
