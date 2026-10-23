/* calling/quality: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.makeCallSessionId = /* Chat calling: quality. Classic script; see CALLING.md. */function () {
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};
App.callGetMemberByCode = function (code) {
  const id = String(code || "");
  return App.callMembersCache.find(m => String(m?.code || "") === id) || null;
};
App.callGetPeerSessionId = function (peerCode) {
  return String(App.callGetMemberByCode(peerCode)?.sessionId || "");
};
App.callGetConnectionPresentation = function () {
  const quality = App.callConnectionQuality || {};
  let text = App.currentCallRoomId ? quality.label || "Connecting…" : App.callActive ? "Call in progress" : "No active call";
  let level = quality.level || "idle";
  if (App.callLeavePending) { text = "Leaving…"; level = "fair"; }
  else if (App.callJoinPending) { text = "Joining…"; level = "fair"; }
  else if (App.currentCallRoomId) {
    if (quality.level === "reconnecting") text = "Reconnecting";
    else if (quality.connecting) text = "Connecting…";
    else if (App.callAudioUnlockRequired && !App.callDeafened) { text = "Enable audio"; level = "fair"; }
    else if (quality.level === "poor") text = "Poor connection";
    else if (quality.measuring) text = "Measuring connection…";
    else text = "Connected";
  }
  return { text, level, detail: App.callAudioUnlockRequired && !App.callDeafened ? "Tap Enable audio in the call controls to resume playback." : quality.detail || text };
};
App.callSyncMenuStatusDisplay = function () {
  const roomEl = App.$("call-menu-room");
  const statusEl = App.$("call-menu-status");
  const qualityDot = App.$("call-menu-quality-dot");
  const metaEl = App.$("call-menu-meta");
  if (roomEl) {
    const roomId = App.currentCallRoomId || App.observedCallRoomId || App.currentRoomId || "";
    const roomName = roomId ? App.roomDisplayName(roomId, App.roomsMetaCache.get(roomId) || null) : "";
    let icon = roomEl.querySelector('.call-room-icon'), label = roomEl.querySelector('.call-room-name');
    if (!icon || !label) {
      icon = document.createElement('span'); icon.className = 'call-room-icon'; icon.setAttribute('aria-hidden', 'true');
      label = document.createElement('span'); label.className = 'call-room-name';
      roomEl.replaceChildren(icon, label);
    }
    if (label.textContent !== (roomName || 'Room')) label.textContent = roomName || 'Room';
    const roomMeta = App.roomsMetaCache.get(roomId);
    const signature = JSON.stringify([roomId, roomMeta?.photoDataURL, roomMeta?.photoTransform]);
    if (roomEl.__roomIconSignature !== signature) {
      App.applyRoomIcon?.(icon, roomId, roomMeta);
      roomEl.__roomIconSignature = signature;
    }
  }
  const status = App.callGetConnectionPresentation();
  if (qualityDot) {
    qualityDot.className = `call-menu-live-dot ${status.level}`;
    qualityDot.dataset.tooltip = status.detail;
  }
  if (statusEl) { statusEl.textContent = status.text; statusEl.dataset.tooltip = status.detail; }
  if (metaEl) { metaEl.textContent = ""; metaEl.hidden = true; }
  App.syncSidebarCallDock?.();
};
App.callReadPeerStats = async function (pc) {
  const now = Date.now();
  const interval = document.visibilityState === 'hidden' ? 12000 : App.CALL_QUALITY_POLL_MS;
  if (pc.__qualityStats && now - Number(pc.__qualityStatsAt || 0) < interval - 100) return pc.__qualityStats;
  if (pc.__qualityStatsPromise) return pc.__qualityStatsPromise;
  const run = (async () => {
    const result = {
      lossPct: null,
      rttMs: null,
      jitterMs: null,
      measuredAt: now,
      audioPacketsReceived: 0,
      receivingAudio: false,
      cpuLimited: false,
      bandwidthLimited: false,
      relay: false,
      videoBitrate: 0,
      availableOutgoingBitrate: null,
      videoStreams: []
    };
    let statsTimeout;
    try {
      const reports = await Promise.race([
        pc.getStats(),
        new Promise((_, reject) => { statsTimeout = setTimeout(() => reject(new Error("Media statistics timed out")), 1800); })
      ]);
      let lost = 0, received = 0, outboundLost = 0, outboundReceived = 0, reportedSendLoss = null;
      const packetSamples = new Map();
      const remotePacketSamples = new Map();
      const videoSamples = new Map();
      const selectedPairs = new Set();
      reports.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) selectedPairs.add(report.selectedCandidatePairId);
      });
      reports.forEach((report, key) => {
        const reportId = String(report.id || key);
        const kind = report.kind || report.mediaType;
        if (report.type === 'inbound-rtp' && kind === 'audio' && !report.isRemote) {
          const sample = { lost: Number(report.packetsLost) || 0, received: Number(report.packetsReceived) || 0 };
          const previous = pc.__inboundPacketSamples?.get(reportId);
          // RTP counters belong to an SSRC, not a whole connection. Opening or
          // closing a camera must not look like a burst of lost screen packets.
          if (previous && sample.received >= previous.received) {
            lost += Math.max(0, sample.lost - previous.lost);
            received += sample.received - previous.received;
          }
          packetSamples.set(reportId, sample);
          result.audioPacketsReceived += sample.received;
          result.receivingAudio ||= sample.received > 0;
          if (Number.isFinite(report.jitter)) result.jitterMs = Math.max(result.jitterMs || 0, report.jitter * 1000);
        }
        // Receiver reports expose the remote end's experience of our outgoing
        // microphone. Receive-only quality missed one-way audio degradation.
        if (report.type === 'remote-inbound-rtp' && kind === 'audio') {
          const sample = { lost: Number(report.packetsLost) || 0, received: Number(report.packetsReceived) || 0, at: Number(report.timestamp) || now };
          const previous = pc.__remotePacketSamples?.get(reportId);
          if (previous && sample.at > previous.at && sample.received >= previous.received) {
            outboundLost += Math.max(0, sample.lost - previous.lost);
            outboundReceived += sample.received - previous.received;
            // Chromium versions without the remote packetsReceived counter
            // still expose the RTCP reporting interval's fractionLost.
            if (report.packetsReceived == null && Number.isFinite(report.fractionLost)) reportedSendLoss = Math.max(reportedSendLoss || 0, Math.min(100, Math.max(0, report.fractionLost * 100)));
          }
          remotePacketSamples.set(reportId, sample);
          const rtt = Number(report.roundTripTime);
          if (report.roundTripTime != null && Number.isFinite(rtt) && rtt >= 0) result.rttMs = Math.max(result.rttMs || 0, rtt * 1000);
          if (Number.isFinite(report.jitter)) result.jitterMs = Math.max(result.jitterMs || 0, report.jitter * 1000);
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (selectedPairs.size ? selectedPairs.has(reportId) : report.nominated || report.selected)) {
          const ms = report.currentRoundTripTime == null ? NaN : Number(report.currentRoundTripTime) * 1000;
          if (Number.isFinite(ms) && ms >= 0) result.rttMs = Math.max(result.rttMs || 0, ms);
          const local = reports.get(report.localCandidateId);
          const remote = reports.get(report.remoteCandidateId);
          result.relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
          const available = Number(report.availableOutgoingBitrate);
          if (Number.isFinite(available) && available > 0) result.availableOutgoingBitrate = available;
        }
        if (report.type === 'outbound-rtp' && kind === 'video') {
          result.cpuLimited ||= report.qualityLimitationReason === 'cpu';
          result.bandwidthLimited ||= report.qualityLimitationReason === 'bandwidth';
          const sample = { bytes: Number(report.bytesSent) || 0, at: Number(report.timestamp) || 0 };
          const prev = pc.__outboundVideoSamples?.get(reportId);
          const bitrate = prev && sample.at > prev.at && sample.bytes >= prev.bytes ? 8 * (sample.bytes - prev.bytes) * 1000 / (sample.at - prev.at) : 0;
          result.videoBitrate += bitrate;
          videoSamples.set(reportId, sample);
          result.videoStreams.push({
            source: report.mid != null && report.mid === pc.__cameraTx?.mid ? 'camera' : report.mid != null && report.mid === pc.__screenTx?.mid ? 'screen' : 'video',
            width: Number(report.frameWidth) || null,
            height: Number(report.frameHeight) || null,
            framesPerSecond: Number.isFinite(report.framesPerSecond) ? report.framesPerSecond : null,
            bitrate,
            limitation: report.qualityLimitationReason || 'unknown'
          });
        }
      });
      const receiveLoss = lost + received ? 100 * lost / (lost + received) : null;
      const sendLoss = reportedSendLoss != null ? reportedSendLoss : outboundLost + outboundReceived ? 100 * outboundLost / (outboundLost + outboundReceived) : null;
      result.lossPct = receiveLoss == null ? sendLoss : sendLoss == null ? receiveLoss : Math.max(receiveLoss, sendLoss);
      result.receiveLossPct = receiveLoss;
      result.sendLossPct = sendLoss;
      pc.__inboundPacketSamples = packetSamples;
      pc.__remotePacketSamples = remotePacketSamples;
      pc.__outboundVideoSamples = videoSamples;
      pc.__qualityStats = result;
      pc.__qualityStatsAt = Date.now();
    } catch {
      // Transient stats failures are not proof of excellent network quality.
      if (pc.__qualityStats) return pc.__qualityStats;
      result.measuredAt = 0;
    } finally {
      clearTimeout(statsTimeout);
    }
    return result;
  })();
  pc.__qualityStatsPromise = run;
  try {
    return await run;
  } finally {
    if (pc.__qualityStatsPromise === run) pc.__qualityStatsPromise = null;
  }
};
App.callUpdateConnectionQuality = async function () {
  if (App.callQualityUpdatePending) { App.callQualityUpdateQueued = true; return; }
  App.callQualityUpdatePending = true;
  const roomAtStart = App.currentCallRoomId;
  const sessionAtStart = App.callSessionId;
  try {
    if (!App.currentCallRoomId) {
      App.callConnectionQuality = {
        level: "idle",
        label: "Idle",
        detail: "Join a call to measure connection quality.",
        rttMs: null,
        lossPct: null
      };
      App.callSyncMenuStatusDisplay();
      return;
    }
    const pcs = Array.from(App.callPeerMap.values());
    const self = String(App.currentUser?.code || "");
    const expected = App.callMembersCache.filter(member => member && String(member.code) !== self && member.sessionId);
    const missingPeers = expected.some(member => App.callPeerMap.get(String(member.code))?.__peerSessionId !== member.sessionId);
    if (!pcs.length) {
      const offline = App.callSignalingConnected === false || navigator.onLine === false;
      App.callConnectionQuality = {
        level: offline ? "reconnecting" : missingPeers ? "fair" : "self",
        label: offline ? "Reconnecting" : missingPeers ? "Connecting" : "Solo",
        connecting: missingPeers,
        detail: offline ? "Reconnecting to the call server." : missingPeers ? "Establishing participant media connections." : "Connected. Waiting for other participants.",
        rttMs: null,
        lossPct: null
      };
      App.callSyncMenuStatusDisplay();
      return;
    }
    let hasFailed = false;
    let hasConnecting = missingPeers;
    let hasUnmeasured = false;
    let worstLoss = null;
    let worstRtt = null;
    let worstJitter = null;
    let measuredPeers = 0;
    // Each query is independent. Serial getStats delayed the status refresh by
    // every peer's IPC latency, especially while multiple encoders were busy.
    const peerStats = await Promise.all(Array.from(App.callPeerMap.entries(), async ([peerCode, pc]) => ({ peerCode, pc, stats: await App.callReadPeerStats(pc) })));
    if (App.currentCallRoomId !== roomAtStart || App.callSessionId !== sessionAtStart) return;
    for (const { peerCode, pc, stats } of peerStats) {
      if (App.callPeerMap.get(peerCode) !== pc) continue;
      const connectionState = String(pc?.connectionState || "");
      const iceConnectionState = String(pc?.iceConnectionState || "");
      const receivingAudio = stats.receivingAudio === true;
      App.callPeerStatusCache.set(String(peerCode), {
        connectionState,
        iceConnectionState,
        receivingAudio,
        peerSessionId: String(pc?.__peerSessionId || "")
      });
      if (["failed", "closed", "disconnected"].includes(connectionState) || ["failed", "closed", "disconnected"].includes(iceConnectionState)) {
        hasFailed = true;
        continue;
      }
      if (!globalThis.ChatCallPolicy.isConnected(pc)) {
        hasConnecting = true;
        continue;
      }
      const member = App.callGetMemberByCode(peerCode);
      const receivesVoice = ['sendrecv', 'recvonly'].includes(pc.__audioTx?.currentDirection);
      if (receivesVoice && member && !member.muted && !member.deafened && stats.audioPacketsReceived === 0) hasConnecting = true;
      const stale = stats.measuredAt != null && (!stats.measuredAt || Date.now() - stats.measuredAt > Math.max(15000, App.CALL_QUALITY_POLL_MS * 3));
      const measured = !stale && [stats.rttMs, stats.lossPct, stats.jitterMs].some(value => value != null && Number.isFinite(value));
      if (!measured) {
        hasUnmeasured = true;
        continue;
      }
      measuredPeers += 1;
      if (Number.isFinite(stats.lossPct) && stats.lossPct != null) worstLoss = Math.max(worstLoss || 0, stats.lossPct);
      if (Number.isFinite(stats.rttMs) && stats.rttMs != null) worstRtt = Math.max(worstRtt || 0, stats.rttMs);
      if (Number.isFinite(stats.jitterMs) && stats.jitterMs != null) worstJitter = Math.max(worstJitter || 0, stats.jitterMs);
    }
    if (App.currentCallRoomId !== roomAtStart || App.callSessionId !== sessionAtStart) return;
    let level = "excellent";
    let label = "Excellent";
    if (hasFailed) {
      level = "reconnecting";
      label = "Reconnecting";
    } else if (hasConnecting) {
      level = "fair";
      label = "Stabilizing";
    } else if (worstLoss >= 10 || worstRtt >= 350 || worstJitter >= 60) {
      level = "poor";
      label = "Poor";
    } else if (worstLoss >= 4 || worstRtt >= 220 || worstJitter >= 30) {
      level = "fair";
      label = "Fair";
    } else if (worstLoss >= 1.5 || worstRtt >= 120 || worstJitter >= 15) {
      level = "good";
      label = "Good";
    } else if (hasUnmeasured || !measuredPeers) {
      level = "fair";
      label = "Measuring";
    }
    // A single RTCP interval during track setup can spike jitter/loss. Confirm
    // a downgrade of an established good path, while failures and severe loss
    // remain immediate and the tooltip still reports the actual measurements.
    const previousQuality = App.callConnectionQuality;
    if (level === 'poor' && ['excellent', 'good'].includes(previousQuality?.level) && worstLoss < 25 && worstRtt < 1000) {
      App.callPoorSince ||= Date.now();
      if (Date.now() - App.callPoorSince < App.CALL_QUALITY_POLL_MS) {
        level = previousQuality.level; label = previousQuality.label;
      }
    } else if (level !== 'poor') App.callPoorSince = 0;
    const detailBits = [];
    if (worstRtt != null) detailBits.push(`${Math.round(worstRtt)} ms RTT`);
    if (worstLoss != null) detailBits.push(`${worstLoss.toFixed(1)}% audio loss`);
    if (worstJitter != null) detailBits.push(`${Math.round(worstJitter)} ms jitter`);
    if (hasUnmeasured) detailBits.push("Waiting for fresh measurements");
    if (App.callSignalingConnected === false) detailBits.push("Media connected; call server reconnecting");
    App.callConnectionQuality = {
      level,
      label,
      detail: hasFailed ? "Recovering the media connection." : hasConnecting ? "Establishing participant media connections." : detailBits.length ? `${pcs.length > 1 ? "Worst participant path: " : ""}${detailBits.join(" • ")}` : "Waiting for fresh media measurements.",
      connecting: hasConnecting && !hasFailed,
      measuring: label === "Measuring",
      rttMs: worstRtt,
      lossPct: worstLoss,
      jitterMs: worstJitter,
      measuredAt: Date.now()
    };
    App.callSyncMenuStatusDisplay();
    App.callScheduleMediaBudget();
  } finally {
    App.callQualityUpdatePending = false;
    if (App.callQualityUpdateQueued) {
      App.callQualityUpdateQueued = false;
      queueMicrotask(() => { void App.callUpdateConnectionQuality(); });
    }
  }
};
App.callStartQualityMonitor = function () {
  App.callStopQualityMonitor();
  App.callQualityTimer = setInterval(() => {
    void App.callUpdateConnectionQuality();
  }, App.CALL_QUALITY_POLL_MS);
  void App.callUpdateConnectionQuality();
};
App.callStopQualityMonitor = function () {
  App.callPoorSince = 0;
  if (App.callQualityTimer) {
    try {
      clearInterval(App.callQualityTimer);
    } catch {}
  }
  App.callQualityTimer = null;
  App.callConnectionQuality = {
    level: "idle",
    label: "Idle",
    detail: "Join a call to measure connection quality.",
    rttMs: null,
    lossPct: null
  };
  App.callSyncMenuStatusDisplay();
};

App.register("calling/quality", function initializeFeature() {

});
})(globalThis.ChatApp);

