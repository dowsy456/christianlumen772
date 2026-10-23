/* Room preview, expanded viewer layers, and live focused-call roster regressions. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const mock = require("./firebase-mock.js");
const { bootstrap, screenGeometry } = require("./screen-focus.browser.cjs");
const reportDir = path.resolve(process.argv[2] || path.join(__dirname, "../../call-ui-update-checks"));

async function visibleControls(page) {
  return page.locator(".call-menu-controls button").evaluateAll(buttons => buttons.filter(button => button.getBoundingClientRect().width > 0 && button.getBoundingClientRect().height > 0).map(button => button.id));
}
async function tooltipAbovePanel(page) {
  return page.evaluate(() => {
    const floating = document.querySelector(".call-viewers-floating");
    const rect = floating.getBoundingClientRect();
    // The production tooltip ignores pointer hits, so enable hit-testing only
    // for this inspection to detect a popup painted behind the enlarged menu.
    const old = floating.style.pointerEvents;
    floating.style.pointerEvents = "auto";
    const node = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    floating.style.pointerEvents = old;
    return !!node && (node === floating || floating.contains(node));
  });
}
async function assertSplitControls(page, label) {
  for (const ids of [["btn-call-mute", "btn-call-input-settings"], ["btn-call-deafen", "btn-call-output-settings"]]) {
    const layout = await page.evaluate(ids => {
      const [primary, arrow] = ids.map(id => document.getElementById(id));
      const p = primary.getBoundingClientRect(), a = arrow.getBoundingClientRect();
      const ps = getComputedStyle(primary), as = getComputedStyle(arrow);
      return { gap: a.left - p.right, heightDifference: p.height - a.height,
        innerRadii: [ps.borderTopRightRadius, ps.borderBottomRightRadius, as.borderTopLeftRadius, as.borderBottomLeftRadius] };
    }, ids);
    assert.equal(layout.gap, 0, `${label}: split controls connect without a gap`);
    assert.equal(layout.heightDifference, 0, `${label}: split controls have equal height`);
    assert.deepEqual(layout.innerRadii, ["0px", "0px", "0px", "0px"], `${label}: inner edges remain square`);
    await page.locator(`#${ids[1]}`).hover();
    assert.equal(await page.locator(`#${ids[1]}`).evaluate(node => getComputedStyle(node).transform), "none", "Hover cannot separate the arrow from its primary control");
  }
}
async function rosterAppearance(page) {
  return page.locator("#call-in-call").evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, border: style.borderColor,
      transform: style.transform, shadow: style.boxShadow, transition: style.transitionDuration, animation: style.animationName };
  });
}

(async () => {
  fs.mkdirSync(reportDir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const { context, page, errors } = await bootstrap(browser, { width: 1440, height: 900 });
    try {
      assert.equal(await page.locator("#btn-call-join").isVisible(), false, "Joined call does not expose Join under the full production CSS cascade");
      assert.equal(await page.locator("#btn-call-join").evaluate(node => getComputedStyle(node).display), "none");
      await assertSplitControls(page, "Normal call");
      assert.equal(await page.locator('#btn-call-menu-close').count(), 0, 'Call menu has no header close button');
      await page.evaluate(() => { ChatApp.callMuted = ChatApp.callDeafened = ChatApp.callCameraSharing = ChatApp.callSharing = true; ChatApp.syncCallControlsUI(); });
      await page.waitForTimeout(250);
      const activeStyles = await page.evaluate(() => {
        const style = id => { const s = getComputedStyle(document.getElementById(id)); return [s.backgroundColor, s.color, s.borderColor]; };
        return { camera: style('btn-call-camera'), screen: style('btn-call-share') };
      });
      assert.deepEqual(activeStyles.camera, activeStyles.screen, 'Active camera matches the green screen share control');
      assert.equal(await page.locator('#btn-call-mute .call-control-slash, #btn-call-deafen .call-control-slash').count(), 2);
      assert.equal(await page.locator('#btn-sidebar-call-mute .call-control-slash, #btn-sidebar-call-deafen .call-control-slash').count(), 2, 'Sidebar quick call controls use the same crossed-out states');
      await page.screenshot({ path: path.join(reportDir, 'camera-muted-controls.png') });
      await page.evaluate(() => { ChatApp.callMuted = ChatApp.callDeafened = ChatApp.callCameraSharing = ChatApp.callSharing = false; ChatApp.syncCallControlsUI(); });
      assert.equal(await page.locator('.call-control-slash').count(), 0);

      await page.evaluate(() => {
        const menu = document.querySelector("#call-menu");
        menu.dataset.callResized = "true";
        menu.style.setProperty("--call-panel-height", "190px");
      });
      await page.waitForFunction(() => document.querySelector("#call-menu").dataset.callCompact === "true");
      await assertSplitControls(page, "Compact call");
      await page.screenshot({ path: path.join(reportDir, "compact-split-controls.png") });
      await page.evaluate(() => {
        const menu = document.querySelector("#call-menu");
        delete menu.dataset.callResized;
        menu.style.removeProperty("--call-panel-height");
      });
      // Enlarged mode uses a separate high stacking context, including when
      // companion chat is visible. A body portal must remain above it.
      await page.click("#btn-call-menu-expand");
      await assertSplitControls(page, "Expanded call");
      await page.locator('.call-screen-tile[data-share-code="ALICE"]').hover();
      await page.waitForFunction(() => document.querySelector(".call-viewers-floating.is-visible .call-viewers-label")?.textContent === "Viewers");
      await page.waitForTimeout(150);
      assert.equal(await tooltipAbovePanel(page), true, "Expanded screen viewers are painted above the call menu");
      await page.screenshot({ path: path.join(reportDir, "expanded-viewers.png") });

      for (const expanded of [true, false]) {
        await page.evaluate(expanded => {
          ChatApp.setCallMenuExpanded(expanded);
          if (!ChatApp.callFocusedShareCode) ChatApp.callToggleShareFocus("ALICE");
          ChatApp.callFocusedControlsVisible = true;
          ChatApp.callSyncFocusedControls("ALICE");
        }, expanded);
        const roster = page.locator("#call-in-call");
        assert.equal(await roster.isVisible(), true, "Roster is visible alongside the focused controls");
        assert.equal(await page.locator("#btn-call-mute").isVisible(), true);
        assert.equal(await roster.evaluate(node => node.tagName), "SPAN", "Roster is a non-clickable hover target");
        assert.equal(await roster.getAttribute("tabindex"), null, "Roster cannot acquire persistent keyboard focus");
        const iconMatches = await roster.evaluate(node => node.querySelector("svg").innerHTML === document.querySelector("#btn-members svg").innerHTML);
        assert.equal(iconMatches, true, "Roster uses the members-list icon");
        await page.mouse.move(1, 1);
        const neutralAppearance = await rosterAppearance(page);
        assert.equal(neutralAppearance.background, "rgba(0, 0, 0, 0)", "In Call has no resting button background");
        assert.equal(neutralAppearance.shadow, "none", "In Call has no button inset shadow");
        await roster.hover();
        await page.waitForFunction(() => document.querySelector(".call-viewers-floating.is-visible .call-viewers-label")?.textContent === "In Call");
        assert.equal(await page.locator(".call-viewers-floating .call-viewer-avatar").count(), 3);
        assert.equal(await tooltipAbovePanel(page), true);
        const hoverAppearance = await rosterAppearance(page);
        assert.equal(hoverAppearance.background, "rgb(38, 50, 64)", "In Call uses the focused Viewers hover style");
        const motion = await page.evaluate(() => {
          const rosterTip = getComputedStyle(document.querySelector(".call-viewers-floating .call-viewers-tooltip"));
          const viewersTip = getComputedStyle(document.querySelector(".call-viewers-eye .call-viewers-tooltip"));
          return { roster: rosterTip.transition, viewers: viewersTip.transition, duration: rosterTip.transitionDuration };
        });
        assert.equal(motion.roster, motion.viewers, "In Call and focused Viewers use identical hover/unhover transitions");
        assert.ok(motion.duration.includes("0.12s"), "In Call tooltip animation is enabled");
        await page.mouse.down();
        assert.deepEqual(await rosterAppearance(page), hoverAppearance, "Pressing the informational target has no additional visual effect");
        await page.mouse.up();
        assert.equal(await roster.evaluate(node => document.activeElement === node), false, "Click does not focus the hover target");
        const exitState = await roster.evaluate(node => {
          node.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
          const floating = document.querySelector(".call-viewers-floating");
          return { hidden: floating.hidden, visible: floating.classList.contains("is-visible") };
        });
        assert.deepEqual(exitState, { hidden: false, visible: false }, "Unhover keeps the tooltip mounted for its exit animation");
        await page.mouse.move(1, 1);
        await page.waitForFunction(() => document.querySelector(".call-viewers-floating").hidden);
        assert.equal(await page.locator(".call-viewers-floating").isVisible(), false, "Click then pointer leave cannot leave a stuck roster tooltip");
        await roster.evaluate(node => node.focus());
        assert.equal(await page.locator(".call-viewers-floating").isVisible(), false, "Programmatic focus does not show the hover-only tooltip");
        await roster.hover();
        await page.evaluate(() => {
          ChatApp.callMembersCache.push({ code: "CAROL", displayName: "Carol", sessionId: "carol-session", connected: true });
          ChatApp.renderCallMenu();
        });
        await page.waitForFunction(() => document.querySelectorAll(".call-viewers-floating.is-visible .call-viewer-avatar").length === 4);
        await page.evaluate(() => {
          ChatApp.callMembersCache = ChatApp.callMembersCache.filter(member => member.code !== "CAROL");
          ChatApp.callRefreshScreenViewerDisplays();
        });
        assert.equal(await page.locator(".call-viewers-floating .call-viewer-avatar").count(), 3, "Roster updates when someone leaves");

        // CSS zoom and a moved anchor reproduce scaled/dragged popup geometry.
        await page.evaluate(() => { document.body.style.zoom = "0.8"; });
        await roster.hover();
        await page.evaluate(() => { document.querySelector("#call-in-call").style.right = "100px"; });
        await roster.hover();
        await page.waitForTimeout(100);
        const geometry = await page.evaluate(() => {
          const a = document.querySelector("#call-in-call").getBoundingClientRect();
          const t = document.querySelector(".call-viewers-floating").getBoundingClientRect();
          return { anchor: { x: a.x, y: a.y, right: a.right }, tip: { x: t.x, y: t.y, right: t.right, bottom: t.bottom }, width: innerWidth, height: innerHeight };
        });
        assert.ok(geometry.tip.x >= 0 && geometry.tip.right <= geometry.width + 1, "Tooltip stays within the scaled viewport");
        assert.ok(geometry.tip.bottom <= geometry.anchor.y + 1, "Tooltip follows the moved roster anchor above the controls");
        await page.evaluate(() => { document.body.style.zoom = ""; document.querySelector("#call-in-call").style.right = ""; });
        await roster.hover();
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(reportDir, `${expanded ? "expanded" : "normal"}-focused-roster.png`) });
        const screen = await screenGeometry(page);
        await page.mouse.click(screen.x, screen.y);
        assert.equal(await roster.isVisible(), false, "Clicking the focused video hides In Call with every other control");
        assert.equal(await page.locator("#btn-call-mute").isVisible(), false);
        assert.equal(await page.locator(".call-viewers-floating").isVisible(), false, "Hiding controls closes the roster tooltip");
        await page.evaluate(() => ChatApp.renderCallMenu());
        assert.equal(await roster.isVisible(), false, "Presence rerenders preserve hidden controls");
        await page.evaluate(() => ChatApp.callToggleShareFocus("ALICE"));
      }

      await page.evaluate(() => {
        ChatApp.closeCallMenu();
        ChatApp.currentCallRoomId = null;
        ChatApp.callWatchedShareCodes.clear();
        ChatApp.observedCallRoomId = "test";
        ChatApp.callMembersReady = true;
        ChatApp.callActive = true;
        ChatApp.callResetRoomPreview();
        ChatApp.syncCallButton();
      });
      assert.equal(await page.locator("#call-menu.is-preview").isVisible(), true, "An active room automatically displays its call preview");
      assert.deepEqual(await visibleControls(page), ["btn-call-join"], "Preview has only the green Join Call control");
      const handset = await page.evaluate(() => {
        const join = document.querySelector("#btn-call-join"), leave = document.querySelector("#btn-call-leave");
        const style = node => { const s = getComputedStyle(node); return [s.width, s.height, s.borderRadius, getComputedStyle(node.querySelector("svg")).width]; };
        return { join: style(join), leave: style(leave), sameIcon: join.querySelector("svg").outerHTML === leave.querySelector("svg").outerHTML, text: join.textContent.trim() };
      });
      assert.deepEqual(handset.join, handset.leave, "Join has exactly the same size and shape as Leave in the same layout");
      assert.equal(handset.sameIcon, false, "Join uses a raised handset distinct from the hang-up icon");
      assert.equal(handset.text, "", "Join has no visible text");
      assert.equal(await page.locator("#btn-side-call").getAttribute("aria-label"), "Join Call");
      const previewHeight = await page.locator(".call-menu-card").evaluate(node => node.getBoundingClientRect().height);
      assert.ok(previewHeight <= 215);
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => getComputedStyle(document.querySelector("#btn-call-join")).backgroundColor === "rgb(36, 139, 96)");
      await page.screenshot({ path: path.join(reportDir, "room-call-preview.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => ChatApp.syncCallButton());
      assert.equal(await page.locator("#call-menu").isVisible(), false, "Close dismisses preview through subsequent presence updates");
      await page.evaluate(() => { ChatApp.callResetRoomPreview(); ChatApp.syncCallButton(); });
      assert.equal(await page.locator("#call-menu.is-preview").isVisible(), true);
      await page.evaluate(() => { ChatApp.callJoinPending = true; ChatApp.syncCallButton(); });
      assert.equal(await page.locator("#btn-call-join").isDisabled(), true);
      assert.equal(await page.locator("#btn-side-call").getAttribute("aria-label"), "Joining Call…");
      await page.evaluate(() => {
        ChatApp.callJoinPending = false;
        ChatApp.syncCallButton();
        ChatApp.joinCall = async (room, options) => {
          window.__previewJoin = { room, options };
          ChatApp.currentCallRoomId = room;
          ChatApp.syncCallControlsUI();
          window.__transientJoinVisible = document.querySelector("#btn-call-join").getBoundingClientRect().width > 0;
          ChatApp.syncCallButton();
          ChatApp.openCallMenu();
        };
      });
      await page.click("#btn-call-join");
      assert.deepEqual(await page.evaluate(() => window.__previewJoin), { room: "test", options: { openMenu: true } });
      assert.equal(await page.evaluate(() => window.__transientJoinVisible), false, "Join hides as soon as membership starts, even before preview class removal");
      assert.equal(await page.locator("#btn-call-join").isVisible(), false, "Joined call hides Join by computed visibility");
      assert.equal((await visibleControls(page)).includes("btn-call-join"), false);
      assert.equal(await page.locator("#call-menu").evaluate(node => node.classList.contains("is-preview")), false);
      assert.ok(await page.locator(".call-menu-card").evaluate(node => node.getBoundingClientRect().height) > previewHeight);
      assert.equal(await page.locator("#btn-side-call").getAttribute("aria-label"), "Call Menu");
      await page.evaluate(() => { ChatApp.currentCallRoomId = null; ChatApp.callActive = false; ChatApp.syncCallButton(); });
      assert.equal(await page.locator("#btn-side-call").getAttribute("aria-label"), "Start Call");
      assert.deepEqual(errors, []);
      console.log("Call UI update browser checks passed:", reportDir);
    } catch (error) {
      await page.screenshot({ path: path.join(reportDir, "failure.png") });
      throw error;
    } finally { await context.close(); }

    // Exercise actual member subscriptions and room-open hooks, including
    // delayed first snapshots and reopening a dismissed call in the same room.
    const liveContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await liveContext.addInitScript(mock);
    await liveContext.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: "application/json", body: "null" }));
    const livePage = await liveContext.newPage();
    try {
      await livePage.goto(pathToFileURL(path.resolve(__dirname, "../index.html")).href);
      await livePage.waitForFunction(() => document.documentElement.dataset.appReady === "true");
      await livePage.click("#btn-go-login");
      await livePage.fill("#login-code", "TEST-USER");
      await livePage.click("#btn-login");
      await livePage.waitForFunction(() => ChatApp.currentUser);
      await livePage.evaluate(() => ChatApp.openRoom("test", { quiet: true }));
      await livePage.waitForFunction(() => document.querySelector("#btn-side-call").getAttribute("aria-label") === "Start Call");
      await livePage.evaluate(() => __testDatabase.ref("calls/test/members/ALICE").set({ username: "Alice", displayName: "Alice", sessionId: "alice-real", connected: true, joinedAt: Date.now(), lastSeenAt: Date.now() }));
      await livePage.locator("#call-menu.is-preview").waitFor({ state: "visible" });
      assert.equal(await livePage.locator("#btn-side-call").getAttribute("aria-label"), "Join Call");
      assert.equal(await livePage.locator("#call-menu .call-participant").count(), 1);
      await livePage.keyboard.press("Escape");
      await livePage.evaluate(() => __testDatabase.ref("calls/test/members/ALICE").update({ lastSeenAt: Date.now(), muted: true }));
      assert.equal(await livePage.locator("#call-menu").isVisible(), false, "Live presence does not reopen a dismissed preview");
      await livePage.evaluate(() => ChatApp.openRoom("test", { quiet: true }));
      await livePage.locator("#call-menu.is-preview").waitFor({ state: "visible" });
      await livePage.keyboard.press("Escape");
      await livePage.evaluate(() => __testDatabase.ref("calls/test/members").remove());
      await livePage.waitForFunction(() => document.querySelector("#btn-side-call").getAttribute("aria-label") === "Start Call");
      await livePage.evaluate(() => __testDatabase.ref("calls/test/members/BOB").set({ username: "Bob", displayName: "Bob", sessionId: "bob-real", connected: true, joinedAt: Date.now(), lastSeenAt: Date.now() }));
      await livePage.locator("#call-menu.is-preview").waitFor({ state: "visible" });
      assert.equal(await livePage.locator("#call-menu .call-participant-name").textContent(), "Bob", "A new call resets the previous call dismissal");
      await livePage.evaluate(() => __testDatabase.ref("calls/test/members").remove());
      await livePage.locator("#call-menu").waitFor({ state: "hidden" });
      console.log("Live room-call preview subscription checks passed");
    } finally { await liveContext.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
