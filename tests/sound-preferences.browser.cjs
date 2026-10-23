'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const desktop of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await context.addInitScript(installFirebaseMock);
      await context.addInitScript(desktop => { if (desktop) { window.chatDesktopNotifications = { setUnreadCount() {} }; window.chatDesktopPreferences = { version:1, setBackgroundRunning(value) { window.__backgroundRunning = value; } }; } }, desktop);
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);
      await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login'); await page.fill('#login-code', 'TEST-USER'); await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      await page.evaluate(() => ChatApp.closeToast());
      await page.click('#btn-side-settings'); await page.click('#settings-tab-preferences');
      assert.equal(await page.locator('#settings-background-running').count(), desktop ? 1 : 0, 'background control is desktop-only');
      if (desktop) {
        assert.equal(await page.locator('#settings-background-running').isChecked(), true);
        await page.locator('label:has(#settings-background-running)').click();
        await page.waitForFunction(() => __testDatabase.values.users['TEST-USER'].settings?.backgroundRunning === false);
        assert.equal(await page.evaluate(() => window.__backgroundRunning), false);
        await page.locator('label:has(#settings-background-running)').click();
        await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/settings/backgroundRunning') === null && ChatApp.normalizeSettings(__testDatabase.values.users['TEST-USER'].settings).backgroundRunning === true);
      }
      assert.equal(await page.locator('#settings-sound-effects-details').textContent(), 'Show All Sounds');
      await page.click('#settings-sound-effects-details');
      assert.equal(await page.locator('#settings-sound-effects-details').textContent(), 'Hide All Sounds');
      assert.equal(await page.locator('[data-sound-upload]').count(), 10);
      assert.equal(await page.locator('[data-settings-kind="sound-effects"]').textContent().then(text => text.includes('Saved to your account')), false);
      assert.equal(await page.locator('[data-sound-card="stopwatching"] .settings-toggle-title').textContent(), 'Stop Watching Screen');
      const toggle = key => page.locator(`label:has(#settings-sound-${key})`).click();
      await toggle('effects');
      assert.equal(await page.locator('[data-sound-effect]:checked').count(), 0);
      await toggle('message');
      assert.equal(await page.locator('#settings-sound-effects').isChecked(), true);
      assert.equal(await page.locator('[data-sound-effect]:checked').count(), 1);
      await toggle('message');
      assert.equal(await page.locator('#settings-sound-effects').isChecked(), false);
      await toggle('effects');
      assert.equal(await page.locator('[data-sound-effect]:checked').count(), 10);
      for (const input of await page.locator('[data-sound-effect]').all()) await input.evaluate(element => { element.checked = false; element.dispatchEvent(new Event('change', { bubbles: true })); });
      assert.equal(await page.locator('#settings-sound-effects').isChecked(), false);
      await toggle('effects');

      const audio = fs.readFileSync(path.resolve(__dirname, '../assets/sounds/Message.mp3'));
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'My Message.mp3', mimeType: 'audio/mpeg', buffer: audio });
      await page.waitForFunction(() => __testDatabase.get('users/TEST-USER/settings/customSoundEffects/message')?.name === 'My Message.mp3');
      assert.equal(await page.locator('[data-sound-choose="message"]').textContent(), 'Change Audio');
      assert.equal(await page.locator('[data-sound-filename="message"]').textContent(), 'My Message.mp3');
      assert.equal(await page.evaluate(async () => {
        const oldSet = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('storage blocked'); };
        try { const settings = await ChatApp.loadSettingsForUser('TEST-USER'); ChatApp.applyResolvedSettings(settings); return settings.customSoundEffects.message.name; }
        finally { Storage.prototype.setItem = oldSet; }
      }), 'My Message.mp3', 'custom sounds restore from Firebase without local storage');
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'document.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
      await page.waitForFunction(() => document.querySelector('[data-sound-status="message"]').textContent === 'Choose an audio file.');
      assert.equal(await page.evaluate(() => ChatApp.currentSettings.customSoundEffects.message.name), 'My Message.mp3', 'invalid replacements preserve the current sound');
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'bad.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not valid mp3 data') });
      await page.waitForFunction(() => document.querySelector('[data-sound-status="message"]').textContent.includes('cannot be played'));
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'Replacement.mp3', mimeType: 'audio/mpeg', buffer: audio });
      await page.waitForFunction(() => ChatApp.currentSettings.customSoundEffects.message?.name === 'Replacement.mp3');
      await page.evaluate(() => {
        const read = ChatApp.readCustomSoundEffect;
        window.__normalAudioRead = read;
        ChatApp.readCustomSoundEffect = async file => {
          const record = await read(file);
          if (file.name === 'Old Slow Upload.mp3') await new Promise(resolve => { window.__finishClosedUpload = resolve; });
          return record;
        };
      });
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'Old Slow Upload.mp3', mimeType: 'audio/mpeg', buffer: audio });
      await page.waitForFunction(() => window.__finishClosedUpload);
      await page.evaluate(() => ChatApp.closeModal());
      await page.click('#btn-side-settings'); await page.click('#settings-tab-preferences'); await page.click('#settings-sound-effects-details');
      assert.equal(await page.locator('[data-sound-filename="message"]').textContent(), 'Replacement.mp3', 'saved custom sound restores when settings reopens');
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'Newest Upload.mp3', mimeType: 'audio/mpeg', buffer: audio });
      await page.waitForFunction(() => ChatApp.currentSettings.customSoundEffects.message?.name === 'Newest Upload.mp3');
      await page.evaluate(() => { window.__finishClosedUpload(); ChatApp.readCustomSoundEffect = window.__normalAudioRead; });
      await page.waitForFunction(() => ChatApp.customSoundSaves.size === 0);
      assert.equal(await page.locator('[data-sound-filename="message"]').textContent(), 'Newest Upload.mp3');
      assert.equal(await page.evaluate(() => __testDatabase.get('users/TEST-USER/settings/customSoundEffects/message/name')), 'Newest Upload.mp3', 'old modal upload cannot replace the newer choice');
      await page.locator('[data-sound-remove="message"]').click();
      await page.waitForFunction(() => !__testDatabase.get('users/TEST-USER/settings/customSoundEffects/message') && !ChatApp.currentSettings.customSoundEffects.message);
      assert.equal(await page.locator('[data-sound-filename="message"]').textContent(), 'Default Sound');
      assert.equal(await page.locator('[data-sound-remove="message"]').isVisible(), false);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[data-sound-card="message"]').scrollIntoViewIfNeeded();
      const geometry = await page.locator('[data-sound-card="message"]').evaluate(card => {
        const parent = card.getBoundingClientRect();
        return [...card.querySelectorAll('button,label')].filter(element => !element.hidden).every(element => { const rect = element.getBoundingClientRect(); return rect.left >= parent.left - 1 && rect.right <= parent.right + 1; });
      });
      assert.equal(geometry, true, 'sound controls fit a phone viewport');
      fs.mkdirSync(path.resolve(__dirname, '../../test-results/sound-preferences'), { recursive: true });
      await page.screenshot({ path: path.resolve(__dirname, `../../test-results/sound-preferences/${desktop ? 'desktop' : 'web'}-mobile.png`) });
      // Pending settings/uploads continue to use the stable account ID while
      // the independent password alias changes.
      await page.evaluate(() => {
        const originalRef = ChatApp.db.ref.bind(ChatApp.db);
        let delayed = false;
        ChatApp.db.ref = path => {
          const ref = originalRef(path);
          if (path === 'users/TEST-USER/settings' && !delayed) {
            delayed = true;
            const update = ref.update.bind(ref);
            ref.update = value => new Promise(resolve => { window.__finishOldSettings = () => update(value).then(resolve); });
          }
          return ref;
        };
        ChatApp.updateSettingsState({ soundEffects: { ping: false } }, { queueRemote: false });
        window.__oldSettingsSave = ChatApp.flushCurrentSettingsSave('TEST-USER');
        const originalRead = ChatApp.readCustomSoundEffect;
        ChatApp.readCustomSoundEffect = async file => {
          const sound = await originalRead(file);
          await new Promise(resolve => { window.__finishSoundRead = resolve; });
          return sound;
        };
      });
      await page.locator('#settings-sound-upload-message').setInputFiles({ name: 'Survives Password.mp3', mimeType: 'audio/mpeg', buffer: audio });
      await page.waitForFunction(() => ChatApp.customSoundSaves?.size === 1 && window.__finishSoundRead);
      await page.waitForFunction(() => window.__finishOldSettings);
      assert.equal(await page.evaluate(() => ChatApp.changePassword('SOUND-PASSWORD')), 'SOUND-PASSWORD');
      assert.equal(await page.evaluate(() => ChatApp.currentUser.code), 'TEST-USER');
      await page.evaluate(() => window.__finishSoundRead());
      await page.evaluate(() => window.__finishOldSettings());
      await page.waitForFunction(() => ChatApp.customSoundSaves.size === 0 && !ChatApp.settingsSaveInFlight && !ChatApp.settingsSaveTimer);
      const saved = await page.evaluate(async () => ({ moved: __testDatabase.get('users/SOUND-PASSWORD'), name: __testDatabase.get('users/TEST-USER/settings/customSoundEffects/message/name'), ping: __testDatabase.get('users/TEST-USER/settings/soundEffects/ping'), oldLogin: await ChatApp.loginWithCode('TEST-USER'), newCode: (await ChatApp.loginWithCode('SOUND-PASSWORD'))?.code }));
      assert.deepEqual(saved, { moved: null, name: 'Survives Password.mp3', ping: false, oldLogin: null, newCode: 'TEST-USER' });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Sound settings passed on web and desktop: master/individual states, ten custom uploads, real MP3 validation, Firebase reload without local storage, replace/remove, phone layout, and stable password changes with simultaneous settings writes/uploads.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
