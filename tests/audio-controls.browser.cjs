/* Call audio menu interaction/layout regression; media pipelines have separate tests. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 740, height: 390 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(installFirebaseMock);
      await context.addInitScript(() => {
        navigator.mediaDevices.enumerateDevices = async () => [
          { kind: 'audioinput', deviceId: 'mic-a', label: 'Desk microphone' },
          { kind: 'audioinput', deviceId: 'mic-b', label: 'Headset microphone' },
          { kind: 'audiooutput', deviceId: 'speaker-a', label: 'Headphones' }
        ];
      });
      await context.route(/^https?:\/\//, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
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
        await ChatApp.openRoom('test', { quiet: true });
        ChatApp.currentCallRoomId = 'test';
        ChatApp.callSessionId = 'audio-ui-test';
        ChatApp.closeToast();
        ChatApp.callMembersCache = [{ code: 'TEST-USER', connected: true, joinedAt: Date.now() }];
        ChatApp.callPreferredAudioInputId = 'mic-a';
        ChatApp.callPreferredAudioOutputId = '';
        let inputVolume = 100, outputVolume = 100;
        window.__audioActions = [];
        ChatApp.callGetInputVolumePercent = () => inputVolume;
        ChatApp.callGetOutputVolumePercent = () => outputVolume;
        ChatApp.callSetInputVolumePercent = value => { inputVolume = Math.max(0, Math.min(100, Number(value))); return inputVolume; };
        ChatApp.callSetOutputVolumePercent = value => { outputVolume = Math.max(0, Math.min(200, Number(value))); return outputVolume; };
        ChatApp.callSetInputDevice = async value => { __audioActions.push(['input', value]); ChatApp.callPreferredAudioInputId = value; return true; };
        ChatApp.callSetOutputDevice = async value => { __audioActions.push(['output', value]); ChatApp.callPreferredAudioOutputId = value; return true; };
        ChatApp.callRefreshMic = async () => { __audioActions.push(['refresh', ChatApp.callPreferredAudioInputId]); };
        ChatApp.syncCallControlsUI();
        ChatApp.openCallMenu();
        document.body.dataset.mobileNav = '0';
      });
      await page.waitForTimeout(250);

      for (const [kind, label] of [['input', 'Input'], ['output', 'Output']]) {
        for (const prefix of ['btn-call', 'btn-sidebar-call']) {
          const toggle = page.locator(`#${prefix}-${kind}-settings`);
          assert.equal(await toggle.getAttribute('data-tooltip'), `${label} Settings`);
          assert.equal(await toggle.getAttribute('aria-label'), `${label} Settings`);
        }
        const menu = page.locator(`#call-${kind}-settings-menu`);
        assert.equal(await menu.getAttribute('aria-label'), `${label} Settings`);
        assert.equal(await menu.locator('.msg-menu-user').count(), 0, 'settings menu has no heading');
        assert.equal(await menu.locator('.call-audio-settings-hint').count(), 0, 'settings menu has no volume helper text');
        assert.equal(await page.locator(`label[for="call-${kind}-device"]`).textContent(), `${label} Device`);
        assert.equal(await page.locator(`label[for="call-${kind}-volume"]`).textContent(), `${label} Volume`);
        assert.equal(await page.locator(`#call-${kind}-volume`).getAttribute('aria-describedby'), null, 'removed hints have no dangling accessibility references');
      }

      const boundsCheck = async id => {
        const box = await page.locator(id).boundingBox();
        const anchor = await page.locator('[data-call-audio-settings][aria-expanded="true"]').boundingBox();
        assert.ok(anchor && (box.x + box.width < anchor.x || box.x > anchor.x + anchor.width || box.y + box.height < anchor.y || box.y > anchor.y + anchor.height), `${id} avoids its trigger`);
        assert.ok(box && box.x >= 7 && box.y >= 7 && box.x + box.width <= viewport.width - 7 && box.y + box.height <= viewport.height - 7, `${id} stays within viewport: ${JSON.stringify(box)}`);
      };
      await page.click('#btn-call-input-settings');
      await page.waitForFunction(() => document.querySelector('#call-input-device').options.length === 3);
      assert.equal(await page.locator('#call-input-settings-menu').isVisible(), true);
      assert.equal(await page.locator('#call-input-device').inputValue(), 'mic-a');
      assert.equal(await page.locator('#call-input-volume').getAttribute('max'), '100');
      assert.equal(await page.locator('#call-input-settings-menu #btn-call-refreshmic').count(), 1);
      assert.equal(await page.locator('.call-menu-controls #btn-call-refreshmic').count(), 0);
      await boundsCheck('#call-input-settings-menu');
      await page.locator('#call-input-volume').fill('35');
      assert.equal(await page.locator('#call-input-volume-value').textContent(), '35%');
      await page.selectOption('#call-input-device', 'mic-b');
      await page.click('#btn-call-refreshmic');
      assert.deepEqual(await page.evaluate(() => __audioActions), [['input', 'mic-b'], ['refresh', 'mic-b']]);
      await page.keyboard.press('Escape');
      await page.locator('#call-input-settings-menu').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#call-input-settings-menu').isHidden(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-call-input-settings');
      assert.equal(await page.evaluate(() => ChatApp.callMenuOpen), true, 'Escape dismisses popover, retaining call panel');

      await page.click('#btn-call-output-settings');
      assert.equal(await page.locator('#call-output-volume').getAttribute('max'), '200');
      await page.locator('#call-output-volume').fill('175');
      assert.equal(await page.locator('#call-output-volume-value').textContent(), '175%');
      await page.selectOption('#call-output-device', 'speaker-a');
      assert.deepEqual(await page.evaluate(() => __audioActions.at(-1)), ['output', 'speaker-a']);
      await boundsCheck('#call-output-settings-menu');
      if (process.env.AUDIO_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.AUDIO_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AUDIO_SCREENSHOT_DIR, `call-audio-main-${viewport.width}.png`) });
      }
      await page.keyboard.press('Escape');
      await page.click('#btn-call-mute');
      assert.equal(await page.evaluate(() => ChatApp.callMuted), true, 'primary icon keeps mute action');
      assert.equal(await page.locator('#call-input-settings-menu').isHidden(), true);
      await page.click('#btn-call-deafen', { button: 'right' });
      assert.equal(await page.locator('#call-output-settings-menu').isVisible(), true, 'right click opens speaker settings');
      await page.keyboard.press('Escape');

      {
        await page.evaluate(() => {
          ChatApp.closeCallMenu();
          if (document.body.dataset.mobileUi === '1') document.body.dataset.mobileNav = '1';
        });
        await page.waitForTimeout(350);
        await page.click('#btn-sidebar-call-input-settings');
        assert.equal(await page.locator('#call-input-volume').inputValue(), '0', 'muted input shows effective silence in sidebar and main controls');
        assert.equal(await page.locator('#call-input-volume-value').textContent(), '0%');
        assert.equal(await page.evaluate(() => ChatApp.callGetInputVolumePercent()), 35, 'unmute retains the chosen input level');
        assert.equal(await page.locator('#call-input-device').inputValue(), 'mic-b');
        await boundsCheck('#call-input-settings-menu');
        if (process.env.AUDIO_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.AUDIO_SCREENSHOT_DIR, `call-audio-sidebar-${viewport.width}.png`) });
        await page.keyboard.press('Escape');
        await page.locator('#btn-sidebar-call-output-settings').focus();
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.locator('#call-output-settings-menu').isVisible(), true, 'keyboard opens popover');
        assert.equal(await page.locator('#call-output-volume').inputValue(), '175');
        await boundsCheck('#call-output-settings-menu');
        await page.mouse.click(viewport.width - 6, 6);
        await page.locator('#call-output-settings-menu').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#call-output-settings-menu').isHidden(), true, 'outside click dismisses');
      }
      // A very short viewport must scroll its menu without covering the trigger.
      await page.evaluate(() => { document.body.dataset.mobileNav = '0'; ChatApp.openCallMenu(); });
      await page.setViewportSize({ width: viewport.width, height: 230 });
      await page.waitForTimeout(200);
      await page.click('#btn-call-input-settings');
      const shortGeometry = await page.evaluate(() => {
        const menu = document.querySelector('#call-input-settings-menu').getBoundingClientRect();
        const anchor = document.querySelector('#btn-call-input-settings').getBoundingClientRect();
        return { fits: menu.top >= 0 && menu.bottom <= innerHeight && menu.left >= 0 && menu.right <= innerWidth,
          separate: menu.right < anchor.left || menu.left > anchor.right || menu.bottom < anchor.top || menu.top > anchor.bottom };
      });
      assert.equal(shortGeometry.fits && shortGeometry.separate, true, 'short viewport menu stays in bounds and avoids its trigger');
      await page.evaluate(() => { ChatApp.currentCallRoomId = null; ChatApp.syncCallControlsUI(); });
      assert.equal(await page.locator('#sidebar-call').isHidden(), true);
      assert.equal(await page.locator('#btn-call-input-settings').isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ viewport, audioMenus: true, sidebarControls: true, errors: 0 }));
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
