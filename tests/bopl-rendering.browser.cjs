/* Local/online rendering uses in-memory signaling and never contacts a backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const mock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/harness') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><script src="/js/runtime/activity-loader.js"></script><body style="margin:0"><iframe id="frame" style="border:0;width:100vw;height:100vh"></iframe>');
  }
  const file = path.resolve(root, '.' + decodeURIComponent(name));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 404 : 200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file)] || 'text/plain' });
    res.end(err ? '' : data);
  });
});
function auditCanvas() {
  const audit = window.__canvasAudit = { requests: [], resizes: [], paints: [], frame: 0, inFrame: false };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = callback => raf.call(window, timestamp => {
    audit.frame++; audit.inFrame = true;
    try { callback(timestamp); } finally { audit.inFrame = false; }
  });
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, options) {
    if (this.id === 'arena') audit.requests.push({ kind, options });
    return get.call(this, kind, options);
  };
  for (const key of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key);
    Object.defineProperty(HTMLCanvasElement.prototype, key, { ...descriptor, set(value) {
      if (this.id === 'arena') audit.resizes.push({ key, value, frame: audit.frame, inFrame: audit.inFrame });
      descriptor.set.call(this, value);
    } });
  }
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
    if (this.canvas.id === 'arena' && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height) {
      audit.paints.push({ frame: audit.frame, inFrame: audit.inFrame, width, height });
    }
    return fill.call(this, x, y, width, height);
  };
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const [device, options] of [
      ['desktop', { viewport: { width: 1280, height: 850 }, deviceScaleFactor: 1 }],
      ['mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }]
    ]) for (const mode of ['local', 'online']) {
      const context = await browser.newContext(options);
      await context.addInitScript(mock);
      await context.addInitScript(auditCanvas);
      await context.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/harness`);
      await page.evaluate(async () => {
        window.__boplRoyaleLaunchConfig = { debug: true, roomId: 'grindoutpost', roomName: 'Grind Outpost', user: { code: 'TEST-USER', username: 'Tester' } };
        document.getElementById('frame').srcdoc = await ChatActivities.load('bopl-royale');
      });
      const frame = await (await page.locator('#frame').elementHandle()).contentFrame();
      await frame.waitForFunction(() => !!window.__boplRoyale?.debug);
      assert.equal(await frame.locator('#roomPill').textContent(), 'ROOM Grind Outpost', 'The game shows the canonical label, including its spaces and capitalization');
      await frame.locator(`[data-action="${mode}"]`).click();
      await frame.waitForFunction(() => window.__boplRoyale.debug.state.screen === 'lobby');
      if (mode === 'online') {
        await page.evaluate(async () => {
          const db = __testDatabase, prefix = 'activities/boplRoyale/rooms/grindoutpost/players/';
          const own = (await db.ref(prefix + 'TEST-USER').once('value')).val();
          await db.ref(prefix + 'REMOTE').set({ ...own, code: 'REMOTE', accountCode: 'REMOTE', name: 'Remote Fixture', color: 3, ready: true, joinedAt: Date.now() + 1 });
        });
        await frame.waitForFunction(() => window.__boplRoyale.debug.state.participants.size === 2);
      } else await frame.evaluate(() => window.__boplRoyale.debug.addLocalBot(1));
      await frame.evaluate(async () => {
        const debug = window.__boplRoyale.debug;
        debug.state.settings.frameRate = '30';
        await debug.toggleReady(debug.state.localCode);
        await debug.startRound();
      });
      await frame.waitForFunction(() => window.__boplRoyale.debug.state.battleRunning && __canvasAudit.paints.length >= 3);
      const stateBeforeRename = await frame.evaluate(() => {
        const state = window.__boplRoyale.debug.state;
        return { screen: state.screen, phase: state.phase, members: [...state.participants.keys()] };
      });
      await frame.evaluate(() => window.__boplRoyale.updateRoomDisplayName('New Outpost'));
      assert.equal(await frame.locator('#roomPill').textContent(), 'ROOM New Outpost', 'A room rename reaches the running game immediately');
      assert.deepEqual(await frame.evaluate(() => {
        const state = window.__boplRoyale.debug.state;
        return { screen: state.screen, phase: state.phase, members: [...state.participants.keys()] };
      }), stateBeforeRename, 'A display rename preserves the running match and participants');
      assert.equal(await page.evaluate(() => window.__boplRoyaleLaunchConfig.roomId), 'grindoutpost');
      if (mode === 'online') assert.equal(await page.evaluate(() => Object.hasOwn(__testDatabase.get('activities/boplRoyale/rooms') || {}, 'New Outpost')), false, 'The multiplayer key stays unchanged');
      const request = await frame.evaluate(() => __canvasAudit.requests[0]);
      assert.equal(request.options.desynchronized, false, `${device}/${mode}: compositor synchronization requested`);
      assert.equal(await frame.evaluate(() => document.getElementById('arena').getContext('2d').getContextAttributes?.().desynchronized === true), false);
      for (const width of ['70vw', '85vw', '100vw']) {
        const before = await frame.evaluate(() => __canvasAudit.paints.length);
        await page.evaluate(width => { document.getElementById('frame').style.width = width; }, width);
        await frame.waitForFunction(before => __canvasAudit.paints.length > before && !window.__boplRoyale.debug.state.canvasSizeDirty, before);
      }
      const bitmap = await frame.evaluate(() => ({ width: document.getElementById('arena').width, height: document.getElementById('arena').height }));
      await page.evaluate(() => { document.getElementById('frame').hidden = true; });
      await page.waitForTimeout(100);
      assert.deepEqual(await frame.evaluate(() => ({ width: document.getElementById('arena').width, height: document.getElementById('arena').height })), bitmap, 'hidden surface keeps its last complete bitmap');
      await page.evaluate(() => { document.getElementById('frame').hidden = false; });
      await frame.waitForFunction(() => !window.__boplRoyale.debug.state.canvasSizeDirty);
      const result = await frame.evaluate(() => {
        const audit = __canvasAudit, canvas = document.getElementById('arena');
        const sample = canvas.getContext('2d').getImageData(2, 2, 1, 1).data;
        return { resizes: audit.resizes, paints: audit.paints, pixel: [...sample] };
      });
      assert(result.resizes.length >= 2);
      for (const resize of result.resizes) {
        assert.equal(resize.inFrame, true, 'backing-store resize stays inside a browser animation frame');
        assert(result.paints.some(paint => paint.frame === resize.frame), 'every resize gets a complete repaint in that same frame');
      }
      assert.equal(result.pixel[3], 255);
      assert(result.pixel.slice(0, 3).some(channel => channel > 0), 'last frame has rendered scene pixels');
      assert.deepEqual(errors, [], `${device}/${mode}: no runtime errors`);
      console.log(`${device}/${mode}: synchronized canvas; ${result.resizes.length} backing-store changes repainted in the same frame; hidden/resumed surface retained.`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
