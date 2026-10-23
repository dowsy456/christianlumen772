'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const firebaseMock = require('./firebase-mock.js');
const root = path.resolve(__dirname, '..'), mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
(async () => {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname), file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => { if (error) response.writeHead(404).end(); else { response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); response.end(bytes); } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    for (const kind of ['desktop', 'web', 'mobile']) {
      const desktop = kind === 'desktop', mobile = kind === 'mobile', requests = [], errors = [];
      let playing = true, position = 30000, shuffle = false, repeat = 'off';
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 950 }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(firebaseMock);
      await context.addInitScript(({ desktop }) => {
        window.__spotifyTrack = { id: '1234567890abcdefghijkl', title: 'A Long Song Name', artist: 'Test Artist', album: 'Test Album', image: 'https://i.scdn.co/image/cover' };
        if (!desktop) {
          sessionStorage.setItem('chat.spotify.tokens.v1:TEST-USER', JSON.stringify({ accessToken: 'TEST_PRIVATE', refreshToken: 'TEST_REFRESH', expiresAt: Date.now() + 3600000, scope: 'user-read-currently-playing user-read-playback-state user-modify-playback-state', clientId: '0aff8efba08a4dc684eecd5dafe5bf8c' })); return;
        }
        let state = { accountCode: '', configured: true, connected: false, connecting: false, track: null, playback: null, supportsPlayback: true, error: '' }, change;
        window.__spotifyOpened = []; window.__spotifyCommands = [];
        window.chatDesktopSpotify = {
          version: 2, setUser: async code => (state = { ...state, accountCode: code }), getState: async () => state,
          onChange: callback => { change = callback; },
          connect: async () => { state = { ...state, connected: true, track: __spotifyTrack, playback: { playing: true, duration: 245000, position: 30000, measuredAt: Date.now(), shuffle: false, repeat: 'off', disallows: {} } }; change(state); return state; },
          disconnect: async () => { state = { ...state, connected: false, track: null, playback: null }; change(state); return state; },
          control: async (action, value) => { __spotifyCommands.push({ action, value }); if (action === 'seek') { state.playback.position = value; state.playback.measuredAt = Date.now(); } if (action === 'shuffle') state.playback.shuffle = !state.playback.shuffle; if (action === 'repeat') state.playback.repeat = { off: 'context', context: 'track', track: 'off' }[state.playback.repeat]; if (action === 'pause') { state.playback.playing = false; state.playerTrack = state.track; state.track = null; } if (action === 'play') { state.playback.playing = true; state.track = state.playerTrack || __spotifyTrack; } change(state); return state; },
          openTrack: async id => __spotifyOpened.push(id)
        };
      }, { desktop });
      await context.route(/^https?:\/\//, route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === 'api.spotify.com') {
          const request = route.request(); requests.push({ method: request.method(), path: url.pathname + url.search });
          if (request.method() !== 'GET') {
            if (url.pathname.endsWith('/pause')) playing = false;
            if (url.pathname.endsWith('/seek')) position = Number(url.searchParams.get('position_ms'));
            if (url.pathname.endsWith('/shuffle')) shuffle = url.searchParams.get('state') === 'true';
            if (url.pathname.endsWith('/repeat')) repeat = url.searchParams.get('state');
            return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
          }
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ is_playing: playing, currently_playing_type: 'track', progress_ms: position, shuffle_state: shuffle, repeat_state: repeat, device: { id: 'test-device' }, item: { id: '1234567890abcdefghijkl', name: 'A Long Song Name', duration_ms: 245000, artists: [{ name: 'Test Artist' }], album: { name: 'Test Album', images: [{ url: 'https://i.scdn.co/image/cover' }] } } }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: 'null' });
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/'); await page.waitForFunction(() => document.documentElement.dataset.appReady === 'true');
      await page.click('#btn-go-login'); await page.fill('#login-code', 'TEST-USER'); await page.click('#btn-login');
      await page.waitForFunction(() => ChatApp.currentUser?.code === 'TEST-USER');
      await page.evaluate(() => ChatApp.openRoom('test', { quiet: true }));
      await page.waitForFunction(() => ChatApp.currentRoomId === 'test' && !ChatApp.bulkLoading);
      await page.evaluate(() => document.querySelector('#btn-side-settings').click()); await page.click('#settings-tab-account');
      assert.equal(await page.locator('#settings-spotify-connect').isVisible(), true, kind + ' has connection settings');
      if (desktop) await page.locator('#settings-spotify-connect').click();
      await page.waitForFunction(() => ChatApp.getUserSpotifyTrack(ChatApp.currentUser)?.title === 'A Long Song Name');
      assert.equal(await page.locator('#settings-spotify-disconnect').isVisible(), true);
      await page.evaluate(() => { ChatApp.closeModal(); if (document.body.dataset.mobileUi === '1') ChatApp.setMobileDrawer('navigation'); });
      const player = page.locator('#sidebar-spotify-player'); await player.waitFor({ state: 'visible' });
      const layout = await player.evaluate(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width, overflow: el.scrollWidth > el.clientWidth + 1, previous: el.previousElementSibling.id, parent: el.parentElement.className }));
      assert.equal(layout.previous, 'sidebar-call'); assert.match(layout.parent, /sidebar-dock/); assert.ok(layout.height < 165); assert.equal(layout.overflow, false);
      assert.equal(await player.locator('.spotify-player-title').innerText(), 'A Long Song Name'); assert.equal(await player.locator('.spotify-player-album').innerText(), 'Test Album');
      await player.locator('[data-spotify-action="shuffle"]').click(); await page.waitForFunction(() => document.querySelector('[data-spotify-action="shuffle"]').getAttribute('aria-pressed') === 'true');
      await player.locator('[data-spotify-action="repeat"]').click(); await page.waitForFunction(() => document.querySelector('[data-spotify-action="repeat"]').dataset.repeat === 'context');
      await player.locator('.spotify-player-seek').evaluate(el => { el.value = '90000'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => ChatApp.desktopSpotifyState.playback.position === 90000);
      if (!desktop) await page.waitForFunction(() => document.querySelector('.spotify-player-seek').getAttribute('aria-valuetext').startsWith('1:30'));
      await player.locator('[data-spotify-action="next"]').click(); await player.locator('[data-spotify-action="previous"]').click();
      const output = path.resolve(root, '../spotify-checks'); fs.mkdirSync(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'spotify-' + kind + '.png') });
      await player.locator('[data-spotify-action="pause"]').click(); await player.locator('[data-spotify-action="play"]').waitFor({state:'visible'}); assert.equal(await player.isVisible(),true);
      await page.waitForFunction(() => !ChatApp.getUserSpotifyTrack(ChatApp.currentUser));
      await player.locator('[data-spotify-action="play"]').click(); await player.locator('[data-spotify-action="pause"]').waitFor({state:'visible'});
      const commands = desktop ? await page.evaluate(() => __spotifyCommands.map(command => command.action)) : requests.filter(request => request.method !== 'GET').map(request => request.path.split('?')[0].split('/').at(-1));
      for (const command of ['shuffle', 'repeat', 'seek', 'next', 'previous', 'pause']) assert.ok(commands.includes(command), kind + ' dispatched ' + command);
      assert.deepEqual(errors, []); console.log(kind + ': account connection, compact dock, responsive controls, seek, shuffle/repeat and pause cleanup passed'); await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
