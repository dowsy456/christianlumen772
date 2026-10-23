/* calling/playback: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callGetOutputVolumePercent = function () {
  return Number.isFinite(App.callOutputVolume) ? Math.max(0, Math.min(200, App.callOutputVolume)) : 100;
};
App.callSetOutputVolumePercent = function (raw, options = {}) {
  App.callOutputVolume = Math.round(Math.max(0, Math.min(200, Number(raw) || 0)));
  if (options.fromGesture) App.callPrimePlaybackContextFromGesture();
  for (const peer of App.callRemoteAudioEls.keys()) App.callApplyRemoteUserVolume(peer, options);
  App.callSaveAudioPreferences();
  App.callSyncAudioSettingsUI?.();
  return App.callOutputVolume;
};
App.callGetUserVolumePercent = /* Chat calling: playback. Classic script; see CALLING.md. */function (peerCode) {
  const value = Number(App.callUserVolumes.get(String(peerCode || "")));
  return Number.isFinite(value) ? Math.max(0, Math.min(400, value)) : 100;
};
App.callGetUserVolumeGain = function (peerCode) {
  return App.callIsUserMuted(peerCode) ? 0 : App.callGetUserVolumePercent(peerCode) / 100;
};
App.callIsUserMuted = code => App.callUserMuted.has(String(code || "")) || App.callGetUserVolumePercent(code) === 0;
App.callSetUserMuted = function (code, muted, options = {}) {
  code = String(code || "");
  if (!code) return false;
  if (muted) App.callUserMuted.add(code); else App.callUserMuted.delete(code);
  if (!muted && App.callGetUserVolumePercent(code) === 0) App.callUserVolumes.delete(code);
  App.callSaveAudioPreferences();
  App.callApplyRemoteUserVolume(code, options);
  return App.callIsUserMuted(code);
};
App.callSaveUserVolumes = function () {
  App.callSaveAudioPreferences();
};
App.callHasLiveMembers = function (members) {
  const now = Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
  // Instance retirement is destructive, unlike hiding a disconnected tile.
  // Preserve temporarily disconnected sessions even for observers without a PC.
  return Object.values(members || {}).some(member => member?.sessionId && !globalThis.ChatCallPolicy.shouldCleanupMember(
    member, null, now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS));
};
App.callLoadAudioPreferences = function (roomId, record, { preserveAudioState = null } = {}) {
  const userCode = String(App.currentUser?.code || "");
  const instanceId = String(record?.instanceId || "");
  const key = `${roomId}:${instanceId}:${userCode}`;
  const preferences = App.callAudioPreferenceCache.get(key) || record?.audioPreferences?.[userCode] || {};
  App.callAudioPreferenceScope = instanceId ? { roomId, instanceId, userCode, key } : null;
  App.callUserVolumes.clear();
  App.callUserMuted.clear();
  App.callScreenVolumes.clear();
  App.callScreenMuted.clear();
  const loadPercent = (value, max) => typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(max, value))) : 100;
  const previousInputVolume = App.callGetInputVolumePercent?.() ?? 100;
  App.callInputVolume = loadPercent(preferences.inputVolume, 100);
  App.callOutputVolume = loadPercent(preferences.outputVolume, 200);
  App.callAudioPreferencesReady = true;
  if (preserveAudioState) {
    App.callMuted = preserveAudioState.muted === true || App.callListenOnly || App.callInputVolume === 0;
    App.callDeafened = preserveAudioState.deafened === true;
  } else App.callSyncInputVolumeMute?.(previousInputVolume);
  App.callApplyInputVolume?.({ smooth: false });
  const loadVolumes = (values, target) => {
    for (const [code, raw] of Object.entries(values || {})) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const value = Math.round(Math.max(0, Math.min(400, raw)));
      if (value !== 100) target.set(code, value);
    }
  };
  loadVolumes(preferences.users, App.callUserVolumes);
  for (const [code, muted] of Object.entries(preferences.mutedUsers || {})) {
    if (muted === true) App.callUserMuted.add(code);
  }
  loadVolumes(preferences.screens, App.callScreenVolumes);
  for (const [code, muted] of Object.entries(preferences.mutedScreens || {})) {
    if (muted === true) App.callScreenMuted.add(code);
  }
  // A new call in this room invalidates any pending in-memory copy of its predecessor.
  for (const oldKey of App.callAudioPreferenceCache.keys()) {
    if (oldKey.startsWith(`${roomId}:`) && oldKey !== key) App.callAudioPreferenceCache.delete(oldKey);
  }
  for (const peer of App.callRemoteAudioEls.keys()) App.callApplyRemoteUserVolume(peer, { smooth: false });
  App.callSyncAudioSettingsUI?.();
};
App.callSaveAudioPreferences = function () {
  const scope = App.callAudioPreferenceScope;
  if (!scope || scope.roomId !== App.currentCallRoomId || scope.userCode !== String(App.currentUser?.code || "")) return;
  const preferences = {
    inputVolume: App.callGetInputVolumePercent(),
    outputVolume: App.callGetOutputVolumePercent(),
    users: Object.fromEntries(App.callUserVolumes),
    mutedUsers: Object.fromEntries(Array.from(App.callUserMuted, code => [code, true])),
    screens: Object.fromEntries(App.callScreenVolumes),
    mutedScreens: Object.fromEntries(Array.from(App.callScreenMuted, code => [code, true]))
  };
  App.callAudioPreferenceCache.set(scope.key, preferences);
  App.callAudioPreferencePending = { scope, preferences };
  if (App.callAudioPreferenceTimer) clearTimeout(App.callAudioPreferenceTimer);
  App.callAudioPreferenceTimer = setTimeout(() => void App.callFlushAudioPreferences(), 150);
};
App.callFlushAudioPreferences = function () {
  if (App.callAudioPreferenceTimer) clearTimeout(App.callAudioPreferenceTimer);
  App.callAudioPreferenceTimer = null;
  const pending = App.callAudioPreferencePending;
  App.callAudioPreferencePending = null;
  if (!pending) return App.callAudioPreferenceWrites;
  const { scope, preferences } = pending;
  const write = async () => {
    // Warm the transaction cache: an initial local null must not cancel a
    // valid preference write before Firebase has read the server record.
    await App.db.ref(`calls/${scope.roomId}`).once("value");
    await App.db.ref(`calls/${scope.roomId}`).transaction(record => {
      // A delayed slider write must never resurrect an ended call or leak into a new one.
      if (!record || record.instanceId !== scope.instanceId || !App.callHasLiveMembers(record.members)) return undefined;
      return { ...record, audioPreferences: { ...record.audioPreferences, [scope.userCode]: preferences } };
    }, undefined, false);
  };
  App.callAudioPreferenceWrites = App.callAudioPreferenceWrites.then(write, write).catch(error => {
    console.warn("Call audio preferences could not be saved:", error);
  });
  return App.callAudioPreferenceWrites;
};
App.callClearAudioPreferenceScope = function () {
  void App.callFlushAudioPreferences();
  App.callAudioPreferenceScope = null;
  App.callUserVolumes.clear();
  App.callUserMuted.clear();
  App.callScreenVolumes.clear();
  App.callScreenMuted.clear();
  App.callInputVolume = 100;
  App.callOutputVolume = 100;
};
App.callScreenAudioKey = code => `screen/${String(code || "")}`;
App.callGetScreenVolume = function (code) {
  const value = App.callScreenVolumes.get(String(code || ""));
  return Number.isFinite(value) ? value : 100;
};
App.callIsScreenMuted = code => App.callScreenMuted.has(String(code || "")) || App.callGetScreenVolume(code) === 0;
App.callGetEffectiveScreenVolume = code => App.callDeafened || App.callIsScreenMuted(code) ? 0 : App.callGetScreenVolume(code);
App.callScreenShouldPlay = function (code) {
  return !App.callDeafened && !!App.currentCallRoomId && App.callWatchedShareCodes.has(code) &&
    !!App.callGetMemberByCode(code)?.sharing && !App.callGetScreenPauseState?.(code)?.paused && code !== String(App.currentUser?.code || "") && !App.callIsScreenMuted(code);
};
App.callGetPlaybackGain = function (key) {
  // Apply deafen at the shared gain boundary, including native fallback and
  // newly arriving screen tracks, so no later playback refresh can unmute it.
  if (App.callDeafened) return 0;
  if (String(key).startsWith("screen/")) {
    const code = String(key).slice(7);
    return App.callScreenShouldPlay(code) ? App.callGetScreenVolume(code) / 100 * App.callGetOutputVolumePercent() / 100 : 0;
  }
  return App.callGetUserVolumeGain(key) * App.callGetOutputVolumePercent() / 100;
};
App.callSetScreenVolume = function (code, raw, options = {}) {
  code = String(code || "");
  if (!code) return 100;
  const value = Math.round(Math.max(0, Math.min(400, Number(raw) || 0)));
  if (value === 100) App.callScreenVolumes.delete(code); else App.callScreenVolumes.set(code, value);
  App.callSaveAudioPreferences();
  App.callApplyRemoteUserVolume(App.callScreenAudioKey(code), options);
  return value;
};
App.callSetScreenMuted = function (code, muted, options = {}) {
  code = String(code || "");
  if (!code) return false;
  if (muted) App.callScreenMuted.add(code); else App.callScreenMuted.delete(code);
  // Unmute is an audible action even when the slider was lowered to zero.
  if (!muted && App.callGetScreenVolume(code) === 0) App.callScreenVolumes.delete(code);
  App.callSaveAudioPreferences();
  App.callApplyRemoteUserVolume(App.callScreenAudioKey(code), options);
  return !!muted;
};
App.callSyncScreenAudioPlayback = function () {
  for (const code of App.callRemoteScreenAudioStreams.keys()) {
    App.callApplyRemoteUserVolume(App.callScreenAudioKey(code), { smooth: false });
  }
};
App.callSetRemoteScreenAudio = function (code, stream) {
  code = String(code || "");
  if (!code || code === String(App.currentUser?.code || "")) return;
  const key = App.callScreenAudioKey(code);
  App.callRemoteScreenAudioStreams.set(code, stream);
  let audio = App.callRemoteAudioEls.get(key);
  if (!audio) {
    audio = document.createElement("audio");
    audio.dataset.peerCode = key;
    audio.dataset.screenOwner = code;
    App.callEnsureAudioHost().appendChild(audio);
    App.callRemoteAudioEls.set(key, audio);
  }
  if (audio.srcObject !== stream) {
    App.callDisconnectRemoteWebAudio(key);
    audio.srcObject = stream;
  }
  void App.callPrepareRemoteAudioElement(audio);
  App.callApplyRemoteUserVolume(key, { smooth: false });
  void App.callResumeRemoteAudio({ fromGesture: false });
};
App.callRemoveRemoteScreenAudio = function (code) {
  const key = App.callScreenAudioKey(code);
  App.callDisconnectRemoteWebAudio(key);
  const fade = App.callRemoteNativeVolumeFades.get(key);
  if (fade) cancelAnimationFrame(fade);
  App.callRemoteNativeVolumeFades.delete(key);
  const audio = App.callRemoteAudioEls.get(key);
  if (audio) {
    try { audio.pause(); audio.srcObject = null; audio.remove(); } catch {}
  }
  App.callRemoteAudioEls.delete(key);
  App.callRemoteScreenAudioStreams.delete(String(code || ""));
};
App.callFadeNativeAudioVolume = function (peerCode, audio, target, smooth = true) {
  if (!audio) return;
  const peer = String(peerCode || audio.dataset?.peerCode || "");
  const next = Math.max(0, Math.min(1, Number(target) || 0));
  const prior = App.callRemoteNativeVolumeFades.get(peer);
  if (prior) cancelAnimationFrame(prior);
  if (!smooth) {
    App.callRemoteNativeVolumeFades.delete(peer);
    try {
      audio.volume = next;
    } catch {}
    return;
  }
  const start = Number.isFinite(audio.volume) ? audio.volume : 1;
  const startedAt = performance.now();
  const duration = 90;
  const step = now => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));
    const eased = 1 - Math.pow(1 - progress, 3);
    try {
      audio.volume = start + (next - start) * eased;
    } catch {}
    if (progress < 1) {
      App.callRemoteNativeVolumeFades.set(peer, requestAnimationFrame(step));
    } else {
      App.callRemoteNativeVolumeFades.delete(peer);
    }
  };
  App.callRemoteNativeVolumeFades.set(peer, requestAnimationFrame(step));
};
App.callFadeWebAudioGain = function (peerCode, gainNode, smooth = true) {
  if (!gainNode?.gain) return;
  const target = App.callDeafened ? 0 : App.callGetPlaybackGain(peerCode);
  const param = gainNode.gain;
  try {
    const now = Number(App.callPlaybackCtx?.currentTime || 0);
    param.cancelScheduledValues?.(now);
    if (smooth && typeof param.setTargetAtTime === "function") {
      param.setTargetAtTime(target, now, 0.025);
    } else {
      param.value = target;
    }
  } catch {
    try {
      param.value = target;
    } catch {}
  }
};
App.callApplyRemoteUserVolume = function (peerCode, {
  smooth = true,
  fromGesture = false
} = {}) {
  const peer = String(peerCode || "");
  if (!peer) return;
  const audio = App.callRemoteAudioEls.get(peer) || null;
  const entry = App.callRemoteWebAudioSources.get(peer) || null;
  const desired = App.callGetPlaybackGain(peer);
  if (entry?.gain) {
    if (entry.audio) {
      try {
        entry.audio.muted = true;
      } catch {}
    }
    App.callFadeWebAudioGain(peer, entry.gain, smooth);
    return;
  }
  // Route the whole mix through one limiter, including sources at normal volume.
  if (audio?.srcObject) {
    if (fromGesture) App.callPrimePlaybackContextFromGesture();
    if (App.callPlaybackCtx?.state === "running" && App.callConnectRemoteWebAudio(peer, audio.srcObject, audio)) {
      const connected = App.callRemoteWebAudioSources.get(peer);
      App.callFadeWebAudioGain(peer, connected?.gain, smooth);
      return;
    }
  }
  if (audio) {
    try {
      audio.muted = !!App.callDeafened;
    } catch {}
    App.callFadeNativeAudioVolume(peer, audio, Math.min(1, desired), smooth);
  }
};
App.callSetUserVolumePercent = function (peerCode, rawValue, {
  smooth = true,
  fromGesture = false
} = {}) {
  const peer = String(peerCode || "");
  if (!peer || peer === String(App.currentUser?.code || "")) return 100;
  const value = Math.round(Math.max(0, Math.min(400, Number(rawValue) || 0)));
  if (value === 100) App.callUserVolumes.delete(peer);else App.callUserVolumes.set(peer, value);
  App.callSaveUserVolumes();
  App.callApplyRemoteUserVolume(peer, {
    smooth,
    fromGesture
  });
  return value;
};
App.sanitizeCallRoom = function (raw) {
  return App.sanitizeRoomCode(raw);
};
App.callEnsureAudioHost = function () {
  if (App.callAudioHost) return App.callAudioHost;
  const host = document.createElement("div");
  host.id = "call-audio-host";
  host.style.position = "fixed";
  host.style.left = "-9999px";
  host.style.top = "-9999px";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "hidden";
  document.body.appendChild(host);
  App.callAudioHost = host;
  return host;
};
App.callSetMobileAudioSession = function (active) {
  const session = navigator.audioSession;
  if (!session) return;
  const hasLiveMic = !!App.callGetLiveAudioTrack();
  try {
    session.type = active ? App.callListenOnly && !hasLiveMic ? "playback" : "play-and-record" : "auto";
  } catch {}
};
App.callPrimePlaybackContextFromGesture = function () {
  App.callSetMobileAudioSession(true);
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    if (!App.callPlaybackCtx || App.callPlaybackCtx.state === "closed") {
      try {
        App.callPlaybackCtx = new AC({
          latencyHint: "interactive",
          sinkId: App.callPreferredAudioOutputId || ""
        });
      } catch {
        App.callPlaybackCtx = new AC();
      }
      const source = App.callPlaybackCtx.createOscillator();
      const gain = App.callPlaybackCtx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(App.callPlaybackCtx.destination);
      source.start();
      App.callPlaybackPrimerSource = source;
      App.callPlaybackPrimerGain = gain;
      App.callEnsurePlaybackMix();
      if (App.callPreferredAudioOutputId) {
        const ctx = App.callPlaybackCtx;
        const outputId = App.callPreferredAudioOutputId;
        App.callOutputDeviceWrites = App.callOutputDeviceWrites.then(async () => {
          if (App.callPlaybackCtx === ctx) await App.callApplyOutputRoute(outputId);
        }).catch(error => console.warn("Audio output restore failed:", error));
      }
    }
    if (["suspended", "interrupted"].includes(App.callPlaybackCtx.state)) {
      const resume = App.callPlaybackCtx.resume();
      resume?.catch?.(e => console.warn("call playback context prime failed:", e));
    }
  } catch (e) {
    console.warn("call playback context unavailable:", e);
  }
  return App.callPlaybackCtx;
};
App.callEnsurePlaybackMix = function () {
  const ctx = App.callPlaybackCtx;
  if (!ctx) return null;
  if (App.callPlaybackMix?.context === ctx) return App.callPlaybackMix;
  const input = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  const ceiling = ctx.createWaveShaper();
  const curve = new Float32Array(4097);
  for (let i = 0; i < curve.length; i++) {
    const x = i * 2 / (curve.length - 1) - 1;
    const a = Math.abs(x);
    // A final bounded soft knee catches transients before the compressor reacts.
    curve[i] = Math.sign(x) * (a <= 0.8 ? a : 0.8 + 0.15 * (1 - Math.exp(-(a - 0.8) / 0.15)));
  }
  ceiling.curve = curve;
  ceiling.oversample = "none";
  input.connect(limiter);
  limiter.connect(ceiling);
  ceiling.connect(ctx.destination);
  App.callPlaybackMix = { context: ctx, input, limiter, ceiling, destination: null, audio: null };
  return App.callPlaybackMix;
};
App.callApplyOutputRoute = async function (deviceId) {
  const ctx = App.callPlaybackCtx;
  if (!ctx || ctx.state === "closed") return;
  const mix = App.callEnsurePlaybackMix();
  if (typeof ctx.setSinkId === "function") {
    await ctx.setSinkId(deviceId || "");
    return;
  }
  if (!deviceId || deviceId === "default") {
    if (mix.audio) {
      mix.ceiling.disconnect();
      mix.ceiling.connect(ctx.destination);
      mix.audio.pause();
      mix.audio.srcObject = null;
      mix.audio.remove();
      mix.audio = null;
      mix.destination = null;
    }
    return;
  }
  // Some browsers offer setSinkId on media elements but not AudioContext.
  // Send the single protected mix through one sink element in that case.
  if (mix.audio) {
    await mix.audio.setSinkId(deviceId);
    await mix.audio.play();
    return;
  }
  const destination = ctx.createMediaStreamDestination();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.srcObject = destination.stream;
  audio.volume = 1;
  audio.setAttribute("playsinline", "");
  App.callEnsureAudioHost().appendChild(audio);
  try {
    if (typeof audio.setSinkId !== "function") throw new Error("Output selection is unavailable in this browser");
    await audio.setSinkId(deviceId);
    await audio.play();
    if (App.callPlaybackCtx !== ctx || ctx.state === "closed") throw new Error("Call output closed during selection");
    mix.ceiling.disconnect();
    mix.ceiling.connect(destination);
    mix.destination = destination;
    mix.audio = audio;
  } catch (error) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    destination.disconnect();
    throw error;
  }
};
App.callSetOutputDevice = async function (deviceId) {
  const next = String(deviceId || "");
  const token = App.callAudioPlaybackToken;
  App.callPrimePlaybackContextFromGesture();
  const apply = async () => {
    if (token !== App.callAudioPlaybackToken) return false;
    const previous = App.callPreferredAudioOutputId;
    const audioElements = Array.from(App.callRemoteAudioEls.values());
    try {
      await App.callApplyOutputRoute(next);
      if (token !== App.callAudioPlaybackToken) return false;
      for (const audio of audioElements) {
        if (typeof audio.setSinkId === "function") await audio.setSinkId(next);
        if (token !== App.callAudioPlaybackToken) return false;
      }
      if (token !== App.callAudioPlaybackToken) return false;
      App.callPreferredAudioOutputId = next;
      App.callSyncAudioSettingsUI?.();
      await App.callResumeRemoteAudio({ fromGesture: true });
      return true;
    } catch (error) {
      if (token !== App.callAudioPlaybackToken) return false;
      try { await App.callApplyOutputRoute(previous); } catch {}
      if (token !== App.callAudioPlaybackToken) return false;
      await Promise.allSettled(audioElements.map(audio => audio.setSinkId?.(previous)));
      if (token !== App.callAudioPlaybackToken) return false;
      App.showToast({ title: "Output device unavailable", body: "Your previous output device is still selected.", duration: 3500 });
      console.warn("Audio output selection failed:", error);
      App.callSyncAudioSettingsUI?.();
      return false;
    }
  };
  App.callOutputDeviceWrites = App.callOutputDeviceWrites.then(apply, apply);
  return App.callOutputDeviceWrites;
};
App.callDisconnectRemoteWebAudio = function (peerCode) {
  const peer = String(peerCode || "");
  const entry = App.callRemoteWebAudioSources.get(peer);
  if (!entry) return;
  try {
    entry.source?.disconnect?.();
  } catch {}
  try {
    entry.gain?.disconnect?.();
  } catch {}
  App.callRemoteWebAudioSources.delete(peer);
  if (entry.audio) {
    try {
      delete entry.audio.dataset.webAudioFallback;
    } catch {}
    try {
      entry.audio.muted = !!App.callDeafened;
    } catch {}
    App.callFadeNativeAudioVolume(peer, entry.audio, Math.min(1, App.callGetPlaybackGain(peer)), false);
  }
};
App.callClosePlaybackContext = function () {
  for (const peer of Array.from(App.callRemoteWebAudioSources.keys())) App.callDisconnectRemoteWebAudio(peer);
  try {
    const mix = App.callPlaybackMix;
    if (mix?.audio) {
      mix.audio.pause();
      mix.audio.srcObject = null;
      mix.audio.remove();
    }
    for (const node of [mix?.input, mix?.limiter, mix?.ceiling, mix?.destination]) node?.disconnect();
  } catch {}
  App.callPlaybackMix = null;
  try {
    App.callPlaybackPrimerSource?.stop?.();
  } catch {}
  try {
    App.callPlaybackPrimerSource?.disconnect?.();
  } catch {}
  try {
    App.callPlaybackPrimerGain?.disconnect?.();
  } catch {}
  try {
    const closeAttempt = App.callPlaybackCtx?.close?.();
    closeAttempt?.catch?.(() => {});
  } catch {}
  App.callPlaybackPrimerSource = null;
  App.callPlaybackPrimerGain = null;
  App.callPlaybackCtx = null;
};
App.callConnectRemoteWebAudio = function (peerCode, stream, audio) {
  const peer = String(peerCode || "");
  if (!peer || !stream || !App.callPlaybackCtx || App.callPlaybackCtx.state !== "running") return false;
  try {
    App.callDisconnectRemoteWebAudio(peer);
    const source = App.callPlaybackCtx.createMediaStreamSource(stream);
    const gain = App.callPlaybackCtx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(App.callEnsurePlaybackMix().input);
    if (audio) {
      audio.dataset.webAudioFallback = "1";
      audio.muted = true;
    }
    App.callRemoteWebAudioSources.set(peer, {
      source,
      gain,
      audio,
      stream
    });
    App.callFadeWebAudioGain(peer, gain, true);
    return true;
  } catch (e) {
    console.warn("remote Web Audio fallback failed:", e);
    return false;
  }
};
App.callCanChooseAudioOutput = function () {
  const AC = window.AudioContext || window.webkitAudioContext;
  return !!(typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype?.setSinkId === "function" || typeof AC?.prototype?.setSinkId === "function");
};
App.callSyncAudioPlaybackControls = function () {
  const resume = App.$("btn-call-audio-resume");
  const output = App.$("btn-call-audio-output");
  if (resume) resume.hidden = !(App.currentCallRoomId && App.callAudioUnlockRequired && !App.callDeafened);
  // Device selection now lives in the deafen dropdown in both call locations.
  if (output) output.hidden = true;
};
App.callPrepareRemoteAudioElement = async function (audio) {
  if (!audio) return;
  const peer = String(audio.dataset.peerCode || "");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.preload = "auto";
  audio.volume = Math.min(1, App.callGetPlaybackGain(peer));
  audio.muted = !!App.callDeafened || audio.dataset.webAudioFallback === "1";
  audio.setAttribute("autoplay", "");
  audio.setAttribute("playsinline", "");
  audio.setAttribute("webkit-playsinline", "");
  if (App.callPreferredAudioOutputId && typeof audio.setSinkId === "function") {
    try {
      await audio.setSinkId(App.callPreferredAudioOutputId);
    } catch {}
  }
};
App.callAwaitPlaybackOperation = async function (operation) {
  // On iOS a suspended context/play promise may wait indefinitely for a new
  // gesture. One such promise must not block every other participant's audio.
  let timer;
  try {
    return await Promise.race([Promise.resolve(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Audio playback needs another attempt"), { name: "TimeoutError" })), 1500);
    })]);
  } finally { clearTimeout(timer); }
};
App.callResumeRemoteAudio = function ({
  fromGesture = false
} = {}) {
  App.callSetMobileAudioSession(!!App.currentCallRoomId || App.callJoinPending);
  const fallbackEntriesToReconnect = [];
  if (fromGesture && (!App.callPlaybackCtx || App.callPlaybackCtx.state === "closed")) {
    for (const [peer, entry] of App.callRemoteWebAudioSources.entries()) {
      fallbackEntriesToReconnect.push({
        peer,
        stream: entry?.stream,
        audio: entry?.audio
      });
    }
    for (const entry of fallbackEntriesToReconnect) App.callDisconnectRemoteWebAudio(entry.peer);
    App.callPrimePlaybackContextFromGesture();
  }
  if (App.callAudioResumePromise && !fromGesture) {
    App.callAudioResumeQueued = true;
    return App.callAudioResumePromise;
  }
  if (App.callAudioResumePromise) App.callAudioResumeQueued = true;
  const playbackToken = App.callAudioPlaybackToken;
  const resumeGeneration = ++App.callAudioResumeGeneration;
  const earlyPlayAttempts = new Map();
  let contextResumeAttempt = null;

  // Invoke play() synchronously in the trusted click/touch/key gesture. Do not
  // put an awaited sink/context operation in front of it or iOS may consume the
  // transient activation before the media element starts.
  if (fromGesture) {
    if (["suspended", "interrupted"].includes(App.callMicCtx?.state)) {
      try { App.callMicCtx.resume()?.catch?.(() => {}); } catch {}
    }
    if (App.callPlaybackMix?.audio) {
      try { App.callPlaybackMix.audio.play()?.catch?.(() => {}); } catch {}
    }
    if (["suspended", "interrupted"].includes(App.callVadCtx?.state)) {
      try {
        contextResumeAttempt = App.callVadCtx.resume();
      } catch {}
    }
    if (["suspended", "interrupted"].includes(App.callPlaybackCtx?.state)) {
      try {
        App.callPlaybackCtx.resume()?.catch?.(() => {});
      } catch {}
    }
    if (!App.callDeafened) {
      for (const audio of App.callRemoteAudioEls.values()) {
        void App.callPrepareRemoteAudioElement(audio);
        if (!audio.srcObject) continue;
        try {
          const playAttempt = Promise.resolve(audio.play()).then(() => null, error => ({
            __callPlayError: error
          }));
          earlyPlayAttempts.set(audio, playAttempt);
        } catch (e) {
          earlyPlayAttempts.set(audio, {
            __callPlayError: e
          });
        }
      }
    }
  }
  const run = (async () => {
    let blocked = false;

    // The capture graph can be interrupted by the permission dialog or audio
    // route change even though its MediaStreamTrack remains "live". Repair it
    // on join/foreground/health checks as well as on clicks; otherwise peers
    // receive valid packets containing silence until the page is refreshed.
    if (["suspended", "interrupted"].includes(App.callMicCtx?.state)) {
      try { await App.callAwaitPlaybackOperation(App.callMicCtx.resume()); } catch {}
    }
    if (!App.callListenOnly && !App.callMuted && !App.callDeafened && App.callMicCtx && App.callMicCtx.state !== "running") blocked = true;

    // Resume the app's existing VAD context during a user gesture. The remote
    // tracks themselves stay on durable <audio> elements, which is the most
    // reliable path across iOS and Android browsers.
    if (contextResumeAttempt || ["suspended", "interrupted"].includes(App.callVadCtx?.state)) {
      try {
        await App.callAwaitPlaybackOperation(contextResumeAttempt || App.callVadCtx.resume());
      } catch (e) {
        if (fromGesture) console.warn("call audio context resume failed:", e);
      }
    }
    if (["suspended", "interrupted"].includes(App.callPlaybackCtx?.state)) {
      try {
        await App.callAwaitPlaybackOperation(App.callPlaybackCtx.resume());
      } catch (e) {
        if (fromGesture) console.warn("call playback context resume failed:", e);
      }
    }
    if (playbackToken !== App.callAudioPlaybackToken || resumeGeneration !== App.callAudioResumeGeneration) return false;
    if (App.callPlaybackCtx?.state === "running") {
      for (const entry of fallbackEntriesToReconnect) {
        if (entry.stream && entry.audio?.srcObject === entry.stream) {
          App.callConnectRemoteWebAudio(entry.peer, entry.stream, entry.audio);
        }
      }
    }
    if (App.callPlaybackMix?.audio && !App.callDeafened) {
      try { await App.callAwaitPlaybackOperation(App.callPlaybackMix.audio.play()); } catch { blocked = true; }
    }
    await Promise.allSettled(Array.from(App.callRemoteAudioEls.entries(), async ([key, audio]) => {
      try { await App.callAwaitPlaybackOperation(App.callPrepareRemoteAudioElement(audio)); } catch {}
      if (playbackToken !== App.callAudioPlaybackToken || App.callRemoteAudioEls.get(key) !== audio || App.callDeafened || !audio.srcObject) return;
      try {
        const earlyAttempt = earlyPlayAttempts.get(audio);
        if (earlyAttempt?.__callPlayError) throw earlyAttempt.__callPlayError;
        const earlyResult = await App.callAwaitPlaybackOperation(earlyAttempt || audio.play());
        if (earlyResult?.__callPlayError) throw earlyResult.__callPlayError;
      } catch (e) {
        if (e?.name === "NotAllowedError" || e?.name === "SecurityError" || e?.name === "TimeoutError") {
          const peer = String(audio.dataset.peerCode || "");
          if (!App.callConnectRemoteWebAudio(peer, audio.srcObject, audio)) blocked = true;
        } else { blocked = true; console.warn("remote call audio playback failed:", e); }
      }
      const peer = String(audio.dataset.peerCode || "");
      if (peer) App.callApplyRemoteUserVolume(peer, {
        smooth: false,
        fromGesture
      });
    }));

    // A muted HTMLMediaElement can report successful playback while its Web
    // Audio fallback graph is suspended. Keep the recovery button visible in
    // that state so an iOS/Android foreground transition cannot cause silent
    // audio with no user-visible way to unlock it.
    if (!App.callDeafened && App.callRemoteWebAudioSources.size && App.callPlaybackCtx?.state !== "running") {
      blocked = true;
    }
    if (playbackToken === App.callAudioPlaybackToken && resumeGeneration === App.callAudioResumeGeneration) {
      App.callAudioUnlockRequired = blocked;
      App.callSyncAudioPlaybackControls();
      App.callSyncMenuStatusDisplay?.();
    }
    return !blocked;
  })();
  App.callAudioResumePromise = run;
  const finish = () => {
    const wasCurrent = App.callAudioResumePromise === run;
    if (wasCurrent) App.callAudioResumePromise = null;
    if (wasCurrent && App.callAudioResumeQueued) {
      App.callAudioResumeQueued = false;
      void App.callResumeRemoteAudio({
        fromGesture: false
      });
    }
  };
  void run.then(finish, finish);
  return run;
};
App.callChooseAudioOutput = async function () {
  if (!App.callCanChooseAudioOutput() || typeof navigator.mediaDevices?.selectAudioOutput !== "function") return;
  try {
    const device = await navigator.mediaDevices.selectAudioOutput();
    return await App.callSetOutputDevice(device?.deviceId || "");
  } catch (e) {
    if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") {
      console.warn("audio output selection failed:", e);
    }
  }
};
App.callTuneAudioSender = async function (sender) {
  await App.callApplySenderBudget(sender, 'audio');
};
App.callTuneScreenSender = async function (sender) {
  await App.callApplySenderBudget(sender, 'video');
};
App.callTuneCameraSender = async function (sender) {
  await App.callApplySenderBudget(sender, 'camera-video');
};

App.register("calling/playback", function initializeFeature() {
App.callOutputVolume = 100;
App.callAudioPreferencesReady = true;
App.callPlaybackMix = null;
App.callOutputDeviceWrites = Promise.resolve();
App.callViewerPresenceSyncToken = 0;
App.callViewerPresenceSyncPromise = null;
App.callViewerPresenceSyncQueued = false;
App.callViewerPresenceForceQueued = false;
App.callPublishedViewingSharesSignature = null;
App.callViewersTooltipSeq = 0;
App.callScreenViewersFloating = null;
App.callScreenViewersFloatingAnchor = null;
App.callScreenViewersFloatingOwner = "";
App.callScreenViewersFloatingTrigger = "";
App.callScreenViewersFloatingFocusKey = "";
App.callScreenViewersFloatingHideTimer = null;
App.callScreenViewersDescriptionTarget = null;
App.callScreenViewersPreviousDescription = null;
App.CALL_VIEWERS_TOOLTIP_TRANSITION_MS = 130;
App.CALL_VAD = {
  START_RMS: 0.008,
  STOP_RMS: 0.004,
  HOLD_MS: 320,
  SAMPLE_MS: 50,
  DB_MIN_MS: 160
};
App.callVadCtx = null;
App.callVadSource = null;
App.callVadAnalyser = null;
App.callVadTimer = null;
App.callVadPublishTimer = null;
App.callVadFloat = null;
App.callVadByte = null;
App.callVadSpeaking = false;
App.callVadLastVoiceMs = 0;
App.callVadLastDbMs = 0;
});
})(globalThis.ChatApp);
