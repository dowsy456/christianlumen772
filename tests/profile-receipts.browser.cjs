/* Regression checks use only the in-memory Firebase fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium, devices} = require('playwright');
const mock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true});
  try {
    for (const [name, options] of [
      ['desktop', {viewport: {width: 1440, height: 960}}],
      ['ios', {...devices['iPhone 13']}],
      ['android', {...devices['Pixel 7']}]
    ]) {
      const context = await browser.newContext(options);
      await context.addInitScript(mock);
      await context.route(/^https?:\/\//, route => route.fulfill({status: 200, contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, body: 'null'}));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login');
      await page.fill('#login-code', 'TEST-USER');
      await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      await page.evaluate(async () => {
        const db = window.__testDatabase;
        for (const [code, username] of [['MIRA', 'Mira'], ['ALICE', 'Alice']]) {
          await db.ref(`users/${code}`).set({code, username, displayName: username, usernameLower: username.toLowerCase()});
          await db.ref(`memberships/${code}/test`).set(true);
        }
        await db.ref('messages/test/receipt').set({userCode: 'MIRA', username: 'Mira', text: 'Readers appear next to this message’s time.', createdAt: Date.now()});
        // An old sender receipt must also disappear for recipients of the message.
        await db.ref('readReceipts/test/receipt').set({'MIRA': 1, 'TEST-USER': 1, 'ALICE': 1});
        await ChatApp.openRoom('test', {quiet: true});
      });
      await page.waitForSelector('.message-seen-avatar[data-usercode="ALICE"]');
      assert.equal(await page.locator('.message-seen-avatar[data-usercode="MIRA"]').count(), 0, `${name}: sender hidden for a different viewer`);
      assert.equal(await page.locator('.message-seen-avatar[data-usercode="TEST-USER"]').count(), 1, `${name}: recipient's own read remains visible`);
      assert.equal(await page.locator('.bubble-top > .bubble-time + .message-seen').count(), 1);
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {time: rect('.bubble-time'), seen: rect('.message-seen'), bubble: rect('.bubble'), body: rect('.bubble-text')};
      });
      assert(geometry.seen.x >= geometry.time.right, `${name}: receipts are to the timestamp's right`);
      assert(geometry.seen.y < geometry.time.bottom && geometry.seen.bottom > geometry.time.y, `${name}: receipts share the timestamp line`);
      assert(geometry.seen.bottom <= geometry.body.y, `${name}: receipts are above message body`);
      assert(geometry.seen.right <= geometry.bubble.right + 1, `${name}: receipt header fits bubble`);

      const reader = page.locator('.message-seen-avatar[data-usercode="ALICE"]');
      if (name === 'desktop') {
        const sender = page.locator('.msg-avatar[data-usercode="MIRA"]');
        const hoverStyle = locator => locator.evaluate(element => {
          const style = getComputedStyle(element);
          return {transform: style.transform, filter: style.filter, shadow: style.boxShadow};
        });
        await sender.hover();
        await page.waitForTimeout(200);
        const normal = await hoverStyle(sender);
        await reader.hover();
        await page.waitForTimeout(200);
        assert.deepEqual(await hoverStyle(reader), normal, 'seen and regular avatars share hover effects');
      }
      await reader.click();
      await page.waitForFunction(() => ChatApp.userProfileOpen && ChatApp.userProfilePinnedCode === 'ALICE');
      assert.equal(await page.locator('#user-profile-card .user-profile-username').textContent(), 'Alice');
      // A DOM click still traverses the real capture and bubble listeners, and
      // works when the mobile popover covers the original anchor visually.
      await reader.evaluate(element => element.click());
      await page.waitForFunction(() => !ChatApp.userProfileOpen);
      await reader.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => ChatApp.userProfileOpen && ChatApp.userProfilePinnedCode === 'ALICE');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !ChatApp.userProfileOpen);

      if (name !== 'desktop') await page.click('#btn-mobile-nav');
      const me = page.locator('.me-pill-dock');
      await me.click();
      await page.waitForFunction(() => ChatApp.userProfileOpen && ChatApp.userProfilePinnedCode === 'TEST-USER');
      assert.equal((await page.locator('#user-profile-card .user-profile-username').textContent()).startsWith('@'), false);
      await me.evaluate(element => element.click());
      await page.waitForFunction(() => !ChatApp.userProfileOpen);
      await me.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => ChatApp.userProfileOpen);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !ChatApp.userProfileOpen);
      assert.equal(await page.locator('#btn-side-collapse').count(), 0, 'navigation has no minimized mode');
      await page.evaluate(() => { document.querySelector('#rooms-list').scrollTop = 99999; });
      await me.click();
      await page.waitForFunction(() => ChatApp.userProfileOpen);
      await me.evaluate(element => element.click());
      await page.waitForFunction(() => !ChatApp.userProfileOpen);

      if (process.env.QA_SCREENSHOTS) {
        fs.mkdirSync(process.env.QA_SCREENSHOTS, {recursive: true});
        await page.evaluate(() => ChatApp.closeMobileDrawers?.());
        await page.screenshot({path: path.join(process.env.QA_SCREENSHOTS, `profile-receipts-${name}.png`)});
      }
      assert.deepEqual(errors, [], `${name}: no browser runtime errors`);
      console.log(`${name}: receipt authors/layout/avatar hover and profile mouse/keyboard toggles passed`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
