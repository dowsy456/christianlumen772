/*
 * Browser smoke tests for lazy activity packages. No Firebase connection is used.
 * Requires Playwright plus an installed Edge/Chrome browser (or Playwright browser).
 * Run: node tests/activities.test.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const appDir = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-activity-test-'));
const loaderPath = path.join(appDir, 'js/runtime/activity-loader.js');
const fileHarness = path.join(scratch, 'harness.html');
const harness = (loader) => `<!doctype html><html><head><meta charset="utf-8"><title>Activity tests</title><script src="${loader}"></script></head><body style="margin:0"><div id="frame-host"></div></body></html>`;
fs.writeFileSync(fileHarness, harness(pathToFileURL(loaderPath).href));

const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/__activity-test') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(harness('/js/runtime/activity-loader.js'));
    return;
  }
  const target = path.resolve(appDir, '.' + decodeURIComponent(pathname));
  if (!target.startsWith(appDir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
  response.end(fs.readFileSync(target));
});

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [
    process.env.CHAT_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((file) => file && fs.existsSync(file));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const results = [];
  try {
    for (const protocol of ['file', 'http']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
      const requests = [];
      const exceptions = [];
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        // External web fonts are optional. Never allow the test to reach any
        // backend or other external endpoint.
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          if (url.origin !== origin) return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.on('request', (request) => requests.push(request.url()));
      page.on('pageerror', (error) => exceptions.push(error.message));
      await page.goto(protocol === 'file' ? pathToFileURL(fileHarness).href : `${origin}/__activity-test`);
      await page.waitForFunction(() => !!window.ChatActivities);
      assert.equal(requests.filter((url) => url.includes('/activities/')).length, 0, 'Activities must not load before selection');
      assert.equal(await page.evaluate(() => window.ChatActivities.load('unknown').then(() => false, () => true)), true);

      for (const id of ['bopl-royale', 'merge-party']) {
        await page.evaluate(async ({ id, useBlob }) => {
          const [first, second] = await Promise.all([window.ChatActivities.load(id), window.ChatActivities.load(id)]);
          if (first !== second) throw new Error('Concurrent activity requests returned different documents');
          window.__boplRoyaleLaunchConfig = { debug: true, roomId: 'LOCAL-TEST', user: { code: 'local-test', username: 'Test Player' } };
          window.__mergePartyLaunchConfig = { offline: true, roomId: 'LOCAL-TEST', user: { code: 'local-test', username: 'Test Player' } };
          const frame = document.createElement('iframe');
          frame.id = 'activity-frame';
          frame.style.cssText = 'width:100vw;height:100vh;border:0';
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups');
          document.getElementById('frame-host').replaceChildren(frame);
          if (useBlob) {
            if (window.__previousBlob) URL.revokeObjectURL(window.__previousBlob);
            window.__previousBlob = URL.createObjectURL(new Blob([first], { type: 'text/html;charset=utf-8' }));
            frame.src = window.__previousBlob;
          } else frame.srcdoc = first;
        }, { id, useBlob: protocol === 'http' });
        const frame = await (await page.locator('#activity-frame').elementHandle()).contentFrame();
        await frame.waitForFunction((id) => id === 'bopl-royale' ? !!window.__boplRoyale?.debug : !!window.__mergeParty?.debug, id);
        assert.equal(await frame.locator('title').textContent(), id === 'bopl-royale' ? 'Bopl Royale' : 'Merge Party');
        assert.equal(await frame.evaluate(() => getComputedStyle(document.body).margin), '0px', 'Extracted CSS applied');
        assert.equal(requests.filter((url) => url.includes(`/activities/${id}/document.js`)).length, 1, 'Concurrent requests share one download');

        if (id === 'bopl-royale') {
          await frame.locator('[data-action="local"]').click();
          await frame.waitForFunction(() => window.__boplRoyale.debug.state.screen === 'lobby');
          const bopl = await frame.evaluate(async () => {
            const debug = window.__boplRoyale.debug;
            debug.addLocalBot(1);
            const art = await Promise.all(Object.values(debug.ballArt).map((src) => new Promise((resolve) => {
              const image = new Image();
              image.onload = () => resolve(image.naturalWidth > 0);
              image.onerror = () => resolve(false);
              image.src = src;
            })));
            const hero = document.querySelector('.hero-ball-art');
            return { players: debug.state.participants.size, art: art.every(Boolean), hero: hero.complete && hero.naturalWidth > 0 };
          });
          assert.ok(bopl.players >= 2, 'Local lobby and bot addition work');
          assert.ok(bopl.art, 'All externalized ball images decode');
          assert.ok(bopl.hero, 'Externalized menu hero image decodes');
          const boplRename = await frame.evaluate(() => {
            const game = window.__boplRoyale, before = game.debug.state.participants.size;
            const changed = game.updateLocalAccountPassword('new-password');
            return { changed, before, after: game.debug.state.participants.size, old: game.debug.state.participants.has('local-test'), next: game.debug.state.participants.has('new-password') };
          });
          assert.ok(boplRename.changed && boplRename.next && !boplRename.old);
          assert.equal(boplRename.after, boplRename.before, 'local Bopl password rebinding preserves players and bots');
          results.push({ protocol, activity: id, ...bopl });
        } else {
          assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().runState), 'menu');
          assert.equal(await frame.evaluate(() => window.__mergeParty.debug.drop()), false, 'Menu prevents accidental drops');
          assert.equal(await frame.locator('#playBtn').isVisible(), true);
          await frame.waitForFunction(() => {
            const image = document.querySelector('.menu-machine img');
            return image.complete && image.naturalWidth > 0;
          });
          await frame.locator('#playBtn').click();
          const merge = await frame.evaluate(() => {
            const debug = window.__mergeParty.debug;
            const invariants = debug.invariantTests();
            debug.drop();
            debug.step(3);
            const state = debug.getState();
            return { balls: state.balls.length, state: state.runState, validPool: invariants.nextPoolOnlyBase, colliderInset: invariants.outlineColliderInset, enlargedHighTiers: invariants.enlargedHighTiers };
          });
          assert.ok(merge.balls >= 1, 'Dropping and physics simulation work');
          assert.equal(merge.state, 'playing');
          assert.ok(merge.validPool && merge.colliderInset && merge.enlargedHighTiers, 'Gameplay invariants preserved');
          const mergeRename = await frame.evaluate(() => {
            const game = window.__mergeParty, before = game.debug.getState();
            game.updateAccountPassword('new-password'); const after = game.debug.getState();
            return { before: before.balls.length, after: after.balls.length, sameScore: before.runScore === after.runScore, state: after.runState };
          });
          assert.equal(mergeRename.after, mergeRename.before); assert.ok(mergeRename.sameScore); assert.equal(mergeRename.state, 'playing');
          await frame.evaluate(() => window.__mergeParty.debug.showMenu());
          await frame.locator('#playBtn').click();
          assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().balls.length), 0, 'Play starts a fresh run');
          results.push({ protocol, activity: id, ...merge });
        }
      }
      assert.deepEqual(exceptions, [], `No uncaught exceptions under ${protocol}`);
      await context.close();
    }
    console.log(JSON.stringify({ passed: true, results }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  server.close();
  const resolvedScratch = path.resolve(scratch);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (path.dirname(resolvedScratch) === resolvedTemp && path.basename(resolvedScratch).startsWith('chat-activity-test-')) {
    fs.rmSync(resolvedScratch, { recursive: true, force: true });
  }
});
