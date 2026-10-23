'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { webcrypto } = require('node:crypto');
const flush = () => new Promise(resolve => setImmediate(resolve));
const track = { id: '1234567890abcdefghijkl', title: 'Song', artist: 'Artist', album: 'Album', image: 'https://i.scdn.co/image/cover' };
function harness({ desktop = true, href = 'https://chat.example/app/', storage = new Map(), fetchImpl = async () => new Response(null, { status: 204 }) } = {}) {
  const initializers = [], timers = new Map(), refs = new Map(), writes = [], events = {};
  let now = 1000000, sessionId = 0, renders = 0, profiles = 0;
  const App = { register: (_id, init) => initializers.push(init), appPresenceNow: () => now, getUserHtmlActivity: () => null, getUserActivityItems: () => [], startAppPresence() {}, stopAppPresence() {}, renderOnlineIndicator: () => ++renders, refreshOpenUserProfileCard: () => ++profiles, liveUserCache: new Map(), $: () => null, escapeHtml: text => String(text).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`), escapeAttr: text => String(text).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`), firebase: { database: { ServerValue: { TIMESTAMP: { '.sv': 'timestamp' } } } } };
  const bridge = { setUser: async accountCode => ({ accountCode, configured: true, connected: false }), onChange(callback) { this.change = callback; } };
  App.db = { ref(key) {
    if (!refs.has(key)) refs.set(key, { key, set: async value => writes.push({ key, value }), update: async value => writes.push({key,value,kind:'update'}), remove: async () => writes.push({ key, value: null }), onDisconnect: () => ({ remove: async () => {}, cancel: async () => {} }), on(_event, callback) { this.callback = callback; }, off() { this.callback = null; } });
    return refs.get(key);
  } };
  class Clock extends Date { static now() { return now; } }
  const navigations = [], context = { ChatApp: App, console, URL, URLSearchParams, AbortController, TextEncoder, Uint8Array, btoa, fetch: fetchImpl, document: { addEventListener() {} }, window: { chatDesktopSpotify: desktop ? bridge : undefined, location: { href, assign: url => navigations.push(url) }, history: { replaceState: (_state, _title, url) => navigations.push(url) }, sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, addEventListener: (name, callback) => { events[name] = callback; } }, Date: Clock, crypto: { randomUUID: () => `spotify-${++sessionId}`, getRandomValues: value => webcrypto.getRandomValues(value), subtle: webcrypto.subtle }, queueMicrotask, setInterval: (fn, delay) => { const id = {}; timers.set(id, { fn, delay, type: 'interval' }); return id; }, clearInterval: id => timers.delete(id), setTimeout: (fn, delay) => { const id = {}; timers.set(id, { fn, delay, type: 'timeout' }); return id; }, clearTimeout: id => timers.delete(id) };
  for (const file of ['game-presence.js', 'spotify-presence.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/chat', file), 'utf8'), context);
  initializers.forEach(init => init());
  return { App, bridge, refs, writes, events, timers, navigations, storage, advance: ms => { now += ms; }, get now() { return now; }, get renders() { return renders; }, get profiles() { return profiles; } };
}
test('web sees listening metadata and exposes Spotify connection settings', () => {
  const f = harness({ desktop: false });
  const user = { code: 'alice', spotifySessions: { desktop: { track, updatedAt: f.now } } };
  assert.equal(f.App.getUserSpotifyTrack(user).title, 'Song');
  assert.equal(f.App.getUserActivityItems(user)[0].kind, 'spotify');
  assert.match(f.App.spotifyAccountSettingsHTML(), /id="settings-spotify-connect"/);
  f.App.currentUser = user; f.App.startSpotifyPresence(); assert.equal(f.writes.length, 0);
});

const playerState = (overrides = {}) => ({ is_playing: true, currently_playing_type: 'track', progress_ms: 32000, shuffle_state: false, repeat_state: 'off', device: { id: 'device', is_restricted: false }, item: { id: track.id, name: track.title, artists: [{ name: track.artist }], album: { name: track.album, images: [{ url: track.image }] }, duration_ms: 240000 }, ...overrides });
const privateTokens = { accessToken: 'PRIVATE_ACCESS', refreshToken: 'PRIVATE_REFRESH', expiresAt: 9999999, clientId: '0aff8efba08a4dc684eecd5dafe5bf8c', scope: 'user-read-currently-playing user-read-playback-state user-modify-playback-state' };
test('web PKCE authorization binds state, scopes and same-origin callback without a client secret', async () => {
  const f = harness({ desktop: false }); await f.App.webSpotify.setUser('alice'); await f.App.webSpotify.connect();
  const url = new URL(f.navigations.at(-1)), flow = JSON.parse(f.storage.get('chat.spotify.pkce.v1'));
  assert.equal(url.origin, 'https://accounts.spotify.com'); assert.equal(url.searchParams.get('redirect_uri'), 'https://chat.example/app/');
  assert.equal(url.searchParams.get('state'), flow.state); assert.match(flow.verifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.match(url.searchParams.get('scope'), /user-modify-playback-state/);
  assert.equal(url.searchParams.has('client_secret'), false); assert.equal(f.writes.length, 0);
});
test('concurrent web Connect clicks create one PKCE flow and an interrupted navigation expires', async () => {
  const f = harness({ desktop: false }); await f.App.webSpotify.setUser('alice');
  await Promise.all([f.App.webSpotify.connect(), f.App.webSpotify.connect()]);
  assert.equal(f.navigations.length, 1);
  const timeout = [...f.timers.values()].find(timer => timer.delay === 180000);
  assert.ok(timeout); timeout.fn();
  assert.equal((await f.App.webSpotify.getState()).connecting, false);
  assert.match((await f.App.webSpotify.getState()).error, /did not finish/);
});
test('OAuth callback exchanges only a valid matching state and cleans the callback URL', async () => {
  const storage = new Map(), requests = [], initial = harness({ desktop: false, storage });
  await initial.App.webSpotify.setUser('alice'); await initial.App.webSpotify.connect();
  const flow = JSON.parse(storage.get('chat.spotify.pkce.v1'));
  const forged = harness({ desktop: false, storage, href: 'https://chat.example/app/?code=secret&state=wrong', fetchImpl: async () => { throw Error('must not exchange'); } });
  await forged.App.webSpotify.getState(); assert.ok(storage.has('chat.spotify.pkce.v1'));
  const f = harness({ desktop: false, storage, href: `https://chat.example/app/?code=secret&state=${flow.state}`, fetchImpl: async (url, options) => { requests.push({ url, ...options }); return url.includes('/api/token') ? Response.json({ access_token: 'PRIVATE_ACCESS', refresh_token: 'PRIVATE_REFRESH', expires_in: 3600, scope: privateTokens.scope }) : Response.json(playerState()); } });
  await f.App.webSpotify.setUser('alice'); await flush();
  assert.equal((await f.App.webSpotify.getState()).track.title, 'Song'); assert.equal(storage.has('chat.spotify.pkce.v1'), false);
  assert.equal(f.navigations[0], 'https://chat.example/app/'); assert.match(requests[0].body, /code_verifier=/);
  assert.doesNotMatch(JSON.stringify(await f.App.webSpotify.getState()), /PRIVATE_|refreshToken|accessToken/);
});
test('web playback commands are optimistic and serialized, while only public music reaches Firebase', async () => {
  const storage = new Map([['chat.spotify.tokens.v1:alice', JSON.stringify(privateTokens)]]), requests = []; let release;
  const f = harness({ desktop: false, storage, fetchImpl: async (url, options) => { requests.push({ url, ...options }); if (options.method !== 'GET' && !release) await new Promise(resolve => { release = resolve; }); return options.method === 'GET' ? Response.json(playerState()) : new Response(null, { status: 204 }); } });
  f.App.currentUser = { code: 'alice' }; f.App.startSpotifyPresence(); await flush();
  f.refs.get('.info/connected').callback({ val: () => true }); await flush();
  const seek = f.App.webSpotify.control('seek', 120000), shuffle = f.App.webSpotify.control('shuffle'); await flush();
  assert.equal((await f.App.webSpotify.getState()).playback.position, 120000); assert.equal((await f.App.webSpotify.getState()).playback.shuffle, true);
  assert.equal(requests.filter(request => request.method !== 'GET').length, 1); release(); await Promise.all([seek, shuffle]);
  assert.match(requests[1].url, /seek\?position_ms=120000&device_id=device/); assert.match(requests[2].url, /shuffle\?state=true&device_id=device/);
  await f.App.webSpotify.control('repeat'); assert.equal((await f.App.webSpotify.getState()).playback.repeat, 'context');
  await f.App.webSpotify.control('pause'); assert.equal((await f.App.webSpotify.getState()).track, null);
  await flush(); assert.equal(f.writes.at(-1).value, null); assert.doesNotMatch(JSON.stringify(f.writes), /PRIVATE_|refreshToken|accessToken/);
});
test('rate limits honor Retry-After and a rejected pause restores the playing track', async () => {
  const storage = new Map([['chat.spotify.tokens.v1:alice', JSON.stringify(privateTokens)]]); let calls = 0;
  const f = harness({ desktop: false, storage, fetchImpl: async (_url, options) => { ++calls; return options.method === 'GET' ? Response.json(playerState()) : new Response(null, { status: 429, headers: { 'Retry-After': '12' } }); } });
  await f.App.webSpotify.setUser('alice'); await flush();
  await assert.rejects(f.App.webSpotify.control('pause'), /Spotify is busy/);
  assert.equal((await f.App.webSpotify.getState()).track.title, 'Song');
  await assert.rejects(f.App.webSpotify.control('next'), /Spotify is busy/); assert.equal(calls, 2);
  assert.ok([...f.timers.values()].some(timer => timer.delay === 12000));
});
test('logout rejects late playback and password migration moves only tab-private authorization', async () => {
  const storage = new Map([['chat.spotify.tokens.v1:alice', JSON.stringify(privateTokens)]]); let release;
  const f = harness({ desktop: false, storage, fetchImpl: async () => new Promise(resolve => { release = () => resolve(Response.json(playerState())); }) });
  await f.App.webSpotify.setUser('alice'); await flush(); await f.App.webSpotify.setUser(''); release(); await flush();
  assert.equal((await f.App.webSpotify.getState()).track, null); assert.equal((await f.App.webSpotify.getState()).connected, false);
  assert.equal(await f.App.webSpotify.rekeyUser('alice', 'new-alice'), true); assert.equal(storage.has('chat.spotify.tokens.v1:alice'), false); assert.ok(storage.has('chat.spotify.tokens.v1:new-alice'));
});
test('desktop publishes only normalized track fields and removes its own session on disconnect/logout', async () => {
  const f = harness(); f.App.currentUser = { code: 'alice', spotifySessions: { other: { track, updatedAt: f.now } } }; f.App.startSpotifyPresence(); await flush();
  f.refs.get('.info/connected').callback({ val: () => true }); await flush();
  f.bridge.change({ accountCode: 'alice', connected: true, configured: true, track: { ...track, refreshToken: 'SECRET', accessToken: 'SECRET' } }); await flush();
  const live = f.writes.at(-1); assert.equal(live.key, 'users/alice/spotifySessions/spotify-1'); assert.equal(live.value.track.title, 'Song'); assert.doesNotMatch(JSON.stringify(f.writes), /SECRET|refreshToken|accessToken/);
  assert.equal(f.App.currentUser.spotifySessions.other.track.title, 'Song');
  const count = f.writes.length; await f.App.writeSpotifyPresence(); assert.equal(f.writes.length, count, 'same track is not rewritten on each native poll');
  f.bridge.change({ accountCode: 'alice', connected: false }); await flush(); assert.equal(f.writes.at(-1).value, null);
  f.App.stopSpotifyPresence(); await flush(); assert.equal(f.App.spotifyPresenceSession, null); assert.equal(f.writes.at(-1).key, live.key);
  const stopped = f.writes.length; f.bridge.change({ accountCode: 'alice', connected: true, track }); await flush(); assert.equal(f.writes.length, stopped);
});
test('remote music expires and repaints an open profile without another database event', async () => {
  const f = harness({ desktop: false }), user = { code: 'alice', spotifySessions: { desktop: { track, updatedAt: f.now } } };
  f.App.liveUserCache.set('alice', user); f.App.userProfileOpen = true; f.App.userProfilePinnedCode = 'alice';
  f.App.observeActivityPresenceUser(user); await flush();
  const timer = [...f.timers.values()].find(timer => timer.type === 'timeout'); assert.equal(timer.delay, 90001);
  f.advance(90001); timer.fn(); await flush();
  assert.equal(f.App.getUserSpotifyTrack(user), null); assert.equal(f.renders, 1); assert.equal(f.profiles, 1);
});
test('unsafe track links/images are rejected and rendered track text is escaped', () => {
  const f = harness();
  assert.equal(f.App.normalizeSpotifyTrack({ ...track, id: 'javascript:bad' }), null);
  const safe = f.App.normalizeSpotifyTrack({ ...track, title: '<img onerror="bad">', image: 'https://evil.invalid/x', url: 'javascript:alert(1)' });
  assert.equal(safe.image, ''); assert.match(safe.url, /^https:\/\/open.spotify.com\/track\//);
  const html = f.App.spotifyProfileMarkup(safe); assert.doesNotMatch(html, /<img onerror|javascript:|evil\.invalid/); assert.match(html, /&#60;img/);
});

test('all web controls accept non-JSON success responses without errors', async () => {
  const storage = new Map([['chat.spotify.tokens.v1:alice', JSON.stringify(privateTokens)]]);
  const f = harness({ desktop: false, storage, fetchImpl: async (_url, options) => options.method === 'GET' ? Response.json(playerState()) : new Response('-accepted', { status: 200 }) });
  await f.App.webSpotify.setUser('alice'); await flush();
  for (const action of ['seek', 'shuffle', 'repeat', 'next', 'previous', 'pause', 'play']) await f.App.webSpotify.control(action, 100000);
  const state = await f.App.webSpotify.getState();
  assert.equal(state.error, ''); assert.equal(state.playback.shuffle, true); assert.equal(state.playback.repeat, 'context');
});

test('app pause preserves a private playable track until an external resume then pause', async () => {
  const storage = new Map([['chat.spotify.tokens.v1:alice', JSON.stringify(privateTokens)]]); let playing = true;
  const f = harness({ desktop:false, storage, fetchImpl:async (url, options) => {
    if (options.method !== 'GET') { if (new URL(url).pathname.endsWith('/pause')) playing=false; if (new URL(url).pathname.endsWith('/play')) playing=true; return new Response(null,{status:204}); }
    return Response.json(playerState({is_playing:playing}));
  }});
  await f.App.webSpotify.setUser('alice'); await flush();
  await f.App.webSpotify.control('pause'); await f.App.webSpotify.refresh();
  let state = await f.App.webSpotify.getState(); assert.equal(state.track,null); assert.equal(state.playerTrack.title,'Song'); assert.equal(state.playback.playing,false);
  await f.App.webSpotify.control('play'); await f.App.webSpotify.refresh();
  state = await f.App.webSpotify.getState(); assert.equal(state.track.title,'Song');
  playing=false; await f.App.webSpotify.refresh(); state=await f.App.webSpotify.getState();
  assert.equal(state.track,null); assert.equal(state.playerTrack,null);
});

test('unchanged Spotify tracks and detected games renew a compact timestamp lease', async () => {
  const f=harness();
  f.App.currentUser={code:'alice'};
  f.App.startSpotifyPresence(); await flush();
  f.refs.get('.info/connected').callback({val:()=>true}); await flush();
  f.App.acceptDesktopSpotify({accountCode:'alice',connected:true,track}); await flush();
  const count=f.writes.length;
  await f.App.writeSpotifyPresence(); assert.equal(f.writes.length,count);
  f.advance(30001); await f.App.writeSpotifyPresence();
  assert.equal(f.writes.at(-1).kind,'update'); assert.deepEqual(Object.keys(f.writes.at(-1).value),['updatedAt']);
  const gameRef=f.App.db.ref('users/alice/gameActivitySessions/test');
  f.App.gamePresenceSession={code:'alice',id:'test',ready:true,connected:true,ref:gameRef};
  f.App.desktopDetectedGames=[{title:'Minecraft'}];
  await f.App.writeGamePresence();
  const gamesCount=f.writes.length;
  await f.App.writeGamePresence(); assert.equal(f.writes.length,gamesCount);
  f.advance(30001); await f.App.writeGamePresence();
  assert.equal(f.writes.at(-1).kind,'update'); assert.deepEqual(Object.keys(f.writes.at(-1).value),['updatedAt']);
});
