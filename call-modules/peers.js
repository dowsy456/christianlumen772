/* calling/peers: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callCreatePeer = /* Chat calling: peers. Classic script; see CALLING.md. */function (peerCode, roomId) {
  const peer = String(peerCode || "");
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const peerSessionId = App.callGetPeerSessionId(peer);
  const localSessionId = String(App.callSessionId || "");
  const lifecycleToken = App.callLifecycleToken;
  const selfCode = String(App.currentUser?.code || "");
  if (!peer || !id || !peerSessionId || !localSessionId || !selfCode) return null;
  const pc = new RTCPeerConnection(App.callMakeRtcConfig());
  pc.__pendingCandidates = [];
  pc.__restartAttempts = 0;
  pc.__discTimer = null;
  pc.__lastIceRestartAt = 0;
  pc.__peerSessionId = peerSessionId;
  pc.__localSessionId = localSessionId;
  pc.__lifecycleToken = lifecycleToken;
  pc.__roomId = id;
  pc.__peerCode = peer;
  App.callBindScreenStateChannel(pc);
  pc.__polite = App.callComparePeerCodes(selfCode, peer) > 0;
  pc.__offerQueued = false;
  pc.__queuedIceRestart = false;
  pc.__offerPumpPromise = null;
  pc.__pendingRemoteOffer = null;
  pc.__pendingRemoteAnswer = null;
  pc.__observedRemoteOfferId = null;
  pc.__handlingAnswer = false;
  pc.__ignoredRemoteSignalIds = new Set();
  pc.__connectTimer = null;
  const clearConnectTimer = () => {
    if (pc.__connectTimer) clearTimeout(pc.__connectTimer);
    pc.__connectTimer = null;
  };
  const clearDiscTimer = () => {
    if (pc.__discTimer) clearTimeout(pc.__discTimer);
    pc.__discTimer = null;
  };
  const clearRecovery = () => {
    clearDiscTimer();
    clearConnectTimer();
    if (pc.__recoveryTimer) clearTimeout(pc.__recoveryTimer);
    pc.__recoveryTimer = null;
    pc.__restartAttempts = 0;
  };
  const armConnectWatchdog = (delayMs = 18000) => {
    if (!App.callPeerIsCurrent(pc, peer)) return;
    clearConnectTimer();
    pc.__connectTimer = setTimeout(() => {
      pc.__connectTimer = null;
      if (!globalThis.ChatCallPolicy.isConnected(pc)) pc.__requestRecovery?.('connect-timeout');
    }, delayMs);
  };
  pc.__requestRecovery = (reason = 'transport-failed') => {
    if (!App.callPeerIsCurrent(pc, peer) || pc.__recoveryTimer || pc.__recoveryPending || globalThis.ChatCallPolicy.isConnected(pc)) return;
    const attempt = Number(pc.__restartAttempts || 0) + 1;
    // Both ICE and aggregate connection events report one failure. This single
    // timer coalesces them and preserves a grace period for network switching.
    const delay = attempt === 1 ? pc.__polite ? 700 : 50 : globalThis.ChatCallPolicy.recoveryDelay(attempt, pc.__polite);
    pc.__recoveryTimer = setTimeout(async () => {
      pc.__recoveryTimer = null;
      if (!App.callPeerIsCurrent(pc, peer) || globalThis.ChatCallPolicy.isConnected(pc)) return;
      pc.__recoveryPending = true;
      pc.__restartAttempts = attempt;
      try {
        await App.callRefreshIceServers();
        if (!App.callPeerIsCurrent(pc, peer) || globalThis.ChatCallPolicy.isConnected(pc)) return;
        try {
          pc.setConfiguration({
            ...pc.getConfiguration(),
            iceServers: App.callMakeRtcConfig().iceServers
          });
        } catch {}
        if (attempt >= 4) {
          await App.callHardRestartPeer(peer, id, reason);
          return;
        }
        // A lost answer must not leave the offer pump polling have-local-offer
        // forever. Withdraw the timed-out exact offer before its ICE retry.
        if (pc.signalingState === 'have-local-offer' && !pc.__makingOffer && !pc.__handlingAnswer) {
          const abandoned = pc.__pendingOfferId;
          await pc.setLocalDescription({
            type: 'rollback'
          });
          pc.__pendingOfferId = null;
          pc.__localSignalId = '';
          if (abandoned) void App.callRemoveSignalIfCurrent(App.db.ref(App.callWeRtcPath(id, peer, peerSessionId, selfCode, localSessionId)).child('offer'), {
            id: abandoned
          });
        }
        pc.__lastIceRestartAt = Date.now();
        // createOffer({iceRestart:true}) below is also supported by older browsers.
        if (!pc.remoteDescription) {
          pc.__allowInitialOffer = true;
          await App.callSetPeerAudioTrack(pc, App.callGetLiveAudioTrack());
          await App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null);
        }
        try {
          pc.restartIce?.();
        } catch {}
        await App.callSendOffer(peer, id, {
          iceRestart: true
        });
        armConnectWatchdog(18000);
      } catch (error) {
        console.warn('Call recovery:', error?.message || error);
        armConnectWatchdog(18000);
      } finally {
        pc.__recoveryPending = false;
      }
    }, delay);
  };
  const updateTransport = () => {
    if (!App.callPeerIsCurrent(pc, peer)) return;
    const ice = String(pc.iceConnectionState || '');
    const conn = String(pc.connectionState || '');
    App.callPeerStatusCache.set(peer, {
      connectionState: conn,
      iceConnectionState: ice,
      receivingAudio: !!App.callRemoteAudioEls.get(peer)?.srcObject,
      peerSessionId
    });
    // A signaling-disconnected member can stay while its media is healthy.
    // Re-evaluate as soon as transport ends, not at the next presence timer.
    if (App.observedCallRoomId === id && App.callObservedMembersSnapshot) {
      App.callsRoomCb?.(App.callObservedMembersSnapshot, { expiry: true });
    }
    void App.callUpdateConnectionQuality();
    if (globalThis.ChatCallPolicy.isConnected(pc)) {
      void App.callPrimePeerMedia(pc);
      App.callShowConnectivityNotice();
      clearRecovery();
      return;
    }
    if (ice === 'failed' || conn === 'failed') {
      clearDiscTimer();
      pc.__requestRecovery('transport-failed');
    } else if (ice === 'disconnected' || conn === 'disconnected') {
      if (pc.__discTimer) return;
      pc.__discTimer = setTimeout(() => {
        pc.__discTimer = null;
        pc.__requestRecovery('network-disconnected');
      }, 6000);
    }
  };
  pc.oniceconnectionstatechange = updateTransport;
  pc.onconnectionstatechange = updateTransport;
  try {
    App.callEnsurePeerAudioTransceiver(pc);
    App.callEnsurePeerScreenTransceiver(pc);
    App.callEnsurePeerScreenAudioTransceiver(pc);
    App.callEnsurePeerCameraTransceiver(pc);
    void App.callSetPeerAudioTrack(pc, App.callGetLiveAudioTrack()).catch(e => console.warn("initial microphone publish failed:", e));
    void App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null).catch(e => console.warn("initial screen publish failed:", e));
    void App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null).catch(e => console.warn("initial camera publish failed:", e));
  } catch (e) {
    console.warn("peer media transceiver setup failed:", e);
  }
  pc.ontrack = ev => {
    if (!App.callPeerIsCurrent(pc, peer)) return;
    let stream = ev.streams && ev.streams[0] ? ev.streams[0] : null;
    if (!ev.track) return;
    if (!stream) {
      try {
        stream = new MediaStream([ev.track]);
      } catch {
        return;
      }
    }
    if (ev.track.kind === "audio") {
      if (App.callIsScreenAudioTrack(pc, ev)) {
        // A screen's audio never replaces the durable microphone element.
        const audioStream = new MediaStream([ev.track]);
        pc.__remoteScreenAudioTrack = ev.track;
        App.callSetRemoteScreenAudio(peer, audioStream);
        const current = () => App.callPeerIsCurrent(pc, peer) && pc.__remoteScreenAudioTrack === ev.track;
        ev.track.onunmute = () => {
          if (current()) App.callSetRemoteScreenAudio(peer, audioStream);
        };
        ev.track.onended = () => {
          if (current()) App.callRemoveRemoteScreenAudio(peer);
        };
        return;
      }
      App.callEnsureAudioHost();

      // Some mobile browsers deliver a streamless track, while others attach
      // audio and video to the same remote stream. Give each peer a dedicated
      // audio-only MediaStream so playback/routing stays consistent.
      let audioStream = null;
      try {
        audioStream = new MediaStream([ev.track]);
      } catch {
        audioStream = stream;
      }
      let audio = App.callRemoteAudioEls.get(peer);
      if (!audio) {
        audio = document.createElement("audio");
        App.callAudioHost.appendChild(audio);
        App.callRemoteAudioEls.set(peer, audio);
      }
      audio.dataset.peerCode = peer;
      void App.callPrepareRemoteAudioElement(audio);
      if (audio.srcObject !== audioStream) {
        App.callDisconnectRemoteWebAudio(peer);
        audio.srcObject = audioStream;
      }
      if (App.callListenOnly || App.callGetUserVolumeGain(peer) > 1) {
        App.callConnectRemoteWebAudio(peer, audioStream, audio);
      } else {
        App.callApplyRemoteUserVolume(peer, {
          smooth: false
        });
      }
      const retryPlayback = () => {
        void App.callResumeRemoteAudio({
          fromGesture: false
        });
      };
      try {
        audio.addEventListener("loadedmetadata", retryPlayback, {
          once: true
        });
      } catch {}
      try {
        audio.addEventListener("canplay", retryPlayback, {
          once: true
        });
      } catch {}
      try {
        ev.track.addEventListener("unmute", retryPlayback);
      } catch {}
      App.callPeerStatusCache.set(peer, {
        connectionState: String(pc.connectionState || ""),
        iceConnectionState: String(pc.iceConnectionState || ""),
        receivingAudio: true,
        peerSessionId
      });
      void App.callUpdateConnectionQuality();
      void App.callResumeRemoteAudio({
        fromGesture: false
      });
      return;
    }
    if (ev.track.kind === "video") {
      // Request interactive playout from the first frame. The browser retains
      // its own minimum buffer when network jitter requires it.
      const receiver = ev.receiver || ev.transceiver?.receiver;
      try { if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; } catch {}
      const camera = App.callIsCameraTrack(pc, ev);
      const shareCode = camera ? App.callCameraKey(peer) : peer;
      const trackSlot = camera ? '__remoteCameraVideoTrack' : '__remoteScreenVideoTrack';
      // Keep visual streams audio-free; one independent playback path per
      // source prevents duplicate sound when a share is moved or focused.
      stream = new MediaStream([ev.track]);
      pc[trackSlot] = ev.track;
      App.callRemoteVideoStreams.set(shareCode, stream);
      App.callShareSyncRequestAt.delete(peer);
      App.callScreenHealthState.delete(peer);
      if (App.callMenuOpen) App.renderCallMenu();
      const cleanupShare = () => {
        if (!App.callPeerIsCurrent(pc, peer) || pc[trackSlot] !== ev.track) return;
        const live = stream?.getVideoTracks?.().some(t => t.readyState !== "ended");
        if (live) return;
        try {
          App.callRemoteVideoStreams.delete(shareCode);
        } catch {}
        if (App.callMenuOpen) App.renderCallMenu();
        if (App.callWatchedShareCodes.has(shareCode)) {
          App.syncShareViewStream();
        }
      };
      try {
        ev.track.onended = cleanupShare;
      } catch {}
      try {
        ev.track.onmute = () => {
          if (!App.callPeerIsCurrent(pc, peer) || pc[trackSlot] !== ev.track) return;
          if (App.callWatchedShareCodes.has(shareCode)) {
            App.syncShareViewStream();
            // A paused publisher is normal when this share has no subscribers.
          }
        };
      } catch {}
      try {
        ev.track.onunmute = () => {
          if (!App.callPeerIsCurrent(pc, peer) || pc[trackSlot] !== ev.track) return;
          App.callRemoteVideoStreams.set(shareCode, stream);
          App.callShareSyncRequestAt.delete(peer);
          App.callScreenHealthState.delete(peer);
          if (App.callMenuOpen) App.renderCallMenu();
          if (App.callWatchedShareCodes.has(shareCode)) {
            App.syncShareViewStream();
          }
        };
      } catch {}
      if (App.callWatchedShareCodes.has(shareCode)) {
        App.syncShareViewStream();
      }
    }
  };
  pc.onicecandidate = e => {
    const cand = e.candidate;
    if (!cand || !App.callPeerIsCurrent(pc, peer)) return;
    const localSignalId = String(pc.__localSignalId || "");
    if (!localSignalId) return;
    const path = App.callWeRtcPath(id, peer, peerSessionId, selfCode, localSessionId) + "/candidates";
    try {
      void App.db.ref(path).push({
        candidate: cand.candidate,
        sdpMid: cand.sdpMid,
        sdpMLineIndex: cand.sdpMLineIndex,
        usernameFragment: cand.usernameFragment || null,
        signalId: localSignalId
      }).catch(() => {});
    } catch {}
  };
  pc.onicecandidateerror = event => {
    if (!App.callPeerIsCurrent(pc, peer)) return;
    console.warn("ICE candidate gathering error:", event?.errorText || event?.errorCode || "unknown error");
    // One failed STUN/TURN URL is not a failed connection. Other configured
    // servers may still yield a working host, srflx, or relay candidate. The
    // connection/ICE state watchdogs above perform a bounded restart only when
    // the transport actually becomes disconnected or failed.
  };
  pc.onsignalingstatechange = () => {
    if (!App.callPeerIsCurrent(pc, peer) || pc.signalingState !== "stable") return;
    if (pc.__offerQueued) void App.callPumpQueuedOffer(pc);
    if (pc.__pendingRemoteOffer) void App.callDrainRemoteOffers(pc);
  };
  pc.onnegotiationneeded = () => {
    if (!App.callPeerIsCurrent(pc, peer)) return;
    if (pc.__polite && !pc.remoteDescription) return;
    void App.callSendOffer(peer, id);
  };
  App.callPeerMap.set(peer, pc);
  armConnectWatchdog();
  App.callWatchPeerSignals(peer, id);
  return pc;
};
App.callEnsurePeers = async function (roomId) {
  if (!App.currentUser || !App.currentCallRoomId || !App.callSessionId || App.callAudioPreferencesReady === false) return;
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const my = String(App.currentUser.code),
    sessionId = String(App.callSessionId),
    token = App.callLifecycleToken;
  const current = () => App.currentCallRoomId === id && App.callSessionId === sessionId && App.callLifecycleToken === token;
  const now = Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
  const peers = App.callMembersCache.filter(m => m && String(m.code) !== my && globalThis.ChatCallPolicy.keepMember(m, App.callPeerMap.get(String(m.code)), now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS));
  const codes = new Set(peers.map(m => String(m.code)));
  for (const code of App.callPeerMap.keys()) if (!codes.has(code)) App.callDestroyPeer(code, id, {
    removeSignaling: true
  });
  // Set up independent participants concurrently. A slow Firebase write for one
  // participant must not hold up four other peers in a six-person room.
  await Promise.allSettled(peers.map(async member => {
    if (!current()) return;
    const peer = String(member.code);
    let pc = App.callPeerMap.get(peer);
    if (pc && (pc.__peerSessionId !== member.sessionId || pc.__localSessionId !== sessionId || pc.__lifecycleToken !== token)) {
      App.callDestroyPeer(peer, id, {
        removeSignaling: true
      });
      pc = null;
    }
    const restartKey = id + ':' + sessionId + ':' + peer + ':' + member.sessionId;
    if (App.callPeerHardRestartPending.has(restartKey)) return;
    pc = pc || App.callCreatePeer(peer, id);
    if (!pc || !current() || !App.callPeerIsCurrent(pc, peer)) return;
    await Promise.allSettled([App.callSetPeerAudioTrack(pc, App.callGetLiveAudioTrack()), App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null), App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null)]);
    if (!current() || !App.callPeerIsCurrent(pc, peer)) return;
    // The lower code starts initial negotiation. Either side can renegotiate
    // after a remote description exists; perfect negotiation handles glare.
    if (!pc.__polite && !pc.__madeOffer && !pc.__offerQueued && !pc.__pendingOfferId) void App.callSendOffer(peer, id);
  }));
  App.callScheduleMediaBudget();
  void App.callUpdateConnectionQuality();
};
App.callAuditLocalMediaSenders = async function () {
  if (!App.currentCallRoomId || !App.callSessionId || !App.currentUser) return;
  const roomId = App.currentCallRoomId;
  const sessionId = App.callSessionId;
  const audioTrack = App.callGetLiveAudioTrack();
  const physicalTrack = App.callGetLiveAudioTrack(App.callRawMicrophoneStream || App.callLocalStream);
  if (App.callMicCtx?.state === "closed" && !App.callListenOnly) {
    App.callScheduleMicRecovery("microphone-context-closed", 180);
  } else if (["suspended", "interrupted"].includes(App.callMicCtx?.state)) {
    void App.callResumeRemoteAudio({ fromGesture: false });
  }
  if ((!audioTrack || !physicalTrack || physicalTrack.muted) && !App.callListenOnly) {
    const ended = !audioTrack || !physicalTrack;
    App.callScheduleMicRecovery(ended ? "track-ended" : "track-muted", ended ? 180 : App.CALL_MIC_MUTE_RECOVERY_MS);
  }
  for (const [peerCode, pc] of App.callPeerMap.entries()) {
    if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId || !App.callPeerIsCurrent(pc, peerCode)) return;
    try {
      const audioSender = App.callEnsurePeerAudioTransceiver(pc)?.sender || null;
      if (audioTrack && audioSender?.track !== audioTrack) {
        await App.callSetPeerAudioTrack(pc, audioTrack);
        App.callRequestPeerMediaRefresh(peerCode, "audio-sender-repair", {
          force: true
        });
      }
    } catch (e) {
      console.warn("microphone sender audit failed:", e);
    }
    try {
      const wantedScreenTrack = App.callPeerWantsScreen(peerCode) ? App.callGetSendingScreenTrack() : null;
      const screenSender = App.callEnsurePeerScreenTransceiver(pc)?.sender || null;
      const wantedScreenAudio = wantedScreenTrack && !App.callScreenPaused && App.callScreenAudioTrack?.readyState === 'live' ? App.callScreenAudioTrack : null;
      const screenAudioSender = pc.__screenAudioTx?.sender;
      if (screenSender && (screenSender.track !== wantedScreenTrack || screenAudioSender?.track !== wantedScreenAudio)) {
        await App.callSetPeerScreenTrack(pc, wantedScreenTrack);
        // replaceTrack repairs media without forced SDP churn.
      }
    } catch (e) {
      console.warn("screen sender audit failed:", e);
    }
    try { await App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null); }
    catch (e) { console.warn("camera sender audit failed:", e); }
  }
};
App.callAuditRemoteAudio = function () {
  if (!App.currentCallRoomId || App.callDeafened) return;
  let needsPlayback = App.callAudioUnlockRequired || (App.callRemoteWebAudioSources.size > 0 && App.callPlaybackCtx?.state !== "running");
  for (const [peer, pc] of App.callPeerMap) {
    if (!App.callPeerIsCurrent(pc, peer) || !globalThis.ChatCallPolicy.isConnected(pc)) continue;
    const tx = pc.__audioTx;
    const track = tx?.receiver?.track;
    const audio = App.callRemoteAudioEls.get(peer);
    // Restore detached DOM playback after mobile page suspension. The receiver
    // already owns the live stream; renegotiating a healthy call is unnecessary.
    if (track?.readyState === "live" && !audio?.srcObject?.getAudioTracks?.().includes(track)) {
      pc.ontrack?.({ track, receiver: tx.receiver, transceiver: tx, streams: [] });
      needsPlayback = true;
    } else if (audio?.srcObject && (audio.paused || audio.ended)) needsPlayback = true;
  }
  if (needsPlayback) void App.callResumeRemoteAudio({ fromGesture: false });
};
App.callCheckScreenHealth = async function () {
  if (!App.currentCallRoomId || !App.callSessionId || !App.callMenuOpen || document.visibilityState === 'hidden') return;
  const self = String(App.currentUser?.code || '');
  const active = new Set();
  for (const member of App.callMembersCache) {
    const code = String(member.code || '');
    if (!code || code === self || !member.sharing || !App.callWatchedShareCodes.has(code)) continue;
    if (App.callGetScreenPauseState(code).paused) { App.callScreenHealthState.delete(code); continue; }
    active.add(code);
    const pc = App.callPeerMap.get(code);
    const video = document.querySelector('.call-view-tile[data-share-code="' + CSS.escape(code) + '"] .call-view-video');
    const track = App.callRemoteVideoStreams.get(code)?.getVideoTracks?.().find(t => t.readyState === 'live');
    if (video?.paused && video.srcObject) {
      try {
        void video.play().catch(() => {});
      } catch {}
    }
    // A hidden tile, autoplay block, static screen or paused video is not an
    // ICE failure. Never tear down working audio because a DOM tile lacks frames.
    if (track && !track.muted) {
      App.callScreenHealthState.delete(code);
      continue;
    }
    const previous = App.callScreenHealthState.get(code);
    const now = Date.now();
    if (!previous) {
      App.callScreenHealthState.set(code, {
        checkedAt: now,
        failures: 1
      });
      continue;
    }
    if (now - previous.checkedAt < 12000) continue;
    App.callScreenHealthState.set(code, {
      checkedAt: now,
      failures: previous.failures + 1
    });
    void App.callSyncViewerPresence({
      force: true
    });
    if (pc && !globalThis.ChatCallPolicy.isConnected(pc)) pc.__requestRecovery?.('screen-transport-unavailable');
    else if (pc && previous.failures === 1) App.callRequestPeerMediaRefresh(code, 'screen-receiver-stalled');
  }
  for (const code of App.callScreenHealthState.keys()) if (!active.has(code)) App.callScreenHealthState.delete(code);
};
App.callStartScreenHealthMonitor = function () {
  App.callStopScreenHealthMonitor();
  let pending = false;
  App.callScreenHealthTimer = setInterval(async () => {
    if (pending || !App.currentCallRoomId) return;
    pending = true;
    try {
      await App.callAuditLocalMediaSenders();
      App.callAuditRemoteAudio();
      await App.callCheckScreenHealth();
    } finally {
      pending = false;
    }
  }, App.CALL_SCREEN_HEALTH_POLL_MS);
};
App.callStopScreenHealthMonitor = function () {
  if (App.callScreenHealthTimer) {
    try {
      clearInterval(App.callScreenHealthTimer);
    } catch {}
  }
  App.callScreenHealthTimer = null;
  App.callScreenHealthState.clear();
};
App.callStartWebRTC = function (roomId) {
  if (!App.currentUser || !App.callSessionId) return;
  App.callEnsureAudioHost();
  App.callApplyLocalMuteState();
  try {
    void App.db.ref('calls/' + roomId + '/webrtc/' + App.currentUser.code + '/' + App.callSessionId).onDisconnect().remove().catch(() => {});
  } catch {}
  void App.callEnsurePeers(roomId);
  App.callStartQualityMonitor();
  App.callStartScreenHealthMonitor();
  App.callStartShareViewerObserver(roomId);
  App.callScheduleIceCredentialRefresh();
  App.callShowConnectivityNotice();
};
App.callStopWebRTC = function ({
  roomId = null,
  preservePlaybackContext = false
} = {}) {
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const sessionId = App.callSessionId;
  if (App.callIceRefreshTimer) clearTimeout(App.callIceRefreshTimer);
  App.callIceRefreshTimer = null;
  if (App.callMediaBudgetTimer) clearTimeout(App.callMediaBudgetTimer);
  App.callMediaBudgetTimer = null;
  App.callMediaBudgetQueued = false;
  App.callScreenCaptureBudgetSignature = "";
  App.callConnectivityNoticeShown = false;
  App.callSignalingConnected = null;
  App.callStopSpeakingMonitor();
  App.callStopQualityMonitor();
  App.callStopScreenHealthMonitor();
  App.callClearMicRecoveryTimer();
  App.callMicRefreshGeneration += 1;
  App.callMicRefreshPending = false;
  App.callStopShareViewerObserver({
    roomId: id,
    sessionId
  });
  try {
    for (const code of Array.from(App.callPeerSignalRefs.keys())) {
      App.callDetachPeerSignals(code);
    }
  } catch {}
  App.callPeerSignalRefs.clear();
  App.callMemberSharingCache.clear();
  App.callPeerStatusCache.clear();
  App.callShareSyncRequestAt.clear();
  App.callPeerTopologySignature = "";
  App.callMemberUiSignature = "";

  // Tear down through the canonical path so both this session's inbox and its
  // branches under peers' inboxes are removed. This prevents stale offers and
  // candidates from surviving a leave/rejoin of the same active call.
  for (const code of Array.from(App.callPeerMap.keys())) {
    App.callDestroyPeer(code, id, {
      removeSignaling: true,
      preserveWatch: true
    });
  }
  App.callPeerMap.clear();
  for (const a of App.callRemoteAudioEls.values()) {
    try {
      a.srcObject = null;
    } catch {}
    try {
      a.remove();
    } catch {}
  }
  App.callRemoteAudioEls.clear();
  App.closeCallScreenContextMenu?.(true);
  for (const code of Array.from(App.callRemoteScreenAudioStreams?.keys() || [])) App.callRemoveRemoteScreenAudio?.(code);
  for (const frame of App.callRemoteNativeVolumeFades.values()) cancelAnimationFrame(frame);
  App.callRemoteNativeVolumeFades.clear();
  if (preservePlaybackContext) {
    for (const peer of Array.from(App.callRemoteWebAudioSources.keys())) App.callDisconnectRemoteWebAudio(peer);
  } else {
    App.callClosePlaybackContext();
  }
  App.callAudioPlaybackToken += 1;
  App.callAudioResumeGeneration += 1;
  App.callAudioUnlockRequired = false;
  App.callAudioResumePromise = null;
  App.callAudioResumeQueued = false;
  App.callSetMobileAudioSession(!!preservePlaybackContext);
  App.callSyncAudioPlaybackControls();
  App.callDisposeMicrophoneGraph({ closeContext: true });
  App.callListenOnly = false;
  App.callCancelScreenCapture?.();
  if (App.callScreenStream) {
    try {
      if (App.callScreenTrack) App.callScreenTrack.onended = null;
      if (App.callScreenAudioTrack) App.callScreenAudioTrack.onended = null;
    } catch {}
    try {
      App.callScreenStream.getTracks().forEach(t => {
        try {
          t.stop();
        } catch {}
        ;
      });
    } catch {}
  }
  App.callStopCamera({ publish: false });
  App.callScreenStream = null;
  App.callScreenTrack = null;
  App.callScreenAudioTrack = null;
  App.callScreenShareId = null;
  App.callScreenPreviewDataURL = null;
  App.callSharing = false;
  App.callRemoteVideoStreams.clear();
  App.callWatchedShareCodes.clear();
  App.closeShareView(true);
  App.callFocusedShareCode = null;
  App.callMultiViewEnabled = false;
  App.shareViewOpen = false;
  App.shareViewUserCode = null;
  App.shareViewUsername = null;
  if (id && App.currentUser && sessionId) {
    const my = String(App.currentUser.code);
    try {
      App.db.ref(`calls/${id}/webrtc/${my}/${sessionId}`).remove();
    } catch {}
  }
  App.callMuted = false;
  App.callDeafened = false;
  App.syncCallControlsUI();
};

App.register("calling/peers", function initializeFeature() {

});
})(globalThis.ChatApp);
