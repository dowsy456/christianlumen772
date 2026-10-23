'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./room-loading-fixture.cjs');
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const desktop of [true, false]) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await context.addInitScript(installFirebaseMock, { count: 0, latencyMs: 5 });
      await context.addInitScript(desktop => {
        if (desktop) window.chatDesktopOverlay = { version: 1, publish() {} };
        window.__notices = [];
        window.Notification = class {
          static permission = 'granted';
          constructor(title, options) { window.__notices.push({ title, options }); }
        };
        if (desktop) {
          window.__popups = [];
          window.__nativeFocused = true;
          window.__nativeVisibilityListeners = [];
          window.__setNativeFocus = focused => {
            __nativeFocused = focused;
            for (const callback of __nativeVisibilityListeners) callback({ focused });
            if (focused) __popups = __popups.filter(popup => popup.roomId !== window.__notificationPolicy?.activeRoomId);
          };
          window.chatDesktopRings = {
            version: 2, publish() {}, onCommand() {},
            getVisibility: async () => ({ focused: __nativeFocused }),
            onVisibility: callback => { __nativeVisibilityListeners.push(callback); }
          };
          window.chatDesktopNotifications = {
            version: 2, setUnreadCount() {},
            setPolicy(policy) {
              window.__notificationPolicy = policy;
              if (__nativeFocused) __popups = __popups.filter(popup => popup.roomId !== policy.activeRoomId);
            },
            showPing(popup) {
              if (__nativeFocused && popup.roomId === window.__notificationPolicy?.activeRoomId) return;
              __popups.push(popup); __notices.push({ title: popup.roomName, options: popup });
            },
            onPingCommand(callback) { window.__pingCommand = callback; }
          };
          window.__clickPopup = id => {
            const popup = __popups.find(item => item.id === id);
            if (!popup) throw new Error(`Missing popup ${id}`);
            __popups = __popups.filter(item => item.id !== id);
            __setNativeFocus(true);
            __pingCommand({ id, roomId: popup.roomId, messageKey: popup.messageKey });
          };
        }
      }, desktop);
      await context.route(/^https?:\/\//, route => route.fulfill({ status:200, contentType:'application/json', headers:{'access-control-allow-origin':'*'}, body:'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.evaluate(() => { window.__testDatabase = window.__roomLoadFixture; });
      await page.click('#btn-go-login'); await page.fill('#login-code','TEST-USER'); await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER' && ChatApp.membershipMap.has('test'));
      await page.evaluate(async () => {
        window.__sounds = [];
        ChatApp.playNotificationSound = name => { if (!ChatApp.isDoNotDisturb()) __sounds.push(name); };
        ChatApp.pushNotifsEnabled = true;
        await ChatApp.db.ref('rooms/other').set({ name:'Other room', createdBy:'TEST-USER' });
        await ChatApp.db.ref('messages/other/history').set({ userCode:'PEER',username:'Friend',text:'old',createdAt:1 });
        await ChatApp.db.ref('memberships/TEST-USER/other').set(true);
      });
      await page.waitForFunction(() => ChatApp.membershipMap.has('other'));
      await page.waitForTimeout(50);
      assert.deepEqual(await page.evaluate(() => __sounds), []);
      await page.evaluate(async () => {
        await ChatApp.db.ref('messages/test/one').set({ userCode:'PEER',username:'Friend',text:'hi',createdAt:Date.now() });
        await ChatApp.db.ref('messages/other/two').set({ userCode:'PEER',username:'Friend',text:'@Tester hi',createdAt:Date.now() });
        await ChatApp.db.ref('pings/TEST-USER/other/ping').set({ from:'PEER',fromUsername:'Friend',msgKey:'two',at:Date.now() });
      });
      await page.waitForFunction(() => __sounds.length === 2 && __notices.length === 1);
      assert.deepEqual(await page.evaluate(() => __sounds), ['Message','Ping']);
      await page.locator('.me-pill-dock').click();
      const avatar = page.locator('#user-profile-card .user-profile-avatar');
      await avatar.waitFor({ state:'visible' });
      await avatar.click();
      if (desktop) {
        const menu = page.locator('#profile-status-menu');
        await menu.waitFor({ state:'visible' });
        await page.waitForTimeout(180); await page.screenshot({ path: path.resolve(__dirname, '../../status-menu.png') });
        assert.equal(await menu.locator('button').count(), 2);
        await menu.getByRole('menuitemradio', { name:'Do Not Disturb' }).click();
        await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/notificationStatus') === 'dnd');
        assert.equal(await page.locator('.user-profile-presence').innerText(), 'Do Not Disturb');
        assert.equal(await page.locator('.user-profile-presence').evaluate(el => getComputedStyle(el,'::before').backgroundColor), 'rgb(239, 91, 102)');
        await page.evaluate(() => { ChatApp.myRoomIdle = true; ChatApp.lastAppInputAt = 0; ChatApp.syncAppIdle(); ChatApp.refreshOpenUserProfilePresence(); });
        assert.equal(await page.locator('.user-profile-presence').innerText(), 'Do Not Disturb');
      } else {
        assert.equal(await page.locator('#profile-status-menu').count(), 0, 'web has no status menu');
        await page.evaluate(() => ChatApp.db.ref('users/TEST-USER/notificationStatus').set('dnd'));
        await page.waitForFunction(() => ChatApp.isDoNotDisturb());
      }
      await page.evaluate(async () => {
        await ChatApp.db.ref('messages/other/three').set({ userCode:'PEER',username:'Friend',text:'@Tester DND',createdAt:Date.now() });
        await ChatApp.db.ref('messages/other/four').set({ userCode:'PEER',username:'Friend',text:'silent regular',createdAt:Date.now() });
      });
      await page.waitForFunction(() => __notices.length === 2);
      assert.equal(await page.evaluate(() => __sounds.length), 2, 'DND sounds remain silent in web and desktop');
      assert.ok(await page.evaluate(() => __notices.every(notice => notice.options.silent)));
      if (desktop) {
        await avatar.click();
        await page.getByRole('menuitemradio', { name:'Online', exact:true }).click();
        await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/notificationStatus') === 'online');
        assert.equal(await page.locator('.user-profile-presence').innerText(), 'Online');
        await page.evaluate(async () => {
          await ChatApp.db.ref('rooms/third').set({ name:'Third room', createdBy:'TEST-USER' });
          await ChatApp.db.ref('memberships/TEST-USER/third').set(true);
          const history = { '000-old-target': { userCode:'PEER', username:'Friend', text:'Old mention jump target', createdAt:1 } };
          for (let index = 0; index < 80; index++) history[`history-${String(index).padStart(3,'0')}`] = { userCode:'PEER', username:'Friend', text:`History ${index}`, createdAt:index + 2 };
          await ChatApp.db.ref('messages/test').update(history);
          await ChatApp.openRoom('test');
          __setNativeFocus(true);
        });
        await page.waitForFunction(() => ChatApp.membershipMap.has('third') && !ChatApp.msgInitialTailPending && !ChatApp.bulkLoading);
        assert.equal(await page.evaluate(() => ChatApp.desktopPresenceFocused), true, 'version 2 native visibility reaches the shared app focus state');
        assert.equal(await page.evaluate(() => ChatApp.msgElByKey.has('000-old-target')), false, 'jump target starts outside the initial message tail');
        await page.evaluate(() => {
          __popups = []; __notices = [];
          const ping = (roomId, messageKey) => ChatApp.showDesktopPingNotification({ roomId, messageKey, fromUsername:'Friend', message:{ text:'@Tester focused-room regression' } });
          ping('test','viewed-now'); ping('other','other-one'); ping('third','third-one'); ping('other','other-two');
        });
        assert.deepEqual(await page.evaluate(() => __popups.map(popup => popup.id)), ['other/other-one','third/third-one','other/other-two']);
        await page.evaluate(() => ChatApp.openRoom('other'));
        await page.waitForFunction(() => !ChatApp.msgInitialTailPending && !ChatApp.bulkLoading);
        assert.deepEqual(await page.evaluate(() => __popups.map(popup => popup.id)), ['third/third-one'], 'navigation closes every ping for that room while preserving other rooms');
        await page.evaluate(() => {
          __setNativeFocus(false);
          ChatApp.showDesktopPingNotification({ roomId:'other', messageKey:'background-current', fromUsername:'Friend', message:{ text:'@Tester background room' } });
          ChatApp.showDesktopPingNotification({ roomId:'test', messageKey:'000-old-target', fromUsername:'Friend', message:{ text:'@Tester background other room' } });
        });
        assert.deepEqual(await page.evaluate(() => __popups.map(popup => popup.id)), ['third/third-one','other/background-current','test/000-old-target']);
        await page.evaluate(() => __setNativeFocus(true));
        assert.deepEqual(await page.evaluate(() => __popups.map(popup => popup.id)), ['third/third-one','test/000-old-target'], 'foregrounding dismisses the selected room only');
        await page.evaluate(() => {
          window.__roomOpens = []; window.__jumpFinished = []; window.__flashedMessages = [];
          const openRoom = ChatApp.openRoom, jump = ChatApp.jumpToRoomMessage, flash = ChatApp.flashMessage;
          ChatApp.openRoom = function (roomId, ...args) { __roomOpens.push(roomId); return openRoom.call(this, roomId, ...args); };
          ChatApp.jumpToRoomMessage = async function (key, options) { await jump.call(this, key, options); __jumpFinished.push(key); };
          ChatApp.flashMessage = function (row) { __flashedMessages.push(row.dataset.msgkey); return flash.call(this, row); };
          __clickPopup('test/000-old-target');
        });
        await page.waitForFunction(() => __jumpFinished.includes('000-old-target') && __flashedMessages.includes('000-old-target'));
        assert.equal(await page.evaluate(() => ChatApp.currentRoomId), 'test');
        assert.deepEqual(await page.evaluate(() => __roomOpens), ['test']);
        assert.deepEqual(await page.evaluate(() => __flashedMessages), ['000-old-target'], 'popup clicks load older history and use the same painted message jump as filters and pins');
        await page.evaluate(() => {
          __setNativeFocus(false);
          // This represents a second queued native click that arrives after the
          // first popup has already opened the target room.
          __pingCommand({ id:'test/already-open', roomId:'test', messageKey:'000-old-target' });
        });
        await page.waitForFunction(() => __jumpFinished.length === 2 && __flashedMessages.length === 2);
        assert.deepEqual(await page.evaluate(() => __roomOpens), ['test'], 'already-open rooms retain their subscriptions');
        assert.deepEqual(await page.evaluate(() => __flashedMessages), ['000-old-target','000-old-target']);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Notifications/status browser: joined-room sound routing, ping deduplication, desktop status menu, Firebase sync, idle persistence, web DND, native v2 focus, selective room dismissal and shared popup message jumps passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
