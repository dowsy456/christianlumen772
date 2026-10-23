/* Tests embedded controls and pause in a real browser without a backend. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const base = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/harness') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end('<!doctype html><html><head><meta charset="utf-8"><script src="/js/runtime/activity-loader.js"></script></head><body style="margin:0"><iframe id="frame" style="display:block;width:100vw;height:100vh;border:0"></iframe></body></html>'); }
  const file = path.resolve(base, '.' + decodeURIComponent(pathname));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file)] || 'text/plain');
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
    const context = await browser.newContext({ deviceScaleFactor: Number(process.env.ACTIVITY_DPR) || 1 });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const id of ['merge-party', 'bopl-royale']) {
      await page.goto(`${origin}/harness`);
      await page.evaluate(async id => {
        window.__mergePartyLaunchConfig = { roomId: 'LOCAL', offline: true, user: { code: 'test' } };
        window.__boplRoyaleLaunchConfig = { roomId: 'LOCAL', debug: true, user: { code: 'test' } };
        window.controlMessages = [];
        window.addEventListener('message', event => window.controlMessages.push(event.data));
        document.getElementById('frame').srcdoc = await ChatActivities.load(id);
      }, id);
      const frame = await (await page.locator('#frame').elementHandle()).contentFrame();
      await frame.waitForFunction(id => id === 'merge-party' ? !!window.__mergeParty : !!window.__boplRoyale?.debug, id);
      if (id === 'merge-party') await frame.locator('#playBtn').click();
      for (const viewport of [{ width: 1920, height: 858 }, { width: 1280, height: 850 }, { width: 700, height: 500 }, { width: 600, height: 1100 }, { width: 360, height: 640 }, { width: 270, height: 640 }]) {
        await page.setViewportSize(viewport);
        await frame.locator('#activityChatBtn').click();
        await page.waitForFunction(() => window.controlMessages.at(-1)?.type === 'htmlhub:activity-chat-toggle');
        assert.equal(await frame.evaluate(id => {
          const bounds = document.querySelector('.activity-controls').getBoundingClientRect();
          const game = document.querySelector('.game').getBoundingClientRect();
          const correctlyPlaced = id === 'merge-party'
            ? (innerWidth <= 600
              ? bounds.left >= 0 && bounds.left < 12 && Math.abs((bounds.top + bounds.bottom) / 2 - innerHeight * .48) < 2 && bounds.width < 50
              : bounds.top >= 0 && bounds.top < 12 && bounds.right >= innerWidth - 12)
            : bounds.top >= game.bottom - 1;
          return game.left >= -1 && game.right <= innerWidth + 1 && correctlyPlaced && bounds.bottom <= innerHeight + 1 && [...document.querySelectorAll('.activity-controls button')].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1; });
        }, id), true, `${id} controls have their intended placement without overlap at ${viewport.width}×${viewport.height}`);
        if (id === 'merge-party') {
          const layout = await frame.evaluate(() => {
            const game = document.querySelector('.game'), rect = game.getBoundingClientRect(), styles = getComputedStyle(game);
            const toolbar = document.querySelector('.activity-controls').getBoundingClientRect();
            const checkout = document.querySelector('.checkout').getBoundingClientRect();
            const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            const score = { left: rect.left + rect.width * 330 / 1080, right: rect.left + rect.width * 750 / 1080, top: rect.top + rect.height * 10 / 1920, bottom: rect.top + rect.height * 180 / 1920 };
            const nextBall = { left: rect.left + rect.width * 20 / 1080, right: rect.left + rect.width * 180 / 1080, top: rect.top + rect.height * 30 / 1920, bottom: rect.top + rect.height * 205 / 1920 };
            const expectedHeight = Math.min(innerHeight, innerWidth * 16 / 9);
            return {
              width: rect.width, height: rect.height, top: rect.top, left: rect.left,
              expectedHeight, expectedWidth: expectedHeight * 9 / 16,
              expectedTop: (innerHeight - expectedHeight) / 2,
              expectedLeft: (innerWidth - expectedHeight * 9 / 16) / 2,
              borderless: styles.boxShadow === 'none' && styles.borderTopWidth === '0px' && styles.outlineStyle === 'none',
              clearCheckout: !intersects(toolbar, checkout), clearScore: !intersects(toolbar, score), clearNextBall: !intersects(toolbar, nextBall),
              surfacePadding: getComputedStyle(document.querySelector('.game-surface')).paddingTop
            };
          });
          for (const dimension of ['width', 'height', 'top', 'left']) {
            assert.ok(Math.abs(layout[dimension] - layout['expected' + dimension[0].toUpperCase() + dimension.slice(1)]) < 1,
              `Merge ${dimension} uses the full viewport with natural 9:16 centering at ${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`);
          }
          assert.equal(layout.surfacePadding, '0px', 'Overlay controls reserve no header space');
          assert.equal(layout.borderless, true, 'The playfield has no surrounding border, outline, or shadow');
          assert.equal(layout.clearCheckout, true, 'Check Out stays clear of the overlay controls');
          assert.equal(layout.clearScore, true, 'The centered scoreboard stays clear of the overlay controls');
          assert.equal(layout.clearNextBall, true, 'The corner next-ball preview stays clear of the overlay controls');
          await frame.waitForFunction(() => {
            const canvas = document.getElementById('gameCanvas'), rect = canvas.getBoundingClientRect();
            const scale = Math.min(1, rect.width * Math.min(devicePixelRatio, 1.5) / 1080, rect.height * Math.min(devicePixelRatio, 1.5) / 1920);
            return canvas.width === Math.round(1080 * scale) && canvas.height === Math.round(1920 * scale);
          }).catch(async error => {
            console.error('Canvas sizing failed:', await frame.evaluate(() => { const c = document.getElementById('gameCanvas'); return { width: c.width, height: c.height, rect: c.getBoundingClientRect().toJSON(), dpr: devicePixelRatio }; }), errors);
            throw error;
          });
          assert.equal(await frame.evaluate(() => [...document.querySelectorAll('.activity-controls button')].every(button => {
            const rect = button.getBoundingClientRect();
            const visibleText = [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
            return rect.width <= 44 && rect.height <= 44 && button.getAttribute('aria-label') && !visibleText;
          })), true, 'Merge controls are compact icons with accessible names');
        }
        if (screenshots) await page.screenshot({ path: path.join(screenshots, `${id}-${viewport.width}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 850 });
      if (id === 'merge-party') {
        for (const side of [-1, 1]) {
          await frame.evaluate(() => window.__mergeParty.debug.start());
          const point = { x: side < 0 ? 8 : 1272, y: 300 };
          assert.equal(await frame.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, point), 'gameSurface', 'Far paper belongs to the game input surface');
          await page.mouse.click(point.x, point.y);
          const dropped = await frame.evaluate(() => {
            const state = window.__mergeParty.debug.getState();
            return { balls: state.balls.length, x: state.balls[0]?.x, held: state.pointerDown, aim: state.aimX };
          });
          assert.equal(dropped.balls, 1, 'A far-background click drops exactly one ball');
          assert.equal(dropped.held, false, 'Pointer capture finishes the paper click');
          assert(side * (dropped.x - 540) > 0, 'Canvas mapping clamps the drop toward the clicked rim');
        }
        await frame.evaluate(() => window.__mergeParty.debug.start());
        await frame.locator('#activityChatBtn').click();
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().balls.length), 0, 'Toolbar clicks never drop a ball');
        const playfield = await frame.locator('#gameCanvas').boundingBox();
        const chatButton = await frame.locator('#activityChatBtn').boundingBox();
        await page.mouse.move(playfield.x + playfield.width / 2, playfield.y + playfield.height / 3);
        await page.mouse.down();
        await page.mouse.move(chatButton.x + chatButton.width / 2, chatButton.y + chatButton.height / 2);
        await page.mouse.up();
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().balls.length), 0, 'Releasing a captured drag over a control cancels placement');
        await frame.evaluate(() => { const d = window.__mergeParty.debug; d.spawn(4, 540, 800); d.useQuake(); });
        await frame.locator('#pauseBtn').click();
        const paused = await frame.evaluate(() => window.__mergeParty.debug.getState().simTime);
        const pausedBallCount = await frame.evaluate(() => window.__mergeParty.debug.getState().balls.length);
        await page.mouse.click(1272, 300);
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().balls.length), pausedBallCount, 'Paper remains inactive while a pause modal is open');
        await frame.locator('#activityChatBtn').click();
        await frame.locator('#pauseExitBtn').click();
        await page.waitForFunction(() => window.controlMessages.at(-1)?.type === 'htmlhub:activity-close');
        await frame.evaluate(() => window.__mergeParty.resumeView());
        assert.equal(await frame.evaluate(() => window.__mergeParty.debug.getState().simTime), paused);
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'merge-party-paused.png') });
        await frame.locator('#resumeBtn').click();
        await frame.waitForFunction(time => window.__mergeParty.debug.getState().simTime > time, paused).catch(async error => {
          console.error('Resume failed:', { errors, state: await frame.evaluate(() => window.__mergeParty.debug.getState()) });
          throw error;
        });
        if (screenshots) {
          const pile = await frame.evaluate(() => {
            const d = window.__mergeParty.debug;
            d.start();
            for (const [tier, x, y] of [[4,405,1295],[3,640,1300],[0,475,1090],[2,620,1080],[1,500,910]]) d.spawn(tier,x,y);
            d.step(360);d.render();
            return { state: d.getState().runState, shapes: d.getState().balls.map(body => ({ tier: body.logicalTier, ...d.bodyShape(body) })) };
          });
          assert.equal(pile.state, 'playing', 'Mixed-pile visual sample stays inside the cup');
          console.log('Supported-pile proportions:', JSON.stringify(pile.shapes));
          await page.screenshot({ path: path.join(screenshots, 'merge-party-gameplay-desktop.png') });
          await page.setViewportSize({ width: 360, height: 640 });
          await frame.waitForFunction(() => {
            const canvas = document.getElementById('gameCanvas');
            return canvas.width === Math.round(canvas.getBoundingClientRect().width * Math.min(devicePixelRatio, 1.5));
          });
          await page.screenshot({ path: path.join(screenshots, 'merge-party-gameplay-mobile.png') });
          await page.setViewportSize({ width: 1280, height: 850 });
        }
      } else {
        assert.equal(await frame.locator('#pauseBtn').count(), 0, 'Bopl has no pause control');
        await frame.locator('[data-action="local"]').click();
        await frame.evaluate(() => { const d = window.__boplRoyale.debug; d.addLocalBot(1); d.toggleReady(d.state.localCode); d.startRound(); });
        await frame.waitForFunction(() => window.__boplRoyale.debug.state.phase === 'battle');
        await frame.locator('#activityChatBtn').click();
        assert.equal(await frame.evaluate(() => window.__boplRoyale.debug.state.battleRunning), true, 'Opening chat does not pause Bopl');
        if (screenshots) await page.screenshot({ path: path.join(screenshots, 'bopl-royale-battle.png') });
      }
      await frame.locator('#activityExitBtn').click();
      await page.waitForFunction(() => window.controlMessages.at(-1)?.type === 'htmlhub:activity-close');
    }
    assert.deepEqual(errors, []);
    console.log('Embedded activity controls and Merge pause passed at desktop, tablet, mobile, and narrow activity widths.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
