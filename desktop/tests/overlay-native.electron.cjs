'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { _electron: electron } = require('playwright');
const executablePath = require('../node_modules/electron');

(async () => {
  const testRoot = path.resolve(__dirname, '../../../native-overlay-qa');
  await fs.mkdir(testRoot, { recursive: true });
  const profile = await fs.mkdtemp(path.join(testRoot, 'profile-'));
  const env = { ...process.env, CHAT_APP_TEST_PROFILE: profile, CHAT_APP_OFFLINE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const until = async (read, description) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await delay(50);
    }
    throw new Error(`Timed out: ${description}`);
  };
  try {
    app = await electron.launch({ executablePath, args: [path.join(__dirname, 'fixtures/overlay-offline.cjs')], env });
    await until(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().some(contents => contents.getURL().startsWith('chatapp://app/'))), 'shared web app loads');
    await until(() => app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('chatapp://app/'));
      return contents.executeJavaScript('!!globalThis.chatDesktopOverlay && document.documentElement.dataset.appReady === "true"');
    }), 'shared web app initializes with the real desktop preload');

    await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      globalThis.__qaMain = windows.find(win => win.getTitle() === 'Chat App');
      globalThis.__qaOverlay = windows.find(win => win.getTitle() === 'Chat App Call Overlay');
      globalThis.__qaCalls = [];
      for (const name of ['hide', 'showInactive', 'setAlwaysOnTop', 'moveTop', 'setBounds']) {
        const original = __qaOverlay[name].bind(__qaOverlay);
        __qaOverlay[name] = (...args) => { __qaCalls.push(name); return original(...args); };
      }
      __qaMain.show();
      __qaMain.focus();
    });

    const snapshot = { active: true, enabled: true, roomId: 'native-fixture', sessionId: 'fixture-session', members: [
      { code: 'one', displayName: 'Native roster one', photoTransform: { x: 0, y: 0, scale: 1 }, speaking: true },
      { code: 'two', displayName: 'Native roster two', photoTransform: { x: 0, y: 0, scale: 1 } },
    ] };
    const publish = value => app.evaluate(async ({ webContents }, value) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('chatapp://app/'));
      await contents.executeJavaScript(`chatDesktopOverlay.publish(${JSON.stringify(value)})`);
    }, value);
    const visible = () => app.evaluate(() => __qaOverlay.isVisible());
    await publish(snapshot);
    await delay(400);
    assert.equal(await visible(), false, 'overlay stays hidden over foreground Chat App');

    await app.evaluate(() => __qaMain.minimize());
    await until(visible, 'overlay appears after minimizing');
    const bounds = await app.evaluate(({ screen }) => ({ overlay: __qaOverlay.getBounds(), workArea: screen.getDisplayMatching(__qaOverlay.getBounds()).workArea }));
    assert.ok(Math.abs(bounds.overlay.x - bounds.workArea.x) <= 1, 'native surface hugs usable screen edge');
    await app.evaluate(() => { __qaCalls.length = 0; });
    for (let i = 0; i < 18; i++) {
      snapshot.members[0].speaking = i % 2 === 0;
      await publish(snapshot);
      await delay(200);
      assert.equal(await visible(), true, 'visible through speaking changes and watchdog intervals');
    }
    assert.deepEqual(await app.evaluate(() => __qaCalls), [], 'stable desktop polling causes no native show, hide, style, z-order, or geometry churn');

    snapshot.members.push({ code: 'three', displayName: 'Third participant', photoTransform: { x: 0, y: 0, scale: 1 } });
    await publish(snapshot);
    await delay(200);
    assert.equal(await visible(), true, 'participant join retains native visibility');
    assert.equal(await app.evaluate(() => __qaCalls.includes('hide')), false);
    for (let i = 0; i < 3; i++) {
      await app.evaluate(() => { __qaMain.restore(); __qaMain.focus(); });
      await until(async () => !(await visible()), 'foreground Chat App hides roster');
      await app.evaluate(() => __qaMain.minimize());
      await until(visible, 'return to desktop restores roster');
    }
    await publish({ ...snapshot, enabled: false });
    await until(async () => !(await visible()), 'explicit disable hides roster');
    await publish(snapshot);
    await until(visible, 'explicit enable shows roster');
    await publish({ active: false });
    await until(async () => !(await visible()), 'leaving hides roster');
    console.log('Native Electron overlay PASS: real bridge, native visibility across 18 speaking updates/watchdog ticks, no compositor churn, edge placement, participant join, three foreground/minimize cycles, enable/disable/leave.');
  } finally {
    if (app) await app.close();
    assert.ok(path.resolve(profile).startsWith(testRoot + path.sep));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
