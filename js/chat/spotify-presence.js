/* Firebase receives public song metadata only, on a session-owned lease.
 * Native tokens stay in the native process; browser PKCE tokens stay in this tab. */
(function (App) {
  "use strict";
  const TTL = 90000;
  const now = () => App.appPresenceNow?.() || Date.now();
  const SPOTIFY_CLIENT_ID = '0aff8efba08a4dc684eecd5dafe5bf8c';
  const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
  const spotifyBridge = () => window.chatDesktopSpotify || App.webSpotify;
  const tokenKey = code => `chat.spotify.tokens.v1:${code}`;
  const flowKey = 'chat.spotify.pkce.v1';
  function readPrivate(key) { try { return JSON.parse(window.sessionStorage.getItem(key) || 'null'); } catch { return null; } }
  function writePrivate(key, value) { try { if (value) window.sessionStorage.setItem(key, JSON.stringify(value)); else window.sessionStorage.removeItem(key); return true; } catch { return false; } }
  const elapsed = ms => { const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  App.normalizeSpotifyPlayback = function (value) {
    if (!value || typeof value !== 'object') return null;
    const duration = Math.max(0, Math.min(86400000, Number(value.duration) || 0));
    const measuredAt = Number(value.measuredAt);
    return { playing: !!value.playing, duration, position: Math.max(0, Math.min(duration, Number(value.position) || 0)), measuredAt: measuredAt > 0 && measuredAt <= Date.now() ? measuredAt : Date.now(), shuffle: !!value.shuffle, repeat: ['off', 'context', 'track'].includes(value.repeat) ? value.repeat : 'off', deviceId: String(value.deviceId || '').slice(0, 200), restricted: !!value.restricted, disallows: { ...(value.disallows || {}) } };
  };
  App.createWebSpotifyConnection = function () {
    let pausedInApp = null;
    let accountCode = '', tokens = null, playback = null, track = null, error = '', connecting = false, generation = 0, timer, connectTimer, refreshing, polling = false, revision = 0, retryAfter = 0, pendingCommands = 0, commands = Promise.resolve();
    const listeners = new Set();
    let redirectUri = '';
    try {
      const current = new URL(window.location.href);
      const redirect = new URL(window.CHAT_SPOTIFY_CONFIG?.redirectUri || './', current);
      if (redirect.origin === current.origin && (redirect.protocol === 'https:' || redirect.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(redirect.hostname))) { redirect.search = ''; redirect.hash = ''; redirectUri = redirect.href; }
    } catch {}
    const clientId = String(window.CHAT_SPOTIFY_CONFIG?.clientId || SPOTIFY_CLIENT_ID);
    const configured = () => !!redirectUri && !!globalThis.crypto?.subtle && /^[a-f\d]{32}$/i.test(clientId);
    const snapshot = () => ({ accountCode, configured: configured(), connected: !!tokens, connecting, track: playback?.playing ? track : null, playerTrack: playback?.playing || pausedInApp ? track : null, playback, supportsPlayback: true, needsReconnect: !!tokens && !tokens.scope.split(' ').includes('user-modify-playback-state'), error });
    const emit = () => { const value = snapshot(); listeners.forEach(listener => listener(value)); return value; };
    const active = epoch => epoch === generation && !!accountCode;
    const save = () => { if (accountCode) writePrivate(tokenKey(accountCode), tokens); };
    function applyPlayback(value) {
      const item = value?.item;
      if (!pausedInApp || !item || item.id !== pausedInApp.id || String(value.device?.id || '') !== pausedInApp.deviceId || value.is_playing && (pausedInApp.confirmed || Date.now() - pausedInApp.at > 3000)) pausedInApp = null;
      else if (!value.is_playing) pausedInApp.confirmed = true;
      track = !item?.is_local && value?.currently_playing_type === 'track' ? App.normalizeSpotifyTrack({ id: item?.id, title: item?.name, artist: (item?.artists || []).map(artist => artist.name).join(', '), album: item?.album?.name, image: item?.album?.images?.[0]?.url }) : null;
      playback = track ? App.normalizeSpotifyPlayback({ playing: value.is_playing, duration: item.duration_ms, position: value.progress_ms, shuffle: value.shuffle_state, repeat: value.repeat_state, deviceId: value.device?.id, restricted: value.device?.is_restricted, disallows: value.actions?.disallows }) : null;
    }
    async function fetchWithDeadline(url, options = {}) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        // Keep the deadline alive while the response body is being received.
        const text = await response.text();
        return { ok: response.ok, status: response.status, headers: response.headers, json: async () => JSON.parse(text) };
      }
      finally { clearTimeout(timeout); }
    }
    async function exchange(body, epoch, owner) {
      const response = await fetchWithDeadline('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, ...body }).toString() });
      const value = await response.json().catch(() => ({}));
      if (!active(epoch) || accountCode !== owner) throw new Error('Spotify account changed.');
      if (!response.ok || !value.access_token) { if (value.error === 'invalid_grant') { tokens = null; save(); } throw new Error('Spotify authorization expired. Reconnect Spotify in Settings.'); }
      tokens = { accessToken: String(value.access_token), refreshToken: String(value.refresh_token || tokens?.refreshToken || ''), expiresAt: Date.now() + Math.max(60, Number(value.expires_in) || 3600) * 1000, scope: String(value.scope || tokens?.scope || ''), clientId };
      save(); return tokens;
    }
    async function accessToken(force = false) {
      if (!tokens) throw new Error('Connect Spotify in Settings first.');
      if (!force && tokens.expiresAt > Date.now() + 30000) return tokens.accessToken;
      if (!refreshing) {
        const epoch = generation, owner = accountCode, refreshToken = tokens.refreshToken;
        const job = exchange({ grant_type: 'refresh_token', refresh_token: refreshToken }, epoch, owner);
        refreshing = job;
        job.finally(() => { if (refreshing === job) refreshing = null; }).catch(() => {});
      }
      return (await refreshing).accessToken;
    }
    async function request(path, method = 'GET') {
      if (Date.now() < retryAfter) throw new Error('Spotify is busy. Controls will be available again shortly.');
      const epoch = generation;
      let response = await fetchWithDeadline(`https://api.spotify.com/v1/me/player${path}`, { method, headers: { Authorization: `Bearer ${await accessToken()}` } });
      if (!active(epoch)) return null;
      if (response.status === 401) response = await fetchWithDeadline(`https://api.spotify.com/v1/me/player${path}`, { method, headers: { Authorization: `Bearer ${await accessToken(true)}` } });
      if (!active(epoch)) return null;
      if (response.status === 429) { retryAfter = Date.now() + Math.max(1, Number(response.headers.get('Retry-After')) || 5) * 1000; throw new Error('Spotify is busy. Controls will be available again shortly.'); }
      if (response.status === 403) throw new Error('Spotify denied playback access. Reconnect to allow controls; playback controls require Spotify Premium and an allowed account.');
      if (response.status === 404) throw new Error('Play a song on a Spotify device first.');
      if (!response.ok) throw new Error('Spotify could not complete that action. Try again.');
      if (method !== 'GET' || response.status === 204) { await response.body?.cancel?.(); return null; }
      try { return await response.json(); }
      catch { throw new Error('Spotify returned an unreadable playback state. Try again.'); }
    }
    function schedule(delay) { clearTimeout(timer); if (tokens && accountCode) timer = setTimeout(() => void poll(), Math.max(delay, retryAfter - Date.now())); }
    async function poll() {
      if (!tokens || !accountCode || polling || pendingCommands) return;
      polling = true; const epoch = generation, observedRevision = revision;
      try { const value = await request(''); if (active(epoch) && revision === observedRevision) { applyPlayback(value); error = ''; emit(); } }
      catch (failure) { if (active(epoch)) { error = failure.message; if (!playback || Date.now() - playback.measuredAt > 15000) { playback = null; track = null; } emit(); } }
      finally { polling = false; if (tokens && accountCode) schedule(document.hidden ? 12000 : playback?.playing ? 1500 : 3000); }
    }
    const callback = (async () => {
      let url; try { url = new URL(window.location.href); } catch { return; }
      const state = url.searchParams.get('state'), code = url.searchParams.get('code'), denied = url.searchParams.get('error');
      if (!state || !code && !denied) return;
      const flow = readPrivate(flowKey);
      ['state', 'code', 'error', 'error_description'].forEach(key => url.searchParams.delete(key));
      window.history?.replaceState(null, '', url.href);
      if (!flow || state !== flow.state) {
        accountCode = String(flow?.accountCode || '');
        error = 'This Spotify sign-in belongs to an earlier attempt. Connect Spotify again from this tab.';
        emit(); return;
      }
      writePrivate(flowKey, null);
      accountCode = String(flow.accountCode || ''); connecting = true;
      const epoch = ++generation;
      try {
        if (Date.now() - flow.createdAt > 600000 || !accountCode || flow.redirectUri !== redirectUri) throw new Error('Spotify sign-in expired. Connect again.');
        if (denied) throw new Error('Spotify connection was cancelled.');
        await exchange({ grant_type: 'authorization_code', code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier }, epoch, accountCode);
        error = '';
      } catch (failure) { error = failure.message; }
      finally { connecting = false; emit(); }
    })();
    const adapter = {
      async setUser(code) {
        await callback;
        const owner = String(code || '');
        if (owner === accountCode) { if (tokens) void poll(); return emit(); }
        ++generation; ++revision; clearTimeout(timer); clearTimeout(connectTimer); refreshing = null;
        accountCode = owner; pausedInApp = null; track = null; playback = null; error = ''; connecting = false;
        const saved = owner ? readPrivate(tokenKey(owner)) : null;
        tokens = saved?.clientId === clientId && typeof saved.accessToken === 'string' && typeof saved.refreshToken === 'string' ? saved : null;
        if (tokens) void poll(); return emit();
      },
      async connect() {
        if (!configured()) throw new Error('Open the hosted HTTPS web app to connect Spotify.');
        if (!accountCode) throw new Error('Sign in to Chat App first.');
        if (connecting) return snapshot();
        const epoch = generation, owner = accountCode;
        connecting = true; error = ''; emit();
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => {
          if (!active(epoch) || !connecting) return;
          connecting = false; error = 'Spotify sign-in did not finish. Connect again to retry.'; emit();
        }, 180000);
        try {
        const random = size => { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
        const verifier = random(64), state = random(32), challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (!active(epoch) || owner !== accountCode || !connecting) return snapshot();
        if (!writePrivate(flowKey, { accountCode, verifier, state, redirectUri, createdAt: Date.now() })) throw new Error('Allow session storage in this browser to connect Spotify.');
        const url = new URL('https://accounts.spotify.com/authorize');
        url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: SPOTIFY_SCOPES, state, code_challenge_method: 'S256', code_challenge: challenge }).toString();
        window.location.assign(url.href); return snapshot();
        } catch (failure) {
          if (active(epoch)) { connecting = false; clearTimeout(connectTimer); error = failure.message || 'Could not open Spotify sign-in. Try again.'; emit(); }
          throw failure;
        }
      },
      async disconnect() { ++generation; ++revision; clearTimeout(timer); clearTimeout(connectTimer); tokens = null; refreshing = null; pausedInApp = null; track = null; playback = null; error = ''; connecting = false; save(); writePrivate(flowKey, null); return emit(); },
      async rekeyUser(from, to) {
        const previous = String(from || ''), next = String(to || '');
        if (!previous || !next) return false;
        const saved = previous === accountCode && tokens ? tokens : readPrivate(tokenKey(previous));
        if (saved && !writePrivate(tokenKey(next), saved)) return false;
        writePrivate(tokenKey(previous), null);
        if (accountCode === previous) { ++generation; ++revision; accountCode = next; refreshing = null; schedule(0); }
        return true;
      },
      getState: async () => snapshot(), onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      refresh: poll,
      async control(action, value) {
        if (!tokens) throw new Error('Connect Spotify in Settings first.');
        if (!tokens.scope.split(' ').includes('user-modify-playback-state')) throw new Error('Reconnect Spotify in Settings to allow playback controls.');
        if (!playback || playback.restricted) throw new Error('Play a song on a controllable Spotify device first.');
        const oldPause = pausedInApp;
        const old = { ...playback }, epoch = generation, commandRevision = ++revision;
        const device = playback.deviceId ? `device_id=${encodeURIComponent(playback.deviceId)}` : '';
        let path, method = 'PUT';
        if (action === 'seek') { const position = Math.round(Math.max(0, Math.min(playback.duration, Number(value) || 0))); path = `/seek?position_ms=${position}`; playback.position = position; playback.measuredAt = Date.now(); }
        else if (action === 'shuffle') { playback.shuffle = !playback.shuffle; path = `/shuffle?state=${playback.shuffle}`; }
        else if (action === 'repeat') { playback.repeat = { off: 'context', context: 'track', track: 'off' }[playback.repeat]; path = `/repeat?state=${playback.repeat}`; }
        else if (action === 'play' || action === 'pause') { pausedInApp = action === 'pause' && track ? { id: track.id, deviceId: playback.deviceId || '', at: Date.now(), confirmed: false } : null; playback.playing = action === 'play'; playback.position = Math.min(playback.duration, playback.position + (old.playing ? Date.now() - old.measuredAt : 0)); playback.measuredAt = Date.now(); path = `/${action}`; }
        else if (action === 'next' || action === 'previous') { path = `/${action}`; method = 'POST'; }
        else throw new Error('Unsupported Spotify control.');
        if (device) path += `${path.includes('?') ? '&' : '?'}${device}`;
        clearTimeout(timer); ++pendingCommands; emit();
        const command = commands.catch(() => {}).then(async () => { if (!active(epoch)) return; await request(path, method); });
        commands = command;
        try { await command; }
        catch (failure) { if (active(epoch)) { if (revision === commandRevision) { playback = old; pausedInApp = oldPause; } error = failure.message; emit(); } throw failure; }
        finally { --pendingCommands; if (!pendingCommands && tokens && accountCode) schedule(250); }
        return snapshot();
      }
    };
    return adapter;
  };
  App.normalizeSpotifyTrack = function (value) {
    const id = String(value?.id || '');
    if (!/^[a-zA-Z0-9]{22}$/.test(id)) return null;
    const text = (input, limit = 240) => String(input || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
    const title = text(value.title);
    if (!title) return null;
    let image = '';
    try { const url = new URL(value.image); if (url.protocol === 'https:' && !url.username && !url.password && /^(?:i\.scdn\.co|mosaic\.scdn\.co|image-cdn[^.]*\.spotifycdn\.com|i\.spotifycdn\.com)$/.test(url.hostname)) image = url.href; } catch {}
    return { id, title, artist: text(value.artist, 480), album: text(value.album), image, url: `https://open.spotify.com/track/${id}` };
  };
  App.getUserSpotifyTrack = function (user) {
    const timestamp = now();
    const records = Object.values(user?.spotifySessions || {}).filter(record => Number(record?.updatedAt) > 0 && Number(record.updatedAt) <= timestamp + TTL && timestamp - Number(record.updatedAt) < TTL).sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    for (const record of records) { const track = App.normalizeSpotifyTrack(record.track); if (track) return track; }
    return null;
  };
  App.spotifyIconMarkup = function (className = '') {
    return `<span class="spotify-activity-icon ${App.escapeAttr(className)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="11"/><path d="M5.7 9c4-1.3 8.6-.9 12.5 1.3M6.7 12.2c3.4-1 7.2-.7 10.4 1.1M7.6 15.3c2.8-.8 5.9-.5 8.6.9" fill="none" stroke="#132219" stroke-width="1.8" stroke-linecap="round"/></svg></span>`;
  };
  App.spotifyProfileMarkup = function (track) {
    if (!track) return '';
    return `<div class="user-profile-spotify" aria-label="Listening to Spotify">
      <div class="spotify-listening-label">${App.spotifyIconMarkup()}<span>Listening to Spotify</span></div>
      <div class="spotify-track-row">${track.image ? `<img class="spotify-album-art" src="${App.escapeAttr(track.image)}" alt="${App.escapeAttr(track.album || 'Album artwork')}" loading="lazy" referrerpolicy="no-referrer"/>` : '<span class="spotify-album-art spotify-album-placeholder" aria-hidden="true">♪</span>'}
        <div class="spotify-track-copy"><div class="spotify-track-name" title="${App.escapeAttr(track.title)}">${App.escapeHtml(track.title)}</div><div class="spotify-track-artist" title="${App.escapeAttr(track.artist)}">${App.escapeHtml(track.artist)}</div></div>
        <a class="spotify-play" href="${App.escapeAttr(track.url)}" data-spotify-track="${App.escapeAttr(track.id)}" target="_blank" rel="noopener noreferrer" aria-label="Play ${App.escapeAttr(track.title)} On Spotify" data-tooltip="Play On Spotify"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></a>
      </div></div>`;
  };
  App.renderMemberListeningStatus = function (element, className, user) {
    if (App.renderMemberActivityStatus) return App.renderMemberActivityStatus(element, className, user);
    if (!element) return;
    const track = App.getUserSpotifyTrack(user);
    element.hidden = !className && !track;
    const markup = `${className ? `<span class="member-class-text">${App.escapeHtml(className)}</span>` : ''}${className && track ? '<span class="member-status-separator" aria-hidden="true"> · </span>' : ''}${track ? `<span class="member-spotify-text">${App.spotifyIconMarkup()}<span>${App.escapeHtml(track.title)} · ${App.escapeHtml(track.artist)}</span></span>` : ''}`;
    if (element.__spotifyMarkup !== markup) { element.innerHTML = markup; element.__spotifyMarkup = markup; }
    element.title = [className, track ? `Listening to ${track.title} by ${track.artist}` : ''].filter(Boolean).join(' · ');
    element.classList.toggle('has-spotify', !!track);
  };
  App.spotifyAccountSettingsHTML = function () {
    return `<section class="settings-panel" data-settings-search="Spotify music listening connection account"><div class="settings-panel-title">Spotify</div><div class="settings-panel-sub">Share what you are listening to and control Spotify from your sidebar.</div><div class="spotify-account-controls"><button class="btn" id="settings-spotify-connect" type="button">Connect Spotify</button><button class="btn" id="settings-spotify-disconnect" type="button" hidden>Disconnect Spotify</button></div><p class="spotify-account-status" id="settings-spotify-status" role="status" aria-live="polite">Checking your connection…</p></section>`;
  };
  App.renderSpotifyAccountSettings = function () {
    const state = App.desktopSpotifyState, connect = App.$('settings-spotify-connect'), disconnect = App.$('settings-spotify-disconnect'), status = App.$('settings-spotify-status');
    if (!connect || !disconnect || !status) return;
    connect.hidden = !!state?.connected && !state?.supportsPlayback;
    connect.disabled = !state?.configured || !!state?.connecting;
    connect.textContent = state?.connecting ? 'Connecting…' : state?.connected ? 'Reconnect Spotify' : 'Connect Spotify';
    disconnect.hidden = !state?.connected && !state?.connecting && !state?.error;
    disconnect.textContent = state?.connecting ? 'Cancel connection' : 'Disconnect Spotify';
    status.textContent = state?.error || (!state ? 'Checking your connection…' : !state.configured ? 'Open the hosted HTTPS web app to connect Spotify.' : state.connecting ? 'Finish connecting in your browser.' : state.needsReconnect ? 'Reconnect Spotify to allow the new playback controls.' : state.connected ? state.track ? `Sharing ${state.track.title} by ${state.track.artist}${!state.supportsPlayback ? '. This desktop connection shares listening activity; playback controls are available in the web app.' : ''}` : 'Connected. Play a song on Spotify to show it on your profile.' : 'Spotify is not connected.');
  };
  App.bindSpotifyAccountSettings = function () {
    const bridge = spotifyBridge();
    if (!bridge) return;
    const connect = App.$('settings-spotify-connect'), disconnect = App.$('settings-spotify-disconnect');
    if (connect) connect.onclick = () => { void bridge.connect().then(App.acceptDesktopSpotify).catch(failure => { const status = App.$('settings-spotify-status'); if (status) status.textContent = failure.message || 'Could not connect Spotify. Try again.'; }); };
    if (disconnect) disconnect.onclick = () => { void bridge.disconnect().then(App.acceptDesktopSpotify).catch(() => { const status = App.$('settings-spotify-status'); if (status) status.textContent = 'Could not disconnect Spotify. Try again.'; }); };
    App.renderSpotifyAccountSettings();
    void bridge.getState().then(App.acceptDesktopSpotify).catch(() => {});
  };
  const playerIcon = {
    shuffle: '<path d="m3 5 3 0c4 0 6 14 10 14h5m-4-4 4 4-4 4M3 19h3c1.5 0 3-2 4-4m4-6c1-2 1.5-4 3-4h4m-4-4 4 4-4 4"/>',
    previous: '<path d="M5 5v14M19 5 8 12l11 7Z"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    next: '<path d="M19 5v14M5 5l11 7-11 7Z"/>',
    repeat: '<path d="m16 2 4 4-4 4M4 11V8a2 2 0 0 1 2-2h14M8 22l-4-4 4-4m12-1v3a2 2 0 0 1-2 2H4"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${playerIcon[name]}</svg>`;
  App.mountSpotifyPlayer = function () {
    if (App.$('sidebar-spotify-player')) return App.$('sidebar-spotify-player');
    const call = App.$('sidebar-call');
    if (!call?.parentElement) return null;
    const player = document.createElement('section');
    player.id = 'sidebar-spotify-player'; player.className = 'sidebar-spotify-player'; player.hidden = true;
    player.setAttribute('aria-label', 'Spotify playback');
    player.innerHTML = `<div class="spotify-player-track"><a class="spotify-player-art" target="_blank" rel="noopener noreferrer" aria-label="Open track on Spotify"></a><div class="spotify-player-copy"><a class="spotify-player-title" target="_blank" rel="noopener noreferrer"></a><div class="spotify-player-artist"></div><div class="spotify-player-album"></div></div></div>
      <input class="spotify-player-seek" type="range" min="0" max="1" value="0" step="1000" aria-label="Song position"/>
      <div class="spotify-player-times" aria-hidden="true"><span data-spotify-position>0:00</span><span data-spotify-duration>0:00</span></div>
      <div class="spotify-player-controls" role="group" aria-label="Spotify controls">${['shuffle', 'previous', 'pause', 'next', 'repeat'].map(action => `<button type="button" class="spotify-player-button" data-spotify-action="${action}" aria-label="${action[0].toUpperCase() + action.slice(1)}" data-tooltip="${action[0].toUpperCase() + action.slice(1)}">${icon(action)}</button>`).join('')}</div><p class="spotify-player-note" role="status" hidden></p>`;
    call.after(player);
    player.addEventListener('click', event => { const button = event.target.closest('[data-spotify-action]'); if (button) void App.controlSpotify(button.dataset.spotifyAction); });
    const seek = player.querySelector('.spotify-player-seek');
    seek.addEventListener('input', () => { seek.dataset.seeking = '1'; App.renderSpotifyProgress(); });
    seek.addEventListener('change', () => { delete seek.dataset.seeking; void App.controlSpotify('seek', Number(seek.value)); });
    seek.addEventListener('pointercancel', () => { delete seek.dataset.seeking; App.renderSpotifyProgress(); });
    seek.addEventListener('blur', () => { delete seek.dataset.seeking; App.renderSpotifyProgress(); });
    return player;
  };
  App.controlSpotify = async function (action, value) {
    const bridge = spotifyBridge();
    try {
      if (!bridge?.control) throw new Error('This desktop connection supports listening activity. Use the web app for Spotify playback controls.');
      await bridge.control(action, value);
    } catch (failure) { App.showToast?.({ title: 'Spotify', body: failure.message || 'Spotify could not complete that action.', duration: 5000 }); }
  };
  App.renderSpotifyProgress = function () {
    const player = App.$('sidebar-spotify-player'), playback = App.desktopSpotifyState?.playback;
    if (!player || player.hidden || !playback) return;
    const seek = player.querySelector('.spotify-player-seek');
    const position = seek.dataset.seeking ? Number(seek.value) : Math.min(playback.duration, playback.position + (playback.playing ? Math.max(0, Date.now() - playback.measuredAt) : 0));
    if (!seek.dataset.seeking) seek.value = String(position);
    seek.style.setProperty('--spotify-progress', `${playback.duration ? position / playback.duration * 100 : 0}%`);
    seek.setAttribute('aria-valuetext', `${elapsed(position)} of ${elapsed(playback.duration)}`);
    player.querySelector('[data-spotify-position]').textContent = elapsed(position);
  };
  App.renderSpotifyPlayer = function () {
    const player = App.mountSpotifyPlayer(); if (!player) return;
    const state = App.desktopSpotifyState, track = state?.playerTrack || state?.track, playback = state?.playback;
    player.hidden = !state?.connected || !track;
    if (player.hidden) { clearInterval(App.spotifyProgressTimer); App.spotifyProgressTimer = null; return; }
    const key = JSON.stringify(track);
    if (player.dataset.trackKey !== key) {
      player.dataset.trackKey = key;
      const art = player.querySelector('.spotify-player-art'), title = player.querySelector('.spotify-player-title');
      art.href = title.href = track.url;
      art.innerHTML = track.image ? `<img class="spotify-album-art" src="${App.escapeAttr(track.image)}" alt="${App.escapeAttr(track.album || 'Album artwork')}" referrerpolicy="no-referrer"/>` : '<span class="spotify-album-art spotify-album-placeholder" aria-hidden="true">♪</span>';
      title.textContent = track.title; title.title = track.title;
      player.querySelector('.spotify-player-artist').textContent = track.artist;
      player.querySelector('.spotify-player-album').textContent = track.album;
    }
    const controls = !!state.supportsPlayback && !state.needsReconnect && !!playback && !playback.restricted;
    const seek = player.querySelector('.spotify-player-seek');
    seek.disabled = !controls || !!playback?.disallows?.seeking; seek.max = String(playback?.duration || 1);
    player.querySelector('[data-spotify-duration]').textContent = elapsed(playback?.duration);
    const restriction = { previous: 'skipping_prev', next: 'skipping_next', pause: 'pausing', play: 'resuming', shuffle: 'toggling_shuffle', repeat: playback?.repeat === 'context' ? 'toggling_repeat_track' : 'toggling_repeat_context' };
    player.querySelectorAll('[data-spotify-action]').forEach(button => {
      let action = button.dataset.spotifyAction;
      if (action === 'pause' || action === 'play') {
        action = playback?.playing === false ? 'play' : 'pause';
        button.dataset.spotifyAction = action; button.innerHTML = icon(action);
        const title = action === 'play' ? 'Play' : 'Pause'; button.setAttribute('aria-label', title); button.dataset.tooltip = title;
      }
      button.disabled = !controls || !!playback?.disallows?.[restriction[action]];
      if (action === 'shuffle' || action === 'repeat') {
        const selected = action === 'shuffle' ? !!playback?.shuffle : playback?.repeat !== 'off' && !!playback;
        button.setAttribute('aria-pressed', String(selected));
        const label = action === 'shuffle' ? `Shuffle ${selected ? 'On' : 'Off'}` : `Repeat ${playback?.repeat === 'track' ? 'One' : playback?.repeat === 'context' ? 'All' : 'Off'}`;
        button.setAttribute('aria-label', label); button.dataset.tooltip = label;
        if (action === 'repeat') button.dataset.repeat = playback?.repeat || 'off';
      }
    });
    const note = player.querySelector('.spotify-player-note');
    note.textContent = !state.supportsPlayback ? 'Playback controls are available in the web app.' : state.needsReconnect ? 'Reconnect Spotify in Settings to enable controls.' : playback?.restricted ? 'This Spotify device does not allow remote controls.' : '';
    note.hidden = !note.textContent;
    App.renderSpotifyProgress();
    if (!App.spotifyProgressTimer && playback) App.spotifyProgressTimer = setInterval(App.renderSpotifyProgress, 250);
  };
  function syncSelf(session, track) {
    if (App.spotifyPresenceSession !== session || App.currentUser?.code !== session.code) return;
    const records = { ...(App.currentUser.spotifySessions || {}) };
    if (track) records[session.id] = { track, updatedAt: now() }; else delete records[session.id];
    App.currentUser.spotifySessions = records;
    const cached = App.liveUserCache?.get(session.code); if (cached) cached.spotifySessions = records;
    App.refreshActivityPresenceForUser?.(App.currentUser);
  }
  App.writeSpotifyPresence = async function () {
    const session = App.spotifyPresenceSession;
    if (!session?.ready || !session.connected) return;
    if (session.writing) { session.again = true; return; }
    session.writing = true;
    const generation = session.generation;
    try {
      const track = App.desktopSpotifyState?.connected ? App.normalizeSpotifyTrack(App.desktopSpotifyState.track) : null;
      const key = JSON.stringify(track);
      if (session.lastKey === key && (!track || Date.now() - session.lastWriteAt < 30000)) return;
      const updatedAt = App.firebase.database.ServerValue.TIMESTAMP;
      if (track && session.lastKey === key) await session.ref.update({ updatedAt });
      else await session.ref.set(track ? { track, updatedAt } : null);
      if (App.spotifyPresenceSession !== session) { await session.ref.remove(); return; }
      session.lastKey = session.connected && session.generation === generation ? key : undefined; session.lastWriteAt = Date.now(); syncSelf(session, track);
    } catch (failure) { console.warn('Spotify presence unavailable', failure?.code || 'offline'); }
    finally { session.writing = false; if (session.again && App.spotifyPresenceSession === session) { session.again = false; void App.writeSpotifyPresence(); } }
  };
  App.armSpotifyPresence = async function (session) {
    if (!session || App.spotifyPresenceSession !== session || !session.connected || session.ready || session.arming) return;
    const generation = session.generation; session.arming = true;
    try {
      await session.ref.onDisconnect().remove();
      if (App.spotifyPresenceSession !== session || !session.connected || generation !== session.generation) return;
      session.ready = true; session.lastKey = undefined; await App.writeSpotifyPresence();
    } catch (failure) { console.warn('Spotify presence registration unavailable', failure?.code || 'offline'); }
    finally { session.arming = false; }
  };
  App.acceptDesktopSpotify = function (value) {
    const session = App.spotifyPresenceSession;
    if (!session || value?.accountCode !== session.code) return;
    App.desktopSpotifyState = { accountCode: session.code, configured: !!value.configured, connected: !!value.connected, connecting: !!value.connecting, needsReconnect: !!value.needsReconnect, error: String(value.error || '').slice(0, 300), track: App.normalizeSpotifyTrack(value.track), playerTrack: App.normalizeSpotifyTrack(value.playerTrack || value.track), playback: App.normalizeSpotifyPlayback(value.playback), supportsPlayback: !!value.supportsPlayback || typeof spotifyBridge()?.control === 'function' };
    App.renderSpotifyAccountSettings(); App.renderSpotifyPlayer(); void App.writeSpotifyPresence();
  };
  App.startSpotifyPresence = function () {
    const bridge = spotifyBridge(), code = String(App.currentUser?.code || '');
    if (!bridge || !code || !App.db || App.spotifyPresenceSession?.code === code) return;
    App.stopSpotifyPresence({ preserveConnection: true });
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const session = { code, id, ref: App.db.ref(`users/${code}/spotifySessions/${id}`), generation: 0, ready: false, connected: false };
    App.spotifyPresenceSession = session;
    session.connectionRef = App.db.ref('.info/connected');
    session.connectionCb = snapshot => { if (App.spotifyPresenceSession !== session) return; ++session.generation; session.ready = false; session.connected = snapshot.val() === true; if (session.connected) void App.armSpotifyPresence(session); };
    session.connectionRef.on('value', session.connectionCb);
    session.heartbeat = setInterval(() => { if (!session.ready) void App.armSpotifyPresence(session); else void App.writeSpotifyPresence(); }, 30000);
    void bridge.setUser(code).then(App.acceptDesktopSpotify).catch(() => {});
  };
  App.stopSpotifyPresence = function ({ preserveConnection = false } = {}) {
    const session = App.spotifyPresenceSession;
    App.spotifyPresenceSession = null; App.desktopSpotifyState = null;
    clearInterval(App.spotifyProgressTimer); App.spotifyProgressTimer = null; App.renderSpotifyPlayer();
    if (!preserveConnection && !App.passwordChangeInFlight) void spotifyBridge()?.setUser('').catch(() => {});
    if (!session) return;
    session.ready = false; session.connected = false; ++session.generation;
    clearInterval(session.heartbeat); session.connectionRef.off('value', session.connectionCb);
    session.ref.remove().then(() => session.ref.onDisconnect().cancel()).catch(() => {});
  };
  App.register('chat/spotify-presence', function () {
    if (!window.chatDesktopSpotify) App.webSpotify = App.createWebSpotifyConnection();
    const activities = App.getUserActivityItems;
    App.getUserActivityItems = function (user) { const track = App.getUserSpotifyTrack(user); return [...activities(user), ...(track ? [{ kind: 'spotify', label: `Listening to ${track.title} by ${track.artist}`, activity: track }] : [])]; };
    const start = App.startAppPresence, stop = App.stopAppPresence;
    App.startAppPresence = function (...args) { const result = start.apply(this, args); App.startSpotifyPresence(); return result; };
    App.stopAppPresence = function (...args) { App.stopSpotifyPresence(); return stop.apply(this, args); };
    spotifyBridge()?.onChange(App.acceptDesktopSpotify);
    window.addEventListener('pagehide', () => App.stopSpotifyPresence({ preserveConnection: true }));
    window.addEventListener('pageshow', () => { if (App.currentUser) App.startSpotifyPresence(); });
    window.addEventListener('focus', () => { void spotifyBridge()?.refresh?.(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { void spotifyBridge()?.refresh?.(); App.renderSpotifyProgress(); } });
    document.addEventListener('click', event => {
      const link = event.target.closest?.('[data-spotify-track]');
      if (!link || !window.chatDesktopSpotify) return;
      event.preventDefault(); event.stopPropagation();
      void window.chatDesktopSpotify.openTrack(link.dataset.spotifyTrack).catch(() => { window.open(link.href, '_blank', 'noopener'); });
    });
    document.addEventListener('error', event => {
      if (event.target?.tagName !== 'IMG' || !event.target.classList.contains('spotify-album-art')) return;
      const fallback = document.createElement('span');
      fallback.className = 'spotify-album-art spotify-album-placeholder'; fallback.textContent = '♪'; fallback.setAttribute('aria-hidden', 'true');
      event.target.replaceWith(fallback);
    }, true);
  });
})(globalThis.ChatApp);
