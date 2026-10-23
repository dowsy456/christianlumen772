'use strict';
// Playwright's Electron driver attaches to the main-process inspector. Shipping
// binaries intentionally disable that entry point; never weaken their fuses to
// make this development-only integration test work.
if (process.env.CHAT_APP_TEST_EXECUTABLE || process.env.CHAT_APP_TEST_EXE) {
  throw new Error('Packaged Chat App must use an ordinary launch smoke check with an isolated offline profile and desktop.log; this inspector-based integration test only supports the development Electron runtime.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
(async () => {
  const qaRoot = path.resolve(__dirname, '../../../release-native-qa');
  await fs.mkdir(qaRoot, { recursive:true });
  const profile = await fs.mkdtemp(path.join(qaRoot, 'profile-'));
  const env = { ...process.env, CHAT_APP_TEST_PROFILE:profile, CHAT_APP_OFFLINE:'1' }; delete env.ELECTRON_RUN_AS_NODE;
  let application;
  try {
    application = await electron.launch({ executablePath: require('../node_modules/electron'), args: [path.resolve(__dirname, '..')], env });
    // Isolated offline QA grants the application's media permission prompt.
    // No microphone/camera is opened; the selected screen stream is stopped below.
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response:0 }); });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      ready = await application.evaluate(async ({ webContents }) => {
        globalThis.__appContents = webContents.getAllWebContents().find(wc => wc.getURL().startsWith('chatapp://app/'));
        return __appContents && await __appContents.executeJavaScript('document.documentElement.dataset.appReady === "true"');
      });
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'real native application loads bundled shared source');
    const snapshot = await application.evaluate(async ({ app, BrowserWindow }) => {
      globalThis.__main = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Chat App');
      globalThis.__badges = [];
      const original = __main.setOverlayIcon.bind(__main);
      __main.setOverlayIcon = (icon, description) => { __badges.push({ description, size:icon?.getSize() || null }); return original(icon, description); };
      const source = await __appContents.executeJavaScript(`({version: ChatRuntime.version, bridgeVersion:chatDesktopBuild.nativeVersion, bridgeFrozen:Object.isFrozen(chatDesktopBuild), notifications:!!window.chatDesktopNotifications, spotify:!!window.chatDesktopSpotify, clipboard:!!window.chatDesktopClipboard, maxFiles:ChatApp.CHAT_FILE_MAX_COUNT, effects:Object.keys(ChatApp.soundEffectCatalog)})`);
      return { nativeVersion:app.getVersion(), ...source };
    });
    assert.equal(snapshot.nativeVersion, require('../package.json').version);
    assert.equal(snapshot.bridgeVersion, snapshot.nativeVersion, 'shared web UI reads the installed native build version');
    assert.equal(snapshot.bridgeFrozen, true, 'a web release cannot rewrite the installed build identity');
    assert.equal(snapshot.version, require('../../build-info.json').assetRevision);
    assert.equal(snapshot.notifications && snapshot.spotify && snapshot.clipboard, true);
    assert.equal(snapshot.maxFiles, 12); assert.equal(snapshot.effects.length, 10);
    const background = await application.evaluate(async () => {
      const before = __appContents.id;
      const initial = await __appContents.executeJavaScript('chatDesktopPreferences.getState()');
      await __appContents.executeJavaScript(`(async () => {
        window.__backgroundAudio = new AudioContext();
        await __backgroundAudio.resume();
        window.__backgroundTrack = __backgroundAudio.createMediaStreamDestination().stream.getAudioTracks()[0];
      })()`, true);
      __main.close();
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = await __appContents.executeJavaScript('({audio:__backgroundAudio.state, track:__backgroundTrack.readyState})');
      const retained = !__main.isVisible() && !__appContents.isDestroyed() && __appContents.id === before;
      __main.show(); __main.focus();
      await __appContents.executeJavaScript('__backgroundTrack.stop(); __backgroundAudio.close(); chatDesktopPreferences.setBackgroundRunning(false)');
      await new Promise(resolve => setTimeout(resolve, 25));
      const disabled = await __appContents.executeJavaScript('chatDesktopPreferences.getState()');
      await __appContents.executeJavaScript('chatDesktopPreferences.setBackgroundRunning(true)');
      return {initial, retained, state, disabled};
    });
    assert.equal(background.initial.backgroundRunning, true);
    assert.equal(background.retained, true, 'Close hides the existing application document');
    assert.deepEqual(background.state, { audio:'running', track:'live' }, 'Background close leaves the audio context and media track alive');
    assert.equal(background.disabled.backgroundRunning, false);
    await application.evaluate(async () => { await __appContents.executeJavaScript('chatDesktopNotifications.setUnreadCount(3)'); });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await application.evaluate(() => __badges.at(-1)), { description:'3 unread messages', size:{width:32,height:32} });
    await application.evaluate(async () => { await __appContents.executeJavaScript('chatDesktopNotifications.setUnreadCount(0)'); });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await application.evaluate(() => __badges.at(-1).size), null);
    const spotifyBridge = await application.evaluate(async () => __appContents.executeJavaScript(`({version: chatDesktopSpotify.version, methods: ['getState', 'connect', 'disconnect', 'control', 'refresh', 'onChange'].every(name => typeof chatDesktopSpotify[name] === 'function')})`));
    assert.equal(spotifyBridge.version, 2, 'Native Spotify bridge supports shared playback controls');
    assert.equal(spotifyBridge.methods, true);
    const spotify = await application.evaluate(async () => __appContents.executeJavaScript('(async () => { await chatDesktopSpotify.refresh(); return chatDesktopSpotify.getState(); })()'));
    assert.equal(spotify.configured, true); assert.equal(spotify.connected, false);
    assert.equal('accessToken' in spotify, false);
    const nativeHelpers = await application.evaluate(async ({ app }) => {
      // Resolve from the running app, including app.asar in a packaged release.
      // Never fall back to this test checkout: that would hide packaging errors.
      const requireApp = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/main.cjs');
      const path = requireApp('node:path');
      const fs = requireApp('node:fs/promises');
      const nativeRoot = app.getAppPath().replace(/([\\/])app\.asar(?=[\\/]|$)/i, '$1app.asar.unpacked');
      const helper = path.join(nativeRoot, 'helpers', 'game-process-helper.exe');
      const bytes = await fs.readFile(helper);
      if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('Packaged native helper is not a Windows executable');
      const { createProcessScanner } = requireApp('./games.cjs');
      const scanner = createProcessScanner();
      let ticks = 0, guard;
      const ticker = setInterval(() => { ticks++; }, 10);
      let processShape = false, warmShape = false;
      try {
        const rows = await Promise.race([scanner.read(), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Native helper cold start exceeded 60 seconds')), 61000); })]);
        processShape = Array.isArray(rows) && rows.every(row => typeof row.name === 'string' && typeof row.path === 'string' && typeof row.commandLine === 'string');
        const warm = await scanner.read();
        warmShape = Array.isArray(warm);
      } finally { clearTimeout(guard); clearInterval(ticker); scanner.stop(); }
      const execute = requireApp('node:util').promisify(requireApp('node:child_process').execFile);
      // Exercise the STA mode only. Do not read file bytes, mutate the Windows
      // clipboard, or return its private paths to the test runner/log output.
      const clipboard = await execute(helper, ['--clipboard-files'], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const paths = JSON.parse(clipboard.stdout.trim() || '[]');
      return { packaged: app.isPackaged, unpackedPath: /app\.asar\.unpacked[\\/]helpers[\\/]/i.test(helper), processShape, warmShape, responsive: ticks > 0, clipboardModeValid: Array.isArray(paths) && paths.every(value => typeof value === 'string') };
    });
    assert.equal(nativeHelpers.processShape && nativeHelpers.warmShape && nativeHelpers.responsive, true, 'Actual helper scans run in a responsive worker, including when its module lives in app.asar');
    assert.equal(nativeHelpers.clipboardModeValid, true, 'The packaged fixed STA clipboard mode returns valid file-drop data');
    if (nativeHelpers.packaged) assert.equal(nativeHelpers.unpackedPath, true, 'Executable is launched from app.asar.unpacked');
    const capture = process.env.CHAT_APP_NATIVE_SKIP_CAPTURE === '1' ? null : await application.evaluate(async ({ BrowserWindow }) => {
      __main.restore(); __main.show(); __main.focus();
      const before = BrowserWindow.getAllWindows().length;
      const result = await __appContents.executeJavaScript(`(async () => {
        if (chatDesktopCapture.version !== 1) throw Error('Missing capture bridge');
        const invalid = await chatDesktopCapture.selectSource('screen:missing:invalid');
        const sources = await chatDesktopCapture.listSources({ fresh: true });
        const source = sources.find(item => item.id.startsWith('screen:'));
        if (!source) throw Error('No native monitor found');
        const selected = await chatDesktopCapture.selectSource(source.id);
        if (!selected) throw Error('Source selection rejected');
        const request = navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal:1280, max:1280 }, height: { ideal:720, max:720 }, frameRate: { ideal:30, max:30 } }, audio:false });
        const stream = await Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(Error('Native screen capture timed out')), 15000))]);
        const settings = stream.getVideoTracks()[0].getSettings();
        stream.getTracks().forEach(track => track.stop());
        return { invalid, sourceCount:sources.length, settings };
      })()`, true);
      return { ...result, before, after:BrowserWindow.getAllWindows().length };
    });
    if (capture) {
      assert.equal(capture.invalid, false, 'an arbitrary native source ID is rejected');
      assert.equal(capture.before, capture.after, 'in-app source selection creates no picker window');
      assert.ok(capture.settings.width <= 1280 && capture.settings.height <= 720);
      assert.ok(capture.settings.frameRate <= 30);
    }
    console.log('Development native integration passed: versions, shared web boot, 12 files, ten effects, real unread IPC/Windows overlay, Spotify v2 playback bridge and isolated offline profile.');
    console.log('Native helpers passed: packaged/source worker scanning, responsive cold startup, warm reuse, fixed STA clipboard mode; no process or clipboard contents logged.');
    console.log('Native background running passed: saved bridge state, same document on close, active audio context and live media track retained.');
    console.log(capture ? 'Native in-app capture passed: source enumeration, invalid ID rejection, selected monitor capture <=720p30, no secondary picker window, immediate track cleanup.' : 'Native screen capture was explicitly skipped for this run; foreground source selection needs an uninterrupted interactive desktop.');
  } finally {
    if (application) await application.close();
    assert.ok(path.resolve(profile).startsWith(qaRoot + path.sep));
    await fs.rm(profile, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
