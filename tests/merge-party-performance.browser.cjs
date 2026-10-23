/* Reproducible offline CPU timing, not a promise about every device's FPS.
 * Optional baseline: MERGE_PARTY_BASELINE=/path/to/original/game.js node ...
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/harness') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><script src="/js/runtime/activity-loader.js"></script><iframe id="game" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executablePath = [process.env.CHAT_TEST_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const report = [];
  try {
    for (const variant of process.env.MERGE_PARTY_BASELINE ? ['original', 'updated'] : ['updated']) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.context().route('**/*', route => {
        const url = new URL(route.request().url());
        return url.origin === `http://127.0.0.1:${server.address().port}` ? route.continue() : route.abort();
      });
      await page.route('**/activities/merge-party/game.js*', route => {
        let code = fs.readFileSync(variant === 'original' ? process.env.MERGE_PARTY_BASELINE : path.join(root, 'activities/merge-party/game.js'), 'utf8');
        // Suspend only the automatic loop; manual step/render calls stay real.
        code = code.replaceAll('requestAnimationFrame(loop);', '');
        return route.fulfill({ contentType: 'text/javascript', body: code });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/harness`);
      await page.evaluate(async () => { window.__mergePartyLaunchConfig = { offline: true, roomId: 'LOCAL-TEST', user: { code: 'performance-test' } }; document.querySelector('iframe').srcdoc = await ChatActivities.load('merge-party'); });
      const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
      await frame.waitForFunction(() => !!window.__mergeParty);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      for (const scenario of ['settled', 'crowded']) {
        const result = await frame.evaluate(scenario => {
          const d = window.__mergeParty.debug; d.start();
          if (scenario === 'settled') { d.spawn(3, 540, 1300); d.step(360); }
          else for (let i = 0; i < 24; i++) d.spawn(i % 6, 320 + (i % 3) * 205, 1200 - Math.floor(i / 3) * 180);
          const samples = [], renderSamples = [];
          for (let i = 0; i < 360; i++) {
            const start = performance.now(); d.step(); samples.push(performance.now() - start);
            const paint = performance.now(); d.render(); renderSamples.push(performance.now() - paint);
          }
          const stats = values => { values.sort((a,b) => a-b); return { mean: +(values.reduce((a,b) => a+b,0)/values.length).toFixed(3), p95: +values[Math.floor(values.length*.95)].toFixed(3) }; };
          const state = d.getState(), canvas = document.querySelector('canvas');
          return { physicsMs: stats(samples), drawingMs: stats(renderSamples), backingPixels: canvas.width*canvas.height, bodies: state.balls.length, finite: state.balls.every(b => Number.isFinite(b.x+b.y+b.vx+b.vy)) };
        }, scenario);
        assert(result.finite, 'Stress simulation stays finite');
        report.push({ variant, scenario, cpuThrottle: 4, ...result });
      }
      assert.deepEqual(errors, []); await page.close();
    }
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
