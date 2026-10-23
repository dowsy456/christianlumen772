// Reuse one browser HTTP cache across a deployment: edited UI assets must refresh.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const currentVersion = /loader\.js\?v=([^"']+)/.exec(html)[1];
const legacyVersion = '20260919-overlay-audio-2';
let deployed = false;
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  requests.push(url.pathname + url.search);
  const extension = path.extname(file);
  let data = fs.readFileSync(file);
  if (url.pathname === '/index.html') data = Buffer.from(deployed ? html : html.replaceAll(currentVersion, legacyVersion));
  const revision = url.searchParams.get('v') === currentVersion ? 'new' : 'old';
  if (url.pathname === '/call-modules/panel.js') data = Buffer.concat([Buffer.from(`window.__loadedCallUIRevision=${JSON.stringify(revision)};\n`), data]);
  if (url.pathname === '/css/call-panel-resize.css') data = Buffer.concat([data, Buffer.from(`\n:root { --loaded-call-css-revision: ${revision}; }\n`)]);
  res.writeHead(200, {
    'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
  });
  res.end(data);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(mock);
    // Do not use Playwright routing: it disables HTTP caching, masking this bug.
    await context.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = (url, options) => new URL(typeof url === 'string' ? url : url.url, location.href).origin === location.origin
        ? originalFetch(url, options) : Promise.resolve(new Response('null', { headers: { 'Content-Type': 'application/json' } }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const entry = `http://127.0.0.1:${server.address().port}/index.html`;
    await page.goto(entry);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    assert.equal(await page.evaluate(() => window.__loadedCallUIRevision), 'old');
    await page.goto('about:blank');
    const requestCount = requests.length;
    await page.goto(entry);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    assert.equal(requests.slice(requestCount).some(url => url.startsWith('/call-modules/panel.js?')), false, 'old JavaScript really was retained in HTTP cache');
    deployed = true;
    await page.goto('about:blank');
    await page.goto(entry);
    await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
    assert.equal(await page.evaluate(() => window.__loadedCallUIRevision), 'new', 'shared call UI refreshes on deployment');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--loaded-call-css-revision').trim()), 'new', 'shared call styles refresh with the UI');
    assert.equal(await page.evaluate(() => ChatRuntime.version), currentVersion);
    const revisions = await page.locator('script[src],link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(node => new URL(node.src || node.href).searchParams.get('v')));
    assert.ok(revisions.every(version => version === currentVersion), 'entry scripts, CSS, and dynamic feature scripts use one revision');
    assert.deepEqual(errors, []);
    console.log('Shared web UI upgrades through a retained browser cache without an EXE change: PASS');

    // The native gate is shared web code. Exercise legacy bridges, immutable
    // current native versions, pre-login startup, and an ordinary browser.
    const policy = { url: 'https://drive.google.com/uc?export=download&id=release-fixture', minimumVersion: '1.7.0' };
    for (const nativeVersion of ['unknown', 'legacy', '1.6.1', '1.7.0', '1.8.0', 'web', 'cached-offline']) {
      const gateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await gateContext.addInitScript(mock);
      await gateContext.addInitScript(({ nativeVersion, policy }) => {
        if (nativeVersion !== 'web') {
          window.chatDesktopPreferences = Object.freeze({ version: 1, setBackgroundRunning() {}, getState: async () => ({ backgroundRunning: true }) });
          if (!['legacy', 'cached-offline'].includes(nativeVersion)) window.chatDesktopBuild = Object.freeze({ nativeVersion, openUpdateAndQuit: async url => { window.__openedNativeUpdate = url; return true; } });
        }
        if (nativeVersion === 'cached-offline') {
          localStorage.setItem('chatapp_native_update_policy_v1', JSON.stringify(policy));
          const originalDatabase = firebase.database;
          const database = () => {
            const db = originalDatabase(), originalRef = db.ref;
            db.ref = value => value === 'admin/desktopUpdate' ? { on() {} } : originalRef(value);
            return db;
          };
          database.ServerValue = originalDatabase.ServerValue; firebase.database = database;
        } else __testDatabase.values.admin.desktopUpdate = policy;
      }, { nativeVersion, policy });
      await gateContext.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' }));
      const nativePage = await gateContext.newPage(), nativeErrors = [];
      nativePage.on('pageerror', error => nativeErrors.push(error.message));
      await nativePage.goto(entry);
      await nativePage.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      const blocked = ['legacy', '1.6.1'].includes(nativeVersion);
      assert.equal(await nativePage.locator('#native-update-gate[open]').count(), blocked ? 1 : 0, nativeVersion);
      if (blocked) {
        assert.equal(await nativePage.evaluate(() => ChatApp.currentUser), null, 'gate works before sign-in');
        assert.equal(await nativePage.locator('#native-update-download').getAttribute('href'), policy.url);
        assert.equal(await nativePage.locator('#native-update-download').evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
        if (nativeVersion === '1.6.1') {
          await nativePage.locator('#native-update-download').click();
          assert.equal(await nativePage.evaluate(() => window.__openedNativeUpdate), policy.url);
        }
        if (process.env.NATIVE_UPDATE_CAPTURE_DIR) {
          fs.mkdirSync(process.env.NATIVE_UPDATE_CAPTURE_DIR, { recursive: true });
          await nativePage.screenshot({ path: path.join(process.env.NATIVE_UPDATE_CAPTURE_DIR, 'native-update-gate.png') });
        }
        await nativePage.evaluate(() => {
          const cloak = document.createElement('div'); cloak.id = 'fixture-cloak';
          cloak.style.cssText = 'position:fixed;inset:0;background:black;z-index:2147483647'; document.documentElement.append(cloak);
          ChatApp.openModal({ title: 'Underlying app dialog', bodyHTML: 'Cannot bypass the update' });
          document.getElementById('native-update-gate').close();
        });
        await nativePage.waitForFunction(() => document.getElementById('native-update-gate').open);
        await nativePage.keyboard.press('Escape'); await nativePage.keyboard.press('Shift+Z');
        assert.equal(await nativePage.locator('#native-update-gate').evaluate(el => el.open && el.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))), true, 'gate covers cloak and dialogs and cannot be dismissed');
        await nativePage.evaluate(() => document.documentElement.requestFullscreen());
        await nativePage.waitForFunction(() => !document.fullscreenElement);
        assert.equal(await nativePage.locator('#native-update-gate').evaluate(el => el.open), true, 'fullscreen cannot put content above the gate');
        const bounds = await nativePage.locator('#native-update-gate').boundingBox();
        assert.deepEqual(bounds, { x: 0, y: 0, width: 1440, height: 900 });
        if (nativeVersion === '1.6.1') {
          await nativePage.evaluate(() => __testDatabase.ref('admin/desktopUpdate').set(null));
          await nativePage.waitForFunction(() => !document.getElementById('native-update-gate').open);
          assert.equal(await nativePage.evaluate(() => localStorage.getItem('chatapp_native_update_policy_v2')), null, 'clearing policy also clears offline cache');
          await nativePage.evaluate(() => document.getElementById('fixture-cloak').remove());
        }
      }
      if (nativeVersion === 'web') {
        await nativePage.evaluate(() => {
          ChatApp.currentUser = { code: 'TEST-USER', username: 'Vinny' };
          ChatApp.isVinny = () => true; ChatApp.openAdminPanel();
        });
        assert.equal(await nativePage.locator('#panel-update-url').inputValue(), policy.url);
        assert.equal(await nativePage.locator('#panel-file-upload-limit').inputValue(), '100');
        assert.deepEqual(await nativePage.locator('#panel-file-upload-setting').evaluate(el => ({
          text: el.textContent.trim(), children: Array.from(el.children, child => child.tagName)
        })), { text: 'File Upload Limit', children: ['LABEL', 'INPUT'] }, 'upload setting contains only the requested label and input');
        const limitBounds = await nativePage.locator('#panel-file-upload-limit').boundingBox();
        assert.ok((await nativePage.locator('#panel-update-url').boundingBox()).y < limitBounds.y && limitBounds.y < (await nativePage.locator('#panel-schedtypes').boundingBox()).y, 'File Upload Limit is directly below Update URL');
        await nativePage.fill('#panel-file-upload-limit', '250.5');
        await nativePage.waitForFunction(() => __testDatabase.get('admin/fileUploadLimitMB') === 250.5 && ChatApp.fileUploadLimitMB === 250.5);
        assert.equal(await nativePage.evaluate(() => ChatApp.isChatAttachmentOverSizeLimit({ size: 200 * 1024 * 1024 })), false, 'admin can raise the default 100 MB cap');
        await nativePage.fill('#panel-file-upload-limit', '1.5');
        await nativePage.waitForFunction(() => __testDatabase.get('admin/fileUploadLimitMB') === 1.5 && ChatApp.fileUploadLimitMB === 1.5);
        assert.equal(await nativePage.evaluate(() => ChatApp.isChatAttachmentOverSizeLimit({ size: 2 * 1024 * 1024 })), true, 'a lower limit updates validation live');
        await nativePage.evaluate(() => ChatApp.closeModal());
        await nativePage.waitForFunction(() => ChatApp.modalEl.hidden);
        await nativePage.evaluate(() => ChatApp.openAdminPanel());
        assert.equal(await nativePage.locator('#panel-file-upload-limit').inputValue(), '1.5', 'saved value persists when reopening the panel');
        await nativePage.evaluate(() => __testDatabase.ref('admin/fileUploadLimitMB').set(125));
        await nativePage.waitForFunction(() => document.getElementById('panel-file-upload-limit').value === '125' && ChatApp.fileUploadLimitMB === 125);
        await nativePage.fill('#panel-file-upload-limit', 'invalid');
        await nativePage.waitForFunction(() => document.getElementById('panel-file-upload-limit').validity.customError);
        assert.equal(await nativePage.evaluate(() => __testDatabase.get('admin/fileUploadLimitMB')), 125, 'invalid drafts are never saved');
        await nativePage.evaluate(() => {
          window.__policyOriginalRef = ChatApp.db.ref;
          ChatApp.db.ref = path => {
            const ref = window.__policyOriginalRef(path);
            if (path === 'admin/fileUploadLimitMB') ref.set = async () => { throw new Error('permission denied fixture'); };
            return ref;
          };
        });
        await nativePage.fill('#panel-file-upload-limit', '50');
        await nativePage.waitForFunction(() => document.getElementById('panel-file-upload-limit').validationMessage.includes('permission denied fixture'));
        assert.equal(await nativePage.evaluate(() => __testDatabase.get('admin/fileUploadLimitMB')), 125, 'rejected writes preserve the shared policy');
        await nativePage.evaluate(() => {
          window.__policyDelayedWrites = [];
          ChatApp.db.ref = path => {
            const ref = window.__policyOriginalRef(path);
            if (path === 'admin/fileUploadLimitMB') ref.set = value => new Promise(resolve => {
              window.__policyDelayedWrites.push(async () => { await __testDatabase.ref(path).set(value); resolve(); });
            });
            return ref;
          };
        });
        await nativePage.fill('#panel-file-upload-limit', '120');
        await nativePage.fill('#panel-file-upload-limit', '130.25');
        assert.equal(await nativePage.evaluate(() => window.__policyDelayedWrites.length), 1, 'autosave serializes overlapping changes');
        await nativePage.evaluate(() => window.__policyDelayedWrites.shift()());
        await nativePage.waitForFunction(() => window.__policyDelayedWrites.length === 1);
        assert.equal(await nativePage.locator('#panel-file-upload-limit').inputValue(), '130.25', 'an older realtime echo preserves the newest draft');
        await nativePage.evaluate(() => window.__policyDelayedWrites.shift()());
        await nativePage.waitForFunction(() => __testDatabase.get('admin/fileUploadLimitMB') === 130.25 && !document.getElementById('panel-file-upload-limit').validity.customError);
        await nativePage.evaluate(() => { ChatApp.db.ref = window.__policyOriginalRef; });
        if (process.env.NATIVE_UPDATE_CAPTURE_DIR) {
          await nativePage.screenshot({ path: path.join(process.env.NATIVE_UPDATE_CAPTURE_DIR, 'admin-update-url.png'), animations: 'disabled' });
        }
        const urlBounds = await nativePage.locator('#panel-update-url').boundingBox(), scheduleBounds = await nativePage.locator('#panel-schedtypes').boundingBox();
        assert.ok(urlBounds.y < scheduleBounds.y, 'Update URL appears above Schedule Type');
        await nativePage.fill('#panel-update-url', 'https://example.test/new.exe');
        await nativePage.evaluate(() => __testDatabase.ref('admin/desktopUpdate').set({ url: 'https://example.test/remote.exe', minimumVersion: '1.7.0' }));
        assert.equal(await nativePage.locator('#panel-update-url').inputValue(), 'https://example.test/new.exe', 'live policy changes do not replace an unfinished draft');
        assert.equal(await nativePage.locator('#panel-save-update-url').count(), 0);
        await nativePage.waitForFunction(() => __testDatabase.get('admin/desktopUpdate')?.url === 'https://example.test/new.exe');
        assert.equal(await nativePage.evaluate(() => __testDatabase.get('admin/desktopUpdate').minimumVersion), '1.7.4');
        await nativePage.fill('#panel-update-url', 'javascript:alert(1)');
        await nativePage.waitForFunction(() => document.getElementById('panel-update-status').textContent.includes('HTTPS'));
        assert.match(await nativePage.locator('#panel-update-status').textContent(), /HTTPS/);
        assert.equal(await nativePage.evaluate(() => __testDatabase.get('admin/desktopUpdate').url), 'https://example.test/new.exe');
        await nativePage.fill('#panel-update-url', '');
        await nativePage.waitForFunction(() => __testDatabase.get('admin/desktopUpdate') === null);
      }
      assert.deepEqual(nativeErrors, [], nativeVersion);
      await gateContext.close();
    }
    console.log('Native update gate and live File Upload Limit: defaults, layout, autosave, persistence, remote updates, limits, invalid values and failed/overlapping writes: PASS');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
