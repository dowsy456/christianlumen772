/* media/voice-recorder: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.canUseVoiceComposer = function () {
  const placeNow = App.getStoredPlace() || "home";
  return !!(App.currentUser && App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true");
};
App.getVoiceDraftOwner = function () {
  return { code: App.currentUser?.code || "", generation: App.accountSessionGeneration, roomId: App.currentRoomId || "" };
};
App.isVoiceDraftCurrent = function (owner = App.voiceDraftOwner) {
  return !!owner && !!App.currentUser && owner.code === App.currentUser.code && owner.generation === App.accountSessionGeneration && owner.roomId === App.currentRoomId;
};
App.getBestVoiceMimeType = function () {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"];
  for (const mime of candidates) {
    try {
      if (globalThis.MediaRecorder?.isTypeSupported?.(mime)) return mime;
    } catch {}
  }
  return "";
};
App.getVoiceFileExtension = function (mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4")) return "m4a";
  if (m.includes("wav")) return "wav";
  return "webm";
};
App.formatVoiceComposerTime = function (totalMs) {
  const totalSec = Math.max(0, Math.floor((Number(totalMs) || 0) / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
};
App.getVoiceRecordingElapsedMs = function () {
  if (!App.voiceRecordingStartAt) return App.voiceRecordingElapsedBeforePause;
  if (App.voiceRecordingPaused) return App.voiceRecordingElapsedBeforePause;
  return App.voiceRecordingElapsedBeforePause + Math.max(0, Date.now() - App.voiceRecordingStartAt);
};
App.getVoicePreviewAudio = function () {
  return App.$("voice-preview-audio");
};
App.stopVoicePreviewPlayback = function ({
  resetTime = false
} = {}) {
  const audio = App.getVoicePreviewAudio();
  if (!audio) return;
  try {
    audio.pause();
  } catch {}
  if (resetTime) {
    try {
      audio.currentTime = 0;
    } catch {}
  }
};
App.revokeVoicePreviewUrl = function () {
  if (!App.voicePreviewUrl) return;
  try {
    URL.revokeObjectURL(App.voicePreviewUrl);
  } catch {}
  App.voicePreviewUrl = "";
};
App.syncVoicePreviewMedia = function () {
  const audio = App.getVoicePreviewAudio();
  if (!audio) return;
  if (App.voicePreviewUrl) {
    if (audio.src !== App.voicePreviewUrl) audio.src = App.voicePreviewUrl;
    audio.hidden = true;
  } else {
    App.stopVoicePreviewPlayback({
      resetTime: true
    });
    audio.removeAttribute("src");
    try {
      audio.load();
    } catch {}
    audio.hidden = true;
  }
};
App.clearVoicePreview = function ({
  keepUi = false
} = {}) {
  App.voiceDraftRevision = (App.voiceDraftRevision || 0) + 1;
  App.stopVoicePreviewPlayback({
    resetTime: true
  });
  App.voicePreviewBlob = null;
  App.voicePreviewMimeType = "";
  App.voicePreviewFile = null;
  App.voiceDraftOwner = null;
  App.revokeVoicePreviewUrl();
  App.syncVoicePreviewMedia();
  if (!keepUi) App.syncVoicePopoverUI();
};
App.setVoicePreview = function (blob) {
  App.revokeVoicePreviewUrl();
  App.voicePreviewBlob = blob;
  App.voicePreviewMimeType = blob.type || "audio/wav";
  App.voicePreviewFile = blob instanceof File ? blob : null;
  App.voiceDraftOwner = App.getVoiceDraftOwner();
  App.voicePreviewUrl = URL.createObjectURL(blob);
  App.syncVoicePreviewMedia();
};
// Decode each segment before joining: concatenating MP3/WebM bytes loses the
// appended speech in many players. PCM WAV works across the web and desktop.
App.joinVoiceSegments = async function (segments) {
  await App.ensureFileUploadLimitLoaded();
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser cannot combine audio clips.");
  const context = new AudioContextClass({ sampleRate: 48000 });
  try {
    const buffers = [];
    for (const segment of segments) buffers.push(await context.decodeAudioData(await segment.arrayBuffer()));
    const frames = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const channels = Math.min(2, Math.max(...buffers.map(buffer => buffer.numberOfChannels)));
    const bytes = frames * channels * 2;
    if (bytes + 44 > App.CHAT_FILE_MAX_BYTES) throw new Error("The combined voice message exceeds the file size limit. Use a shorter clip.");
    const output = new ArrayBuffer(44 + bytes);
    const view = new DataView(output);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVE"); text(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
    view.setUint32(24, context.sampleRate, true); view.setUint32(28, context.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, bytes, true);
    let offset = 44;
    for (const buffer of buffers) {
      const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)));
      for (let frame = 0; frame < buffer.length; frame++) for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, data[channel][frame]));
        view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true); offset += 2;
      }
    }
    return new Blob([output], { type: "audio/wav" });
  } finally { await context.close(); }
};
App.importVoiceAudio = async function (file) {
  if (!file || !App.canUseVoiceComposer() || App.voiceRecorder || App.voiceDraftBusy || App.voiceRecordingStarting) return;
  const roomId = App.currentRoomId, userCode = App.currentUser?.code;
  try { await App.ensureFileUploadLimitLoaded(); }
  catch (error) {
    App.showToast({ title: "Audio upload unavailable", body: error.message, duration: 2800 });
    return;
  }
  if (roomId !== App.currentRoomId || userCode !== App.currentUser?.code || !App.canUseVoiceComposer() || App.voiceRecorder || App.voiceDraftBusy || App.voiceRecordingStarting) return;
  if (file.size > App.CHAT_FILE_MAX_BYTES) {
    App.showToast({ title: "Audio is too large", body: `Choose a clip ${App.CHAT_FILE_MAX_LABEL} or smaller.`, duration: 2800 });
    return;
  }
  App.stopVoicePreviewPlayback({ resetTime: true });
  App.voiceDraftRevision = (App.voiceDraftRevision || 0) + 1;
  if (!file.type) {
    const extension = file.name.toLowerCase().split(".").pop();
    const mime = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", aac: "audio/aac", flac: "audio/flac" }[extension];
    if (mime) file = new File([file], file.name, { type: mime, lastModified: file.lastModified });
  }
  App.setVoicePreview(file);
  App.syncVoicePopoverUI();
};
App.getVoicePreviewFile = function () {
  if (!App.isVoiceDraftCurrent()) { App.clearVoicePreview(); return null; }
  if (App.voicePreviewFile instanceof File) return App.voicePreviewFile;
  if (!(App.voicePreviewBlob instanceof Blob)) return null;
  const mime = String(App.voicePreviewMimeType || App.voicePreviewBlob.type || "audio/webm");
  const ext = App.getVoiceFileExtension(mime);
  App.voicePreviewFile = new File([App.voicePreviewBlob], `voice-message-${Date.now()}.${ext}`, {
    type: mime
  });
  return App.voicePreviewFile;
};
App.stopVoiceRecordingTimer = function () {
  if (App.voiceRecordingTimer) {
    clearInterval(App.voiceRecordingTimer);
    App.voiceRecordingTimer = 0;
  }
};
App.startVoiceRecordingTimer = function () {
  App.stopVoiceRecordingTimer();
  App.voiceRecordingTimer = setInterval(() => {
    App.syncVoicePopoverUI();
  }, 120);
};
App.resetVoiceRecorderState = function ({
  keepStream = false
} = {}) {
  App.stopVoiceRecordingTimer();
  App.voiceRecorder = null;
  App.voiceRecorderChunks = [];
  App.voiceRecordingStartAt = 0;
  App.voiceRecordingElapsedBeforePause = 0;
  App.voiceRecordingPaused = false;
  App.voiceRecorderStopMode = "preview";
  if (!keepStream && App.voiceRecorderStream) {
    try {
      App.voiceRecorderStream.getTracks().forEach(track => track.stop());
    } catch {}
    App.voiceRecorderStream = null;
  }
};
App.ensureVoiceRecorderStream = async function () {
  if (App.voiceRecorderStream) return App.voiceRecorderStream;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone access is not supported in this browser.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: true
  });
};
App.syncVoicePopoverUI = function () {
  // Neither a microphone prompt nor a deferred decode may move someone's
  // private draft into another account or the next room's composer.
  if (App.voiceDraftOwner && !App.isVoiceDraftCurrent()) {
    if (App.voiceRecordingStarting) App.voiceRecorderRequestToken += 1;
    if (App.voiceRecorder) App.finishVoiceRecording({ savePreview: false });
    App.clearVoicePreview({ keepUi: true });
  }
  const pop = App.$("voice-popover");
  const preview = App.$("voice-preview-time");
  const state = App.$("voice-state-text");
  const pauseBtn = App.$("btn-voice-pause");
  const stopBtn = App.$("btn-voice-stop");
  const startBtn = App.$("btn-voice-start");
  const uploadBtn = App.$("btn-voice-upload");
  const clearBtn = App.$("btn-voice-clear");
  const previewAudio = App.getVoicePreviewAudio();
  const previewPlayer = App.$("voice-preview-player");
  const previewPlay = App.$("btn-voice-preview-play");
  const previewSeek = App.$("voice-preview-seek");
  const previewDuration = App.$("voice-preview-duration");
  const countEl = App.$("voice-count");
  const hasRecorder = !!App.voiceRecorder;
  const hasPreview = !!App.voicePreviewBlob;
  const busy = !!(App.voiceDraftBusy || App.voiceRecordingStarting);
  const overLimit = App.pendingFiles.length >= App.CHAT_FILE_MAX_COUNT;
  const previewMs = (() => {
    if (hasRecorder) return App.getVoiceRecordingElapsedMs();
    if (previewAudio) {
      const dur = Number(previewAudio.duration);
      if (Number.isFinite(dur) && dur > 0) return dur * 1000;
    }
    return 0;
  })();
  if (pop) {
    pop.dataset.recording = hasRecorder && !App.voiceRecordingPaused ? "1" : "0";
    pop.dataset.paused = hasRecorder && App.voiceRecordingPaused ? "1" : "0";
    pop.dataset.hasPreview = hasPreview ? "1" : "0";
  }
  if (preview) preview.textContent = App.formatVoiceComposerTime(previewMs);
  if (state) {
    state.textContent = busy ? "Preparing audio…" : hasRecorder ? App.voiceRecordingPaused ? "Paused" : "Recording…" : hasPreview ? "Ready — add your voice or attach" : "Ready to record";
  }
  if (startBtn) {
    startBtn.hidden = hasRecorder;
    startBtn.disabled = overLimit || busy;
    startBtn.textContent = hasPreview ? "Add Recording" : "Start Recording";
  }
  if (uploadBtn) {
    uploadBtn.disabled = overLimit || hasRecorder || busy;
  }
  if (pauseBtn) {
    pauseBtn.hidden = !hasRecorder;
    pauseBtn.disabled = !hasRecorder;
    pauseBtn.textContent = App.voiceRecordingPaused ? "Resume" : "Pause";
  }
  if (stopBtn) {
    stopBtn.hidden = !hasRecorder && !hasPreview;
    stopBtn.disabled = busy || (hasRecorder ? false : !hasPreview || overLimit);
    stopBtn.textContent = hasRecorder ? "Stop Recording" : "Attach Clip";
  }
  if (clearBtn) {
    clearBtn.hidden = !hasRecorder && !hasPreview;
    clearBtn.disabled = false;
    clearBtn.textContent = hasRecorder ? "Cancel" : "Discard";
  }
  if (previewAudio) {
    previewAudio.hidden = true;
  }
  if (previewPlayer) previewPlayer.hidden = !hasPreview || hasRecorder || busy;
  if (previewPlay && previewAudio) {
    const playing = hasPreview && !previewAudio.paused && !previewAudio.ended;
    previewPlay.setAttribute("aria-label", playing ? "Pause voice preview" : "Play voice preview");
    previewPlay.innerHTML = playing ? `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 7v10M16 7v10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>` : `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 7.5v9l7-4.5-7-4.5Z" fill="currentColor"/></svg>`;
  }
  if (previewAudio && previewSeek instanceof HTMLInputElement) {
    const duration = Number.isFinite(previewAudio.duration) ? Math.max(0, previewAudio.duration) : 0;
    const current = Number.isFinite(previewAudio.currentTime) ? Math.max(0, previewAudio.currentTime) : 0;
    previewSeek.max = String(duration);
    if (!previewSeek.matches(":active")) previewSeek.value = String(Math.min(current, duration));
    if (previewDuration) previewDuration.textContent = `${App.formatVoiceComposerTime(current * 1000)} / ${App.formatVoiceComposerTime(duration * 1000)}`;
  }
  if (countEl) countEl.textContent = `${App.pendingFiles.length}/${App.CHAT_FILE_MAX_COUNT}`;
};
App.addVoiceMessageFile = async function (file) {
  if (!file) return false;
  const added = await App.addPendingFile(file, {
    isVoiceMessage: true,
    displayName: "Voice Message",
    voiceTrimStartSec: 0
  });
  if (!added) return false;
  App.renderFilesBar();
  App.syncChatOverlayMetrics();
  return true;
};
App.sendVoicePreviewToComposer = async function () {
  if (App.voiceDraftBusy || App.voiceRecorder || App.voiceRecordingStarting) return;
  const file = App.getVoicePreviewFile();
  if (!file) return;
  App.stopVoicePreviewPlayback({
    resetTime: true
  });
  const added = await App.addVoiceMessageFile(file);
  if (!added) return;
  App.clearVoicePreview({
    keepUi: true
  });
  App.syncVoicePopoverUI();
  App.closeVoicePopover({
    keepRecorder: false
  });
};
App.startVoiceRecording = async function () {
  if (!App.canUseVoiceComposer()) return;
  if (App.voiceRecorder || App.voiceDraftBusy || App.voiceRecordingStarting) return;
  if (App.pendingFiles.length >= App.CHAT_FILE_MAX_COUNT) {
    App.showChatFileLimitToast();
    return;
  }
  const requestToken = ++App.voiceRecorderRequestToken;
  if (App.voiceDraftOwner && !App.isVoiceDraftCurrent()) App.clearVoicePreview({ keepUi: true });
  const intro = App.voicePreviewBlob;
  const revision = App.voiceDraftRevision || 0;
  const owner = App.getVoiceDraftOwner();
  App.voiceDraftOwner = owner;
  App.voiceRecordingStarting = true;
  App.syncVoicePopoverUI();
  try {
    App.stopVoicePreviewPlayback({
      resetTime: true
    });
    const stream = await App.ensureVoiceRecorderStream();
    if (requestToken !== App.voiceRecorderRequestToken || !App.isVoiceDraftCurrent(owner) || !App.voicePopoverOpen || !App.canUseVoiceComposer()) {
      try {
        stream.getTracks().forEach(track => track.stop());
      } catch {}
      if (App.voiceRecorderStream === stream) App.voiceRecorderStream = null;
      return;
    }
    App.voiceRecorderStream = stream;
    const mimeType = App.getBestVoiceMimeType();
    App.voiceRecorderChunks = [];
    App.voiceRecordingElapsedBeforePause = 0;
    App.voiceRecordingStartAt = Date.now();
    App.voiceRecordingPaused = false;
    App.voiceRecorderStopMode = "preview";
    const recorder = mimeType ? new MediaRecorder(stream, {
      mimeType
    }) : new MediaRecorder(stream);
    App.voiceRecorder = recorder;
    recorder.addEventListener("dataavailable", e => {
      if (e.data && e.data.size > 0) App.voiceRecorderChunks.push(e.data);
    });
    recorder.addEventListener("stop", async () => {
      const shouldSavePreview = App.voiceRecorderStopMode !== "discard";
      const mime = String(recorder.mimeType || mimeType || "audio/webm");
      const chunks = App.voiceRecorderChunks.slice();
      App.resetVoiceRecorderState({
        keepStream: false
      });
      App.voiceDraftBusy = true;
      App.syncVoicePopoverUI();
      if (shouldSavePreview && chunks.length) {
        try {
          const recording = new Blob(chunks, {
            type: mime
          });
          const result = intro ? await App.joinVoiceSegments([intro, recording]) : recording;
          if (revision === (App.voiceDraftRevision || 0) && App.isVoiceDraftCurrent(owner)) App.setVoicePreview(result);
        } catch (e) {
          console.error("voice preview build failed:", e);
          App.showToast({
            title: "Voice message failed",
            body: e.message || "Couldn’t prepare the preview. Your original clip is still available.",
            duration: 2400
          });
        }
      } else if (!shouldSavePreview) {
        App.clearVoicePreview({
          keepUi: true
        });
      }
      App.voiceDraftBusy = false;
      App.syncVoicePopoverUI();
    });
    recorder.start(250);
    App.syncVoicePreviewMedia();
    App.startVoiceRecordingTimer();
    App.syncVoicePopoverUI();
  } catch (e) {
    if (requestToken !== App.voiceRecorderRequestToken) return;
    console.error("voice recording start failed:", e);
    App.resetVoiceRecorderState({
      keepStream: false
    });
    App.syncVoicePopoverUI();
    App.showToast({
      title: "Microphone unavailable",
      body: "Allow microphone access and try again.",
      duration: 2800
    });
  } finally {
    App.voiceRecordingStarting = false;
    App.syncVoicePopoverUI();
  }
};
App.toggleVoiceRecordingPause = function () {
  if (!App.voiceRecorder) return;
  try {
    if (App.voiceRecorder.state === "recording") {
      App.voiceRecordingElapsedBeforePause = App.getVoiceRecordingElapsedMs();
      try {
        App.voiceRecorder.requestData?.();
      } catch {}
      App.voiceRecordingPaused = true;
      App.voiceRecorder.pause();
    } else if (App.voiceRecorder.state === "paused") {
      App.voiceRecordingStartAt = Date.now();
      App.voiceRecordingPaused = false;
      App.voiceRecorder.resume();
    }
  } catch {}
  App.syncVoicePopoverUI();
};
App.finishVoiceRecording = function ({
  savePreview = true
} = {}) {
  if (!App.voiceRecorder) return;
  App.voiceRecorderStopMode = savePreview ? "preview" : "discard";
  try {
    if (App.voiceRecorder.state !== "inactive") App.voiceRecorder.stop();
  } catch (e) {
    console.error("voice recording stop failed:", e);
    App.resetVoiceRecorderState({
      keepStream: false
    });
    if (!savePreview) App.clearVoicePreview({
      keepUi: true
    });
    App.syncVoicePopoverUI();
    App.showToast({
      title: "Voice message failed",
      body: "Couldn’t finish the recording.",
      duration: 2400
    });
  }
};
App.clearVoiceRecordingDraft = function () {
  if (App.voiceRecordingStarting) App.voiceRecorderRequestToken += 1;
  if (App.voiceRecorder) {
    App.finishVoiceRecording({
      savePreview: false
    });
    return;
  }
  App.clearVoicePreview();
};
App.closeVoicePopover = function ({
  keepRecorder = true
} = {}) {
  const pop = App.$("voice-popover");
  if (!pop) return;
  App.voiceRecorderRequestToken += 1;
  App.$("btn-voice")?.setAttribute("aria-expanded", "false");
  if (pop.hidden) {
    if (!keepRecorder && App.voiceRecorder) App.finishVoiceRecording({
      savePreview: false
    });
    return;
  }
  App.stopVoicePreviewPlayback({
    resetTime: false
  });
  pop.classList.remove("open");
  pop.classList.add("closing");
  const closeToken = ++App.voicePopoverCloseToken;
  const finish = () => {
    if (closeToken !== App.voicePopoverCloseToken) return;
    pop.hidden = true;
    pop.classList.remove("closing");
    App.voicePopoverOpen = false;
  };
  setTimeout(finish, 200);
  if (!keepRecorder && App.voiceRecorder) {
    App.finishVoiceRecording({
      savePreview: false
    });
  }
};
App.bindVoicePopoverOnce = function () {
  if (App.voiceRecorderBound) return;
  App.voiceRecorderBound = true;
  App.voiceUploadInputEl = document.createElement("input");
  App.voiceUploadInputEl.type = "file";
  App.voiceUploadInputEl.accept = "audio/*";
  App.voiceUploadInputEl.hidden = true;
  document.body.appendChild(App.voiceUploadInputEl);
  App.voiceUploadInputEl.addEventListener("change", async () => {
    const file = App.voiceUploadInputEl.files?.[0];
    App.voiceUploadInputEl.value = "";
    if (!file) return;
    await App.importVoiceAudio(file);
  });
  const previewAudio = App.getVoicePreviewAudio();
  if (previewAudio && previewAudio.dataset.bound !== "1") {
    previewAudio.dataset.bound = "1";
    previewAudio.addEventListener("loadedmetadata", App.syncVoicePopoverUI);
    previewAudio.addEventListener("durationchange", App.syncVoicePopoverUI);
    previewAudio.addEventListener("timeupdate", App.syncVoicePopoverUI);
    previewAudio.addEventListener("play", App.syncVoicePopoverUI);
    previewAudio.addEventListener("pause", App.syncVoicePopoverUI);
    previewAudio.addEventListener("ended", App.syncVoicePopoverUI);
  }
  App.$("btn-voice-preview-play")?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    const audio = App.getVoicePreviewAudio();
    if (!audio || !App.voicePreviewBlob) return;
    if (audio.paused || audio.ended) {
      if (audio.ended) audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    App.syncVoicePopoverUI();
  });
  App.$("voice-preview-seek")?.addEventListener("input", e => {
    e.stopPropagation();
    const audio = App.getVoicePreviewAudio();
    if (!audio) return;
    const next = Number(e.currentTarget?.value);
    if (Number.isFinite(next)) audio.currentTime = next;
    App.syncVoicePopoverUI();
  });
  App.$("btn-voice-close")?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    App.closeVoicePopover({
      keepRecorder: false
    });
  });
  App.$("btn-voice-start")?.addEventListener("click", async e => {
    e.preventDefault();
    e.stopPropagation();
    await App.startVoiceRecording();
  });
  App.$("btn-voice-pause")?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    App.toggleVoiceRecordingPause();
  });
  App.$("btn-voice-stop")?.addEventListener("click", async e => {
    e.preventDefault();
    e.stopPropagation();
    if (App.voiceRecorder) {
      App.finishVoiceRecording({
        savePreview: true
      });
      return;
    }
    await App.sendVoicePreviewToComposer();
  });
  App.$("btn-voice-clear")?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    App.clearVoiceRecordingDraft();
  });
  App.$("btn-voice-upload")?.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (App.pendingFiles.length >= App.CHAT_FILE_MAX_COUNT) {
      App.showChatFileLimitToast();
      return;
    }
    App.voiceUploadInputEl?.click();
  });
};
App.openVoicePopover = function () {
  const pop = App.$("voice-popover");
  if (!pop) return;
  App.closeRoomActivitiesMenu?.();
  App.closeEmojiPopover?.();
  App.closeStickerPopover?.({ immediate:true });
  App.closeComposerMoreMenu?.({ immediate:true });
  App.bindVoicePopoverOnce();
  App.voicePopoverCloseToken += 1;
  App.syncVoicePreviewMedia();
  pop.hidden = false;
  pop.classList.remove("closing");
  requestAnimationFrame(() => pop.classList.add("open"));
  App.voicePopoverOpen = true;
  App.layoutChatPopovers?.();
  App.$("btn-voice")?.setAttribute("aria-expanded", "true");
  App.syncVoicePopoverUI();
};
App.toggleVoicePopover = function () {
  if (!App.canUseVoiceComposer()) {
    App.showToast({
      title: "Pick a room",
      body: "Create or join a room first.",
      duration: 2200
    });
    return;
  }
  if (App.voicePopoverOpen) App.closeVoicePopover({
    keepRecorder: false
  });else App.openVoicePopover();
};

App.register("media/voice-recorder", function initializeFeature() {
App.voicePopoverOpen = false;
App.voicePopoverCloseToken = 0;
App.voiceRecorderRequestToken = 0;
App.voiceDraftOwner = null;
App.voiceDraftRevision = 0;
App.voiceDraftBusy = false;
App.voiceRecordingStarting = false;
App.voiceRecorderBound = false;
App.voiceRecorder = null;
App.voiceRecorderStream = null;
App.voiceRecorderChunks = [];
App.voiceRecordingStartAt = 0;
App.voiceRecordingElapsedBeforePause = 0;
App.voiceRecordingTimer = 0;
App.voiceRecordingPaused = false;
App.voiceUploadInputEl = null;
App.voicePreviewBlob = null;
App.voicePreviewMimeType = "";
App.voicePreviewFile = null;
App.voicePreviewUrl = "";
App.voiceRecorderStopMode = "preview";
App.syncEmojiButtonVisibility();
});
})(globalThis.ChatApp);
