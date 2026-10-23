/* Mounted-chat regression: real local UI with in-memory Firebase, no production writes.
 * node tests/companion-chat-v2.browser.cjs [screenshots-directory]
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const installFirebaseMock = require("./firebase-mock.js");
const root = path.resolve(__dirname, "..");
const screenshots = path.resolve(process.argv[2] || path.join(root, "../companion-chat-v2"));
const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (error, data) => { res.writeHead(error ? 404 : 200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" }); res.end(error ? "Not found" : data); });
});

(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const results = [];
  page.on("pageerror", error => errors.push(error.stack || error.message));
  await context.addInitScript(installFirebaseMock);
  await context.route(/^https?:\/\//, route => route.request().url().startsWith(origin) ? route.continue() : route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: "null" }));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function assertOriginalChat(label) {
    assert.deepEqual(await page.evaluate(() => ({
      messages: __originalMessages === document.getElementById("messages-inner"),
      row: __originalRow === document.querySelector(".msg-row"),
      room: __originalRoomRef === ChatApp.roomOnlineRef,
      opens: __extraRoomOpens,
    })), { messages: true, row: true, room: true, opens: 0 }, `${label}: preserves the mounted chat and subscription`);
  }
  async function typeByPointer(label) {
    const input = page.locator("#msg-input");
    await input.click();
    assert.equal(await input.evaluate(node => document.activeElement === node), true, `${label}: clicking composer focuses it`);
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`Draft ${label}`);
    assert.equal(await input.inputValue(), `Draft ${label}`, `${label}: physical typing reaches composer`);
  }
  async function assertOnscreen(selector, label) {
    await page.locator(selector).waitFor({ state: "visible" });
    await settle();
    await page.locator(selector).evaluate(node => Promise.all(node.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {}))));
    await settle();
    const rect = await page.locator(selector).boundingBox();
    assert.ok(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= 1441 && rect.y + rect.height <= 901,
      `${label}: stays in viewport ${JSON.stringify(rect)}`);
  }
  async function clickComposerTool(id) {
    if (!await page.locator(id).isVisible()) {
      await page.locator("#btn-composer-more").click();
      await assertOnscreen("#composer-more-menu", "More Tools");
      assert.ok(await page.locator("#composer-more-actions > button:visible").count() >= 2, "Overflow contains at least two tools");
    }
    await page.locator(id).click();
  }
  async function exerciseMenus(label) {
    for (const [button, menu] of [["#btn-stickers", "#sticker-popover"], ["#btn-voice", "#voice-popover"], ["#btn-activities", "#room-activities-menu"]]) {
      await clickComposerTool(button);
      await assertOnscreen(menu, `${label} ${menu}`);
      await typeByPointer(`${label} after ${menu}`);
      await page.locator(menu).waitFor({ state: "hidden" });
    }
    await page.locator(".msg-row").first().click({ button: "right" });
    await assertOnscreen("#msg-menu", `${label} message context menu`);
    await typeByPointer(`${label} after context menu`);
    await page.locator("#msg-menu").waitFor({ state: "hidden" });
  }
  async function assertChatGeometry(mode, side, percent) {
    const chat = await page.locator(".chat-main").boundingBox();
    const surface = await page.locator(mode === "activity" ? "#games-stage-wrap" : "#call-menu").boundingBox();
    const width = 1440 * percent / 100;
    assert.ok(Math.abs(chat.width - width) < 1, `${mode} ${side} ${percent}% width ${chat.width}`);
    assert.equal(Math.round(chat.x), side === "left" ? 0 : 1440 - width);
    assert.ok(Math.abs(surface.width + chat.width - 1440) < 1, `${mode}: the shared surface fills the remaining width`);
    assert.ok(Math.abs(surface.x - (side === "left" ? width : 0)) < 1, `${mode}: surface respects sidebar side`);
    const editor = await page.locator("#msg-input").boundingBox();
    const row = await page.locator("#composer-row").boundingBox();
    assert.ok(editor.width >= row.width - 14 && editor.x <= row.x + 8,
      `${mode}: narrow textarea uses its full row without side-button insets ${JSON.stringify({ editor, row })}`);
    if (mode === "call") assert.equal(await page.locator("#call-menu-list").evaluate(node => node.scrollHeight <= node.clientHeight + 1), true, "Call content never scrolls beside chat");
  }
  async function companionScenario(mode) {
    await page.waitForFunction(expected => document.body.dataset.companionMode === expected && document.body.dataset.companionChat === "1", mode);
    await assertOriginalChat(`${mode} entry`);
    assert.equal(await page.locator('.activity-chat-head').count(), 0, 'companion has no duplicate header');
    assert.equal(await page.locator('.chat-main > #room-toolbar').count(), 1, 'actual room header stays inside companion');
    assert.equal(await page.locator('#room-toolbar #btn-activities + #btn-members').count(), 1, 'activities precede members in room header');
    assert.equal(await page.locator('#room-toolbar #activity-chat-close').count(), 1, 'companion close is in the real header');
    assert.equal(await page.locator("#members-sidebar").isVisible(), false, "Members start closed in companion mode");
    for (const side of ["right", "left"]) {
      await page.evaluate(value => ChatApp.applySidebarPosition(value), side);
      for (const [percent, key] of [[15, "Home"], [30, "End"]]) {
        await page.locator("#activity-chat-resize").focus();
        await page.keyboard.press(key);
        await settle();
        await assertChatGeometry(mode, side, percent);
        await exerciseMenus(`${mode}-${side}-${percent}`);
        await assertOriginalChat(`${mode}-${side}-${percent}`);
        results.push(`${mode}-${side}-${percent}`);
      }
      const grip = await page.locator("#activity-chat-resize").boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(side === "left" ? 288 : 1152, 450, { steps: 4 });
      await page.mouse.up();
      await assertChatGeometry(mode, side, 20);
    }
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const title = await page.locator("#room-toolbar-name").boundingBox();
    await page.mouse.move(title.x + 2, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x + title.width - 2, title.y + title.height / 2, { steps: 4 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "", "Dragging header cannot select its text");
    await clickComposerTool("#btn-members");
    await page.locator("#activity-chat-members-back").waitFor({ state: "visible" });
    const back = await page.locator("#activity-chat-members-back").boundingBox();
    const close = await page.locator("#activity-chat-close").boundingBox();
    const members = await page.locator("#members-sidebar").boundingBox();
    const chat = await page.locator(".chat-main").boundingBox();
    assert.ok(back.x + back.width <= close.x, "Members arrow is left of the header X");
    assert.equal(members.width, chat.width, "Members stay inside the existing chat width");
    assert.equal(await page.locator(".activity-members-close").count(), 0, "Old full-width Back to Chat button was removed");
    await page.locator("#activity-chat-members-back").click();
    await page.locator("#members-sidebar").waitFor({ state: "hidden" });
    await typeByPointer(`${mode} after members`);
    await page.screenshot({ path: path.join(screenshots, `${mode}-left-chat.png`) });
  }
  try {
    await page.goto(`${origin}/index.html`);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === "true");
    await page.click("#btn-go-login");
    await page.fill("#login-code", "TEST-USER");
    await page.click("#btn-login");
    await page.waitForFunction(() => ChatApp.currentUser?.code === "TEST-USER");
    await page.evaluate(() => ChatApp.openRoom("test", { quiet: true }));
    await page.waitForFunction(() => ChatApp.currentRoomId === "test" && !ChatApp.bulkLoading);
    await typeByPointer("original room message");
    await page.locator("#btn-send").click();
    await page.waitForFunction(() => document.querySelector(".msg-row"));
    await page.evaluate(() => {
      window.__originalMessages = document.getElementById("messages-inner");
      window.__originalRow = document.querySelector(".msg-row");
      window.__originalRoomRef = ChatApp.roomOnlineRef;
      window.__extraRoomOpens = 0;
      const open = ChatApp.openRoom;
      ChatApp.openRoom = function (...args) { __extraRoomOpens++; return open.apply(this, args); };
    });
    await exerciseMenus("normal");
    await page.evaluate(() => {
      document.getElementById("btn-members").focus();
      ChatApp.openModal({ title:"Focus regression", bodyHTML:'<button type="button">Modal action</button>' });
    });
    await page.locator("#btn-modal-close").click();
    await page.locator("#msg-input").click();
    await page.keyboard.type("typing during modal close");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement.id),"msg-input","closing modal must not steal focus back from composer");
    await page.evaluate(() => ChatApp.openMergePartyActivity("test"));
    await page.waitForFunction(() => document.querySelector("#games-frame")?.contentWindow?.__mergeParty);
    await page.frameLocator("#games-frame").locator("#activityChatBtn").click();
    await companionScenario("activity");
    const activityDraft = await page.locator("#msg-input").inputValue();
    await page.locator("#activity-chat-close").click();
    await page.locator(".chat-main").waitFor({ state: "hidden" });
    await page.frameLocator("#games-frame").locator("#activityChatBtn").click();
    assert.equal(await page.locator("#msg-input").inputValue(), activityDraft, "Activity chat toggle retains the draft");
    await page.frameLocator("#games-frame").locator("#activityExitBtn").click();
    await page.waitForFunction(() => document.body.dataset.companionMode === "none");
    await typeByPointer("normal after activity");
    await assertOriginalChat("activity exit");
    await page.evaluate(async () => {
      await __testDatabase.ref("calls/test/members/TEST-USER").set({ code: "TEST-USER", username: "Tester", displayName: "Tester", sessionId: "companion-ui-fixture", connected: true, joinedAt: Date.now() });
      ChatApp.currentCallRoomId = "test";
      ChatApp.callSessionId = "companion-ui-fixture";
      ChatApp.openCallMenu();
    });
    await page.locator("#btn-call-menu-chat").click();
    await companionScenario("call");
    const callDraft = await page.locator("#msg-input").inputValue();
    await page.locator("#btn-call-menu-chat").click();
    await page.waitForFunction(() => ChatApp.callMenuExpanded && document.body.dataset.companionChat === "0");
    await page.locator("#btn-call-menu-chat").click();
    assert.equal(await page.locator("#msg-input").inputValue(), callDraft, "Call chat toggle retains the draft");
    // An activity launched from the enlarged call's chat temporarily owns the
    // companion view; exiting returns to that same call and mounted draft.
    await clickComposerTool("#btn-activities");
    await page.locator("#room-activity-merge-party").click();
    await page.waitForFunction(() => document.querySelector("#games-frame")?.contentWindow?.__mergeParty);
    await page.frameLocator("#games-frame").locator("#activityChatBtn").click();
    await page.waitForFunction(() => document.body.dataset.companionMode === "activity" && document.body.dataset.companionChat === "1");
    await typeByPointer("activity launched from call");
    await assertOriginalChat("call-to-activity transition");
    await page.frameLocator("#games-frame").locator("#activityExitBtn").click();
    await page.waitForFunction(() => document.body.dataset.companionMode === "call" && document.body.dataset.companionChat === "1");
    assert.equal(await page.locator("#msg-input").inputValue(), "Draft activity launched from call");
    assert.equal(await page.locator("#btn-call-menu-chat").getAttribute("aria-pressed"), "true");
    await typeByPointer("call restored after activity");
    await page.locator("#btn-call-menu-expand").click();
    await page.waitForFunction(() => document.body.dataset.companionMode === "none");
    await typeByPointer("normal after restoring call");
    await page.locator("#btn-call-menu-chat").click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !ChatApp.callMenuOpen);
    await page.waitForFunction(() => document.body.dataset.companionMode === "none");
    await typeByPointer("normal after closing call");
    await assertOriginalChat("all transitions");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, scenarios: results, originalChatReopens: 0, screenshots }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(screenshots, "failure.png") }).catch(() => {});
    console.error(JSON.stringify({ completed: results, errors }, null, 2));
    throw error;
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
