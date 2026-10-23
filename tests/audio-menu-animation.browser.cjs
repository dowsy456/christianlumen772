/* Audio popovers must share the existing context menus' animation and lifetime. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const installFirebaseMock = require('./firebase-mock.js');

(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.addInitScript(installFirebaseMock);
    await context.addInitScript(() => {
      navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk Microphone' },
        { kind: 'audiooutput', deviceId: 'headphones', label: 'Headphones' }
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
    const reference = await page.evaluate(async () => {
      await ChatApp.openRoom('test', { quiet: true });
      ChatApp.currentCallRoomId = 'test';
      ChatApp.callSessionId = 'audio-menu-animation-test';
      ChatApp.callMembersCache = [
        { code: 'TEST-USER', connected: true, joinedAt: Date.now() },
        { code: 'ALICE', username: 'Alice', connected: true, joinedAt: Date.now() }
      ];
      ChatApp.closeToast();
      ChatApp.syncCallControlsUI();
      ChatApp.openCallMenu();
      window.__animationStyle = menu => {
        const style = getComputedStyle(menu);
        return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction, fill: style.animationFillMode };
      };
      ChatApp.openCallUserContextMenu('ALICE', 300, 200);
      const menu = ChatApp.callUserContextMenuEl;
      const open = __animationStyle(menu);
      ChatApp.closeCallUserContextMenu();
      const close = __animationStyle(menu);
      ChatApp.closeCallUserContextMenu(true);
      return { open, close };
    });
    assert.equal(reference.open.name, 'msgMenuIn');
    assert.equal(reference.close.name, 'msgMenuOut');
    assert.equal(reference.open.duration, '0.14s');

    for (const kind of ['input', 'output']) {
      for (const dismissal of ['escape', 'outside', 'toggle']) {
        const opening = await page.evaluate(kind => {
          ChatApp.openCallAudioSettings(kind, document.getElementById(`btn-call-${kind}-settings`));
          return __animationStyle(document.getElementById(`call-${kind}-settings-menu`));
        }, kind);
        assert.deepEqual(opening, reference.open, `${kind} opening matches the existing user context menu`);
        await page.waitForTimeout(180);
        const closing = await page.evaluate(({ kind, dismissal }) => {
          const menu = document.getElementById(`call-${kind}-settings-menu`);
          if (dismissal === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          if (dismissal === 'outside') document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          if (dismissal === 'toggle') document.getElementById(`btn-call-${kind}-settings`).click();
          return { animation: __animationStyle(menu), hidden: menu.hidden, closing: menu.classList.contains('closing'), open: menu.classList.contains('open') };
        }, { kind, dismissal });
        assert.deepEqual(closing, { animation: reference.close, hidden: false, closing: true, open: false }, `${kind} ${dismissal} keeps the menu visible while closing`);
        await page.locator(`#call-${kind}-settings-menu`).waitFor({ state: 'hidden' });
      }
    }

    await page.evaluate(() => {
      ChatApp.openCallAudioSettings('input', document.getElementById('btn-call-input-settings'));
      ChatApp.closeCallAudioSettings();
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => ChatApp.openCallAudioSettings('input', document.getElementById('btn-call-input-settings')));
    await page.waitForTimeout(230);
    assert.equal(await page.locator('#call-input-settings-menu').isVisible(), true, 'Old close events and timers cannot hide a rapidly reopened menu');

    const childCleanup = await page.evaluate(() => {
      const select = document.getElementById('call-input-device');
      const state = ChatApp.customSelectState.get(select);
      ChatApp.openCustomSelect(state);
      const wasOpen = state.portalOpen;
      ChatApp.closeCallAudioSettings();
      // Child animation events must not prematurely complete the parent fade.
      select.dispatchEvent(new AnimationEvent('animationend', { animationName: 'msgMenuOut', bubbles: true }));
      return { wasOpen, childHidden: state.pop.hidden, portalOpen: state.portalOpen, parentHidden: document.getElementById('call-input-settings-menu').hidden };
    });
    assert.deepEqual(childCleanup, { wasOpen: true, childHidden: true, portalOpen: false, parentHidden: false }, 'Closing removes the child device portal and ignores bubbled animation completion');
    await page.locator('#call-input-settings-menu').waitFor({ state: 'hidden' });

    const switched = await page.evaluate(() => {
      ChatApp.openCallAudioSettings('input', document.getElementById('btn-call-input-settings'));
      ChatApp.openCallAudioSettings('output', document.getElementById('btn-call-output-settings'));
      const inputHidden = document.getElementById('call-input-settings-menu').hidden;
      const outputOpen = !document.getElementById('call-output-settings-menu').hidden;
      ChatApp.closeCallAudioSettings({ immediate: true });
      return { inputHidden, outputOpen, immediateHidden: document.getElementById('call-output-settings-menu').hidden };
    });
    assert.deepEqual(switched, { inputHidden: true, outputOpen: true, immediateHidden: true }, 'Switching and lifecycle cleanup dismiss stale menus immediately');

    await page.evaluate(() => ChatApp.closeCallMenu(true));
    await page.click('#btn-sidebar-call-input-settings');
    const sidebarOpening = await page.locator('#call-input-settings-menu').evaluate(menu => __animationStyle(menu));
    assert.deepEqual(sidebarOpening, reference.open, 'Sidebar uses the same opening animation');
    await page.evaluate(() => ChatApp.closeCallAudioSettings({ immediate: true }));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ sharedAnimationNamesDurationAndEasing: true, escapeOutsideAndToggleAnimate: true, rapidReopen: true, childPortalCleanup: true, switchingAndImmediateClose: true, sidebar: true, errors: 0 }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
