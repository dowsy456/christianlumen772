/* Browser layout regression test. Run with Playwright available in NODE_PATH.
 * node tests/panel-resize.browser.cjs [app-directory] [screenshots-directory]
 * Backend scripts are removed and all network requests intercepted; no real call is joined.
 */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ownApp = path.resolve(__dirname, "..");
const appDir = path.resolve(process.argv[2] || ownApp);
const screenshots = path.resolve(process.argv[3] || path.join(ownApp, "test-results/panel-resize"));
const originalHtml = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
const cssFiles = (originalHtml.match(/<link\b[^>]*>/gi) || [])
  .filter((tag) => /\brel=["']stylesheet["']/i.test(tag))
  .map((tag) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
  .filter((href) => href && !/^(?:https?:)?\/\//i.test(href))
  .map((href) => path.resolve(appDir, href.replace(/[?#].*$/, "")));
const resizeCss = path.join(ownApp, "css/call-panel-resize.css");
if (!cssFiles.includes(resizeCss)) cssFiles.push(resizeCss);
const html = originalHtml
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<link\b[^>]*>/gi, "");
fs.mkdirSync(screenshots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.request().url() === "http://panel-resize.test/index.html"
      ? route.fulfill({ status: 200, contentType: "text/html", body: html }) : route.abort());
    await page.goto("http://panel-resize.test/index.html");
    for (const css of cssFiles) await page.addStyleTag({ path: css });
    await page.evaluate(() => {
      document.body.dataset.mode = "chat";
      document.body.dataset.mobileUi = "0";
      document.body.dataset.membersSidebar = "0";
      document.querySelectorAll(".view").forEach((view) => { view.dataset.active = String(view.id === "view-chat"); });
      const menu = document.getElementById("call-menu");
      menu.hidden = false;
      menu.classList.add("is-open");
      document.getElementById("call-menu-status").textContent = "Connected";
      document.getElementById("call-menu-meta").textContent = "6 people";
      document.getElementById("call-menu-room").textContent = "Resize test room";
      document.getElementById("call-menu-quality-dot").classList.remove("idle");
      const list = document.getElementById("call-menu-list");
      list.dataset.participants = "6";
      list.innerHTML = `<div class="call-stage call-stage-avatars call-roster-grid" data-items="6">${["Alex", "Blair", "Casey", "Drew", "Emery", "Frankie"].map((name, i) => `<div class="call-participant call-stage-tile"><div class="call-user-avatar" style="display:grid;place-items:center;background:hsl(${i * 50} 25% 28%);font-size:24px;color:#e8f0f8">${name[0]}</div><div class="call-participant-name">${name}</div></div>`).join("")}</div>`;
      document.getElementById("btn-call-menu-expand").onclick = () => {
        menu.classList.toggle("is-expanded");
        document.body.classList.toggle("call-menu-expanded", menu.classList.contains("is-expanded"));
      };
    });
    await page.addScriptTag({ path: path.join(ownApp, "call-modules/panel-resize.js") });
    const card = page.locator("#call-menu > .call-menu-card");
    const handle = page.locator(".call-panel-resize-handle");
    await handle.waitFor({ state: "visible" });
    const initialHeight = (await card.boundingBox()).height;
    const grip = await handle.boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 130, { steps: 15 });
    await page.mouse.up();
    const draggedHeight = (await card.boundingBox()).height;
    assert.ok(Math.abs(draggedHeight - initialHeight - 130) <= 2, `Drag: ${initialHeight} → ${draggedHeight}`);
    await page.screenshot({ path: path.join(screenshots, "desktop-resized.png") });
    await page.locator("#btn-call-menu-expand").click();
    await handle.waitFor({ state: "hidden" });
    assert.ok((await card.boundingBox()).height >= 870, "Expanded panel fills viewport");
    await page.screenshot({ path: path.join(screenshots, "desktop-expanded.png") });
    await page.locator("#btn-call-menu-expand").click();
    await handle.waitFor({ state: "visible" });
    assert.ok(Math.abs((await card.boundingBox()).height - draggedHeight) < 2, "Collapse restores resized height");
    await handle.focus();
    await page.keyboard.press("Home");
    assert.equal(Math.round((await card.boundingBox()).height), 280);
    const controls = await page.locator(".call-menu-foot").boundingBox();
    const smallCard = await card.boundingBox();
    assert.ok(controls.y >= smallCard.y && controls.y + controls.height <= smallCard.y + smallCard.height + 1, "Call controls stay inside minimum panel");
    await page.screenshot({ path: path.join(screenshots, "desktop-minimum.png") });
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#call-menu").getAttribute("data-call-resized"), null);

    // A roomy panel must leave breathing room rather than enlarging one user.
    const sixPeople = await page.locator("#call-menu-list").innerHTML();
    await page.evaluate(() => {
      const list = document.getElementById("call-menu-list");
      list.dataset.participants = "1";
      list.innerHTML = '<div class="call-stage call-stage-avatars call-roster-grid" data-items="1"><div class="call-stage-tile call-participant"><div class="call-participant-avatar-shell"><div class="call-user-avatar"></div></div><div class="call-participant-name">Alex</div></div></div>';
    });
    for (const panelState of ["normal", "tall", "expanded"]) {
      if (panelState === "tall") { await handle.focus(); await page.keyboard.press("End"); }
      if (panelState === "expanded") await page.locator("#btn-call-menu-expand").click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const portrait = await page.locator(".call-user-avatar").boundingBox();
      assert.ok(portrait.width >= 80 && portrait.width <= 90, `Lone portrait stays natural in ${panelState} panel: ${portrait.width}px`);
      const participantStyle = await page.locator(".call-participant").evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderTopWidth }));
      assert.equal(participantStyle.background, "rgba(0, 0, 0, 0)");
      assert.equal(participantStyle.border, "0px");
    }
    await page.screenshot({ path: path.join(screenshots, "single-person-natural-size.png") });
    const chatButton = await page.locator("#btn-call-menu-chat").boundingBox();
    const expandButton = await page.locator("#btn-call-menu-expand").boundingBox();
    assert.ok(chatButton.x + chatButton.width <= expandButton.x, "Chat toggle is immediately before expand and available while enlarged");
    assert.equal(await page.locator(".call-menu-foot #call-menu-status").count(), 1, "Connection status is in the footer");
    assert.equal(await card.evaluate(node => getComputedStyle(node).borderRadius), "0px", "Call surface is not nested in a bubble");
    await page.locator("#call-menu-list").evaluate(list => {
      list.classList.add("is-focused", "has-shares");
      list.innerHTML = '<div class="call-stage call-roster-grid"><div class="call-stage-tile call-screen-tile call-view-tile is-focused"><div class="call-view-head">Alex\'s Screen</div><div class="call-view-body"><video class="call-view-video"></video></div></div></div>';
    });
    for (const selector of [".call-menu-head", ".call-menu-foot", ".call-view-head"]) {
      await page.locator(`#call-menu ${selector}`).waitFor({ state: "hidden" });
    }
    await page.locator("#call-menu").evaluate(menu => menu.classList.add("is-focus-controls-visible"));
    for (const selector of [".call-menu-head", ".call-menu-foot", ".call-view-head"]) {
      await page.locator(`#call-menu ${selector}`).waitFor({ state: "visible" });
    }
    await page.locator("#btn-call-menu-chat").waitFor({ state: "visible" });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("#call-menu-list").evaluate(list => list.scrollHeight <= list.clientHeight + 1), true, "Focused screen fits after revealing call controls");
    await page.locator("#call-menu").evaluate(menu => menu.classList.remove("is-focus-controls-visible"));
    for (const selector of [".call-menu-head", ".call-menu-foot", ".call-view-head"]) {
      await page.locator(`#call-menu ${selector}`).waitFor({ state: "hidden" });
    }
    await page.locator("#call-menu-list").evaluate(list => list.classList.remove("is-focused", "has-shares"));
    await page.locator("#btn-call-menu-expand").click();
    await handle.focus();
    await page.keyboard.press("Enter");
    await page.locator("#call-menu-list").evaluate((list, content) => { list.dataset.participants = "6"; list.innerHTML = content; }, sixPeople);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.body.dataset.mobileUi = "1";
      document.body.dataset.mobileNav = "0";
      document.body.dataset.navCompact = "0";
    });
    await page.waitForFunction(() => document.querySelector(".sidebar:not(.members-sidebar)").getBoundingClientRect().right <= 0);
    await handle.focus();
    await page.keyboard.press("ArrowDown");
    await page.evaluate(async () => { for (let i=0;i<3;i++) await new Promise(requestAnimationFrame); });
    await page.screenshot({ path: path.join(screenshots, "mobile-resized.png") });
    const mobileCard = await card.boundingBox();
    assert.ok(mobileCard.x >= 0 && mobileCard.x + mobileCard.width <= 391, "Mobile panel fits horizontally");
    assert.ok(mobileCard.height >= 160 && mobileCard.y + mobileCard.height < 830, `Mobile panel respects viewport: ${JSON.stringify(mobileCard)} ${await page.locator('#call-menu').evaluate(menu => JSON.stringify({style:menu.style.cssText,cls:menu.className,viewport:window.visualViewport.height,innerHeight:window.innerHeight,handle:menu.querySelector('.call-panel-resize-handle').outerHTML}))}`);
    await page.locator("#btn-call-menu-expand").click();
    await handle.waitFor({ state: "hidden" });
    const expandedList = await page.locator("#call-menu-list").boundingBox();
    const firstParticipant = await page.locator(".call-participant").first().boundingBox();
    assert.ok(firstParticipant.y >= expandedList.y, "First mobile participant is not clipped above the scroll area");
    await page.screenshot({ path: path.join(screenshots, "mobile-expanded.png") });
    await page.locator("#btn-call-menu-expand").click();
    await handle.waitFor({ state: "visible" });
    await handle.focus();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector('.call-roster-grid').dataset.callFit === 'true');
    const listAtMinimum = await page.locator("#call-menu-list").evaluate((list) => ({
      scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, overflow: getComputedStyle(list).overflowY,
      firstTop: list.querySelector(".call-participant").getBoundingClientRect().top,
      top: list.getBoundingClientRect().top,
    }));
    assert.equal(listAtMinimum.overflow, "auto");
    assert.ok((await page.locator(".call-user-avatar").first().boundingBox()).width >= 64, "Small mobile roster keeps readable portraits");
    assert.ok(listAtMinimum.firstTop >= listAtMinimum.top, "First participant is reachable at minimum height");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const touchGrip = await handle.boundingBox();
    assert.ok(touchGrip.height >= 20, "Touch grip has an enlarged hit target");
    const x = touchGrip.x + touchGrip.width / 2;
    const y = touchGrip.y + touchGrip.height / 2;
    const beforeTouchHeight = (await card.boundingBox()).height;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 85 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const afterTouchHeight = (await card.boundingBox()).height;
    assert.ok(Math.abs(afterTouchHeight - beforeTouchHeight - 85) < 2, `Touch dragging changes the height: ${beforeTouchHeight} → ${afterTouchHeight}`);
    await page.screenshot({ path: path.join(screenshots, "mobile-touch-resized.png") });
    // The same size calculation must include offered screens, watched video,
    // and participants, including large calls and a short mobile panel.
    const matrix = [];
    for (const viewportWidth of [390, 1440]) {
      await page.setViewportSize({ width: viewportWidth, height: 900 });
      await page.evaluate(width => { document.body.dataset.mobileUi = width < 600 ? "1" : "0"; }, viewportWidth);
      for (const participantCount of [3, 6, 18]) for (const height of [280, 336, 400]) {
        await page.evaluate(({ participantCount, height }) => {
          const menu = document.getElementById("call-menu");
          const grip = menu.querySelector(".call-panel-resize-handle");
          grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
          for (let next = 280; next < height; next += 16) grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
          const list = document.getElementById("call-menu-list");
          list.classList.add("has-shares", "is-crowded");
          list.innerHTML = `<div class="call-stage call-roster-grid call-stage-shares" data-items="${participantCount + 3}">
            <div class="call-stage-tile call-screen-tile call-view-tile"><div class="call-view-head"><div class="call-view-title">Watched screen</div><button class="call-view-action">×</button></div><div class="call-view-body"><video class="call-view-video"></video></div></div>
            ${[1, 2].map(i => `<div class="call-stage-tile call-screen-tile call-share-offer"><div class="call-share-poster"><div class="call-share-avatar"></div></div><div class="call-share-overlay"><div class="call-share-name">Screen ${i}</div><div class="call-share-offer-actions"><button class="call-share-watch">Watch</button><button class="call-share-multi">◉</button></div></div></div>`).join("")}
            ${Array.from({ length: participantCount }, (_, i) => `<div class="call-stage-tile call-participant"><div class="call-participant-avatar-shell"><div class="call-user-avatar"></div></div><div class="call-participant-name">Participant ${i + 1}</div></div>`).join("")}</div>`;
        }, { participantCount, height });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator("#call-menu-list").evaluate(list => { list.scrollTop = 0; });
        const geometry = await page.locator("#call-menu-list").evaluate(list => {
          const bounds = list.getBoundingClientRect();
          const tiles = [...list.querySelectorAll(".call-stage-tile")].map(tile => {
            const rect = tile.getBoundingClientRect();
            return { width: rect.width, height: rect.height, x: rect.x, right: rect.right, y: rect.y, inside: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 };
          });
          return { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, top: bounds.top, center: bounds.x + bounds.width / 2, tiles,
            portraits: [...list.querySelectorAll(".call-user-avatar")].map(avatar => avatar.getBoundingClientRect().width) };
        });
        assert.equal(geometry.tiles.length, participantCount + 3);
        assert.ok(geometry.tiles.every(tile => tile.inside && tile.width >= 159 && tile.height >= 127), `Every tile remains usable: ${viewportWidth}px, ${participantCount} people, ${height}px panel`);
        assert.ok(geometry.portraits.every(width => width >= 64), "Portraits never shrink into tiny dots");
        assert.ok(geometry.tiles[0].y >= geometry.top, "Overflow starts at the top so every row is reachable");
        const lastY = geometry.tiles.at(-1).y, lastRow = geometry.tiles.filter(tile => Math.abs(tile.y - lastY) < 2);
        assert.ok(Math.abs((lastRow[0].x + lastRow.at(-1).right) / 2 - geometry.center) < 2, `Incomplete final row is centered: ${JSON.stringify({viewportWidth,participantCount,height,lastRow,center:geometry.center})}`);
        await page.locator("#call-menu-list").evaluate(list => { list.scrollTop = list.scrollHeight; });
        const last = await page.locator(".call-stage-tile").last().boundingBox(), viewport = await page.locator("#call-menu-list").boundingBox();
        assert.ok(last.y + last.height <= viewport.y + viewport.height + 1, "Last row is reachable by scrolling");
        matrix.push({ viewportWidth, participantCount, height, tileHeight: geometry.tiles[0].height });
      }
    }
    for (const entry of matrix.filter(item => item.height === 280)) {
      const taller = matrix.find(item => item.viewportWidth === entry.viewportWidth && item.participantCount === entry.participantCount && item.height === 400);
      assert.ok(taller.tileHeight >= entry.tileHeight, `Increasing call height keeps screens usable: ${JSON.stringify({ entry, taller })}`);
    }
    await page.screenshot({ path: path.join(screenshots, "screens-and-18-participants.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, initialHeight, draggedHeight, fitScenarios: matrix.length, screenshots }, null, 2));
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
