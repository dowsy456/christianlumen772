/* calling/policy: methods register before ordered initialization. */
(function (App) {
  "use strict";


App.register("calling/policy", function initializeFeature() {
/* Pure call policy, shared by runtime and offline regression tests. */
(function (root) {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  function mediaBudget({
    subscribers = 1
  } = {}) {
    const viewers = clamp(subscribers, 1, 32);
    // Capture stays 720p30. Bound aggregate mesh upload so screen + camera
    // viewers cannot multiply a 4 Mbps encoder into an unbounded upload queue.
    // Congestion control may lower individual paths further when necessary.
    const videoBitrate = Math.min(4000000, Math.floor(12000000 / viewers));
    return {
      audioBitrate: 48000,
      screenAudioBitrate: 128000,
      videoBitrate,
      maxFramerate: 30,
      width: 1280,
      height: 720,
      totalVideoBudget: videoBitrate * viewers
    };
  }
  function wantsScreen(member, owner, shareId) {
    return !!(member && member.connected !== false && shareId && member.viewingSharesSessionId === member.sessionId && member.viewingShares?.[owner] === shareId);
  }
  function packetDelta(previous, current) {
    if (!previous || current.received < previous.received || current.lost < previous.lost) return 0;
    const lost = Math.max(0, current.lost - previous.lost);
    const received = Math.max(0, current.received - previous.received);
    return lost + received > 0 ? 100 * lost / (lost + received) : 0;
  }
  function isConnected(pc) {
    if (!pc || ['failed', 'closed', 'disconnected'].includes(pc.connectionState) || ['failed', 'closed', 'disconnected'].includes(pc.iceConnectionState)) return false;
    // ICE success alone does not establish DTLS/media. Only older engines
    // without the aggregate state need the ICE-only fallback.
    return pc.connectionState ? pc.connectionState === 'connected' : ['connected', 'completed'].includes(pc.iceConnectionState);
  }
  function memberLastSeen(member) {
    if (member?.connected === false && Number(member.disconnectedAt) > 0) return Number(member.disconnectedAt);
    return Math.max(0, ...['disconnectedAt', 'lastSeenAt', 'updatedAt', 'joinedAt'].map(key => Number(member?.[key]) || 0));
  }
  function keepMember(member, pc, now, graceMs, heartbeatMs = 120000) {
    if (!member?.sessionId) return false;
    if (String(member.departedSessionId || '') === String(member.sessionId)) return false;
    if (pc && pc.__peerSessionId === member.sessionId && isConnected(pc)) return true;
    const last = memberLastSeen(member);
    // Missing legacy timestamps do not invalidate an otherwise live member.
    if (member.connected !== false) return !last || now - last <= heartbeatMs;
    // Keep an existing session during a signaling/ICE interruption so its
    // recovery watchdog can run. Explicit departures above still disappear
    // immediately. Observers without a peer do not show disconnected users.
    return !!(pc && pc.__peerSessionId === member.sessionId && last && now - last <= graceMs);
  }
  function shouldCleanupMember(member, pc, now, graceMs = 45000, heartbeatMs = 120000) {
    if (!member?.sessionId) return false;
    if (String(member.departedSessionId || '') === String(member.sessionId)) return true;
    if (pc && pc.__peerSessionId === member.sessionId && isConnected(pc)) return false;
    const last = memberLastSeen(member);
    // Observers outside the call cannot know whether media still flows between
    // participants. Hide a disconnected tile immediately, but preserve shared
    // membership/SDP through the signaling reconnect grace period.
    return last > 0 && now - last > (member.connected === false ? graceMs : heartbeatMs);
  }
  function recoveryDelay(attempt, polite = false) {
    return Math.min(30000, 4000 * Math.pow(2, Math.max(0, attempt - 1))) + (polite ? 650 : 0);
  }
  const api = Object.freeze({
    mediaBudget,
    wantsScreen,
    packetDelta,
    isConnected,
    memberLastSeen,
    keepMember,
    shouldCleanupMember,
    recoveryDelay
  });
  root.ChatCallPolicy = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);

/* Deployment-owned, fresh ICE credentials. No embedded third-party password. */
});
})(globalThis.ChatApp);
