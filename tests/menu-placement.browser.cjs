/* All custom context menus must avoid their trigger throughout opening motion. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { bootstrap, screenGeometry } = require("./screen-focus.browser.cjs");
const captures = path.resolve(__dirname, "../../menu-placement-v5");
const menus = {
  message: "#msg-menu", avatar: "#msg-menu", room: "#msg-menu", text: "#msg-text-menu",
  emoji: "#emoji-ctx-menu", user: "#call-user-context-menu", screen: "#call-screen-context-menu",
  activity: "#html-hub-menu", sticker: "#sticker-context-menu"
};
async function dismiss(page) {
  await page.evaluate(() => {
    ChatApp.closeMsgMenu(true); ChatApp.closeMsgTextMenu(true); ChatApp.closeEmojiCtxMenu(true);
    ChatApp.closeCallUserContextMenu(true); ChatApp.closeCallScreenContextMenu(true);
    ChatApp.closeHtmlHubContextMenu(true); ChatApp.closeStickerContextMenu(true);
  });
}
async function openAt(page, kind, point) {
  await dismiss(page);
  await page.evaluate(({ kind, point }) => {
    let anchor = document.querySelector("#placement-anchor");
    if (!anchor) {
      anchor = document.createElement("button"); anchor.id = "placement-anchor"; anchor.type = "button";
      anchor.textContent = "…"; anchor.style.cssText = "position:fixed;width:40px;height:34px;z-index:2147482500";
      document.body.appendChild(anchor);
    }
    anchor.style.left = `${Math.max(0, Math.min(innerWidth - 40, point.x - 20))}px`;
    anchor.style.top = `${Math.max(0, Math.min(innerHeight - 34, point.y - 17))}px`;
    const ctx = { username: "Tester", userCode: "TEST-USER", pointerX: point.x, pointerY: point.y, canEdit: true, canReply: true };
    if (kind === "message") ChatApp.openMsgMenuFor(anchor, ctx);
    if (kind === "avatar") ChatApp.openMsgMenuFor(anchor, { ...ctx, menu: "avatar" });
    if (kind === "room") ChatApp.openRoomButtonContextMenu(new MouseEvent("contextmenu", { clientX: point.x, clientY: point.y }), "test", anchor);
    if (kind === "text") ChatApp.openMsgTextMenu({ x: point.x, y: point.y, text: "Selected test text", word: "", username: "Tester" });
    if (kind === "emoji") ChatApp.openEmojiCtxMenu({ x: point.x, y: point.y, emoji: "😀" });
    if (kind === "user") ChatApp.openCallUserContextMenu("ALICE", point.x, point.y);
    if (kind === "screen") ChatApp.openCallScreenContextMenu("ALICE", point.x, point.y);
    if (kind === "activity") {
      ChatApp.htmlHubItemsCache = [{ id: "placement-test", title: "Test HTML", ownerCode: "TEST-USER", creatorCode: "TEST-USER" }];
      ChatApp.openHtmlHubContextMenu("placement-test", point.x, point.y);
    }
    if (kind === "sticker") {
      ChatApp.stickerPopoverOpen = true;
      ChatApp.openStickerContextMenu({ id: "placement-sticker", creatorCode: "TEST-USER" }, point.x, point.y, anchor);
    }
  }, { kind, point });
}
async function check(page, selector, excluded, label) {
  const info = await page.locator(selector).evaluate(menu => {
    const rect = menu.getBoundingClientRect(), viewport = visualViewport;
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      vLeft: viewport?.offsetLeft || 0, vTop: viewport?.offsetTop || 0,
      vRight: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth), vBottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight),
      clientWidth: menu.clientWidth, scrollWidth: menu.scrollWidth, visible: !menu.hidden && getComputedStyle(menu).display !== "none" };
  });
  assert.ok(info.visible && info.width > 0 && info.height > 0, `${label}: menu is usable`);
  assert.ok(info.left >= info.vLeft && info.top >= info.vTop && info.right <= info.vRight + .5 && info.bottom <= info.vBottom + .5, `${label}: fits visual viewport ${JSON.stringify(info)}`);
  assert.ok(info.right < excluded.left || info.left > excluded.right || info.bottom < excluded.top || info.top > excluded.bottom, `${label}: does not overlap activation ${JSON.stringify({ info, excluded })}`);
  assert.ok(info.scrollWidth <= info.clientWidth + 1, `${label}: no horizontal overflow`);
}
const pointRect = point => ({ left: point.x, right: point.x, top: point.y, bottom: point.y });

(async () => {
  fs.mkdirSync(captures, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
  const report = { passed: false, checks: 0, scenarios: [] };
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 230 }]) {
      const mobile = viewport.width < 600;
      const { context, page, errors } = await bootstrap(browser, viewport, mobile);
      page.setDefaultTimeout(5000);
      try {
        const points = [
          { x: 1, y: 1 }, { x: viewport.width - 1, y: 1 },
          { x: 1, y: viewport.height - 1 }, { x: viewport.width - 1, y: viewport.height - 1 },
          { x: viewport.width / 2, y: viewport.height / 2 }
        ];
        for (const [kind, selector] of Object.entries(menus)) {
          for (const point of points) {
            await openAt(page, kind, point);
            await check(page, selector, pointRect(point), `${kind} initial ${viewport.width}x${viewport.height}`);
            await page.waitForTimeout(170);
            await check(page, selector, pointRect(point), `${kind} settled ${viewport.width}x${viewport.height}`);
            report.checks += 2;
          }
        }
        // A button trigger excludes its entire bounds, and opening motion must
        // not drift over the button while scaling from the top-left corner.
        for (const point of points) {
          await openAt(page, "avatar", point);
          await page.evaluate(() => ChatApp.openAvatarContextMenuFor(document.querySelector("#placement-anchor"), "TEST-USER"));
          const anchor = await page.locator("#placement-anchor").boundingBox();
          const excluded = { left: anchor.x, right: anchor.x + anchor.width, top: anchor.y, bottom: anchor.y + anchor.height };
          for (let sample = 0; sample < 5; sample++) {
            await check(page, "#msg-menu", excluded, "Whole button exclusion during opening");
            await page.waitForTimeout(35);
            report.checks++;
          }
        }
        // A real right-click must reserve the small avatar/control, even when
        // its handler supplies pointer coordinates rather than avoidAnchor.
        for (const point of points) {
          await openAt(page, "avatar", point);
          await dismiss(page);
          await page.locator("#placement-anchor").evaluate(anchor => {
            anchor.classList.add("sched-avatar");
            anchor.dataset.usercode = "TEST-USER";
          });
          const control = page.locator("#placement-anchor");
          const rect = await control.boundingBox();
          await control.click({ button: "right" });
          const excluded = { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height };
          await check(page, "#msg-menu", excluded, "Real right-click excludes entire small avatar");
          await page.waitForTimeout(180);
          await check(page, "#msg-menu", excluded, "Settled right-click excludes entire small avatar");
          report.checks += 2;
        }
        // A definition panel grows after its menu is already open.
        const center = { x: viewport.width / 2, y: viewport.height / 2 };
        await openAt(page, "text", center);
        await page.evaluate(() => ChatApp.renderMsgTextDefinition("fixture", Array.from({ length: 12 }, (_, index) => ({ definition: `Long definition ${index}: a deliberately lengthy explanation to verify scrollable placement without covering the activation point.` }))));
        await page.waitForTimeout(200);
        await check(page, "#msg-text-menu", pointRect(center), "Growing definition panel");
        assert.ok(await page.locator("#msg-text-menu").evaluate(menu => [menu, ...menu.querySelectorAll(".msg-text-menu-definition")].some(node => node.scrollHeight > node.clientHeight)), "Long definitions remain scrollable");
        await page.locator("#msg-text-menu").evaluate(menu => {
          for (const node of [menu, ...menu.querySelectorAll(".msg-text-menu-definition")]) node.scrollTop = node.scrollHeight;
        });
        await page.waitForTimeout(50);
        await check(page, "#msg-text-menu", pointRect(center), "Scrolling a submenu preserves exclusion");
        await page.screenshot({ path: path.join(captures, `${viewport.width}x${viewport.height}-growing-menu.png`) });

        // Expanding Assets must measure the final child height and relocate
        // when another side has room, rather than pinning a clipped scroller.
        const assetsPoint = { x: viewport.width / 2, y: viewport.height * .65 };
        await openAt(page, "avatar", assetsPoint);
        await page.evaluate(({ x, y }) => ChatApp.openMsgMenuFor(document.querySelector("#placement-anchor"), {
          menu: "avatar", username: "Tester", userCode: "TEST-USER", bannerDataURL: "data:image/png;base64,",
          pointerX:x, pointerY:y
        }), assetsPoint);
        await page.waitForTimeout(180);
        for (let toggle = 0; toggle < 4; toggle++) {
          await page.locator('[data-menu-group="assets"]').click();
          await page.waitForTimeout(350);
          await check(page, "#msg-menu", pointRect(assetsPoint), "Assets expansion/collapse stays on screen");
          const sizes = await page.locator("#msg-menu").evaluate(menu => ({ client:menu.clientHeight, scroll:menu.scrollHeight, top:menu.getBoundingClientRect().top }));
          if (viewport.height > 400) assert.ok(sizes.scroll <= sizes.client + 1, `Assets uses available space before scrolling: ${JSON.stringify(sizes)}`);
          await page.waitForTimeout(100);
          assert.ok(Math.abs((await page.locator("#msg-menu").boundingBox()).y - sizes.top) < 1, "Expanded menu settles without repeated repositioning");
          report.checks++;
        }
        await page.locator('[data-menu-group="assets"]').click();
        await page.waitForTimeout(350);
        await page.screenshot({ path:path.join(captures, `${viewport.width}x${viewport.height}-assets-expanded.png`) });

        if (viewport.height > 400) {
          await dismiss(page);
          await page.evaluate(() => {
            ChatApp.stickerPopoverOpen = false;
            ChatApp.openUserProfileAt(document.querySelector("#placement-anchor"), "TEST-USER");
          });
          const more = page.locator(".user-profile-more:visible");
          await more.waitFor({ state: "visible" });
          const rect = await more.boundingBox();
          await more.click();
          await page.waitForTimeout(180);
          await check(page, "#msg-menu", { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height }, "Real profile three-dot click");
          await dismiss(page);
          await more.click({ button: "right" });
          await check(page, "#msg-menu", { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height }, "Real profile three-dot right-click");
          await page.waitForTimeout(180);
          await check(page, "#msg-menu", { left: rect.x, right: rect.x + rect.width, top: rect.y, bottom: rect.y + rect.height }, "Settled profile three-dot right-click");
          await page.screenshot({ path: path.join(captures, `${viewport.width}-profile-actions.png`) });
          await dismiss(page);
          await page.evaluate(() => ChatApp.closeUserProfile(true));

          if (!mobile) {
            await page.locator('.call-view-tile[data-share-code="ALICE"] .call-view-focus').click();
            await page.locator(".call-view-tile.is-focused .call-view-body").focus();
            await page.keyboard.press("Shift+F10");
            const tile = await page.locator(".call-view-tile.is-focused").boundingBox();
            await page.waitForTimeout(170);
            await check(page, "#call-screen-context-menu", pointRect({ x: tile.x + 28, y: tile.y + 28 }), "Keyboard screen menu");
          } else {
            await page.locator('.call-view-tile[data-share-code="ALICE"] .call-view-focus').click();
            const point = await screenGeometry(page);
            const session = await context.newCDPSession(page);
            await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
            await page.waitForTimeout(700);
            await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await page.waitForTimeout(180);
            await check(page, "#call-screen-context-menu", pointRect(point), "Real touch long-press menu");
            await session.detach();
          }
        }
        assert.deepEqual(errors, [], "No browser runtime errors");
        report.scenarios.push({ viewport, passed: true });
        console.log(`PASS ${viewport.width}x${viewport.height}: all custom menus avoid points/controls at edges and while animating`);
      } catch (error) {
        await page.screenshot({ path: path.join(captures, `${viewport.width}x${viewport.height}-failure.png`) });
        report.scenarios.push({ viewport, passed: false, failure: error.stack, errors });
        throw error;
      } finally { await context.close(); }
    }
    report.passed = true;
  } finally {
    fs.writeFileSync(path.join(captures, "menu-placement-report.json"), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
