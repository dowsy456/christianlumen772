/* calling/signaling: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callPeerIsCurrent = /* Chat calling: signaling. Classic script; see CALLING.md. */function (pc, peerCode) {
  const code = String(peerCode || pc?.__peerCode || "");
  if (!pc || pc.__closing || !code) return false;
  return App.callPeerMap.get(code) === pc && App.currentCallRoomId === pc.__roomId && App.callSessionId === pc.__localSessionId && App.callLifecycleToken === pc.__lifecycleToken && App.callGetPeerSessionId(code) === pc.__peerSessionId;
};
App.callEnsurePeerAudioTransceiver = function (pc) {
  if (!pc) return null;
  if (pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return null;
  // An answer must use the transceiver associated with the offered m-line.
  // A precreated addTransceiver on an answerer may remain unassociated while
  // setRemoteDescription creates another receiver at mid 0.
  const negotiated = pc.getTransceivers?.().find(tx => !tx.stopped && tx !== pc.__screenAudioTx && tx?.mid != null && tx?.receiver?.track?.kind === 'audio');
  if (negotiated) pc.__audioTx = negotiated;
  if (pc.__audioTx) {
    if (pc.__audioTx.direction !== 'sendrecv') pc.__audioTx.direction = 'sendrecv';
    return pc.__audioTx;
  }
  try {
    pc.__audioTx = pc.getTransceivers?.().find(tx => !tx.stopped && tx !== pc.__screenAudioTx && tx?.receiver?.track?.kind === "audio") || null;
  } catch {}
  if (!pc.__audioTx && typeof pc.addTransceiver === "function") {
    pc.__audioTx = pc.addTransceiver("audio", {
      direction: "sendrecv"
    });
  }
  if (pc.__audioTx && pc.__audioTx.direction !== 'sendrecv') pc.__audioTx.direction = 'sendrecv';
  return pc.__audioTx || null;
};
App.callSetPeerAudioTrack = async function (pc, track) {
  if (!pc) return null;
  if (pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return null;
  const nextTrack = track && track.readyState === "live" ? track : null;
  const tx = App.callEnsurePeerAudioTransceiver(pc);
  let sender = tx?.sender || null;
  if (!sender) {
    sender = pc.getSenders?.().find(item => item !== pc.__screenAudioTx?.sender && item?.track?.kind === "audio") || null;
  }
  if (!sender && nextTrack && typeof pc.addTrack === "function") {
    sender = pc.addTrack(nextTrack, App.callLocalStream || new MediaStream([nextTrack]));
  } else if (sender && sender.track !== nextTrack) {
    await sender.replaceTrack(nextTrack);
  }
  await App.callTuneAudioSender(sender);
  return sender;
};
App.callMakeSignalId = function (prefix = "signal") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};
App.callRemoveSignalIfCurrent = async function (ref, signal) {
  if (!ref) return;
  const expectedId = String(signal?.id || "");
  const expectedSdp = String(signal?.sdp || "");
  try {
    await ref.transaction(current => {
      if (!current) return null;
      const same = expectedId ? String(current.id || "") === expectedId : !!expectedSdp && String(current.sdp || "") === expectedSdp;
      return same ? null : undefined;
    }, undefined, false);
  } catch {}
};
App.callDisposePeerConnection = function (pc) {
  if (!pc) return;
  try {
    pc.__closing = true;
  } catch {}
  for (const key of ["__connectTimer", "__discTimer", "__offerRetryTimer", "__answerWatchdog", "__remoteOfferRetryTimer", "__recoveryTimer", "__credentialRestartTimer", "__iceDrainTimer"]) {
    if (!pc[key]) continue;
    try {
      clearTimeout(pc[key]);
    } catch {}
    pc[key] = null;
  }
  try {
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.onsignalingstatechange = null;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.onicecandidateerror = null;
    pc.ontrack = null;
  } catch {}
  try {
    pc.getReceivers?.().forEach(receiver => {
      try {
        receiver.track?.stop?.();
      } catch {}
    });
  } catch {}
  try {
    pc.close();
  } catch {}
};
App.callWeRtcPath = function (roomId, toCode, toSessionId, fromCode, fromSessionId) {
  return `calls/${roomId}/webrtc/${toCode}/${toSessionId}/${fromCode}/${fromSessionId}`;
};
App.callComparePeerCodes = // Never use localeCompare() to choose WebRTC roles. Its result can vary with
// browser locale, which can make both ends believe the *other* end must offer.
// Direct string comparison is a stable UTF-16 code-unit order on every browser.
function (a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
};
App.callRequestPeerMediaRefresh = function (peerCode, reason = "media-refresh", {
  force = false,
  iceRestart = false
} = {}) {
  if (!App.currentUser || !App.currentCallRoomId || !App.callSessionId) return;
  const peer = String(peerCode || "");
  const peerSessionId = App.callGetPeerSessionId(peer);
  if (!peer || !peerSessionId) return;
  const now = Date.now();
  const last = Number(App.callShareSyncRequestAt.get(peer) || 0);
  if (!force && now - last < 2500) return;
  App.callShareSyncRequestAt.set(peer, now);

  // Either participant may publish an SDP change. Perfect-negotiation glare
  // handling below deterministically resolves simultaneous offers. This is
  // essential for screen sharing: a person's outgoing video can no longer be
  // blocked merely because their account code assigned them the non-offer role.
  void App.callSendOffer(peer, App.currentCallRoomId, {
    iceRestart: !!iceRestart
  });
};
App.callDrainPendingIce = async function (pc) {
  if (!pc?.remoteDescription || pc.__iceDrainPending) return;
  pc.__iceDrainPending = true;
  try {
    const queued = pc.__pendingCandidates || [];
    pc.__pendingCandidates = [];
    for (const candidate of queued) {
      if (!App.callPeerIsCurrent(pc, pc.__peerCode)) return;
      if (candidate.signalId && pc.__ignoredRemoteSignalIds?.has(candidate.signalId)) continue;
      if (!App.callCandidateMatchesDescription(pc, candidate)) {
        // Candidates for a new ICE generation can arrive before its SDP.
        if (Date.now() - Number(candidate.__queuedAt || Date.now()) < 30000) pc.__pendingCandidates.push(candidate);
        continue;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // SDP can be rolled back or replaced while addIceCandidate is pending.
        // Preserve transient failures instead of permanently dropping the only
        // usable relay candidate after removing it from the signaling inbox.
        candidate.__attempts = Number(candidate.__attempts || 0) + 1;
        if (candidate.__attempts < 4 && Date.now() - Number(candidate.__queuedAt || Date.now()) < 30000) pc.__pendingCandidates.push(candidate);
      }
    }
    if (pc.__pendingCandidates.length > 128) pc.__pendingCandidates = pc.__pendingCandidates.slice(-128);
  } finally {
    pc.__iceDrainPending = false;
    if (App.callPeerIsCurrent(pc, pc.__peerCode) && !pc.__iceDrainTimer && pc.__pendingCandidates?.some(candidate => App.callCandidateMatchesDescription(pc, candidate))) {
      pc.__iceDrainTimer = setTimeout(() => {
        pc.__iceDrainTimer = null;
        void App.callDrainPendingIce(pc);
      }, 250);
    }
  }
};
App.callCandidateMatchesDescription = function (pc, candidate) {
  if (!pc?.remoteDescription?.type) return false;
  const ufrag = String(candidate.usernameFragment || '');
  if (ufrag) return String(pc.remoteDescription.sdp || '').split(/\r?\n/).includes('a=ice-ufrag:' + ufrag);
  return !candidate.signalId || !pc.__remoteSignalId || String(candidate.signalId) === String(pc.__remoteSignalId);
};
App.callDetachPeerSignals = function (peerCode) {
  const code = String(peerCode || "");
  const ref = App.callPeerSignalRefs.get(code);
  if (!ref) return;
  try {
    ref.child("offer").off();
  } catch {}
  try {
    ref.child("answer").off();
  } catch {}
  try {
    ref.child("restart").off();
  } catch {}
  try {
    ref.child("restartRequests").off();
  } catch {}
  try {
    ref.child("candidates").off();
  } catch {}
  App.callPeerSignalRefs.delete(code);
};
App.callDestroyPeer = function (peerCode, roomId, {
  removeSignaling = true,
  preserveWatch = false
} = {}) {
  const code = String(peerCode || "");
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const pc = App.callPeerMap.get(code);
  const peerSessionId = String(pc?.__peerSessionId || App.callGetPeerSessionId(code) || "");
  const localSessionId = String(pc?.__localSessionId || App.callSessionId || "");
  if (pc) {
    App.callDisposePeerConnection(pc);
    App.callPeerMap.delete(code);
  }
  App.callDetachPeerSignals(code);
  App.callPeerStatusCache.delete(code);
  App.callScreenHealthState.delete(code);
  App.callDisconnectRemoteWebAudio(code);
  const volumeFade = App.callRemoteNativeVolumeFades.get(code);
  if (volumeFade) cancelAnimationFrame(volumeFade);
  App.callRemoteNativeVolumeFades.delete(code);
  const a = App.callRemoteAudioEls.get(code);
  if (a) {
    try {
      a.srcObject = null;
    } catch {}
    try {
      a.remove();
    } catch {}
  }
  App.callRemoteAudioEls.delete(code);
  App.callRemoveRemoteScreenAudio?.(code);
  try {
    App.callRemoteVideoStreams.delete(code);
    App.callRemoteVideoStreams.delete(App.callCameraKey(code));
  } catch {}
  if (!preserveWatch) {
    const cameraKey = App.callCameraKey(code);
    App.callWatchedShareCodes.delete(cameraKey);
    if (App.callFocusedShareCode === cameraKey) App.callFocusedShareCode = null;
  }
  if (!preserveWatch && App.callWatchedShareCodes.has(code)) {
    App.callWatchedShareCodes.delete(code);
    if (App.callFocusedShareCode === code) App.callFocusedShareCode = null;
    App.shareViewOpen = App.callWatchedShareCodes.size > 0;
  }
  if (removeSignaling && id && App.currentUser && localSessionId && peerSessionId) {
    const my = String(App.currentUser.code);
    try {
      App.db.ref(App.callWeRtcPath(id, code, peerSessionId, my, localSessionId)).remove();
    } catch {}
    try {
      App.db.ref(App.callWeRtcPath(id, my, localSessionId, code, peerSessionId)).remove();
    } catch {}
  }
};
App.callScheduleOfferPump = function (pc, delayMs = 180) {
  if (!pc || pc.__closing || pc.__offerRetryTimer) return;
  pc.__offerRetryTimer = setTimeout(() => {
    pc.__offerRetryTimer = null;
    void App.callPumpQueuedOffer(pc);
  }, Math.max(80, Number(delayMs) || 180));
};
App.callWatchOfferAnswer = function (pc, signalId, offerRef) {
  clearTimeout(pc.__answerWatchdog);
  const check = async () => {
    pc.__answerWatchdog = null;
    if (!App.callPeerIsCurrent(pc, pc.__peerCode) || pc.__pendingOfferId !== signalId || pc.signalingState !== 'have-local-offer') return;
    if (pc.__handlingAnswer || pc.__handlingOffer || pc.__makingOffer) {
      pc.__answerWatchdog = setTimeout(check, 1000); return;
    }
    try {
      // Media can remain connected while a renegotiation answer is lost. Its
      // transport watchdog never fires, leaving new shares/joins stuck forever.
      // Roll back only this offer; preserve the working audio/ICE transport.
      await pc.setLocalDescription({ type: 'rollback' });
      if (!App.callPeerIsCurrent(pc, pc.__peerCode)) return;
      if (pc.__pendingOfferId === signalId) pc.__pendingOfferId = null;
      if (pc.__localSignalId === signalId) pc.__localSignalId = '';
      void App.callRemoveSignalIfCurrent(offerRef, { id: signalId });
      await App.callSendOffer(pc.__peerCode, pc.__roomId, { iceRestart: !globalThis.ChatCallPolicy.isConnected(pc) });
    } catch (error) {
      console.warn('Call negotiation retry:', error?.message || error);
      pc.__requestRecovery?.('answer-timeout');
    }
  };
  pc.__answerWatchdog = setTimeout(check, 15000);
};
App.callPumpQueuedOffer = async function (pc) {
  if (!pc || pc.__closing || pc.__offerPumpPromise || !pc.__offerQueued) return false;
  const peer = String(pc.__peerCode || "");
  const my = String(App.currentUser?.code || "");
  if (!App.callPeerIsCurrent(pc, peer) || !my) return false;
  // setLocalDescription(answer) fires a stable-state event before the answer
  // has been published. A queued negotiation must not replace localDescription
  // with an offer while the answer handler is still reading it.
  if (pc.__handlingOffer || pc.__handlingAnswer || pc.__pendingRemoteOffer || pc.__pendingRemoteAnswer) return false;
  if (pc.signalingState !== "stable") {
    // signalingstatechange wakes this queue; recovery handles a lost answer.
    return true;
  }
  const run = (async () => {
    const useIceRestart = !!pc.__queuedIceRestart;
    pc.__offerQueued = false;
    pc.__queuedIceRestart = false;
    pc.__makingOffer = true;
    const roomId = String(pc.__roomId || "");
    const localSessionId = String(pc.__localSessionId || "");
    const peerSessionId = String(pc.__peerSessionId || "");
    const signalId = App.callMakeSignalId("offer");
    try {
      // negotiationneeded can run before an asynchronous replaceTrack finishes.
      // Attach the microphone before creating SDP on every offer path.
      await App.callSetPeerAudioTrack(pc, App.callGetLiveAudioTrack());
      await App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null);
      await App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null);
      if (!App.callPeerIsCurrent(pc, peer)) return false;
      const offer = await pc.createOffer(useIceRestart ? {
        iceRestart: true
      } : undefined);
      if (!App.callPeerIsCurrent(pc, peer)) return false;
      pc.__localSignalId = signalId;
      await pc.setLocalDescription(App.callPrepareLocalDescription(offer));
      await App.callPrimePeerMedia(pc);
      if (!App.callPeerIsCurrent(pc, peer) || pc.signalingState !== "have-local-offer") return false;
      pc.__pendingOfferId = signalId;
      const offerRef = App.db.ref(App.callWeRtcPath(roomId, peer, peerSessionId, my, localSessionId)).child("offer");
      const offerPayload = {
        id: signalId,
        type: pc.localDescription.type,
        sdp: pc.localDescription.sdp,
        iceRestart: useIceRestart,
        createdAt: App.firebase.database.ServerValue.TIMESTAMP
      };
      await offerRef.set(offerPayload);
      if (!App.callPeerIsCurrent(pc, peer)) return false;

      // A polite collision may roll this offer back while the Firebase write is
      // in flight. Do not leave that abandoned value in the peer's inbox.
      if (String(pc.__pendingOfferId || "") !== signalId) {
        await App.callRemoveSignalIfCurrent(offerRef, offerPayload);
        return pc.signalingState === "stable";
      }
      pc.__madeOffer = true;
      App.callWatchOfferAnswer(pc, signalId, offerRef);
      return true;
    } catch (e) {
      if (App.callPeerIsCurrent(pc, peer)) {
        if (pc.__pendingOfferId === signalId) pc.__pendingOfferId = null;
        if (pc.__localSignalId === signalId) pc.__localSignalId = "";

        // If publishing failed after setLocalDescription, no remote can answer
        // the unpublished offer. Roll back before retrying so the pump is not
        // stranded forever in `have-local-offer`.
        let stableForRetry = pc.signalingState === "stable";
        if (!stableForRetry && pc.signalingState === "have-local-offer") {
          try {
            await pc.setLocalDescription({
              type: "rollback"
            });
            stableForRetry = pc.signalingState === "stable";
          } catch {}
        }
        if (stableForRetry && App.callPeerIsCurrent(pc, peer)) {
          pc.__offerQueued = true;
          pc.__queuedIceRestart = pc.__queuedIceRestart || useIceRestart;
          App.callScheduleOfferPump(pc, 650);
        } else if (App.callPeerIsCurrent(pc, peer)) {
          void App.callHardRestartPeer(peer, roomId, "offer-publication-failed");
        }
      }
      console.error("offer send failed:", e);
      return false;
    } finally {
      pc.__makingOffer = false;
    }
  })();
  pc.__offerPumpPromise = run;
  try {
    return await run;
  } finally {
    if (pc.__offerPumpPromise === run) pc.__offerPumpPromise = null;
    if (pc.__offerQueued && !pc.__offerRetryTimer) {
      if (pc.signalingState === "stable") queueMicrotask(() => {
        void App.callPumpQueuedOffer(pc);
      });
      // A stable-state event resumes negotiation without a permanent poll loop.
    }
  }
};
App.callSendOffer = async function (peerCode, roomId, {
  iceRestart = false
} = {}) {
  if (!App.currentUser || !App.currentCallRoomId || !App.callSessionId) return false;
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const peer = String(peerCode || "");
  const pc = App.callPeerMap.get(peer);
  if (!id || !peer || !pc || !App.callPeerIsCurrent(pc, peer)) return false;
  if (pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return false;
  pc.__offerQueued = true;
  pc.__queuedIceRestart = pc.__queuedIceRestart || !!iceRestart;
  await App.callPumpQueuedOffer(pc);
  return true;
};
App.callHardRestartPeer = async function (peerCode, roomId, reason = "") {
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  const peer = String(peerCode || "");
  if (!id || !peer || App.currentCallRoomId !== id || !App.callSessionId) return;
  const old = App.callPeerMap.get(peer);
  const localSessionId = String(old?.__localSessionId || App.callSessionId || "");
  const peerSessionId = String(old?.__peerSessionId || App.callGetPeerSessionId(peer) || "");
  const selfCode = String(App.currentUser?.code || "");
  if (!localSessionId || !peerSessionId || !selfCode) return;
  const restartKey = `${id}:${localSessionId}:${peer}:${peerSessionId}`;
  if (App.callPeerHardRestartPending.has(restartKey)) return;
  App.callPeerHardRestartPending.add(restartKey);
  try {
    if (old) old.__hardRestarting = true;
    App.callDestroyPeer(peer, id, {
      removeSignaling: false,
      preserveWatch: true
    });
    try {
      // Clear only this browser's outgoing branch. The peer's incoming branch
      // may contain its sole recovery offer; erasing both directions can make
      // simultaneous restarts delete one another's SDP and deadlock.
      await App.db.ref(App.callWeRtcPath(id, peer, peerSessionId, selfCode, localSessionId)).remove();
    } catch {}
    if (App.currentCallRoomId !== id || App.callSessionId !== localSessionId || App.callGetPeerSessionId(peer) !== peerSessionId) return;

    // A topology audit may have recreated a peer while Firebase cleanup was in
    // flight. Its just-published offer could have been erased by that cleanup,
    // so dispose it and always start from a stable, known signaling state.
    const interim = App.callPeerMap.get(peer);
    if (interim) App.callDestroyPeer(peer, id, {
      removeSignaling: false,
      preserveWatch: true
    });
    const replacement = App.callCreatePeer(peer, id);
    if (!replacement) return;
    // A replacement has no remote SDP, including on the polite side. Let this
    // recovery owner offer immediately; waiting for the normal initial-offer
    // rule stranded polite replacements until the next 18-second watchdog.
    replacement.__allowInitialOffer = true;
    await App.callSetPeerAudioTrack(replacement, App.callGetLiveAudioTrack());
    await App.callSetPeerScreenTrack(replacement, App.callSharing ? App.callScreenTrack : null);
    await App.callSetPeerCameraTrack(replacement, App.callCameraSharing ? App.callCameraTrack : null);
    await App.callSendOffer(peer, id, { iceRestart: true });
  } finally {
    App.callPeerHardRestartPending.delete(restartKey);
  }
};
App.callScheduleRemoteOfferDrain = function (pc, delayMs = 180) {
  if (!pc || pc.__closing || pc.__remoteOfferRetryTimer) return;
  pc.__remoteOfferRetryTimer = setTimeout(() => {
    pc.__remoteOfferRetryTimer = null;
    void App.callDrainRemoteOffers(pc);
  }, Math.max(80, Number(delayMs) || 180));
};
App.callDrainRemoteOffers = async function (pc) {
  if (!pc || pc.__closing || pc.__handlingOffer || !pc.__pendingRemoteOffer) return;

  // Serialize SDP mutations. The only safe overlap is the impolite peer
  // discarding a glare offer while its matching answer is already being
  // applied; that path only removes the Firebase value and never changes SDP.
  const canIgnoreDuringAnswer = (pc.__handlingAnswer || pc.__pendingRemoteAnswer) && !pc.__polite && !pc.__makingOffer && pc.signalingState === "have-local-offer" && !!pc.__pendingOfferId;
  if ((pc.__handlingAnswer || pc.__pendingRemoteAnswer) && !canIgnoreDuringAnswer) {
    if (pc.__pendingRemoteAnswer && !pc.__handlingAnswer) void App.callDrainRemoteAnswers(pc);
    App.callScheduleRemoteOfferDrain(pc, 100);
    return;
  }
  pc.__handlingOffer = true;
  try {
    while (pc.__pendingRemoteOffer && App.callPeerIsCurrent(pc, pc.__peerCode)) {
      const pending = pc.__pendingRemoteOffer;
      pc.__pendingRemoteOffer = null;
      const offer = pending.offer;
      const signalId = String(offer?.id || `legacy_${String(offer?.sdp || "").length}_${String(offer?.sdp || "").slice(-24)}`);

      // Firebase `value` can withdraw/replace an offer while this drain was
      // delayed behind local publication or answer handling. Never replay that
      // canceled SDP after the connection has returned to stable.
      if (typeof pc.__observedRemoteOfferId === "string" && pc.__observedRemoteOfferId !== signalId) {
        continue;
      }
      if (pc.__lastRemoteOfferId === signalId) {
        await App.callRemoveSignalIfCurrent(pending.ref, offer);
        continue;
      }
      try {
        const answerRef = pending.answerRef || App.db.ref(App.callWeRtcPath(pc.__roomId, pc.__peerCode, pc.__peerSessionId, App.currentUser.code, pc.__localSessionId)).child("answer");

        // If setting the answer in Firebase failed after the WebRTC state
        // already became stable, retry that exact serialized answer instead of
        // trying to apply the same remote offer again.
        if (pending.answerPayload) {
          await answerRef.set(pending.answerPayload);
          if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
          pc.__lastRemoteOfferId = signalId;
          await App.callRemoveSignalIfCurrent(pending.ref, offer);
          continue;
        }
        const resumingAppliedOffer = pending.remoteAppliedId === signalId && pc.signalingState === "have-remote-offer";
        if (!resumingAppliedOffer) {
          const offerCollision = pc.__makingOffer || pc.signalingState !== "stable";

          // Let an in-flight local publication settle before resolving glare.
          // Otherwise an optimistic local Firebase write could make us discard
          // the only durable remote offer even if our own write later fails.
          if (pc.__makingOffer) {
            if (!pc.__pendingRemoteOffer) pc.__pendingRemoteOffer = pending;
            App.callScheduleRemoteOfferDrain(pc, 180);
            break;
          }
          if (offerCollision && !pc.__polite && pc.signalingState === "have-local-offer" && !!pc.__pendingOfferId) {
            // callPumpQueuedOffer does not clear __makingOffer until its exact
            // offer is durably written (and rolls back/restarts on failure).
            // Therefore this local offer is authoritative even if its Firebase
            // leaf has already disappeared: normal answer publication consumes
            // that leaf first. Re-reading it here caused both peers to roll back
            // during ordinary glare and stranded one-way screen senders.
            pc.__ignoredRemoteSignalIds = pc.__ignoredRemoteSignalIds || new Set();
            pc.__ignoredRemoteSignalIds.add(signalId);
            while (pc.__ignoredRemoteSignalIds.size > 16) {
              pc.__ignoredRemoteSignalIds.delete(pc.__ignoredRemoteSignalIds.values().next().value);
            }
            if (Array.isArray(pc.__pendingCandidates)) {
              pc.__pendingCandidates = pc.__pendingCandidates.filter(candidate => String(candidate?.signalId || "") !== signalId);
            }
            await App.callRemoveSignalIfCurrent(pending.ref, offer);
            continue;
          }
          if (offerCollision) {
            let rolledBack = false;
            const abandonedOfferId = String(pc.__pendingOfferId || "");
            try {
              if (pc.signalingState === "have-local-offer") {
                await pc.setLocalDescription({
                  type: "rollback"
                });
              } else if (pc.signalingState === "have-remote-offer") {
                await pc.setRemoteDescription({
                  type: "rollback"
                });
              }
              rolledBack = pc.signalingState === "stable";
            } catch {}
            if (!rolledBack) {
              // Preserve any newer value-event work. The still-present Firebase
              // offer will be picked up by the fresh peer after this restart.
              if (!pc.__pendingRemoteOffer) pc.__pendingRemoteOffer = pending;
              void App.callHardRestartPeer(pc.__peerCode, pc.__roomId, "remote-offer-rollback-failed");
              break;
            }

            // The polite peer abandoned its local offer in favor of the remote
            // one. Clear its bookkeeping and conditionally remove only that
            // exact abandoned Firebase value; never erase a newer offer.
            if (abandonedOfferId) {
              pc.__pendingOfferId = null;
              pc.__localSignalId = "";
              pc.__madeOffer = false;
              const abandonedRef = App.db.ref(App.callWeRtcPath(pc.__roomId, pc.__peerCode, pc.__peerSessionId, App.currentUser.code, pc.__localSessionId)).child("offer");
              // Withdraw the rolled-back offer before publishing its answer.
              // This preserves deterministic Firebase ordering for the
              // impolite peer and prevents a stale offer being replayed later.
              await App.callRemoveSignalIfCurrent(abandonedRef, {
                id: abandonedOfferId
              });
            }
          }

          // Revalidate after rollback/Firebase awaits. A later value event may
          // have withdrawn this exact offer or replaced it with a new one.
          if (typeof pc.__observedRemoteOfferId === "string" && pc.__observedRemoteOfferId !== signalId) {
            continue;
          }
          await pc.setRemoteDescription(new RTCSessionDescription({
            type: offer.type,
            sdp: offer.sdp
          }));
          if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
          pc.__ignoredRemoteSignalIds?.delete?.(signalId);
          pending.remoteAppliedId = signalId;
          pc.__remoteSignalId = signalId;
          await App.callDrainPendingIce(pc);
        }

        // Remote SDP creates/associates answer-side transceivers. Attach local
        // media and set sendrecv before createAnswer, otherwise the answer is
        // recvonly and audio flows only from the initial offerer.
        await App.callSetPeerAudioTrack(pc, App.callGetLiveAudioTrack());
        await App.callSetPeerScreenTrack(pc, App.callSharing ? App.callScreenTrack : null);
        await App.callSetPeerCameraTrack(pc, App.callCameraSharing ? App.callCameraTrack : null);
        if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
        const answer = await pc.createAnswer();
        pc.__localSignalId = signalId;
        await pc.setLocalDescription(App.callPrepareLocalDescription(answer));
        await App.callPrimePeerMedia(pc);
        if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
        pending.answerRef = answerRef;
        pending.answerPayload = {
          id: signalId,
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
          createdAt: App.firebase.database.ServerValue.TIMESTAMP
        };
        await answerRef.set(pending.answerPayload);
        if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
        pc.__lastRemoteOfferId = signalId;
        await App.callRemoveSignalIfCurrent(pending.ref, offer);
      } catch (e) {
        if (App.callPeerIsCurrent(pc, pc.__peerCode)) {
          // A value callback may have queued a newer offer while the answer was
          // being prepared. Never overwrite that newer work with this retry.
          if (!pc.__pendingRemoteOffer) pc.__pendingRemoteOffer = pending;
          App.callScheduleRemoteOfferDrain(pc, 500);
        }
        console.error("offer handling failed:", e);
        break;
      }
    }
  } finally {
    pc.__handlingOffer = false;
    if (pc.__pendingRemoteAnswer && !pc.__handlingAnswer) {
      queueMicrotask(() => {
        void App.callDrainRemoteAnswers(pc);
      });
    } else if (pc.__pendingRemoteOffer && pc.signalingState === "stable" && !pc.__remoteOfferRetryTimer) {
      queueMicrotask(() => {
        void App.callDrainRemoteOffers(pc);
      });
    } else if (pc.__offerQueued && pc.signalingState === "stable") {
      queueMicrotask(() => { void App.callPumpQueuedOffer(pc); });
    }
  }
};
App.callDrainRemoteAnswers = async function (pc) {
  if (!pc || pc.__closing || pc.__handlingAnswer || pc.__handlingOffer || !pc.__pendingRemoteAnswer) return;
  pc.__handlingAnswer = true;
  try {
    while (pc.__pendingRemoteAnswer && App.callPeerIsCurrent(pc, pc.__peerCode)) {
      const pending = pc.__pendingRemoteAnswer;
      pc.__pendingRemoteAnswer = null;
      const answer = pending.answer;
      const signalId = String(answer?.id || "");
      if (signalId && pc.__pendingOfferId && signalId !== String(pc.__pendingOfferId)) {
        await App.callRemoveSignalIfCurrent(pending.ref, answer);
        continue;
      }
      if (signalId && pc.__lastRemoteAnswerId === signalId) {
        await App.callRemoveSignalIfCurrent(pending.ref, answer);
        continue;
      }
      if (pc.signalingState !== "have-local-offer") {
        await App.callRemoveSignalIfCurrent(pending.ref, answer);
        continue;
      }
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: answer.type,
          sdp: answer.sdp
        }));
        await App.callPrimePeerMedia(pc);
        if (!App.callPeerIsCurrent(pc, pc.__peerCode)) break;
        pc.__remoteSignalId = signalId || pc.__pendingOfferId || "";
        pc.__lastRemoteAnswerId = signalId || String(answer.sdp || "");
        pc.__pendingOfferId = null;
        await App.callDrainPendingIce(pc);
        await App.callRemoveSignalIfCurrent(pending.ref, answer);
        if (pc.__offerQueued) void App.callPumpQueuedOffer(pc);
      } catch (e) {
        console.error("answer handling failed:", e);
        if (App.callPeerIsCurrent(pc, pc.__peerCode)) {
          await App.callRemoveSignalIfCurrent(pending.ref, answer);
          if (App.callPeerIsCurrent(pc, pc.__peerCode)) {
            await App.callHardRestartPeer(pc.__peerCode, pc.__roomId, "remote-answer-apply-failed");
          }
        }
        break;
      }
    }
  } finally {
    pc.__handlingAnswer = false;
    if (pc.__pendingRemoteAnswer && App.callPeerIsCurrent(pc, pc.__peerCode)) {
      queueMicrotask(() => {
        void App.callDrainRemoteAnswers(pc);
      });
    } else if (pc.__pendingRemoteOffer && App.callPeerIsCurrent(pc, pc.__peerCode)) {
      queueMicrotask(() => {
        void App.callDrainRemoteOffers(pc);
      });
    } else if (pc.__offerQueued && pc.signalingState === "stable") {
      queueMicrotask(() => { void App.callPumpQueuedOffer(pc); });
    }
  }
};
App.callWatchPeerSignals = function (peerCode, roomId) {
  if (!App.currentUser || !App.callSessionId) return;
  const code = String(peerCode || "");
  const peerSessionId = App.callGetPeerSessionId(code);
  const localSessionId = String(App.callSessionId || "");
  const lifecycleToken = App.callLifecycleToken;
  const selfCode = String(App.currentUser.code || "");
  const id = App.sanitizeCallRoom(roomId);
  if (!id || !peerSessionId || !localSessionId || !selfCode) return;
  const contextIsCurrent = () => App.currentCallRoomId === id && App.callSessionId === localSessionId && App.callLifecycleToken === lifecycleToken && App.callGetPeerSessionId(code) === peerSessionId;
  App.callDetachPeerSignals(code);
  const incomingRef = App.db.ref(App.callWeRtcPath(id, selfCode, localSessionId, code, peerSessionId));
  App.callPeerSignalRefs.set(code, incomingRef);
  incomingRef.child("offer").on("value", snap => {
    const offer = snap.val();
    if (!contextIsCurrent()) return;
    const existing = App.callPeerMap.get(code) || null;
    if (!offer || !offer.sdp) {
      if (!App.callPeerIsCurrent(existing, code)) return;
      const withdrawnId = String(existing.__observedRemoteOfferId || "");
      existing.__observedRemoteOfferId = "";
      const queued = existing.__pendingRemoteOffer?.offer || null;
      const queuedId = String(queued?.id || `legacy_${String(queued?.sdp || "").length}_${String(queued?.sdp || "").slice(-24)}`);
      if (withdrawnId && queued && queuedId === withdrawnId) existing.__pendingRemoteOffer = null;
      return;
    }
    const pc = existing || App.callCreatePeer(code, id);
    if (!App.callPeerIsCurrent(pc, code)) return;
    const signalId = String(offer.id || `legacy_${String(offer.sdp || "").length}_${String(offer.sdp || "").slice(-24)}`);
    pc.__observedRemoteOfferId = signalId;
    pc.__pendingRemoteOffer = {
      offer,
      ref: snap.ref
    };
    void App.callDrainRemoteOffers(pc);
  });
  incomingRef.child("answer").on("value", snap => {
    const answer = snap.val();
    if (!answer || !answer.sdp || !contextIsCurrent()) return;
    const pc = App.callPeerMap.get(code);
    if (!App.callPeerIsCurrent(pc, code)) return;
    pc.__pendingRemoteAnswer = {
      answer,
      ref: snap.ref
    };
    void App.callDrainRemoteAnswers(pc);
  });

  // Backward compatibility for clients still writing the earlier scalar request.
  incomingRef.child("restart").on("value", async snap => {
    if (!snap.val() || !contextIsCurrent()) return;
    const pc = App.callPeerMap.get(code) || App.callCreatePeer(code, id);
    const needsIce = ["failed", "disconnected"].includes(String(pc?.iceConnectionState || ""));
    try {
      await App.callSendOffer(code, id, {
        iceRestart: needsIce
      });
    } catch {}
    try {
      await snap.ref.remove();
    } catch {}
  });
  incomingRef.child("restartRequests").on("child_added", async snap => {
    const request = snap.val() || null;
    if (!request || !contextIsCurrent()) return;
    if (request.localSessionId && String(request.localSessionId) !== peerSessionId) {
      try {
        await snap.ref.remove();
      } catch {}
      return;
    }
    if (request.peerSessionId && String(request.peerSessionId) !== localSessionId) {
      try {
        await snap.ref.remove();
      } catch {}
      return;
    }
    const requestReason = String(request.reason || "media-refresh");
    if (requestReason.startsWith("hard-restart:")) {
      try {
        await snap.ref.remove();
      } catch {}
      if (!contextIsCurrent()) return;
      await App.callHardRestartPeer(code, id, `requested-${requestReason.slice("hard-restart:".length) || "peer-recovery"}`);
      return;
    }
    App.callPeerMap.get(code) || App.callCreatePeer(code, id);
    const needsIce = /ice|failed|disconnected|reconnect|timeout/i.test(requestReason);
    try {
      await App.callSendOffer(code, id, {
        iceRestart: needsIce
      });
    } catch {}
    try {
      await snap.ref.remove();
    } catch {}
  });
  incomingRef.child("candidates").on("child_added", async snap => {
    const candidate = snap.val();
    if (!candidate || !candidate.candidate || !contextIsCurrent()) return;
    const pc = App.callPeerMap.get(code);
    if (!App.callPeerIsCurrent(pc, code)) return;
    candidate.__queuedAt = Date.now();
    const candidateSignalId = String(candidate.signalId || "");
    if (candidateSignalId && pc.__ignoredRemoteSignalIds?.has?.(candidateSignalId)) {
      try {
        await snap.ref.remove();
      } catch {}
      return;
    }
    pc.__pendingCandidates = pc.__pendingCandidates || [];
    pc.__pendingCandidates.push(candidate);
    if (pc.__pendingCandidates.length > 128) pc.__pendingCandidates.shift();
    void App.callDrainPendingIce(pc);
    try {
      await snap.ref.remove();
    } catch {}
  });
};

App.register("calling/signaling", function initializeFeature() {

});
})(globalThis.ChatApp);
