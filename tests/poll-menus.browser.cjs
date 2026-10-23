/* Real pointer interactions against the local app and in-memory Firebase. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');
const captures = path.resolve(__dirname, '../../poll-checks');

(async () => {
  fs.mkdirSync(captures, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
      await context.addInitScript(mock);
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: 'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login');
      await page.fill('#login-code', 'TEST-USER');
      await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser);
      await page.evaluate(async () => {
        await ChatApp.openRoom('test', { quiet: true });
        ChatApp.closeMobileDrawers(); ChatApp.closeToast();
      });
      await page.waitForFunction(() => !ChatApp.bulkLoading);
      await page.evaluate(() => ChatApp.openPollComposer());
      await page.fill('#poll-question', 'Which time works?');
      await page.locator('#poll-editor-answers input').nth(0).fill('Morning');
      await page.locator('#poll-editor-answers input').nth(1).fill('Evening');
      assert.equal(await page.locator('#poll-question').evaluate(el=>getComputedStyle(el).resize),'none');
      assert.equal(await page.locator('#poll-popover button').filter({hasText:/^(Cancel|Close)$/}).count(),0);
      assert.equal(await page.locator('#poll-popover .chat-popup-close').count(),1);
      for(const unit of ['days','hours','minutes','seconds'])await page.fill(`#poll-duration-${unit}`,'0');
      await page.click('#poll-attach');
      assert.match(await page.locator('#poll-editor-error').textContent(),/at least 1 second/);
      for(const [unit,value] of Object.entries({days:2,hours:3,minutes:4,seconds:5}))await page.fill(`#poll-duration-${unit}`,String(value));
      await page.waitForTimeout(180);
      await page.screenshot({ path: path.join(captures, `${viewport.width}-custom-duration.png`) });
      await page.click('#poll-attach');
      assert.equal(await page.evaluate(() => ChatApp.pendingPoll.durationSeconds), 183845);
      await page.locator('.poll-draft-edit').click();
      for(const [unit,value] of Object.entries({days:2,hours:3,minutes:4,seconds:5}))assert.equal(await page.locator(`#poll-duration-${unit}`).inputValue(),String(value));
      await page.click('#poll-attach');
      const sentAfter=await page.evaluate(()=>ChatApp.pollNow());
      await page.click('#btn-send');
      await page.waitForFunction(()=>Object.values(__testDatabase.values.messages.test).some(message=>message.poll?.durationSeconds===183845));
      const saved=await page.evaluate(()=>Object.entries(__testDatabase.values.messages.test).find(([,message])=>message.poll?.durationSeconds===183845));
      assert.equal(saved[1].poll.durationSeconds,183845);
      assert.ok(saved[1].poll.endsAt>=sentAfter+183845000 && saved[1].poll.endsAt<=Date.now()+183845000);
      await page.evaluate(async key=>{await __testDatabase.ref(`messages/test/${key}`).remove();},saved[0]);
      await page.waitForFunction(()=>document.querySelectorAll('.message-poll').length===0);
      await page.evaluate(async () => {
        ChatApp.clearPendingPoll();
        const stamp = Date.now();
        await __testDatabase.ref('messages/test/event').set({ t: 'system', createdAt: stamp, system: { type: 'member_joined', userCode: 'TEST-USER', displayName: 'Tester' } });
        await __testDatabase.ref('messages/test/poll').set({ userCode: 'TEST-USER', displayName: 'Tester', createdAt: stamp + 1,
          poll: { question: 'Which time works?', endsAt: stamp + 3600000, options: [{ id: 'a', text: 'Morning' }, { id: 'b', text: 'Evening' }],
            votes: { 'TEST-USER': { options: ['a'], displayName: 'Tester' } } } });
      });
      await page.locator('.system-message-name').waitFor();
      await page.locator('.system-message-name').click();
      assert.equal(await page.evaluate(() => ChatApp.userProfileOpen), false, 'Event names do not open profiles');
      assert.equal(await page.locator('.system-message-name').evaluate(el => el.tagName), 'SPAN');
      await page.locator('.system-message-avatar').click();
      assert.equal(await page.evaluate(() => ChatApp.userProfileOpen), true, 'Event pictures still open profiles');
      await page.evaluate(() => ChatApp.closeUserProfile(true));
      await page.locator('.bubble-name').last().click();
      assert.equal(await page.evaluate(() => ChatApp.userProfileOpen), false, 'Message names do not open profiles');
      await page.locator('.poll-view-votes').click();
      await page.locator('.poll-voter').waitFor();
      const geometry = await page.evaluate(async () => {
        const menu = document.querySelector('#poll-popover');
        const frames = [];
        for (let i = 0; i < 12; i++) {
          const r = menu.getBoundingClientRect();
          frames.push({ x: r.x, y: r.y, w: r.width, h: r.height });
          await new Promise(requestAnimationFrame);
        }
        const a = document.querySelector('.poll-view-votes').getBoundingClientRect();
        return { frames, anchor: { x: a.x, y: a.y, right: a.right, bottom: a.bottom }, transform: getComputedStyle(menu).transform };
      });
      const first = geometry.frames[0];
      for (const frame of geometry.frames) assert.deepEqual(frame, first, 'Voters menu does not jump or scale during opening');
      assert.ok(first.x >= 0 && first.y >= 0 && first.x + first.w <= viewport.width + 1 && first.y + first.h <= viewport.height + 1);
      assert.ok(Math.abs(first.y - geometry.anchor.bottom - 8) <= 1 || Math.abs(first.y + first.h - geometry.anchor.y + 8) <= 1, 'Voters menu stays beside vote-count trigger');
      assert.equal(geometry.transform, 'none');
      assert.equal(await page.locator('#modal').isVisible(), false, 'No modal is used');
      await page.locator('.poll-voter .poll-user-name').click();
      assert.equal(await page.evaluate(() => ChatApp.userProfileOpen), false, 'Voter names do not open profiles');
      await page.screenshot({ path: path.join(captures, `${viewport.width}-voters.png`) });
      await page.locator('.poll-voter .poll-user-avatar').click();
      assert.equal(await page.evaluate(() => ChatApp.userProfileOpen), true, 'Voter pictures still open profiles');
      await page.evaluate(async () => {
        ChatApp.closeUserProfile(true); ChatApp.closePollPopover({ immediate: true });
        const votes = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`VOTER-${i}`, { options: ['a'], displayName: `Voter ${i}` }]));
        await __testDatabase.ref('messages/test/poll/poll/votes').set(votes);
      });
      await page.locator('.poll-view-votes').filter({ hasText: '35 votes' }).click();
      await page.locator('.poll-voter').last().scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.poll-voter').count(), 35);
      const scrollBefore = await page.locator('#poll-popover').evaluate(menu => { window.__pollVoterNode=menu.querySelectorAll('.poll-voter')[20]; return menu.scrollTop; });
      assert.ok(scrollBefore > 0);
      await page.waitForTimeout(1250);
      assert.equal(await page.locator('#poll-popover').evaluate(menu => menu.scrollTop), scrollBefore, 'clock ticks and popup measurements do not reset scroll');
      await page.evaluate(async () => { await __testDatabase.ref('messages/test/poll/poll/votes/VOTER-new').set({options:['b'],displayName:'New Voter'}); });
      await page.waitForFunction(() => document.querySelectorAll('#poll-popover .poll-voter').length===36);
      assert.equal(await page.evaluate(() => window.__pollVoterNode.isConnected), true, 'live vote changes retain unchanged voter nodes');
      assert.equal(await page.locator('#poll-popover').evaluate(menu => menu.scrollTop), scrollBefore, 'live vote updates retain scroll');
      const longMenu = await page.locator('#poll-popover').evaluate(menu => {
        const r = menu.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrollable: menu.scrollHeight > menu.clientHeight };
      });
      assert.ok(longMenu.scrollable && longMenu.top >= 0 && longMenu.bottom <= viewport.height + 1 && longMenu.left >= 0 && longMenu.right <= viewport.width + 1, 'Long voter lists scroll within the viewport');
      await page.screenshot({ path: path.join(captures, `${viewport.width}-long-voters.png`) });
      await page.keyboard.press('Escape');
      await page.locator('#poll-popover').waitFor({ state: 'hidden' });
      await page.evaluate(async () => { await __testDatabase.ref('messages/test/poll/poll/votes').set({}); });
      await page.locator('.poll-view-votes').filter({ hasText: '0 votes' }).click();
      assert.equal(await page.locator('.poll-voters').getByText('No votes yet.').isVisible(), true);
      await page.evaluate(()=>{ChatApp.closePollPopover({immediate:true});ChatApp.openPollComposer();});
      await page.fill('#poll-question','Quick poll');
      await page.locator('#poll-editor-answers input').nth(0).fill('Yes');
      await page.locator('#poll-editor-answers input').nth(1).fill('No');
      await page.fill('#poll-duration-days','0');await page.fill('#poll-duration-seconds','2');
      await page.click('#poll-attach');await page.click('#btn-send');
      await page.waitForFunction(()=>Object.values(__testDatabase.values.messages.test).some(message=>message.poll?.question==='Quick poll'&&message.poll.endedAt));
      const short=await page.evaluate(()=>Object.values(__testDatabase.values.messages.test).find(message=>message.poll?.question==='Quick poll').poll);
      assert.equal(short.durationSeconds,2);assert.equal(short.endedAt,short.endsAt);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: durations, dismissal, draft, profile targets, voter placement and animation`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
