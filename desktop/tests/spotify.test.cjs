'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSpotifyConnection, createOAuthRequest, normalizeTrack, validateConfig } = require('../spotify.cjs');
const config = { clientId: 'a'.repeat(32), redirectUri: 'http://127.0.0.1/spotify/callback' };
const id = '1234567890abcdefghijkl';
const scope = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const playing = { is_playing: true, currently_playing_type: 'track', progress_ms: 42000, shuffle_state: false, repeat_state: 'off', device: { id: 'desktop-player', is_restricted: false }, item: { id, name: 'Song', duration_ms: 245000, artists: [{ name: 'Artist' }], album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/album' }] } } };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  const root = path.resolve(__dirname, '../../../spotify-test-work'); fs.mkdirSync(root, { recursive: true });
  const userData = fs.mkdtempSync(path.join(root, 'profile-'));
  const handlers = new Map(), requests = [], schedule = new Map(), external = [], sent = [];
  const ipcMain = { handle: (channel, callback) => handlers.set(channel, callback), removeHandler: channel => handlers.delete(channel) };
  const mainWindow = new EventEmitter();
  const wc = Object.assign(new EventEmitter(), { mainFrame: { url: 'chatapp://app/index.html' }, getURL: () => 'chatapp://app/index.html', isDestroyed: () => false, send: (channel, value) => sent.push({ channel, value }) });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from('ENCRYPTED:' + Buffer.from(text).toString('base64')), decryptString: bytes => Buffer.from(bytes.toString().slice(10), 'base64').toString() };
  let currentTime = 1000000, auth = 0;
  const fake = options.fetchImpl || (async (url, request) => { requests.push({ url, request }); return url.includes('/api/token') ? new Response(JSON.stringify({ access_token: `PRIVATE_ACCESS_${++auth}`, refresh_token: 'PRIVATE_REFRESH', expires_in: 3600, scope }), { status: 200 }) : new Response(JSON.stringify(playing), { status: 200 }); });
  const controller = createSpotifyConnection({ ipcMain, mainWindow, shell: { openExternal: async url => external.push(url) }, safeStorage, userData, config, timers: { setTimeout(fn, delay) { const timer = {}; schedule.set(timer, { fn, delay }); return timer; }, clearTimeout(timer) { schedule.delete(timer); } }, now: () => currentTime, fetchImpl: fake, oauthFactory: async () => ({ codePromise: Promise.resolve('PRIVATE_AUTH_CODE'), verifier: 'PRIVATE_VERIFIER', redirectUri: 'http://127.0.0.1:45000/spotify/callback', cancel() {} }), ...options });
  controller.bindContents(wc);
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const call = (name, value, sender = event) => handlers.get(`chat-spotify:${name}`)(sender, value);
  t.after(() => { controller.destroy(); assert.ok(userData.startsWith(root + path.sep)); fs.rmSync(userData, { recursive: true, force: true }); });
  return { controller, call, event, wc, sent, requests, schedule, external, userData, advance: ms => { currentTime += ms; } };
}
test('PKCE binds loopback callback to a random state and never accepts Unicode or foreign callbacks', async () => {
  let authorization;
  const flow = await createOAuthRequest(config, { openExternal: async url => { authorization = new URL(url); } });
  try {
    assert.equal(authorization.origin, 'https://accounts.spotify.com');
    assert.equal(authorization.searchParams.get('scope'), scope);
    assert.equal(authorization.searchParams.get('code_challenge'), crypto.createHash('sha256').update(flow.verifier).digest('base64url'));
    for (const state of ['wrong', 'é'.repeat(43)]) {
      const invalid = new URL(flow.redirectUri); invalid.search = new URLSearchParams({ state, code: 'bad' }).toString();
      const response = await fetch(invalid); assert.equal(response.status, 400);
    }
    const callback = new URL(flow.redirectUri); callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'correct' }).toString();
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(await flow.codePromise, 'correct');
  } finally { flow.cancel(); }
});
test('a stale browser callback restarts active sign-in without exchanging its mismatched code', async () => {
  let authorization;
  const flow = await createOAuthRequest(config, { openExternal: async url => { authorization = new URL(url); } });
  try {
    const stale = new URL(flow.redirectUri); stale.search = new URLSearchParams({ state: 'z'.repeat(43), code: 'stale-code' });
    const response = await fetch(stale, { redirect: 'manual' });
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), authorization.href);
    const valid = new URL(flow.redirectUri); valid.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'correct-code' });
    await fetch(valid); assert.equal(await flow.codePromise, 'correct-code');
  } finally { flow.cancel(); }
});
test('cancellation stops an OAuth request even while OS browser opening never settles', async () => {
  const controller = new AbortController(); let launch;
  const launched = new Promise(resolve => { launch = resolve; });
  const pending = createOAuthRequest(config, { signal: controller.signal, openExternal: () => { launch(); return new Promise(() => {}); } });
  await launched; controller.abort();
  await assert.rejects(pending, /cancelled/);
});
test('trusted web reload preserves native OAuth and the original verifier', async t => {
  let finish, cancelled = false;
  const f = harness(t, { oauthFactory: async () => ({ codePromise: new Promise(resolve => { finish = resolve; }), verifier: 'original-verifier', redirectUri: config.redirectUri, cancel: () => { cancelled = true; } }) });
  await f.call('user', 'alice'); const pending = f.call('connect'); await flush();
  f.wc.emit('did-start-navigation', {}, 'chatapp://app/index.html', false, true);
  f.wc.emit('did-navigate');
  await f.call('user', 'alice'); assert.equal(f.call('get').connecting, true); assert.equal(cancelled, false);
  finish('matching-code'); await pending; await flush();
  assert.equal(f.call('get').connected, true);
  assert.match(f.requests.find(request => request.url.includes('/api/token')).request.body, /code_verifier=original-verifier/);
});
test('only song metadata is exposed, paused/local/ad data is not published', () => {
  const track = normalizeTrack(playing); assert.equal(track.title, 'Song'); assert.equal(track.url, `https://open.spotify.com/track/${id}`);
  assert.equal(normalizeTrack({ ...playing, is_playing: false }), null);
  assert.equal(normalizeTrack({ ...playing, currently_playing_type: 'ad' }), null);
  assert.equal(normalizeTrack({ ...playing, item: { ...playing.item, is_local: true } }), null);
  assert.equal(normalizeTrack({ ...playing, item: { ...playing.item, album: { images: [{ url: 'https://tracking.invalid/private' }] } } }).image, '');
  assert.throws(() => validateConfig({ ...config, redirectUri: 'https://evil.invalid/spotify/callback' }), /redirect/);
});
test('connection persists encrypted per chat account; logout hides it and disconnect deletes it', async t => {
  const f = harness(t); await f.call('user', 'alice'); await f.call('connect'); await flush();
  assert.equal(f.call('get').track.title, 'Song');
  assert.equal(f.call('get').connected, true);
  const files = fs.readdirSync(f.userData); assert.equal(files.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.userData, files[0]), 'utf8'), /PRIVATE_ACCESS|PRIVATE_REFRESH/);
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE_ACCESS|PRIVATE_REFRESH|PRIVATE_AUTH_CODE|PRIVATE_VERIFIER/);
  await f.call('user', 'bob'); assert.equal(f.call('get').connected, false); assert.equal(f.call('get').track, null);
  await f.call('user', 'alice'); await flush(); assert.equal(f.call('get').connected, true);
  await f.call('disconnect'); assert.equal(f.call('get').track, null); assert.deepEqual(fs.readdirSync(f.userData), []);
  await f.call('user', ''); assert.equal(f.call('get').accountCode, ''); assert.equal(f.schedule.size, 0);
});
test('untrusted frames cannot connect/read native state or launch arbitrary protocols', async t => {
  const f = harness(t);
  assert.equal(f.call('user', 'alice', { ...f.event, senderFrame: { url: 'chatapp://app/index.html' } }), null);
  assert.equal(f.call('get', null, { ...f.event, sender: {} }), null);
  assert.equal(await f.call('open', 'https://evil.invalid/'), false); assert.equal(f.external.length, 0);
  assert.equal(await f.call('open', id), true); assert.deepEqual(f.external, [`spotify:track:${id}`]);
  f.wc.emit('did-start-navigation', {}, 'https://evil.invalid/', false, true);
  assert.equal(f.call('connect'), null);
});

test('password change rekeys the active encrypted Spotify connection without exposing tokens', async t => {
  const f = harness(t); await f.call('user', 'OLD-PASS'); await f.call('connect'); await flush();
  const oldFile = fs.readdirSync(f.userData)[0];
  assert.equal(await f.call('rekey', { from:'OTHER', to:'NEW-PASS' }), false);
  assert.equal(await f.call('rekey', { from:'OLD-PASS', to:'NEW-PASS' }), true);
  await flush();
  assert.equal(f.call('get').accountCode, 'NEW-PASS'); assert.equal(f.call('get').connected, true);
  assert.equal(fs.existsSync(path.join(f.userData, oldFile)), false); assert.equal(fs.readdirSync(f.userData).length, 1);
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE_ACCESS|PRIVATE_REFRESH/);
  await f.call('user', 'OLD-PASS'); assert.equal(f.call('get').connected, false);
  await f.call('user', 'NEW-PASS'); assert.equal(f.call('get').connected, true);
});
test('native track links fall back to Spotify web when no desktop protocol is installed', async t => {
  const opened = [], f = harness(t, { shell: { openExternal: async url => { opened.push(url); if (url.startsWith('spotify:')) throw Error('No handler'); } } });
  await f.call('open', id); assert.deepEqual(opened, [`spotify:track:${id}`, `https://open.spotify.com/track/${id}`]);
});
test('a rate-limited Spotify response honors Retry-After and clears stale music', async t => {
  let polls = 0;
  const f = harness(t, { fetchImpl: async url => url.includes('/api/token') ? new Response(JSON.stringify({ access_token: 'private', refresh_token: 'private', expires_in: 3600 })) : ++polls === 1 ? new Response(JSON.stringify(playing)) : new Response('', { status: 429, headers: { 'retry-after': '90' } }) });
  await f.call('user', 'alice'); await f.call('connect'); await flush();
  const timer = [...f.schedule.values()][0]; await timer.fn(); await flush();
  assert.equal(f.call('get').track, null); assert.match(f.call('get').error, /limiting/); assert.equal([...f.schedule.values()].at(-1).delay, 90000);
});
test('pending OAuth cannot reconnect or persist tokens after logout', async t => {
  let finish, cancelled = false;
  const f = harness(t, { oauthFactory: async () => ({ codePromise: new Promise(resolve => { finish = resolve; }), verifier: 'private', redirectUri: config.redirectUri, cancel: () => { cancelled = true; } }) });
  await f.call('user', 'alice'); const pending = f.call('connect'); await flush();
  await f.call('user', ''); finish('private'); await pending;
  assert.equal(cancelled, true); assert.equal(f.call('get').connected, false); assert.equal(f.requests.length, 0); assert.deepEqual(fs.readdirSync(f.userData), []);
});
test('a late playback response cannot publish the previous account after switching', async t => {
  let finish;
  const f = harness(t, { fetchImpl: async url => url.includes('/api/token') ? new Response(JSON.stringify({ access_token: 'private', refresh_token: 'private', expires_in: 3600 })) : new Promise(resolve => { finish = resolve; }) });
  await f.call('user', 'alice'); await f.call('connect'); await flush();
  await f.call('user', 'bob'); finish(new Response(JSON.stringify(playing))); await flush();
  assert.equal(f.call('get').accountCode, 'bob'); assert.equal(f.call('get').track, null); assert.equal(f.schedule.size, 0);
});

test('native controls expose only playback metadata and serialize seek, shuffle, repeat, skip and pause', async t => {
  const requests = []; let finishFirst;
  const f = harness(t, { fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    if (url.includes('/api/token')) return Response.json({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600, scope });
    if (options.method === 'GET') return Response.json(playing);
    if (!finishFirst) await new Promise(resolve => { finishFirst = resolve; });
    return new Response(null, { status: 204 });
  } });
  await f.call('user', 'alice'); await f.call('connect'); await flush();
  assert.equal(f.call('get').supportsPlayback, true); assert.equal(f.call('get').needsReconnect, false);
  assert.equal(f.call('get').playback.duration, 245000);
  const seek = f.call('control', { action: 'seek', position: 112000 }), shuffle = f.call('control', { action: 'shuffle' }); await flush();
  assert.equal(f.call('get').playback.position, 112000); assert.equal(f.call('get').playback.shuffle, true);
  assert.equal(requests.length, 3, 'next command waits for first HTTP response');
  finishFirst(); await Promise.all([seek, shuffle]);
  for (const action of ['repeat', 'repeat', 'repeat', 'previous', 'next', 'pause']) await f.call('control', { action });
  const routes = requests.slice(2).map(request => request.url);
  assert.match(routes[0], /seek\?position_ms=112000&device_id=desktop-player/); assert.match(routes[1], /shuffle\?state=true/);
  assert.match(routes[2], /repeat\?state=context/); assert.match(routes[3], /repeat\?state=track/); assert.match(routes[4], /repeat\?state=off/);
  assert.equal(requests.find(request => request.url.includes('/previous')).method, 'POST');
  assert.equal(requests.find(request => request.url.includes('/pause')).method, 'PUT'); assert.equal(f.call('get').track, null);
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE_ACCESS|PRIVATE_REFRESH/);
  assert.equal(f.call('control', { action: 'play' }, { ...f.event, senderFrame: {} }), null);
  await assert.rejects(f.call('control', { action: 'https://evil.invalid/' }), /not supported/);
  await assert.rejects(f.call('control', { action: 'seek', position: NaN }), /must be a number/);
});

test('native playback rejects missing scopes, allows reconnection and rolls back a denied action', async t => {
  let authorizations = 0, denied = false;
  const f = harness(t, { fetchImpl: async (url, options) => {
    if (url.includes('/api/token')) return Response.json({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600, scope: ++authorizations > 1 ? scope : 'user-read-currently-playing' });
    if (options.method === 'GET') return Response.json(playing);
    denied = true; return new Response(null, { status: 403 });
  } });
  await f.call('user', 'alice'); await f.call('connect'); await flush();
  assert.equal(f.call('get').needsReconnect, true); await assert.rejects(f.call('control', { action: 'pause' }), /Reconnect/); assert.equal(denied, false);
  await f.call('connect'); await flush(); assert.equal(f.call('get').needsReconnect, false);
  await assert.rejects(f.call('control', { action: 'pause' }), /Premium/);
  assert.equal(f.call('get').track.title, 'Song'); assert.equal(f.call('get').playback.playing, true);
});

test('all native controls accept successful empty and non-JSON acknowledgements without false rollback', async t => {
  for (const body of ['', '-command accepted', 'OK']) {
    const f = harness(t, { fetchImpl: async (url, options) => {
      if (url.includes('/api/token')) return Response.json({ access_token: 'private', refresh_token: 'private', expires_in: 3600, scope });
      return options.method === 'GET' ? Response.json(playing) : new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    } });
    await f.call('user', 'alice'); await f.call('connect'); await flush();
    for (const action of ['seek', 'shuffle', 'repeat', 'next', 'previous', 'pause', 'play']) await f.call('control', { action, position: 123000 });
    assert.equal(f.call('get').error, '');
    assert.equal(f.call('get').playback.shuffle, true);
    assert.equal(f.call('get').playback.repeat, 'context');
    assert.equal(f.call('get').playback.playing, true);
  }
});

test('native app pause preserves private player metadata and an external pause clears it', async t => {
  let isPlaying = true;
  const f = harness(t, { fetchImpl:async (url, request) => {
    if (url.includes('/api/token')) return Response.json({access_token:'token',refresh_token:'refresh',expires_in:3600,scope});
    if (request.method !== 'GET') { if(url.includes('/pause')) isPlaying=false; if(url.includes('/play')) isPlaying=true; return new Response(null,{status:204}); }
    return Response.json({...playing,is_playing:isPlaying});
  }});
  await f.call('user','alice'); await f.call('connect'); await flush();
  await f.call('control',{action:'pause'}); assert.equal(f.call('get').track,null); assert.equal(f.call('get').playerTrack.title,'Song');
  const poll=()=>{const entry=[...f.schedule.values()].at(-1);entry.fn();return flush();};
  await poll(); assert.equal(f.call('get').playerTrack.title,'Song');
  await f.call('control',{action:'play'}); await poll(); assert.equal(f.call('get').track.title,'Song');
  isPlaying=false; await poll(); assert.equal(f.call('get').playerTrack,null);
});
