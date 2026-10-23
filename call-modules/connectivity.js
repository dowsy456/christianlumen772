/* calling/connectivity: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callRuntimeConfig = function () {
  return globalThis.CHAT_CALL_CONFIG && typeof globalThis.CHAT_CALL_CONFIG === 'object' ? globalThis.CHAT_CALL_CONFIG : {};
};
App.callValidateIceServers = function (value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap(server => {
    if (!server || typeof server !== 'object') return [];
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls || server.url]).filter(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url));
    if (!urls.length) return [];
    const relay = urls.some(url => /^turns?:/i.test(url));
    if (relay && (!server.username || !server.credential)) return [];
    return [{
      urls,
      ...(relay ? {
        username: String(server.username),
        credential: String(server.credential)
      } : {})
    }];
  });
};
App.callRefreshIceServers = async function ({
  force = false
} = {}) {
  const runtime = App.callRuntimeConfig();
  const endpoint = String(runtime.iceServersEndpoint || '');
  if (!endpoint) return App.callMakeRtcConfig().iceServers;
  const now = Date.now();
  if (App.callIceCredentialPromise) return App.callIceCredentialPromise;
  if (!force && App.callIceCredentialCache?.expiresAt > now + 60000) return App.callIceCredentialCache.iceServers;
  // Failed servers must not receive a request per peer/event.
  if (App.callIceLastAttemptAt && now - App.callIceLastAttemptAt < 15000) return App.callMakeRtcConfig().iceServers;
  App.callIceLastAttemptAt = now;
  const run = (async () => {
    let timer;
    const abort = new AbortController();
    try {
      const url = new URL(endpoint, document.baseURI || location.href);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw Error('ICE endpoint must use HTTPS (or localhost for development).');
      }
      timer = setTimeout(() => abort.abort(), 4500);
      const headers = {
        Accept: 'application/json'
      };
      // Deployments can obtain a Firebase ID token (or equivalent) here.
      if (typeof runtime.getIceAuthorization === 'function') {
        const authorization = await Promise.race([Promise.resolve().then(() => runtime.getIceAuthorization()), new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(Error('Relay authorization timed out.')), {
          once: true
        }))]);
        if (authorization) headers.Authorization = String(authorization);
      }
      const response = await fetch(url.href, {
        signal: abort.signal,
        cache: 'no-store',
        credentials: 'omit',
        headers
      });
      if (!response.ok) throw Error('ICE endpoint returned HTTP ' + response.status);
      const payload = await response.json();
      const iceServers = App.callValidateIceServers(payload.iceServers || payload);
      if (!iceServers.length) throw Error('ICE endpoint returned no valid servers.');
      const rawExpiry = Number(payload.expiresAt);
      const ttl = Math.max(60, Math.min(86400, Number(payload.ttlSeconds) || 600));
      const expiresAt = Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry < 1e12 ? rawExpiry * 1000 : rawExpiry : Date.now() + ttl * 1000;
      if (expiresAt <= Date.now() + 30000) throw Error('ICE credentials are already expired or expire in under 30 seconds.');
      const credentialsChanged = !!App.callIceCredentialCache && JSON.stringify(App.callIceCredentialCache.iceServers) !== JSON.stringify(iceServers);
      App.callIceCredentialCache = {
        iceServers,
        expiresAt
      };
      App.callConnectivityStatus = {
        relayConfigured: iceServers.some(s => s.urls.some(u => /^turns?:/i.test(u))),
        credentialSource: 'endpoint',
        lastError: null
      };
      for (const pc of App.callPeerMap.values()) {
        if (pc.__closing) continue;
        try {
          pc.setConfiguration({
            ...pc.getConfiguration(),
            iceServers
          });
        } catch {}
        // Existing TURN allocations may still use old short-lived credentials.
        // One deterministic side migrates a relay path after a changed refresh;
        // established RTP continues while the new ICE generation is checked.
        if (credentialsChanged && !pc.__polite && pc.remoteDescription && pc.__qualityStats?.relay) {
          if (pc.__credentialRestartTimer) clearTimeout(pc.__credentialRestartTimer);
          pc.__credentialRestartTimer = setTimeout(() => {
            pc.__credentialRestartTimer = null;
            if (App.callPeerIsCurrent(pc, pc.__peerCode)) void App.callSendOffer(pc.__peerCode, pc.__roomId, {
              iceRestart: true
            });
          }, 250 + Math.floor(Math.random() * 750));
        }
      }
      App.callScheduleIceCredentialRefresh();
      return iceServers;
    } catch (error) {
      App.callConnectivityStatus.lastError = String(error?.message || error);
      console.warn('Call relay configuration:', App.callConnectivityStatus.lastError);
      App.callScheduleIceCredentialRefresh(60000);
      return App.callMakeRtcConfig().iceServers;
    } finally {
      clearTimeout(timer);
    }
  })();
  App.callIceCredentialPromise = run;
  try {
    return await run;
  } finally {
    if (App.callIceCredentialPromise === run) App.callIceCredentialPromise = null;
  }
};
App.callScheduleIceCredentialRefresh = function (retryMs) {
  if (App.callIceRefreshTimer) clearTimeout(App.callIceRefreshTimer);
  App.callIceRefreshTimer = null;
  if (!App.currentCallRoomId || !App.callRuntimeConfig().iceServersEndpoint) return;
  const delay = retryMs || Math.max(15000, (App.callIceCredentialCache?.expiresAt || Date.now() + 120000) - Date.now() - 60000);
  App.callIceRefreshTimer = setTimeout(() => {
    App.callIceRefreshTimer = null;
    void App.callRefreshIceServers({
      force: true
    });
  }, delay);
};
App.callShowConnectivityNotice = function () {
  if (App.callConnectivityNoticeShown || !App.currentCallRoomId || !App.callSessionId) return;
  const self = String(App.currentUser?.code || '');
  const hasRemoteMembers = App.callMembersCache.some(member => member && String(member.code) !== self && member.connected !== false);
  // Joining the signaling room does not prove a remote media path is ready.
  // Solo calls are ready after their acknowledged join; group calls wait for
  // the first established transport and never toast again for later peers.
  if (hasRemoteMembers && !Array.from(App.callPeerMap.values()).some(globalThis.ChatCallPolicy.isConnected)) return;
  App.callConnectivityNoticeShown = true;
  App.showToast({
    title: 'Connected',
    duration: 1000
  });
};

App.register("calling/connectivity", function initializeFeature() {
App.callIceCredentialCache = null;
App.callIceCredentialPromise = null;
App.callIceRefreshTimer = null;
App.callIceLastAttemptAt = 0;
App.callConnectivityNoticeShown = false;
App.callConnectivityStatus = {
  relayConfigured: false,
  credentialSource: 'stun',
  lastError: null
};
App.CALL_PUBLIC_STUN = Object.freeze([{
  urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']
}]);
globalThis.getChatCallDiagnostics = function () {
  return {
    topology: 'peer-to-peer mesh',
    active: !!App.currentCallRoomId,
    participantCount: App.callPeerMap.size + (App.currentCallRoomId ? 1 : 0),
    connectivity: {
      ...App.callConnectivityStatus
    },
    budget: App.callGetMediaBudget(),
    quality: {
      ...App.callConnectionQuality
    },
    peers: Array.from(App.callPeerMap.values(), pc => ({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState,
      recoveryAttempts: pc.__restartAttempts || 0,
      stats: pc.__qualityStats ? {
        ...pc.__qualityStats
      } : null
    }))
  };
};

/* Capture targets stay stable; diagnostics report aggregate mesh demand. */
});
})(globalThis.ChatApp);
