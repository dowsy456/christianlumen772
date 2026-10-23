/* calling/microphone: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callGetInputVolumePercent = function () {
  return Number.isFinite(App.callInputVolume) ? Math.max(0, Math.min(100, App.callInputVolume)) : 100;
};
App.callGetEffectiveInputVolumePercent = function () {
  return App.callMuted || App.callDeafened || App.callListenOnly ? 0 : App.callGetInputVolumePercent();
};
App.callApplyInputVolume = function ({ smooth = true } = {}) {
  const param = App.callMicGain?.gain;
  if (param) {
    const now = App.callMicCtx.currentTime;
    const target = App.callGetInputVolumePercent() / 100;
    param.cancelScheduledValues(now);
    if (smooth && target > 0) param.setTargetAtTime(target, now, 0.025);
    else param.setValueAtTime(target, now);
  }
  // Zero must be actual silence, including while an AudioContext is suspended.
  for (const track of App.callLocalStream?.getAudioTracks?.() || []) {
    track.enabled = !(App.callMuted || App.callDeafened) && App.callGetInputVolumePercent() > 0;
  }
  for (const track of App.callRawMicrophoneStream?.getAudioTracks?.() || []) {
    track.enabled = !(App.callMuted || App.callDeafened) && App.callGetInputVolumePercent() > 0;
  }
};
App.callSetInputVolumePercent = function (raw) {
  const previousVolume = App.callGetInputVolumePercent();
  App.callInputVolume = Math.round(Math.max(0, Math.min(100, Number(raw) || 0)));
  App.callSyncInputVolumeMute(previousVolume);
  App.callApplyInputVolume();
  App.callSaveAudioPreferences();
  App.callSyncAudioSettingsUI?.();
  return App.callInputVolume;
};
App.callSyncInputVolumeMute = function (previousVolume) {
  const wasMuted = !!App.callMuted;
  if (App.callGetInputVolumePercent() === 0) App.callMuted = true;
  else if (previousVolume === 0 && !App.callListenOnly) App.callMuted = false;
  if (wasMuted === !!App.callMuted) return;
  const member = App.callMembersCache.find(item => String(item.code) === String(App.currentUser?.code));
  if (member) {
    member.muted = !!App.callMuted;
    member.speaking = false;
  }
  App.callSetLocalSpeaking(false, { force: true });
  App.syncCallControlsUI();
  if (App.callMenuOpen) App.renderCallMenu?.();
  try {
    void App.myCallMemberRef?.update({
      muted: !!App.callMuted,
      speaking: false,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    }).catch(() => {});
  } catch {}
};
App.callPrimeMicrophoneContext = function () {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!App.callMicCtx || App.callMicCtx.state === "closed") App.callMicCtx = new AC({ latencyHint: "interactive" });
    if (["suspended", "interrupted"].includes(App.callMicCtx.state)) App.callMicCtx.resume()?.catch?.(() => {});
  } catch (error) { console.warn("Microphone volume context unavailable:", error); }
  return App.callMicCtx;
};
App.callDisposeMicrophoneGraph = function ({ closeContext = false } = {}) {
  for (const node of [App.callMicSource, App.callMicGain, App.callMicDestination]) {
    try { node?.disconnect(); } catch {}
  }
  const tracks = new Set([...(App.callLocalStream?.getTracks?.() || []), ...(App.callRawMicrophoneStream?.getTracks?.() || [])]);
  for (const track of tracks) {
    track.onended = track.onmute = track.onunmute = null;
    try { track.stop(); } catch {}
  }
  App.callLocalStream = App.callRawMicrophoneStream = null;
  App.callMicSource = App.callMicGain = App.callMicDestination = null;
  if (closeContext) {
    try { App.callMicCtx?.close()?.catch?.(() => {}); } catch {}
    App.callMicCtx = null;
  }
};
App.callRequestMicPermission = /* Chat calling: microphone. Classic script; see CALLING.md. */async function ({ deviceId = App.callPreferredAudioInputId } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    App.showToast({
      title: "Microphone unavailable",
      body: "This runtime does not expose microphone access.",
      duration: 4500
    });
    return null;
  }
  App.callPrimeMicrophoneContext();
  const prep = async stream => {
    try {
      for (const track of stream.getAudioTracks()) {
        try {
          track.contentHint = "speech";
        } catch {}
        try {
          await track.applyConstraints({
            echoCancellation: {
              ideal: true
            },
            noiseSuppression: {
              ideal: true
            },
            autoGainControl: {
              ideal: true
            },
            channelCount: {
              ideal: 1
            },
            sampleRate: {
              ideal: 48000
            }
          });
        } catch {}
      }
    } catch {}
    void App.callRefreshAudioDevices?.();
    return stream;
  };
  try {
    const constraints = { ...App.CALL_AUDIO_CONSTRAINTS, audio: { ...App.CALL_AUDIO_CONSTRAINTS.audio } };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    return await prep(await navigator.mediaDevices.getUserMedia(constraints));
  } catch (e) {
    if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
      App.showToast({
        title: "Microphone unavailable",
        body: "You can still join listen-only, then enable your microphone from the call controls.",
        duration: 5000
      });
      return null;
    }
  }
  try {
    return await prep(await navigator.mediaDevices.getUserMedia({
      // Preserve the chosen microphone even when optional processing constraints fail.
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    }));
  } catch {
    App.showToast({
      title: "Microphone unavailable",
      body: "You can still join listen-only, then enable your microphone from the call controls.",
      duration: 5000
    });
    return null;
  }
};
App.callGetLiveAudioTrack = function (stream = App.callLocalStream) {
  const track = stream?.getAudioTracks?.()[0] || null;
  return track && track.readyState === "live" ? track : null;
};
App.callClearMicRecoveryTimer = function () {
  if (App.callMicRecoveryTimer) {
    try {
      clearTimeout(App.callMicRecoveryTimer);
    } catch {}
  }
  App.callMicRecoveryTimer = null;
};
App.callScheduleMicRecovery = function (reason = "microphone-health", delayMs = App.CALL_MIC_MUTE_RECOVERY_MS) {
  if (!App.currentCallRoomId || !App.callSessionId || !App.currentUser || App.callLeavePending) return;
  const roomId = App.currentCallRoomId;
  const sessionId = App.callSessionId;
  App.callClearMicRecoveryTimer();
  App.callMicRecoveryTimer = setTimeout(() => {
    App.callMicRecoveryTimer = null;
    if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId || App.callLeavePending) return;
    const track = App.callGetLiveAudioTrack(App.callRawMicrophoneStream);
    if (reason === "track-muted" && track && !track.muted) return;
    void App.callRefreshMic({
      quiet: true,
      reason
    });
  }, Math.max(120, Number(delayMs) || App.CALL_MIC_MUTE_RECOVERY_MS));
};
App.callBindLocalMicrophoneHealth = function (track, roomId = App.currentCallRoomId, sessionId = App.callSessionId) {
  if (!track) return;
  try {
    track.onended = () => {
      if (App.callRawMicrophoneStream?.getAudioTracks?.()[0] !== track) return;
      if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId) return;
      App.callScheduleMicRecovery("track-ended", 180);
    };
    track.onmute = () => {
      if (App.callRawMicrophoneStream?.getAudioTracks?.()[0] !== track) return;
      if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId) return;
      App.callScheduleMicRecovery("track-muted", App.CALL_MIC_MUTE_RECOVERY_MS);
    };
    track.onunmute = () => {
      if (App.callRawMicrophoneStream?.getAudioTracks?.()[0] === track) App.callClearMicRecoveryTimer();
    };
  } catch {}
};
App.callAttachLocalStream = function (stream, {
  resetToggles = true,
  preserveAudioState = null
} = {}) {
  if (preserveAudioState) {
    App.callMuted = preserveAudioState.muted === true || App.callGetInputVolumePercent() === 0;
    App.callDeafened = preserveAudioState.deafened === true;
  } else if (resetToggles) {
    App.callMuted = App.callGetInputVolumePercent() === 0;
    App.callDeafened = false;
  }

  // Stop any existing VAD cleanly (don't spam DB during swap)
  App.callStopSpeakingMonitor({
    clearDb: false
  });

  // Publish the gain-controlled track, retaining the physical track for health,
  // mute and device selection. Never connect the microphone to local speakers.
  App.callDisposeMicrophoneGraph();
  App.callRawMicrophoneStream = stream;
  App.callLocalStream = stream;
  if (App.callGetLiveAudioTrack(stream)) {
    try {
      const ctx = App.callPrimeMicrophoneContext();
      if (!ctx) throw new Error("Web Audio is unavailable");
      App.callMicSource = ctx.createMediaStreamSource(stream);
      App.callMicGain = ctx.createGain();
      App.callMicGain.gain.value = App.callGetInputVolumePercent() / 100;
      App.callMicDestination = ctx.createMediaStreamDestination();
      App.callMicSource.connect(App.callMicGain);
      App.callMicGain.connect(App.callMicDestination);
      App.callLocalStream = App.callMicDestination.stream;
    } catch (error) {
      App.callDisposeMicrophoneGraph();
      App.callLocalStream = new MediaStream();
      App.callListenOnly = true;
      App.callMuted = true;
      App.showToast({ title: "Microphone unavailable", body: "Microphone volume processing could not start. Refresh your microphone to retry.", duration: 4500 });
      console.warn("Microphone gain setup failed:", error);
    }
  }
  try {
    for (const t of App.callLocalStream.getAudioTracks()) {
      try {
        t.contentHint = "speech";
      } catch {}
      try {
        t.enabled = !(App.callMuted || App.callDeafened);
      } catch {}
    }
  } catch {}
  App.syncCallControlsUI();
  App.callApplyLocalMuteState();

  // Start local voice activity detection -> drives Firebase `speaking` + green aura
  App.callStartSpeakingMonitor();
};
App.callApplyLocalMuteState = function () {
  const shouldSend = !(App.callMuted || App.callDeafened) && App.callGetInputVolumePercent() > 0;
  if (App.callLocalStream) {
    for (const t of App.callLocalStream.getAudioTracks()) {
      try {
        t.enabled = shouldSend;
      } catch {}
    }
  }
  for (const t of App.callRawMicrophoneStream?.getAudioTracks?.() || []) t.enabled = shouldSend;
  for (const a of App.callRemoteAudioEls.values()) {
    const peer = String(a.dataset.peerCode || "");
    try {
      a.muted = !!App.callDeafened || a.dataset.webAudioFallback === "1";
    } catch {}
    if (peer && a.dataset.webAudioFallback !== "1") {
      App.callFadeNativeAudioVolume(peer, a, Math.min(1, App.callGetPlaybackGain(peer)), true);
    }
  }
  for (const [peer, entry] of App.callRemoteWebAudioSources.entries()) {
    App.callFadeWebAudioGain(peer, entry.gain, !App.callDeafened);
  }
  App.callSyncScreenAudioPlayback();
  App.syncCallScreenContextMenu?.();
  if (!App.callDeafened) void App.callResumeRemoteAudio({
    fromGesture: false
  });else {
    App.callAudioUnlockRequired = false;
    App.callSyncAudioPlaybackControls();
  }
};
App.callSetLocalSpeaking = function (isSpeaking, {
  force = false
} = {}) {
  const value = !!isSpeaking;
  if (!force && value === App.callVadSpeaking && !App.callVadPublishTimer) return;
  App.callVadSpeaking = value;
  const code = String(App.currentUser?.code || '');
  const member = App.callMembersCache.find(m => String(m.code || '') === code);
  if (member) member.speaking = value;
  App.callPatchSpeakingIndicators();
  if (!App.currentCallRoomId || !App.currentUser || !App.callSessionId) return;
  if (App.callVadPublishTimer) clearTimeout(App.callVadPublishTimer);
  App.callVadPublishTimer = null;
  const room = App.currentCallRoomId,
    session = App.callSessionId;
  const publish = () => {
    App.callVadPublishTimer = null;
    if (App.currentCallRoomId !== room || App.callSessionId !== session || !App.myCallMemberRef) return;
    App.callVadLastDbMs = Date.now();
    // Trailing write is essential: the old throttle could permanently omit
    // the final speaking:false transition and leave a green ring stuck on.
    void App.myCallMemberRef.update({
      speaking: App.callVadSpeaking
    }).catch(() => {});
  };
  const delay = force ? 0 : Math.max(0, App.CALL_VAD.DB_MIN_MS - (Date.now() - App.callVadLastDbMs));
  if (delay) App.callVadPublishTimer = setTimeout(publish, delay);else publish();
};
App.callStopSpeakingMonitor = function ({
  clearDb = true
} = {}) {
  if (App.callVadPublishTimer) clearTimeout(App.callVadPublishTimer);
  App.callVadPublishTimer = null;
  if (App.callVadTimer) {
    try {
      clearInterval(App.callVadTimer);
    } catch {}
    App.callVadTimer = null;
  }
  if (App.callVadSource) {
    try {
      App.callVadSource.disconnect();
    } catch {}
    App.callVadSource = null;
  }
  if (App.callVadAnalyser) {
    try {
      App.callVadAnalyser.disconnect();
    } catch {}
    App.callVadAnalyser = null;
  }
  if (App.callVadCtx) {
    try {
      App.callVadCtx.close();
    } catch {}
    App.callVadCtx = null;
  }
  App.callVadFloat = null;
  App.callVadByte = null;
  App.callVadLastVoiceMs = 0;
  if (clearDb) {
    App.callSetLocalSpeaking(false, {
      force: true
    });
  } else {
    App.callVadSpeaking = false;
  }
};
App.callStartSpeakingMonitor = function () {
  // Restart cleanly
  App.callStopSpeakingMonitor({
    clearDb: false
  });
  if (!App.callLocalStream || !App.currentUser) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    App.callVadCtx = new AC();
    App.callVadAnalyser = App.callVadCtx.createAnalyser();
    App.callVadAnalyser.fftSize = 512;
    App.callVadAnalyser.smoothingTimeConstant = 0.85;
    App.callVadSource = App.callVadCtx.createMediaStreamSource(App.callRawMicrophoneStream || App.callLocalStream);
    App.callVadSource.connect(App.callVadAnalyser);
    if (typeof App.callVadAnalyser.getFloatTimeDomainData === "function") {
      App.callVadFloat = new Float32Array(App.callVadAnalyser.fftSize);
      App.callVadByte = null;
    } else {
      App.callVadByte = new Uint8Array(App.callVadAnalyser.fftSize);
      App.callVadFloat = null;
    }

    // Join is a user gesture, but resume anyway for browsers that start suspended
    try {
      if (App.callVadCtx.state === "suspended") App.callVadCtx.resume();
    } catch {}
    App.callVadLastVoiceMs = 0;
    App.callVadLastDbMs = 0;
    let noiseFloor = 0.0015;
    let lastResumeAt = 0;
    App.callVadTimer = setInterval(() => {
      // Not in a call anymore => force off
      if (!App.callLocalStream || !App.currentUser || !App.currentCallRoomId) {
        App.callSetLocalSpeaking(false);
        return;
      }

      // Muted/deafened => never speaking
      if (App.callMuted || App.callDeafened || App.callGetInputVolumePercent() === 0) {
        App.callSetLocalSpeaking(false);
        return;
      }
      if (!App.callVadAnalyser) return;
      if (App.callVadCtx?.state === 'suspended' && Date.now() - lastResumeAt > 2000) {
        lastResumeAt = Date.now();
        void App.callVadCtx.resume().catch(() => {});
      }
      let rms = 0;
      if (App.callVadFloat) {
        App.callVadAnalyser.getFloatTimeDomainData(App.callVadFloat);
        let sum = 0;
        for (let i = 0; i < App.callVadFloat.length; i++) {
          const v = App.callVadFloat[i];
          sum += v * v;
        }
        rms = Math.sqrt(sum / App.callVadFloat.length);
      } else if (App.callVadByte) {
        App.callVadAnalyser.getByteTimeDomainData(App.callVadByte);
        let sum = 0;
        for (let i = 0; i < App.callVadByte.length; i++) {
          const v = (App.callVadByte[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / App.callVadByte.length);
      }
      const now = Date.now();

      // Follow quiet background noise without learning an ongoing voice as
      // silence. Lower thresholds detect quiet microphones and short syllables.
      if (!App.callVadSpeaking && rms < App.CALL_VAD.START_RMS) noiseFloor = noiseFloor * 0.96 + rms * 0.04;
      const startThreshold = Math.max(App.CALL_VAD.START_RMS, Math.min(0.018, noiseFloor * 2.8));
      const stopThreshold = Math.max(App.CALL_VAD.STOP_RMS, startThreshold * 0.55);
      if (rms >= startThreshold) {
        App.callVadLastVoiceMs = now;
        App.callSetLocalSpeaking(true);
        return;
      }

      // While speaking: use stop threshold + hold time to avoid flicker
      if (App.callVadSpeaking) {
        if (rms >= stopThreshold) App.callVadLastVoiceMs = now;
        if (App.callVadLastVoiceMs && now - App.callVadLastVoiceMs > App.CALL_VAD.HOLD_MS) {
          App.callSetLocalSpeaking(false);
        }
      } else {
        // Ensure false (no-op if already false)
        App.callSetLocalSpeaking(false);
      }
    }, App.CALL_VAD.SAMPLE_MS);
  } catch (e) {
    console.warn("VAD init failed:", e);
    App.callStopSpeakingMonitor({
      clearDb: false
    });
  }
};
App.callToggleMute = function () {
  if (!App.currentCallRoomId || !App.currentUser) return;
  if (App.callListenOnly) {
    App.showToast({
      title: "Microphone unavailable",
      body: "Use Enable Microphone to start sending audio.",
      duration: 2200
    });
    return;
  }

  // Can't be both: muting clears deafen
  if (App.callDeafened) App.callDeafened = false;
  const muted = !App.callMuted;
  if (!muted && App.callGetInputVolumePercent() === 0) App.callSetInputVolumePercent(100);
  App.callMuted = muted;
  App.callApplyLocalMuteState();
  App.syncCallControlsUI();
  try {
    App.db.ref(`calls/${App.currentCallRoomId}/members/${App.currentUser.code}`).update({
      muted: !!App.callMuted,
      deafened: false,
      speaking: false,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    });
  } catch {}
};
App.callToggleDeafen = function () {
  if (!App.currentCallRoomId || !App.currentUser) return;

  // An input at zero stays marked muted when changing speaker playback.
  if (App.callMuted && !App.callListenOnly && App.callGetInputVolumePercent() > 0) App.callMuted = false;
  App.callDeafened = !App.callDeafened;
  App.callApplyLocalMuteState();
  if (!App.callDeafened) void App.callResumeRemoteAudio({
    fromGesture: true
  });
  App.syncCallControlsUI();
  try {
    App.db.ref(`calls/${App.currentCallRoomId}/members/${App.currentUser.code}`).update({
      muted: !!App.callMuted,
      deafened: !!App.callDeafened,
      speaking: false,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    });
  } catch {}
};
App.callSyncControlSlash = function (button, crossedOut) {
  const icon = button?.querySelector?.("svg");
  if (!icon) return;
  let slash = icon.querySelector(".call-control-slash");
  if (crossedOut && !slash) {
    slash = document.createElementNS("http://www.w3.org/2000/svg", "path");
    slash.setAttribute("class", "call-control-slash");
    slash.setAttribute("d", "M4 4 20 20");
    slash.setAttribute("stroke", "currentColor");
    slash.setAttribute("stroke-width", "2.4");
    slash.setAttribute("stroke-linecap", "round");
    icon.appendChild(slash);
  } else if (!crossedOut) slash?.remove();
};
App.syncCallControlsUI = function () {
  App.callSyncJoinControl?.();
  const bLeave = App.$("btn-call-leave");
  const bMute = App.$("btn-call-mute");
  const bDeafen = App.$("btn-call-deafen");
  const bShare = App.$("btn-call-share");
  const bRefreshMic = App.$("btn-call-refreshmic");
  const inCall = !!App.currentCallRoomId;
  const operationPending = App.callJoinPending || App.callLeavePending;
  if (bLeave) {
    bLeave.hidden = false;
    bLeave.disabled = operationPending;
  }
  if (bMute) {
    const label = App.callListenOnly ? "Microphone unavailable" : App.callMuted ? "Unmute" : "Mute";
    bMute.setAttribute("aria-label", label);
    bMute.dataset.tooltip = label;
    bMute.classList.toggle("is-active", App.callMuted);
    bMute.setAttribute("aria-pressed", String(!!App.callMuted));
    App.callSyncControlSlash(bMute, App.callMuted);
    App.callSyncControlSlash(App.$("btn-sidebar-call-mute"), App.callMuted);
    bMute.disabled = !inCall || operationPending || App.callListenOnly;
  }
  if (bDeafen) {
    const label = App.callDeafened ? "Undeafen" : "Deafen";
    bDeafen.setAttribute("aria-label", label);
    bDeafen.dataset.tooltip = label;
    bDeafen.classList.toggle("is-active", App.callDeafened);
    bDeafen.setAttribute("aria-pressed", String(!!App.callDeafened));
    App.callSyncControlSlash(bDeafen, App.callDeafened);
    App.callSyncControlSlash(App.$("btn-sidebar-call-deafen"), App.callDeafened);
    bDeafen.disabled = !inCall || operationPending;
  }
  if (bShare) {
    const label = App.callSharing ? "Stop Sharing" : "Share Screen";
    bShare.setAttribute("aria-label", label);
    bShare.dataset.tooltip = label;
    bShare.classList.toggle("is-active", App.callSharing);
    bShare.disabled = !inCall || operationPending;
  }
  const bCamera = App.$("btn-call-camera");
  if (bCamera) {
    const label = App.callCameraSharing ? "Stop Camera" : App.callCameraCapturePending ? "Opening Camera…" : "Share Camera";
    bCamera.setAttribute("aria-label", label);
    bCamera.setAttribute("aria-pressed", String(!!App.callCameraSharing));
    bCamera.dataset.tooltip = label;
    bCamera.classList.toggle("is-active", !!App.callCameraSharing);
    bCamera.disabled = !inCall || operationPending || (App.callCameraCapturePending && !App.callCameraSharing);
  }
  if (bRefreshMic) {
    bRefreshMic.disabled = !inCall || operationPending || App.callMicRefreshPending;
    const label = App.callMicRefreshPending ? "Refreshing Microphone…" : App.callListenOnly ? "Enable Microphone" : "Refresh Microphone";
    bRefreshMic.setAttribute("aria-label", label);
    bRefreshMic.dataset.tooltip = label;
    bRefreshMic.classList.toggle("is-pending", App.callMicRefreshPending);
  }
  App.callSyncAudioPlaybackControls();
  App.callSyncMenuStatusDisplay();
  App.callSyncAudioSettingsUI?.();
  App.callSyncDesktopOverlay?.();
};
App.callSetInputDevice = async function (deviceId) {
  if (!App.currentCallRoomId || App.callMicRefreshPending || App.callLeavePending) return false;
  return await App.callRefreshMic({ deviceId: String(deviceId || ""), quiet: true, reason: "input-device-change" });
};
App.callRefreshMic = async function ({
  quiet = false,
  reason = "manual",
  deviceId = App.callPreferredAudioInputId ?? App.callRawMicrophoneStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId ?? ""
} = {}) {
  if (!App.currentCallRoomId || !App.currentUser || App.callMicRefreshPending || App.callLeavePending) return;
  const roomId = App.currentCallRoomId;
  const sessionId = App.callSessionId;
  const lifecycleToken = App.callLifecycleToken;
  const refreshGeneration = ++App.callMicRefreshGeneration;
  const contextIsCurrent = () => App.currentCallRoomId === roomId && App.callSessionId === sessionId && App.callLifecycleToken === lifecycleToken && !App.callLeavePending;
  App.callMicRefreshPending = true;
  App.syncCallControlsUI();
  try {
    const stream = await App.callRequestMicPermission({ deviceId });
    if (!stream) {
      if (contextIsCurrent() && !App.callGetLiveAudioTrack(App.callRawMicrophoneStream)) {
        App.callListenOnly = true;
        App.callMuted = true;
        for (const [peerCode, pc] of Array.from(App.callPeerMap.entries())) {
          if (!contextIsCurrent()) break;
          if (!App.callPeerIsCurrent(pc, peerCode)) continue;
          try {
            await App.callSetPeerAudioTrack(pc, null);
          } catch {}
        }
        App.callSetMobileAudioSession(true);
        App.callApplyLocalMuteState();
        try {
          await App.myCallMemberRef?.update?.({
            muted: true,
            speaking: false,
            updatedAt: App.firebase.database.ServerValue.TIMESTAMP
          });
        } catch {}
      }
      return false;
    }

    // Permission dialogs can outlive a leave/rejoin. Never attach that stale
    // stream to a newer call session.
    if (!contextIsCurrent()) {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch {}
      return;
    }
    const audioTrack = stream.getAudioTracks?.()[0] || null;
    if (!audioTrack || audioTrack.readyState === "ended") {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch {}
      App.showToast({
        title: "Microphone unavailable",
        body: "No live microphone track was returned.",
        duration: 2600
      });
      return;
    }
    if (App.callListenOnly) {
      App.callListenOnly = false;
      App.callMuted = App.callGetInputVolumePercent() === 0;
    }
    App.callAttachLocalStream(stream, {
      resetToggles: false
    });
    if (App.callListenOnly) return false;
    // An empty selection means the OS default; don't silently pin it to the
    // physical device currently returned by getUserMedia.
    App.callPreferredAudioInputId = String(deviceId || "");
    App.callBindLocalMicrophoneHealth(audioTrack, roomId, sessionId);
    const outgoingTrack = App.callGetLiveAudioTrack();

    // Snapshot this session's peers. Iterating the live Map can otherwise walk
    // into replacement peers created by a rapid leave/rejoin while an awaited
    // replaceTrack is still settling.
    const peerEntries = Array.from(App.callPeerMap.entries());
    for (const [peerCode, pc] of peerEntries) {
      if (!contextIsCurrent()) break;
      if (!App.callPeerIsCurrent(pc, peerCode)) continue;
      try {
        await App.callSetPeerAudioTrack(pc, outgoingTrack);
        if (!contextIsCurrent()) break;
        if (!App.callPeerIsCurrent(pc, peerCode)) continue;
        App.callRequestPeerMediaRefresh(peerCode, reason || "mic-refresh", {
          force: true
        });
      } catch (e) {
        console.warn("microphone publish failed:", e);
      }
    }
    if (!contextIsCurrent()) return;
    App.callApplyLocalMuteState();
    try {
      await App.db.ref(`calls/${roomId}/members/${App.currentUser.code}`).update({
        muted: !!App.callMuted,
        deafened: !!App.callDeafened,
        speaking: false,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP
      });
    } catch {}
    if (!quiet) {
      App.showToast({
        title: "Microphone refreshed",
        body: "Your microphone is live again.",
        duration: 2000
      });
    }
    return true;
  } finally {
    if (App.callMicRefreshGeneration === refreshGeneration) {
      App.callMicRefreshPending = false;
      App.syncCallControlsUI();
    }
  }
};

App.register("calling/microphone", function initializeFeature() {
  App.callInputVolume = 100;
  App.callMicRefreshGeneration = 0;
  App.callPreferredAudioInputId = "";
  App.callRawMicrophoneStream = null;
  App.callMicCtx = null;
  App.callMicSource = App.callMicGain = App.callMicDestination = null;
});
})(globalThis.ChatApp);
