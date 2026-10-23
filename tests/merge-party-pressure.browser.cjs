/* Real mouse/touch input must never squeeze or widen existing balls.
 * Only the automatic animation loop is disabled; real physics, rendering,
 * event handlers, pointer capture, and native touch dispatch remain active.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const base = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/harness') {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/js/runtime/activity-loader.js"></script></head><body style="margin:0"><iframe id="frame" style="display:block;width:100vw;height:100vh;border:0"></iframe></body></html>');
  }
  const file = path.resolve(base, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'text/plain');
  if (pathname === '/activities/merge-party/game.js') {
    const source = fs.readFileSync(process.env.MERGE_PARTY_GAME || file, 'utf8');
    assert.ok(source.includes('requestAnimationFrame(loop);'), 'Manual-step harness must disable the automatic loop');
    return res.end(source.replaceAll('requestAnimationFrame(loop);', ''));
  }
  res.end(fs.readFileSync(file));
});

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.CHAT_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const screenshots = process.env.ACTIVITY_SCREENSHOTS;
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
  try {
    for (const touch of [false, true]) {
      const label = touch ? 'touch' : 'mouse';
      const context = await browser.newContext({ viewport: touch ? { width: 360, height: 640 } : { width: 1280, height: 850 }, hasTouch: touch, isMobile: touch });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/harness`);
      await page.evaluate(async () => {
        window.__mergePartyLaunchConfig = { roomId: 'LOCAL', offline: true, user: { code: 'test' } };
        document.getElementById('frame').srcdoc = await ChatActivities.load('merge-party');
      });
      const frame = await (await page.locator('#frame').elementHandle()).contentFrame();
      await frame.waitForFunction(() => !!window.__mergeParty?.debug);
      await frame.locator('#playBtn').click();
      await frame.evaluate(() => {
        document.getElementById('gameCanvas').addEventListener('pointerdown', event => { window.lastTestPointerId = event.pointerId; });
        window.sampleTestPhysics = () => {
          const d = window.__mergeParty.debug;
          return d.getState().balls.filter(body => !body.dead).map(body => ({
            tier: body.logicalTier, x: body.x, y: body.y,
            vx: body.vx, vy: body.vy, angle: body.angle, omega: body.omega,
            mass: body.mass, radius: body.radius, shape: d.bodyShape(body),
            height: d.effectiveRadius(body, 0, 1), width: d.effectiveRadius(body, 1, 0),
            sleeping: body.sleeping, merge: body.mergeTransactionId
          }));
        };
      });
      const cdp = touch ? await context.newCDPSession(page) : null;
      async function down(point) {
        if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
      }
      async function move(point) {
        if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        else await page.mouse.move(point.x, point.y, { steps: 8 });
      }
      async function up() {
        if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        else await page.mouse.up();
      }
      async function cancel() {
        if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        else {
          await frame.evaluate(() => document.getElementById('gameCanvas').releasePointerCapture(window.lastTestPointerId));
          await page.mouse.move(1, 1); await page.mouse.up();
        }
      }
      async function setup(kind = 'single') {
        return frame.evaluate(kind => {
          const d = window.__mergeParty.debug; d.start();
          const lower = d.spawn(3, 540, d.BASE_CUP.floorY - d.TIERS[3].diameter / 2); d.step(180);
          if (kind !== 'single') {
            d.spawn(0, lower.x, lower.y - d.effectiveRadius(lower, 0, 1) - d.TIERS[0].diameter / 2 - (kind === 'impact' ? 180 : 0));
            if (kind !== 'impact') d.step(240);
          }
          d.render(); return window.sampleTestPhysics();
        }, kind);
      }
      async function sample(frames = 0) {
        return frame.evaluate(frames => { window.__mergeParty.debug.step(frames); return window.sampleTestPhysics(); }, frames);
      }
      async function screenPoint(body, dx = 0, dy = 0) {
        const canvas = await frame.locator('#gameCanvas').boundingBox();
        return { x: canvas.x + (body.x + dx) * canvas.width / 1080, y: canvas.y + (body.y + dy) * canvas.height / 1920 };
      }
      async function screenshot(name) {
        if (screenshots) { await frame.evaluate(() => window.__mergeParty.debug.render()); await page.screenshot({ path: path.join(screenshots, `merge-party-input-${label}-${name}.png`) }); }
      }

      for (const scenario of [
        { name: 'hold', kind: 'single', dx: 0, dy: 0 },
        { name: 'downward', kind: 'single', dx: 0, dy: 170 },
        { name: 'sideways', kind: 'single', dx: 135, dy: 0 },
        { name: 'stack', kind: 'stack', dx: 0, dy: 210 },
        { name: 'impact', kind: 'impact', dx: -110, dy: 170 }
      ]) {
        await setup(scenario.kind);
        const expected = [];
        for (let batch = 0; batch < 12; batch++) expected.push(await sample(10));
        const initial = await setup(scenario.kind), target = initial.at(-1);
        const from = await screenPoint(target), to = await screenPoint(target, scenario.dx, scenario.dy);
        assert.equal(await frame.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, from), 'gameCanvas', `${label}: gesture begins on the actual canvas`);
        await down(from); await move(to);
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().pointerDown), true, 'The pointer is held');
        for (let batch = 0; batch < 12; batch++) {
          assert.deepEqual(await sample(10), expected[batch], `${label} ${scenario.name}: input leaves every physical body identical to idle simulation at frame ${(batch + 1) * 10}`);
        }
        await screenshot(scenario.name);
        const beforeRelease = await sample();
        await up();
        const released = await sample();
        assert.equal(released.at(-1).vx, 0, `${label}: dragging cannot charge a horizontal throw`);
        assert.equal(released.at(-1).vy, 0, `${label}: every drop begins at rest`);
        assert.equal(released.length, initial.length + 1, `${label}: releasing ${scenario.name} places exactly one ball`);
        assert.deepEqual(released.slice(0, initial.length).map(body => ({ ...body, sleeping: false })), beforeRelease.map(body => ({ ...body, sleeping: false })),
          `${label}: release cannot resize or move the existing balls; ordinary placement may wake sleeping bodies`);
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().pointerDown), false);
      }

      const cancelled = await setup('stack'), target = cancelled.at(-1);
      await down(await screenPoint(target)); await move(await screenPoint(target, 0, 200)); await cancel();
      assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().pointerDown), false, `${label}: cancellation clears held input`);
      assert.equal((await sample(120)).length, 2, `${label}: cancellation never places the queued ball`);
      assert.deepEqual(errors, [], `${label}: no runtime errors`);
      console.log(`${label}: idle-equivalent hold, downward/sideways drag, loaded stack, natural impact, single release, and cancellation passed.`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
