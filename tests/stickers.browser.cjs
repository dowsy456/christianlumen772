/* Run with node tests/stickers.browser.cjs. All account/asset data stays in memory. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium, devices } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const [name, device] of [
      ['desktop', { viewport: { width: 1440, height: 900 } }],
      ['android', devices['Pixel 7']],
      ['ios-layout', devices['iPhone 13']]
    ]) {
      const context = await browser.newContext(device);
      await context.addInitScript(installFirebaseMock);
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.evaluate(async () => {
        const app = ChatApp;
        const code = 'TEST-USER';
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect width="300" height="150" fill="#ff6748"/><circle cx="100" cy="75" r="55" fill="#54cfc9"/></svg>';
        const dataURL = 'data:image/svg+xml;base64,' + btoa(svg);
        await __testDatabase.ref(`users/${code}`).update({ photoDataURL: dataURL, photoTransform: { unit: 'rel', scale: 1.6, x: .13, y: -.08 } });
        for (let i = 0; i < 40; i++) {
          const id = `sticker-${String(i).padStart(2, '0')}`;
          await __testDatabase.ref(`stickers/meta/${id}`).set({ id, name: `Sticker ${i}`, kind: 'image', mimeType: 'image/svg+xml', state: 'ready', creatorCode: code, creatorUsername: 'Tester', byteSize: 250, createdAt: i + 1 });
          await __testDatabase.ref(`stickers/assets/${id}`).set({ dataURL, dataChunkCount: 1 });
          await __testDatabase.ref(`stickerCollections/${code}/${id}`).set({ savedAt: i + 1 });
        }
        app.currentUser = await app.loginWithCode(code);
        app.ensureLiveUserListener(code);
        app.setMeHeader();
        app.showView('chat');
        app.attachMemberships();
        await app.openRoom('test', { quiet: true });
        app.prepareStickerPicker();
      });
      await page.waitForFunction(() => ChatApp.stickerLibraryMeta.size === 40 && ChatApp.currentRoomId === 'test');
      await page.evaluate(() => ChatApp.openStickerPopover());
      await page.waitForFunction(() => document.querySelectorAll('.sticker-tile img').length >= 6);
      const identity = await page.evaluate(() => { window.__firstSticker = document.querySelector('.sticker-tile img'); ChatApp.renderStickerMenu(); return __firstSticker === document.querySelector('.sticker-tile img'); });
      assert.equal(identity, true, `${name}: metadata update should preserve decoded media`);
      await page.locator('.sticker-tile').first().click({ button: 'right' });
      const menu = page.locator('#sticker-context-menu');
      await menu.waitFor({ state: 'visible' });
      await menu.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
      const menuGeometry = await menu.evaluate(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, position: getComputedStyle(el).position, opacity: getComputedStyle(el).opacity }; });
      assert.equal(menuGeometry.position, 'fixed');
      assert.equal(menuGeometry.opacity, '1');
      assert.ok(menuGeometry.left >= 0 && menuGeometry.right <= menuGeometry.width && menuGeometry.top >= 0 && menuGeometry.bottom <= menuGeometry.height, `${name}: menu fits viewport`);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#sticker-popover').isVisible(), true);
      await page.locator('.sticker-tile').first().click({ button: 'right' });
      await menu.waitFor({ state: 'visible' });
      // Shared menus scroll their outer surface; the sticker grid itself grows
      // with its tiles. Exercise a real scroll, rather than a no-op on the grid.
      const scrolled = await page.locator('#sticker-popover').evaluate(popover => {
        popover.scrollTop = 300;
        return popover.scrollTop;
      });
      assert.ok(scrolled > 0, `${name}: sticker collection really scrolled`);
      await menu.waitFor({ state: 'hidden' });
      await page.evaluate(async () => { ChatApp.closeStickerPopover({ immediate: true }); await ChatApp.openStickerViewer(ChatApp.stickerLibraryMeta.get('sticker-39')); });
      const avatar = page.locator('.sticker-viewer-uploader-avatar img');
      await avatar.waitFor();
      await avatar.evaluate(el => Promise.all(el.closest('.modal-card').getAnimations().map(animation => animation.finished)));
      const crop = await avatar.evaluate(el => {
        const image = el.getBoundingClientRect(), frame = el.parentElement.getBoundingClientRect();
        const border = parseFloat(getComputedStyle(el.parentElement).borderLeftWidth) || 0;
        const frameWidth = frame.width - border * 2;
        return {
          objectFit: getComputedStyle(el).objectFit,
          x: (image.left + image.width / 2 - frame.left - frame.width / 2) / frameWidth,
          y: (image.top + image.height / 2 - frame.top - frame.height / 2) / frameWidth,
          scale: image.width / frameWidth
        };
      });
      assert.equal(crop.objectFit, 'contain', `${name}: uploader must use editor crop base geometry`);
      assert.ok(Math.abs(crop.x - .13) < .015, `${name}: horizontal offset remains relative to avatar frame width`);
      assert.ok(Math.abs(crop.y + .08) < .015, `${name}: vertical offset remains relative to avatar frame width`);
      assert.ok(Math.abs(crop.scale - 1.6) < .015, `${name}: saved zoom applies at small avatar size`);
      if (process.env.STICKER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.STICKER_SCREENSHOT_DIR, `sticker-${name}.png`) });
      assert.deepEqual(errors, [], `${name}: ${errors.join('\n')}`);
      console.log(`${name}: picker retention, eager media, menu animation/dismissal/viewport and uploader crop passed`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
