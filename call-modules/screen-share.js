/* calling/screen-share: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.CALL_PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';
App.CALL_RESUME_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 5 11 7-11 7V5Z" fill="currentColor"/></svg>';
App.callGetScreenPauseState = function (key) {
  if (App.callShareIsCamera(key)) return { paused: false };
  const code = String(key || "");
  if (code === String(App.currentUser?.code || "")) return {
    paused: !!App.callScreenPaused, frame: App.callScreenPauseFrame, version: App.callScreenPauseVersion, shareId: App.callScreenShareId
  };
  const member = App.callGetMemberByCode(code);
  const direct = App.callRemotePauseStates.get(code);
  if (direct && direct.shareId === member?.shareId && direct.version > Number(member?.sharePauseVersion || 0)) return direct;
  return { paused: !!member?.sharing && !!member?.sharePaused, frame: member?.sharePauseFrame || null,
    version: Number(member?.sharePauseVersion || 0), shareId: member?.shareId };
};
App.callSyncScreenPauseTile = function (tile, code) {
  const state = App.callGetScreenPauseState(code);
  tile.classList.toggle("is-screen-paused", state.paused);
  let overlay = tile.querySelector(".call-screen-paused");
  if (!state.paused) { overlay?.remove(); return; }
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "call-screen-paused";
    overlay.setAttribute("role", "status");
    overlay.innerHTML = '<img class="call-screen-paused-frame" alt=""><div class="call-screen-paused-label">' + App.CALL_PAUSE_SVG + '<span>Screen Paused</span></div>';
    (tile.querySelector(".call-view-body") || tile.querySelector(".call-share-open") || tile).appendChild(overlay);
  }
  const frame = state.frame || App.callGetSharePreview(code);
  const image = overlay.querySelector("img");
  image.style.transform = tile.querySelector(".call-view-video")?.style.transform || "";
  if (typeof frame === "string" && frame.length <= 96000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame)) {
    if (image.getAttribute("src") !== frame) image.src = frame;
    image.hidden = false;
  } else image.hidden = true;
};
App.callRefreshScreenPauseDisplays = function () {
  document.querySelectorAll(".call-screen-tile[data-share-code]").forEach(tile => App.callSyncScreenPauseTile(tile, tile.dataset.shareCode));
  App.callSyncScreenAudioPlayback();
  App.syncCallScreenContextMenu?.();
};
App.callGetSendingScreenTrack = () => App.callSharing ? (App.callScreenPaused ? App.callScreenPauseTrack : App.callScreenTrack) : null;
App.callPreparePauseCapture = function (stream) {
  if (App.callScreenPauseSource) {
    App.callScreenPauseSource.pause();
    App.callScreenPauseSource.srcObject = null;
  }
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  App.callScreenPauseSource = video;
  video.play()?.catch?.(() => {});
};
App.callClearScreenPause = function () {
  App.callScreenPaused = false;
  App.callScreenPauseFrame = null;
  App.callScreenPauseVersion = 0;
  App.callScreenPauseTrack?.stop();
  App.callScreenPauseTrack = null;
  App.callScreenPauseCanvas = null;
  if (App.callScreenPauseSource) {
    App.callScreenPauseSource.pause(); App.callScreenPauseSource.srcObject = null;
    App.callScreenPauseSource = null;
  }
};
App.callScreenPausePayload = () => ({ type: "screen-pause", shareId: App.callScreenShareId,
  paused: App.callScreenPaused, frame: App.callScreenPauseFrame, version: App.callScreenPauseVersion });
App.callReceiveScreenPause = function (code, payload) {
  if (payload?.type !== "screen-pause" || typeof payload.paused !== "boolean" || !Number.isSafeInteger(payload.version) ||
      payload.shareId !== App.callGetShareId(code)) return;
  const current = App.callGetScreenPauseState(code);
  if (payload.version <= current.version) return;
  const frame = typeof payload.frame === "string" && payload.frame.length <= 96000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(payload.frame) ? payload.frame : null;
  App.callRemotePauseStates.set(code, { shareId: payload.shareId, paused: payload.paused, version: payload.version, frame });
  App.callRefreshScreenPauseDisplays();
};
App.callBindScreenStateChannel = function (pc) {
  if (!pc?.createDataChannel) return;
  try {
    // Both current peers negotiate this ID before SDP. Firebase remains the
    // durable source for late viewers and peers on older application versions.
    const channel = pc.createDataChannel("screen-state", { negotiated: true, id: 9, ordered: true });
    pc.__screenStateChannel = channel;
    channel.onmessage = event => {
      if (!App.callPeerIsCurrent(pc) || typeof event.data !== "string" || event.data.length > 100000) return;
      try { App.callReceiveScreenPause(pc.__peerCode, JSON.parse(event.data)); } catch {}
    };
    channel.onopen = () => {
      if (App.callScreenShareId && App.callPeerIsCurrent(pc)) {
        try { channel.send(JSON.stringify(App.callScreenPausePayload())); } catch {}
      }
    };
  } catch {}
};
App.callSetScreenPaused = async function (paused) {
  if (!App.callSharing || !App.callScreenShareId || !App.currentCallRoomId || !App.currentUser) return;
  paused = !!paused;
  if (paused === App.callScreenPaused) return;
  const previousTrack = App.callScreenPauseTrack;
  if (paused) {
    const source = App.callScreenPauseSource || document.querySelector(`.call-view-tile[data-share-code="${CSS.escape(App.currentUser.code)}"] video`);
    // Capture the current decoded frame synchronously in the click handler.
    // If no frame has decoded yet, freeze a neutral frame without leaking live capture.
    const sample = document.createElement("canvas");
    sample.width = 40; sample.height = Math.max(1, Math.round(40 * (source?.videoHeight || 9) / (source?.videoWidth || 16)));
    const small = sample.getContext("2d");
    small.fillStyle = "#17212b"; small.fillRect(0, 0, sample.width, sample.height);
    if (source?.readyState >= 2) small.drawImage(source, 0, 0, sample.width, sample.height);
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = Math.max(1, Math.min(640, Math.round(320 * sample.height / sample.width)));
    const pen = canvas.getContext("2d");
    pen.filter = "blur(14px)";
    pen.drawImage(sample, -24, -24, canvas.width + 48, canvas.height + 48);
    App.callScreenPauseCanvas = canvas;
    App.callScreenPauseFrame = canvas.toDataURL("image/jpeg", .65);
    App.callScreenPauseTrack = canvas.captureStream?.(1).getVideoTracks()[0] || null;
    App.callScreenPauseTrack?.requestFrame?.();
  } else {
    App.callScreenPauseFrame = null;
    App.callScreenPauseTrack = null;
    App.callScreenPauseCanvas = null;
  }
  App.callScreenPaused = paused;
  // Stop live capture output immediately, including while a prior sender
  // replacement is pending. The frozen canvas stays enabled independently.
  if (App.callScreenTrack) App.callScreenTrack.enabled = !paused;
  if (App.callScreenAudioTrack) App.callScreenAudioTrack.enabled = !paused;
  App.callScreenPauseVersion = Math.max(Date.now(), App.callScreenPauseVersion + 1);
  App.callRefreshScreenPauseDisplays();
  const payload = App.callScreenPausePayload();
  const serialized = JSON.stringify(payload);
  for (const pc of App.callPeerMap.values()) {
    try { if (pc.__screenStateChannel?.readyState === "open") pc.__screenStateChannel.send(serialized); } catch {}
    void App.callSetPeerScreenTrack(pc, App.callScreenTrack).catch(error => console.warn("Screen pause sender update failed:", error));
  }
  // Do not wait for a round trip before rendering or switching media.
  const ref = App.myCallMemberRef || App.db.ref(`calls/${App.currentCallRoomId}/members/${App.currentUser.code}`);
  try {
    await ref.update({ sharePaused: paused, sharePauseFrame: payload.frame, sharePauseVersion: payload.version });
  } catch (error) {
    console.warn("Screen pause state could not be saved:", error);
    App.showToast?.({ title: "Screen status could not sync", body: "Your selection is kept. Reconnecting will publish it again.", duration: 4000 });
  } finally { previousTrack?.stop(); }
};
App.callEnsurePeerScreenTransceiver = /* Chat calling: screen-share. Classic script; see CALLING.md. */function (pc) {
  if (!pc) return null;
  if (pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return null;
  const negotiated = pc.getTransceivers?.().find(tx => !tx.stopped && tx !== pc.__cameraTx && tx?.mid != null && tx?.receiver?.track?.kind === 'video');
  if (negotiated) pc.__screenTx = negotiated;
  if (pc.__screenTx) { App.callPreferEfficientVideoCodecs(pc.__screenTx); return pc.__screenTx; }
  try {
    pc.__screenTx = pc.getTransceivers?.().find(tx => !tx.stopped && tx !== pc.__cameraTx && tx?.receiver?.track?.kind === "video") || null;
  } catch {}
  if (!pc.__screenTx && typeof pc.addTransceiver === "function") {
    pc.__screenTx = pc.addTransceiver("video", {
      direction: "sendrecv",
      sendEncodings: App.callVideoSendEncodings()
    });
  }
  App.callPreferEfficientVideoCodecs(pc.__screenTx);
  return pc.__screenTx || null;
};
// The first video m-line is always a screen; the second is always a camera.
// Keeping both negotiated allows either source to stop without disturbing audio.
App.callEnsurePeerCameraTransceiver = function (pc) {
  if (!pc || pc.__closing || pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return null;
  const screen = App.callEnsurePeerScreenTransceiver(pc);
  const video = (pc.getTransceivers?.() || []).filter(tx => !tx.stopped && tx.receiver?.track?.kind === 'video');
  const negotiated = video.find(tx => tx !== screen && tx.mid != null);
  if (negotiated) pc.__cameraTx = negotiated;
  if (!pc.__cameraTx || pc.__cameraTx.stopped) pc.__cameraTx = video.find(tx => tx !== screen) || pc.addTransceiver?.('video', { direction: 'sendrecv', sendEncodings: App.callVideoSendEncodings() }) || null;
  App.callPreferEfficientVideoCodecs(pc.__cameraTx);
  return pc.__cameraTx;
};
App.callIsCameraTrack = function (pc, event) {
  if (event.track?.kind !== 'video') return false;
  const video = (pc.getTransceivers?.() || []).filter(tx => !tx.stopped && tx.receiver?.track?.kind === 'video');
  const tx = event.transceiver || video.find(item => item.receiver?.track === event.track);
  return !!tx && (tx === pc.__cameraTx || video.indexOf(tx) > 0);
};
App.callSetPeerCameraTrack = async function (pc, track) {
  const tx = App.callEnsurePeerCameraTransceiver(pc);
  if (!tx?.sender) return null;
  const apply = async () => {
    if (pc.__closing) return;
    if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv';
    const live = track?.readyState === 'live' && App.callCameraSharing && App.callPeerWantsCamera(pc.__peerCode) ? track : null;
    if (tx.sender.track !== live) await tx.sender.replaceTrack(live);
    if (live) await App.callTuneCameraSender(tx.sender);
  };
  const pending = (pc.__cameraTrackPromise || Promise.resolve()).catch(() => {}).then(apply);
  pc.__cameraTrackPromise = pending;
  try { await pending; } finally { if (pc.__cameraTrackPromise === pending) pc.__cameraTrackPromise = null; }
  return tx.sender;
};
App.callEnsurePeerScreenAudioTransceiver = function (pc) {
  if (!pc || pc.__closing || pc.__polite && !pc.remoteDescription && !pc.__allowInitialOffer) return null;
  // Preserve the microphone as the first audio m-line. Screen audio always has
  // its own second audio m-line, including when either source is temporarily off.
  const microphone = App.callEnsurePeerAudioTransceiver(pc);
  const audio = (pc.getTransceivers?.() || []).filter(tx => !tx.stopped && tx.receiver?.track?.kind === 'audio');
  const negotiated = audio.find(tx => tx !== microphone && tx.mid != null);
  if (negotiated) pc.__screenAudioTx = negotiated;
  if (!pc.__screenAudioTx || pc.__screenAudioTx.stopped) {
    pc.__screenAudioTx = audio.find(tx => tx !== microphone) || pc.addTransceiver?.('audio', { direction: 'sendrecv' }) || null;
  }
  return pc.__screenAudioTx;
};
App.callIsScreenAudioTrack = function (pc, event) {
  if (event.track?.kind !== 'audio') return false;
  const audio = (pc.getTransceivers?.() || []).filter(tx => !tx.stopped && tx.mid != null && tx.receiver?.track?.kind === 'audio');
  const tx = event.transceiver || audio.find(item => item.receiver?.track === event.track);
  return !!tx && (tx === pc.__screenAudioTx || audio.indexOf(tx) > 0);
};
App.callSetPeerScreenTrack = async function (pc, track) {
  const tx = App.callEnsurePeerScreenTransceiver(pc);
  if (!tx?.sender) return null;
  const audioTx = App.callEnsurePeerScreenAudioTransceiver(pc);
  // Keep sendrecv negotiated even while capture is paused. replaceTrack(null)
  // stops encoding/upload without renegotiating every viewer click.
  const apply = async () => {
    if (pc.__closing) return;
    if (tx.direction !== 'sendrecv') tx.direction = 'sendrecv';
    // Evaluate subscriptions when this queued update actually runs. An earlier
    // pause must not overwrite a Watch click that arrived during replaceTrack.
    const wantedTrack = track ? (App.callScreenPaused ? App.callScreenPauseTrack : track) : null;
    const liveVideo = wantedTrack?.readyState === 'live' && App.callPeerWantsScreen(pc.__peerCode) ? wantedTrack : null;
    const audioTrack = App.callScreenAudioTrack;
    const liveAudio = liveVideo && !App.callScreenPaused && audioTrack?.readyState === 'live' ? audioTrack : null;
    // Independent senders prevent microphone mute and user volume from ever
    // muting a shared tab. Subscriber changes pause both media types together.
    await Promise.all([
      (async () => {
        if (tx.sender.track !== liveVideo) await tx.sender.replaceTrack(liveVideo);
        if (liveVideo) await App.callTuneScreenSender(tx.sender);
      })(),
      (async () => {
        if (!audioTx?.sender) return;
        if (audioTx.direction !== 'sendrecv') audioTx.direction = 'sendrecv';
        if (audioTx.sender.track !== liveAudio) await audioTx.sender.replaceTrack(liveAudio);
        if (liveAudio) await App.callApplySenderBudget(audioTx.sender, 'screen-audio');
      })()
    ]);
  };
  // Subscriber and capture updates can arrive together; keep the latest update last.
  const pending = (pc.__screenTrackPromise || Promise.resolve()).catch(() => {}).then(apply);
  pc.__screenTrackPromise = pending;
  try {
    await pending;
  } finally {
    if (pc.__screenTrackPromise === pending) pc.__screenTrackPromise = null;
  }
  return tx.sender;
};
App.callScheduleScreenShareResync = function (roomId, sessionId, shareId) {
  // onnegotiationneeded handles SDP. A one-off local audit replaces repeated
  // forced offers to every peer at 320, 1250 and 3600 milliseconds.
  setTimeout(() => {
    if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId || App.callScreenShareId !== shareId) return;
    App.callScheduleMediaBudget();
  }, 400);
};
App.callGetDisplayMediaFunction = function () {
  if (App.mobileNativeAvailable && App.mobileNativeInfo?.screenShare === true) return App.callRequestNativeDisplayStream;
  if (typeof navigator.mediaDevices?.getDisplayMedia === "function") {
    return navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  }
  const legacy = navigator.getDisplayMedia || navigator.webkitGetDisplayMedia || navigator.mozGetDisplayMedia;
  return typeof legacy === "function" ? legacy.bind(navigator) : null;
};
// Android MediaProjection owns capture consent and its foreground notification.
// Frames stay on the device until this ordinary WebRTC video track sends them
// to the existing, explicitly selected viewers. Device audio is not captured.
App.callRequestNativeDisplayStream = function () {
  if (App.nativeScreenCapture) return Promise.reject(new DOMException("Screen capture already active", "InvalidStateError"));
  return new Promise((resolve, reject) => {
    const requestId = `screen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const canvas = document.createElement("canvas");
    canvas.width = 720; canvas.height = 1280;
    if (typeof canvas.captureStream !== "function") { reject(new DOMException("Video capture unavailable", "NotSupportedError")); return; }
    const context = canvas.getContext("2d", { alpha: false });
    let stream = null, settled = false, closed = false, decoding = false;
    const state = { requestId, stop: () => finish() };
    App.nativeScreenCapture = state;
    const finish = (error, fromSystem = false) => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      window.removeEventListener("chatapp:native", onNative);
      if (App.nativeScreenCapture === state) App.nativeScreenCapture = null;
      if (!fromSystem) App.mobilePost?.("stopScreenShare", { requestId });
      for (const track of stream?.getTracks() || []) {
        track.__nativeOriginalStop?.();
        if (fromSystem) track.dispatchEvent(new Event("ended"));
      }
      if (!settled) { settled = true; reject(error || new DOMException("Screen capture canceled", "NotAllowedError")); }
    };
    const onNative = async event => {
      const data = event.detail || {};
      if (closed || (data.requestId && data.requestId !== requestId)) return;
      if (data.action === "screenShareStopped") { finish(undefined, true); return; }
      if (data.action === "error" && data.code === "screenShare") { finish(new DOMException(data.message || "Capture failed", "NotAllowedError")); return; }
      if (data.action !== "screenFrame" || decoding || !/^data:image\/jpeg;base64,/.test(data.dataURL || "")) return;
      decoding = true;
      const frame = new Image();
      try {
        frame.src = data.dataURL; await frame.decode();
        if (closed) return;
        // Fit rotation changes into a stable video frame; changing canvas size
        // mid-call can invalidate the negotiated encoding resolution.
        const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
        const width = frame.width * scale, height = frame.height * scale;
        context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(frame, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        if (!stream) {
          stream = canvas.captureStream(8);
          for (const track of stream.getTracks()) {
            track.__nativeOriginalStop = track.stop.bind(track);
            track.stop = () => finish();
          }
          clearTimeout(timer); settled = true; resolve(stream);
        }
      } catch (error) { if (!settled) finish(error); }
      finally { decoding = false; }
    };
    const timer = setTimeout(() => finish(new DOMException("Screen capture did not start", "NotAllowedError")), 60000);
    window.addEventListener("chatapp:native", onNative);
    if (!App.mobilePost?.("startScreenShare", { requestId })) finish(new Error("Capture bridge unavailable"));
  });
};
App.callCaptureScreenPreview = function (stream) {
  // Read exactly one decoded frame. Only a small, already blurred JPEG leaves
  // the publisher; unopened shares never need a video subscription for previews.
  return new Promise(resolve => {
    const track = stream?.getVideoTracks?.().find(item => item.readyState === 'live');
    if (!track) { resolve(null); return; }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    let done = false;
    let frameId = null;
    const finish = image => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener('loadeddata', capture);
      if (frameId != null) video.cancelVideoFrameCallback?.(frameId);
      try { video.pause(); video.srcObject = null; } catch {}
      resolve(image);
    };
    const capture = () => {
      if (done || video.readyState < 2 || !video.videoWidth) return;
      try {
        const sample = document.createElement('canvas');
        sample.width = 40;
        sample.height = Math.max(1, Math.round(40 * video.videoHeight / video.videoWidth));
        sample.getContext('2d').drawImage(video, 0, 0, sample.width, sample.height);
        const poster = document.createElement('canvas');
        poster.width = 320;
        poster.height = Math.max(1, Math.min(640, Math.round(320 * video.videoHeight / video.videoWidth)));
        const pen = poster.getContext('2d');
        pen.filter = 'blur(14px)';
        pen.drawImage(sample, -24, -24, poster.width + 48, poster.height + 48);
        finish(poster.toDataURL('image/jpeg', 0.65));
      } catch { finish(null); }
    };
    const timer = setTimeout(() => finish(null), 5000);
    video.addEventListener('loadeddata', capture);
    video.srcObject = new MediaStream([track]);
    if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(capture);
    try { video.play()?.catch?.(() => finish(null)); } catch { finish(null); }
  });
};
App.callPublishScreenPreview = async function (stream, roomId, sessionId, shareId) {
  const current = () => App.currentCallRoomId === roomId && App.callSessionId === sessionId && App.callScreenShareId === shareId && App.callSharing;
  const preview = App.callScreenPreviewDataURL || await App.callCaptureScreenPreview(stream);
  if (!preview || !current()) return;
  // Retain this first frame even when the screen is stopped/restarted in the
  // same call. Call teardown clears it for the next call.
  App.callScreenPreviewDataURL = preview;
  if (App.callMenuOpen) App.renderCallMenu();
  try {
    await App.db.ref(`calls/${roomId}/members/${App.currentUser.code}`).update({ sharePreviewDataURL: preview });
  } catch (error) { console.warn('Screen preview could not be published:', error); }
};
App.callGetScreenShareUnavailableMessage = function () {
  if (!window.isSecureContext && location.protocol !== "file:") {
    return "Screen capture requires HTTPS or localhost in this browser.";
  }
  if (location.protocol === "file:") {
    return "This browser does not expose screen capture to file:// pages. Use HTTPS or localhost in a supported desktop browser.";
  }
  return "This browser does not expose screen capture. Stable iOS and Android browsers may require a native app; receiving shared screens still works.";
};
App.callGetScreenAudioCaptureOptions = function () {
  let canExcludeCallAudio = false;
  try {
    canExcludeCallAudio = navigator.mediaDevices?.getSupportedConstraints?.().restrictOwnAudio === true;
  } catch {}
  return {
    // Exclude this document's output from capture, including remote call voices
    // and watched shares. Their normal local playback remains audible.
    audio: { restrictOwnAudio: true, suppressLocalAudioPlayback: false },
    // Older browsers can still share another tab's audio. A system/window mix
    // without own-audio exclusion would send the call back to its participants.
    systemAudio: canExcludeCallAudio ? 'include' : 'exclude',
    windowAudio: canExcludeCallAudio ? 'system' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include'
  };
};
App.callFilterScreenCaptureAudio = function (stream) {
  const settingsFor = track => {
    try { return track?.getSettings?.() || {}; } catch { return {}; }
  };
  const surface = settingsFor(stream?.getVideoTracks?.()[0]).displaySurface;
  // The picker excludes the calling tab. Another selected tab supplies its own
  // audio without mixing in call playback from this document.
  if (surface === 'browser') return;
  let removedUnsafeAudio = false;
  for (const track of stream?.getAudioTracks?.() || []) {
    const settings = settingsFor(track);
    if (settings.restrictOwnAudio === true || settings.deviceId === 'loopbackWithoutChrome') continue;
    // Picker preferences are only hints in older browsers. Verify the returned
    // system/window mix before any peer sender sees it; do not touch call audio.
    try { track.stop(); } catch {}
    try { stream.removeTrack(track); } catch {}
    removedUnsafeAudio = true;
  }
  if (removedUnsafeAudio) App.showToast?.({
    title: 'Screen audio unavailable',
    body: 'This capture cannot exclude call audio. Video is still shared. Share a browser tab with audio to include sound.',
    duration: 6500
  });
};
App.callRequestDisplayStream = async function ({ beforeCapture = null } = {}) {
  const getDisplayMedia = App.callGetDisplayMediaFunction();
  if (!getDisplayMedia) return null;
  const budget = App.callGetMediaBudget();
  const audioOptions = App.callGetScreenAudioCaptureOptions();
  // Called directly in the click gesture: no credential/network await here.
  const constraints = {
    video: {
      width: {
        ideal: budget.width,
        max: budget.width
      },
      height: {
        ideal: budget.height,
        max: budget.height
      },
      frameRate: {
        ideal: budget.maxFramerate,
        max: budget.maxFramerate
      },
      cursor: 'always'
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      ...audioOptions.audio
    },
    systemAudio: audioOptions.systemAudio,
    windowAudio: audioOptions.windowAudio,
    selfBrowserSurface: audioOptions.selfBrowserSurface,
    surfaceSwitching: audioOptions.surfaceSwitching
  };
  let stream;
  try {
    if (beforeCapture) await beforeCapture();
    stream = await getDisplayMedia(constraints);
  } catch (e) {
    if (!['TypeError', 'OverconstrainedError', 'NotSupportedError', 'ConstraintNotSatisfiedError'].includes(String(e?.name || ''))) throw e;
    // Relax optional resolution and processing hints, never the call-audio
    // exclusion: falling back to audio:true would reintroduce the feedback loop.
    if (beforeCapture) await beforeCapture();
    stream = await getDisplayMedia({ video: true, ...audioOptions });
  }
  App.callFilterScreenCaptureAudio(stream);
  // Legacy capture may ignore the initial options. Apply the same 720p30 cap
  // before attaching any sender, including after the compatibility fallback.
  const track = stream?.getVideoTracks?.()[0];
  try {
    if (track) await App.callApplyScreenCaptureBudget(track, budget);
  } catch (error) {
    for (const item of stream?.getTracks?.() || []) { try { item.stop(); } catch {} }
    throw error;
  }
  return stream;
};
App.callCancelScreenCapture = function () {
  const request = App.callScreenCaptureRequest;
  App.callScreenCaptureRequest = null;
  App.callScreenCapturePending = false;
  if (request?.id) { try { globalThis.chatDesktopCapture?.cancelSelection?.(request.id); } catch {} }
};
App.callToggleShareScreen = async function ({ sourceId = "", shareAudio = false } = {}) {
  if (!App.currentCallRoomId || !App.currentUser) return;
  if (App.callSharing) {
    App.callStopShareScreen();
    return;
  }
  if (App.callScreenCapturePending) return;
  if (!App.callGetDisplayMediaFunction()) {
    App.showToast({
      title: "Screen share unavailable",
      body: App.callGetScreenShareUnavailableMessage(),
      duration: 6000
    });
    return;
  }
  if (!sourceId && globalThis.chatDesktopCapture?.version === 1) {
    App.callOpenCapturePicker('screen');
    return;
  }
  const roomId = App.currentCallRoomId;
  const sessionId = App.callSessionId;
  let capturedStream = null;
  const captureRequest = { id: App.callMakeSignalId('capture') };
  const currentRequest = () => App.callScreenCaptureRequest === captureRequest && App.currentCallRoomId === roomId && App.callSessionId === sessionId;
  App.callScreenCaptureRequest = captureRequest;
  App.callScreenCapturePending = true;
  try {
    const beforeCapture = sourceId ? async () => {
      if (!currentRequest()) throw new DOMException('Capture canceled', 'AbortError');
      const selected = await globalThis.chatDesktopCapture?.selectSource(sourceId, { audio: shareAudio, requestId: captureRequest.id });
      if (!currentRequest()) {
        globalThis.chatDesktopCapture?.cancelSelection?.(captureRequest.id);
        throw new DOMException('Capture canceled', 'AbortError');
      }
      if (!selected) throw new DOMException('That screen is no longer available. Choose it again.', 'NotFoundError');
    } : null;
    const stream = await App.callRequestDisplayStream({ beforeCapture });
    if (!stream) return;
    capturedStream = stream;
    if (!currentRequest()) {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch {}
      return;
    }
    const track = stream.getVideoTracks?.()[0] || null;
    if (!track || track.readyState !== "live") {
      try {
        stream.getTracks().forEach(t => {
          try {
            t.stop();
          } catch {}
          ;
        });
      } catch {}
      return;
    }
    try {
      // Preserve shared text detail while adapting to the available bandwidth.
      track.contentHint = "detail";
    } catch {}
    App.callSharing = true;
    App.callScreenStream = stream;
    App.callScreenTrack = track;
    App.callClearScreenPause();
    App.callPreparePauseCapture(stream);
    App.callPublishDesktopOverlay?.();
    App.callScreenAudioTrack = stream.getAudioTracks?.().find(t => t.readyState === 'live') || null;
    if (App.callScreenAudioTrack) {
      try { App.callScreenAudioTrack.contentHint = 'music'; } catch {}
      const audioTrack = App.callScreenAudioTrack;
      audioTrack.onended = () => {
        if (App.callScreenAudioTrack !== audioTrack) return;
        App.callScreenAudioTrack = null;
        App.callScheduleMediaBudget();
      };
    }
    App.callScreenShareId = `share_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const shareId = App.callScreenShareId;
    const currentShare = () => currentRequest() && App.callSharing && App.callScreenStream === stream && App.callScreenShareId === shareId && track.readyState === 'live';

    // Make self share viewable locally (same UI as viewing others).
    try {
      App.callRemoteVideoStreams.set(String(App.currentUser.code), stream);
    } catch {}
    if (App.callWatchedShareCodes.has(String(App.currentUser.code))) {
      App.syncShareViewStream();
    }

    // If the user ends share from browser UI, stop sharing immediately.
    track.onended = () => {
      if (App.callScreenStream !== stream) return;
      App.callStopShareScreen(true);
    };

    // Ensure peers exist, attach the track, and force a queued media refresh so
    // late/rejoined peers and browsers that require a new SDP direction load it.
    try {
      await App.callEnsurePeers(roomId);
    } catch {}
    if (!currentShare()) {
      stream.getTracks().forEach(mediaTrack => mediaTrack.stop());
      return;
    }
    for (const [peerCode, pc] of App.callPeerMap.entries()) {
      if (!currentShare()) break;
      try {
        await App.callSetPeerScreenTrack(pc, App.callScreenTrack);
        // Viewer subscription attaches capture without restarting healthy audio.
      } catch (e) {
        console.warn("screen share publish failed:", e);
      }
    }
    if (!currentShare()) {
      try {
        stream.getTracks().forEach(mediaTrack => mediaTrack.stop());
      } catch {}
      return;
    }

    // Update Firebase member flag after the track is attached.
    App.callNotifyLocalScreenState?.(roomId, sessionId, shareId);
    try {
      App.db.ref(`calls/${roomId}/members/${App.currentUser.code}`).update({
        sharing: true,
        sharePaused: !!App.callScreenPaused, sharePauseFrame: App.callScreenPauseFrame || null, sharePauseVersion: App.callScreenPauseVersion || 0,
        shareId,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP
      });
    } catch {}
    void App.callPublishScreenPreview(stream, roomId, sessionId, shareId);
    App.syncCallControlsUI();
    if (App.callMenuOpen) App.renderCallMenu();
    App.callScheduleScreenShareResync(roomId, sessionId, shareId);
    capturedStream = null;
  } catch (e) {
    // User cancelled or permission denied.
    if (capturedStream) {
      if (App.callSharing && App.callScreenStream === capturedStream) {
        try {
          App.callStopShareScreen(true);
        } catch {}
      }
      try {
        capturedStream.getTracks().forEach(mediaTrack => {
          try {
            mediaTrack.onended = null;
          } catch {}
          try {
            mediaTrack.stop();
          } catch {}
        });
      } catch {}
    }
    if (!currentRequest()) return;
    App.callSharing = false;
    App.callPublishDesktopOverlay?.();
    App.callScreenStream = null;
    App.callScreenTrack = null;
    App.callScreenAudioTrack = null;
    App.callScreenShareId = null;
    console.warn("screen share start failed:", e);
    const message = e?.name === "InvalidStateError" ? "Tap Share Screen again while this tab is focused. The browser requires a fresh user gesture." : e?.name === "SecurityError" ? App.callGetScreenShareUnavailableMessage() : e?.name === "NotAllowedError" || e?.name === "AbortError" ? "Screen capture was canceled or blocked by the browser or operating system." : "The capture could not start. Try choosing the screen again in a supported desktop browser.";
    App.showToast({
      title: "Screen share failed",
      body: message,
      duration: 4200
    });
    App.syncCallControlsUI();
  } finally {
    try { globalThis.chatDesktopCapture?.cancelSelection?.(captureRequest.id); } catch {}
    if (App.callScreenCaptureRequest === captureRequest) {
      App.callScreenCapturePending = false;
      App.callScreenCaptureRequest = null;
    }
  }
};
App.callRemoveShareViewerGeneration = async function (roomId, ownerCode, endedShareId) {
  const id = App.sanitizeCallRoom(roomId);
  const owner = String(ownerCode || "");
  const generation = String(endedShareId || "");
  // Without a generation id there is no race-free way to distinguish an old
  // viewer leaf from one belonging to a newly-started share.
  if (!id || !owner || !generation) return;
  try {
    await App.db.ref(`calls/${id}/screenViewers/${owner}`).transaction(viewersRaw => {
      if (!viewersRaw || typeof viewersRaw !== "object") return null;
      const nextViewers = {};
      for (const [viewerCode, sessionsRaw] of Object.entries(viewersRaw)) {
        if (!sessionsRaw || typeof sessionsRaw !== "object") continue;

        // Compatibility with the first rollout, where a viewer record was not
        // nested by session id.
        if (sessionsRaw.sessionId) {
          const recordShareId = String(sessionsRaw.shareId || "");
          if (recordShareId && generation && recordShareId !== generation) {
            nextViewers[viewerCode] = sessionsRaw;
          }
          continue;
        }
        const nextSessions = {};
        for (const [sessionKey, record] of Object.entries(sessionsRaw)) {
          if (!record || typeof record !== "object") continue;
          const recordShareId = String(record.shareId || "");
          // Preserve records from a newer generation. A Firebase transaction
          // retries if a new viewer arrives while this cleanup is in flight.
          if (recordShareId && generation && recordShareId !== generation) {
            nextSessions[sessionKey] = record;
          }
        }
        if (Object.keys(nextSessions).length) nextViewers[viewerCode] = nextSessions;
      }
      return Object.keys(nextViewers).length ? nextViewers : null;
    }, undefined, false);
  } catch (e) {
    console.warn("screen viewer generation cleanup failed:", e);
  }
};
App.callStopShareScreen = function (quiet = false) {
  App.callCancelScreenCapture();
  if (!App.currentCallRoomId || !App.currentUser) return;
  const roomId = App.currentCallRoomId;
  const selfCode = String(App.currentUser.code || "");
  const endedShareId = String(App.callScreenShareId || "");
  if (endedShareId) App.callNotifyLocalScreenState?.(roomId, App.callSessionId, "");
  App.callSharing = false;
  App.callScreenShareId = null;
  App.callClearScreenPause();

  // Detach from peers and notify them to remove stale screen tracks.
  for (const [peerCode, pc] of App.callPeerMap.entries()) {
    try {
      if (pc.__screenTx) {
        void App.callSetPeerScreenTrack(pc, null).catch(e => console.warn("screen share detach failed:", e));
        // Stable transceiver: pausing capture does not need another SDP exchange.
      }
    } catch {}
  }

  // Stop local tracks.
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
  App.callScreenStream = null;
  App.callScreenTrack = null;
  App.callScreenAudioTrack = null;

  // Clear local self-cache for share viewer.
  try {
    App.callRemoteVideoStreams.delete(selfCode);
  } catch {}

  // Update Firebase.
  try {
    App.db.ref(`calls/${roomId}/members/${App.currentUser.code}`).update({
      sharing: false,
      sharePaused: false, sharePauseFrame: null, sharePauseVersion: 0,
      shareId: null,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    });
  } catch {}
  void App.callRemoveShareViewerGeneration(roomId, selfCode, endedShareId);
  App.callShareViewersCache.delete(selfCode);
  // If I was watching my own share view, close it.
  if (App.callWatchedShareCodes.has(String(App.currentUser.code))) {
    App.callCloseWatchedShare(String(App.currentUser.code));
  }
  if (!quiet) {
    App.showToast({
      title: "Screen share ended",
      body: "Your screen is no longer being shared.",
      duration: 1800
    });
  }
  App.syncCallControlsUI();
  if (App.callMenuOpen) App.renderCallMenu();
  void App.callSyncViewerPresence();
};


App.callToggleCamera = async function ({ deviceId = "" } = {}) {
  if (!App.currentCallRoomId || !App.currentUser) return;
  if (App.callCameraSharing) { App.callStopCamera(); return; }
  if (App.callCameraCapturePending) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    App.showToast({ title: 'Camera unavailable', body: 'Camera sharing requires a supported browser on HTTPS or the desktop app.' });
    return;
  }
  if (!deviceId && (globalThis.chatDesktopCapture || App.callDesktopOverlayAvailable?.())) {
    App.callOpenCapturePicker('camera');
    return;
  }
  const roomId = App.currentCallRoomId, sessionId = App.callSessionId;
  const selfCode = String(App.currentUser.code);
  let stream = null;
  const captureRequest = {};
  App.callCameraCaptureRequest = captureRequest;
  App.callCameraCapturePending = true;
  App.syncCallControlsUI();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 },
      ...(deviceId && deviceId !== '__default_camera__' ? { deviceId: { exact: deviceId } } : { facingMode: 'user' })
    } });
    if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId || App.callCameraCaptureRequest !== captureRequest) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    const track = stream.getVideoTracks().find(track => track.readyState === 'live');
    if (!track) throw new Error('The camera did not provide video.');
    await App.callApplyScreenCaptureBudget(track);
    if (App.currentCallRoomId !== roomId || App.callSessionId !== sessionId || App.callCameraCaptureRequest !== captureRequest) {
      stream.getTracks().forEach(item => item.stop());
      return;
    }
    try { track.contentHint = 'motion'; } catch {}
    const shareId = App.callMakeSignalId('camera');
    App.callCameraStream = stream;
    App.callCameraTrack = track;
    App.callCameraShareId = shareId;
    App.callCameraSharing = true;
    App.callPublishDesktopOverlay?.();
    App.callCameraPreviewDataURL = null;
    const current = () => App.currentCallRoomId === roomId && App.callSessionId === sessionId && App.callCameraShareId === shareId && App.callCameraSharing;
    track.onended = () => { if (current()) App.callStopCamera(); };
    App.syncCallControlsUI();
    if (App.callMenuOpen) App.renderCallMenu();
    // Capture one blurred still locally. Never upload a live preview or raw frame.
    void App.callCaptureScreenPreview(stream).then(async preview => {
      if (!preview || !current()) return;
      App.callCameraPreviewDataURL = preview;
      if (App.callMenuOpen) App.renderCallMenu();
      try {
        await App.db.ref('calls/' + roomId + '/members/' + selfCode).transaction(member => {
          if (!current() || !member || member.sessionId !== sessionId || member.cameraShareId !== shareId) return;
          return { ...member, cameraPreviewDataURL: preview };
        }, undefined, false);
      } catch (error) { console.warn('Camera preview could not be published:', error); }
    });
    const publish = App.db.ref('calls/' + roomId + '/members/' + selfCode).transaction(member => {
      if (!current() || !member || member.sessionId !== sessionId) return;
      return { ...member, cameraSharing: true, cameraShareId: shareId,
        cameraPreviewDataURL: App.callCameraPreviewDataURL || null, updatedAt: App.firebase.database.ServerValue.TIMESTAMP };
    }, undefined, false);
    const result = await (App.callAwaitSignaling ? App.callAwaitSignaling(publish) : publish);
    if (!current()) return;
    if (!result.committed) throw new Error('The call ended before your camera could be shared.');
    App.callNotifyLocalCameraState?.(roomId, sessionId, shareId);
    await App.callEnsurePeers(roomId);
    App.callScheduleMediaBudget();
  } catch (error) {
    const reportFailure = App.callCameraCaptureRequest === captureRequest;
    if (stream && App.callCameraStream === stream) App.callStopCamera();
    else stream?.getTracks().forEach(track => track.stop());
    if (reportFailure && App.currentCallRoomId === roomId && App.callSessionId === sessionId) App.showToast({
      title: 'Camera sharing failed',
      body: error?.name === 'NotAllowedError' ? 'Allow camera access in your browser or system settings and try again.' : error?.name === 'NotFoundError' ? 'No camera was found. Connect a camera and try again.' : error?.name === 'NotReadableError' ? 'The camera is busy or unavailable. Close other apps using it and try again.' : 'Your camera could not start. Check camera access and try again.', duration: 5000
    });
    console.warn('Camera sharing failed:', error);
  } finally {
    if (App.callCameraCaptureRequest === captureRequest) {
      App.callCameraCapturePending = false;
      App.callCameraCaptureRequest = null;
    }
    App.syncCallControlsUI();
  }
};
App.callStopCamera = function ({ publish = true } = {}) {
  const roomId = App.currentCallRoomId, sessionId = App.callSessionId;
  const selfCode = String(App.currentUser?.code || ''), shareId = App.callCameraShareId;
  if (shareId) App.callNotifyLocalCameraState?.(roomId, sessionId, "");
  App.callCameraSharing = false;
  App.callPublishDesktopOverlay?.();
  App.callCameraCapturePending = false;
  App.callCameraCaptureRequest = null;
  App.callCameraShareId = null;
  if (App.callCameraTrack) App.callCameraTrack.onended = null;
  App.callCameraStream?.getTracks().forEach(track => track.stop());
  App.callCameraStream = null;
  App.callCameraTrack = null;
  App.callCameraPreviewDataURL = null;
  for (const pc of App.callPeerMap.values()) if (pc.__cameraTx) void App.callSetPeerCameraTrack(pc, null).catch(error => console.warn('Camera detach failed:', error));
  const key = App.callCameraKey(selfCode);
  App.callWatchedShareCodes.delete(key);
  if (App.callFocusedShareCode === key) App.callFocusedShareCode = null;
  App.callShareViewersCache.delete(key);
  if (publish && roomId && sessionId && selfCode && shareId) {
    void App.db.ref('calls/' + roomId + '/members/' + selfCode).transaction(member => {
      if (!member || member.sessionId !== sessionId || member.cameraShareId !== shareId) return;
      return { ...member, cameraSharing: false, cameraShareId: null, cameraPreviewDataURL: null, updatedAt: App.firebase.database.ServerValue.TIMESTAMP };
    }, undefined, false).catch(error => console.warn('Camera presence could not be cleared:', error));
    void App.callRemoveShareViewerGeneration(roomId, key, shareId);
  }
  App.syncCallControlsUI();
  if (App.callMenuOpen) App.renderCallMenu();
  void App.callSyncViewerPresence();
};

/* Capture choices share the regular app menu surface and fade animation. */
App.callCaptureChoices = { screen: [], camera: [] };
App.callCaptureChoiceJobs = {};
App.callRefreshCaptureChoices = function (kind, fresh = false, previews = false) {
  if (App.callCaptureChoiceJobs[kind]) return App.callCaptureChoiceJobs[kind];
  const request = kind === 'screen'
    ? globalThis.chatDesktopCapture?.listSources({ fresh, previews })
    : navigator.mediaDevices?.enumerateDevices?.().then(devices => devices.filter(device => device.kind === 'videoinput').map((device, index) => ({ id: device.deviceId || '__default_camera__', name: device.label || `Camera ${index + 1}`, kind: 'camera' })));
  if (!request) return Promise.resolve([]);
  const job = Promise.resolve(request).then(items => {
    const previous = new Map((App.callCaptureChoices[kind] || []).map(item => [item.id, item]));
    App.callCaptureChoices[kind] = Array.isArray(items) ? items.map(item => ({ ...item, thumbnail: item.thumbnail || previous.get(item.id)?.thumbnail || '' })) : [];
    if (App.callCapturePicker?.kind === kind) App.callRenderCaptureChoices();
    return App.callCaptureChoices[kind];
  }).finally(() => { if (App.callCaptureChoiceJobs[kind] === job) delete App.callCaptureChoiceJobs[kind]; });
  App.callCaptureChoiceJobs[kind] = job;
  return job;
};
App.callPrimeCapturePicker = function () {
  if (!globalThis.chatDesktopCapture && !App.callDesktopOverlayAvailable?.()) return;
  void App.callRefreshCaptureChoices('camera').catch(() => {});
  if (globalThis.chatDesktopCapture) void App.callRefreshCaptureChoices('screen').catch(() => {});
};
App.callLayoutCapturePicker = function () {
  const state = App.callCapturePicker, menu = App.$('call-capture-picker');
  if (!state || !menu || menu.hidden) return;
  const v = window.visualViewport;
  const left = v?.offsetLeft || 0, top = v?.offsetTop || 0;
  const width = v?.width || innerWidth, height = v?.height || innerHeight;
  const anchor = state.anchor?.getBoundingClientRect();
  const popupWidth = Math.min(500, width - 16);
  menu.style.setProperty('--chat-popup-width', `${popupWidth}px`);
  menu.style.setProperty('--chat-popup-max-height', `${height - 16}px`);
  const naturalHeight = Math.min(menu.scrollHeight + 2, height - 16);
  const above = anchor ? anchor.top - top - 16 : 0;
  const below = anchor ? top + height - anchor.bottom - 16 : height - 16;
  const preferAbove = above >= Math.min(naturalHeight, 260) || above > below;
  const available = Math.max(100, Math.min(height - 16, anchor ? (preferAbove ? above : below) : height - 16));
  menu.style.setProperty('--chat-popup-max-height', `${available}px`);
  const popupHeight = Math.min(naturalHeight, available);
  menu.style.setProperty('--chat-popup-left', `${Math.max(left + 8, Math.min(anchor?.left || left + 8, left + width - popupWidth - 8))}px`);
  menu.style.setProperty('--chat-popup-top', `${Math.max(top + 8, Math.min(anchor ? (preferAbove ? anchor.top - popupHeight - 8 : anchor.bottom + 8) : top + 8, top + height - popupHeight - 8))}px`);
};
App.callCloseCapturePicker = function ({ immediate = false, restoreFocus = false } = {}) {
  const menu = App.$('call-capture-picker'), state = App.callCapturePicker;
  App.callCapturePicker = null;
  clearTimeout(App.callCapturePickerTimer);
  clearInterval(App.callCaptureRefreshTimer);
  clearTimeout(App.callCapturePreviewTimer);
  if (!menu) return;
  menu.classList.remove('open');
  menu.classList.add('closing');
  menu.style.opacity = '0';
  const finish = () => { menu.hidden = true; menu.classList.remove('closing'); };
  if (immediate) finish(); else App.callCapturePickerTimer = setTimeout(finish, 150);
  if (restoreFocus) state?.anchor?.focus?.({ preventScroll: true });
};
App.callRenderCaptureChoices = function () {
  const state = App.callCapturePicker, menu = App.$('call-capture-picker');
  if (!state || !menu) return;
  const body = menu.querySelector('.call-capture-choices');
  const choices = App.callCaptureChoices[state.kind] || [];
  const retained = new Set();
  const existing = new Map([...body.children].map(node => [node.dataset.sourceId, node]));
  for (const choice of choices) {
    const id = String(choice.id || '');
    if (!id || retained.has(id)) continue;
    retained.add(id);
    let button = existing.get(id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'call-capture-choice';
      button.dataset.sourceId = id;
      button.innerHTML = '<span class="call-capture-preview"></span><span class="call-capture-name"></span><span class="call-capture-kind"></span>';
      button.addEventListener('click', () => {
        if (App.callCapturePicker !== state || App.currentCallRoomId !== state.roomId || App.callSessionId !== state.sessionId) return App.callCloseCapturePicker();
        App.callCloseCapturePicker();
        void (state.kind === 'camera' ? App.callToggleCamera({ deviceId: id }) : App.callToggleShareScreen({ sourceId: id, shareAudio: state.shareAudio === true }));
      });
      body.appendChild(button);
    }
    button.querySelector('.call-capture-name').textContent = String(choice.name || (state.kind === 'camera' ? 'Camera' : 'Screen'));
    button.querySelector('.call-capture-kind').textContent = state.kind === 'camera' ? '720p · 30 fps' : id.startsWith('screen:') ? 'Entire screen · 720p · 30 fps' : 'Window · 720p · 30 fps';
    const preview = button.querySelector('.call-capture-preview');
    const thumbnail = /^data:image\/(png|jpeg|webp);base64,/.test(choice.thumbnail || '') ? choice.thumbnail : '';
    if (preview.dataset.thumbnail !== thumbnail) {
      preview.dataset.thumbnail = thumbnail;
      preview.replaceChildren();
      if (thumbnail) { const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = thumbnail; preview.appendChild(img); }
      else preview.innerHTML = state.kind === 'camera' ? App.CALL_CAMERA_SVG : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 21h6M12 17v4" stroke="currentColor" stroke-width="2"/></svg>';
    }
  }
  for (const node of [...body.children]) if (!retained.has(node.dataset.sourceId)) node.remove();
  const status = menu.querySelector('.call-capture-status');
  status.hidden = choices.length > 0;
  status.textContent = state.error || (state.loaded ? (state.kind === 'camera' ? 'No cameras found. Connect a camera to share.' : 'No screens or windows are available.') : 'Finding available sources…');
  App.callLayoutCapturePicker();
};
App.callOpenCapturePicker = function (kind) {
  if (!App.currentCallRoomId || !App.currentUser) return;
  if (App.callCapturePicker?.kind === kind) { App.callCloseCapturePicker({ restoreFocus: true }); return; }
  App.dismissChatPopovers?.();
  App.callCloseCapturePicker({ immediate: true });
  const anchor = App.callCaptureAnchor || document.activeElement?.closest?.('button') || App.$(kind === 'camera' ? 'btn-call-camera' : 'btn-call-share');
  App.callCaptureAnchor = null;
  let menu = App.$('call-capture-picker');
  if (!menu) {
    menu = document.createElement('section');
    menu.id = 'call-capture-picker';
    menu.className = 'chat-popup call-capture-picker';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'false');
    menu.setAttribute('aria-labelledby', 'call-capture-title');
    document.body.appendChild(menu);
  }
  const state = App.callCapturePicker = { kind, anchor, roomId: App.currentCallRoomId, sessionId: App.callSessionId, loaded: false, shareAudio: false };
  menu.innerHTML = '<header class="chat-popup-heading"><span class="chat-popup-mark" aria-hidden="true"></span><div class="chat-popup-heading-copy"><strong id="call-capture-title"></strong></div><button class="chat-popup-close chat-icon-button" type="button" aria-label="Close capture menu"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header><p class="call-capture-status" role="status"></p><div class="call-capture-choices"></div>';
  if (kind === 'screen') {
    const audio = document.createElement('label');
    audio.className = 'call-capture-audio';
    audio.innerHTML = '<input type="checkbox"><span>Share system audio<small>Includes other apps when supported.</small></span>';
    audio.querySelector('input').addEventListener('change', event => { state.shareAudio = event.target.checked; });
    menu.querySelector('.chat-popup-heading').after(audio);
  }
  menu.querySelector('#call-capture-title').textContent = kind === 'camera' ? 'Share Camera' : 'Share Screen';
  menu.querySelector('.chat-popup-mark').innerHTML = kind === 'camera' ? App.CALL_CAMERA_SVG : '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 21h6M12 17v4" stroke="currentColor" stroke-width="2"/></svg>';
  menu.querySelector('.chat-popup-close').addEventListener('click', () => App.callCloseCapturePicker({ restoreFocus: true }));
  menu.classList.remove('open', 'closing');
  menu.hidden = false;
  menu.style.opacity = '0';
  App.callRenderCaptureChoices();
  void menu.offsetHeight;
  menu.classList.add('open');
  menu.style.opacity = '1';
  const refresh = (fresh = false) => App.callRefreshCaptureChoices(kind, fresh).then(() => {
    state.loaded = true;
    if (App.callCapturePicker === state) App.callRenderCaptureChoices();
  }).catch(() => {
    state.error = kind === 'camera' ? 'Camera devices could not be listed. Check camera access and try again.' : 'Screens could not be listed. Close this menu and try again.';
    if (App.callCapturePicker === state) App.callRenderCaptureChoices();
  });
  void refresh().then(() => {
    // Source buttons are usable before thumbnail extraction begins. One small
    // preview batch per opening avoids recapturing every window on a timer.
    if (kind === 'screen') App.callCapturePreviewTimer = setTimeout(() => {
      if (App.callCapturePicker === state) void App.callRefreshCaptureChoices(kind, false, true).catch(() => {});
    }, 250);
  });
  App.callCaptureRefreshTimer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(true); }, 15000);
};

App.register("calling/screen-share", function initializeFeature() {
document.addEventListener('pointerdown', event => {
  const state = App.callCapturePicker;
  if (state && !App.$('call-capture-picker')?.contains(event.target) && !state.anchor?.contains?.(event.target)) App.callCloseCapturePicker();
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && App.callCapturePicker) { event.preventDefault(); event.stopImmediatePropagation(); App.callCloseCapturePicker({ restoreFocus: true }); }
}, true);
window.addEventListener('resize', App.callLayoutCapturePicker);
window.visualViewport?.addEventListener('resize', App.callLayoutCapturePicker);
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (App.callCapturePicker?.kind === 'camera') void App.callRefreshCaptureChoices('camera', true).catch(() => {}); });

App.callScreenPreviewDataURL = null;
});
})(globalThis.ChatApp);
