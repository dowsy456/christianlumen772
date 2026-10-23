/* stickers/editor: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.waitForMediaEvent = function (media, eventName, timeoutMs = 12000, signal = null) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener(eventName, onReady);
      media.removeEventListener("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onReady = () => {
      cleanup();
      resolve(media);
    };
    const onError = () => {
      cleanup();
      reject(new Error("That media file could not be decoded."));
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Sticker creation was cancelled.", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    media.addEventListener(eventName, onReady, {
      once: true
    });
    media.addEventListener("error", onError, {
      once: true
    });
    signal?.addEventListener?.("abort", onAbort, {
      once: true
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("The media file took too long to load."));
    }, timeoutMs);
  });
};
App.seekStickerVideo = function (video, time) {
  const target = Math.max(0, Math.min(Number(video.duration) || 0, Number(time) || 0));
  if (Math.abs((Number(video.currentTime) || 0) - target) < 0.018) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = 0;
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", fail);
    };
    const done = () => {
      finish();
      resolve();
    };
    const fail = () => {
      finish();
      reject(new Error("Could not seek through that video."));
    };
    video.addEventListener("seeked", done, {
      once: true
    });
    video.addEventListener("error", fail, {
      once: true
    });
    timer = setTimeout(done, 5000);
    try {
      video.currentTime = target;
    } catch (error) {
      finish();
      reject(error);
    }
  });
};
App.clampStickerCrop = function (state, sourceWidth, sourceHeight) {
  const sw = Math.max(1, Number(sourceWidth) || 1);
  const sh = Math.max(1, Number(sourceHeight) || 1);
  const zoom = Math.max(0.5, Math.min(4, Number(state.zoom) || 1));
  const scale = Math.max(App.STICKER_OUTPUT_SIZE / sw, App.STICKER_OUTPUT_SIZE / sh) * zoom;
  const maxX = Math.max(0, (sw * scale - App.STICKER_OUTPUT_SIZE) / 2);
  const maxY = Math.max(0, (sh * scale - App.STICKER_OUTPUT_SIZE) / 2);
  state.zoom = zoom;
  state.panX = Math.max(-maxX, Math.min(maxX, Number(state.panX) || 0));
  state.panY = Math.max(-maxY, Math.min(maxY, Number(state.panY) || 0));
  return {
    sw,
    sh,
    scale,
    maxX,
    maxY
  };
};
App.drawStickerCrop = function (canvas, media, state) {
  if (!canvas || !media) return;
  const sw = Number(media.videoWidth || media.naturalWidth || media.width || 0);
  const sh = Number(media.videoHeight || media.naturalHeight || media.height || 0);
  if (!sw || !sh) return;
  const crop = App.clampStickerCrop(state, sw, sh);
  const width = sw * crop.scale;
  const height = sh * crop.scale;
  const x = (App.STICKER_OUTPUT_SIZE - width) / 2 + state.panX;
  const y = (App.STICKER_OUTPUT_SIZE - height) / 2 + state.panY;
  const ctx = canvas.getContext("2d", {
    alpha: true,
    desynchronized: true
  });
  if (!ctx) return;
  ctx.clearRect(0, 0, App.STICKER_OUTPUT_SIZE, App.STICKER_OUTPUT_SIZE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(media, x, y, width, height);
  } catch {}
};
App.canvasToStickerBlob = function (canvas) {
  return new Promise((resolve, reject) => {
    const done = blob => {
      if (blob) resolve(blob);else reject(new Error("Could not create the sticker image."));
    };
    try {
      canvas.toBlob(webp => {
        if (webp) done(webp);else canvas.toBlob(done, "image/png");
      }, "image/webp", 0.9);
    } catch (error) {
      reject(error);
    }
  });
};
App.supportedStickerVideoMimeType = function () {
  if (typeof MediaRecorder !== "function") return "";
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return candidates.find(type => {
    try {
      return !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || "";
};
App.exportAnimatedSticker = async function (video, canvas, state, drawFrame) {
  const mimeType = App.supportedStickerVideoMimeType();
  if (!mimeType || typeof canvas.captureStream !== "function") {
    throw new Error("Animated sticker creation is not supported by this browser.");
  }
  const start = Math.max(0, Number(state.start) || 0);
  const end = Math.min(Number(video.duration) || 0, Number(state.end) || 0);
  const duration = end - start;
  if (!(duration > 0 && duration <= App.STICKER_MAX_VIDEO_SECONDS + 0.001)) {
    throw new Error("Choose a video clip between 0 and 5 seconds long.");
  }
  try {
    video.pause();
  } catch {}
  await App.seekStickerVideo(video, start);
  drawFrame();
  const chunks = [];
  const stream = canvas.captureStream(30);
  let recorder = null;
  let raf = 0;
  let safety = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    try {
      video.pause();
    } catch {}
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {}
    try {
      stream.getTracks().forEach(track => track.stop());
    } catch {}
  };
  try {
    try {
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 1400000
      });
    } catch {
      recorder = new MediaRecorder(stream, {
        mimeType
      });
    }
    recorder.addEventListener("dataavailable", event => {
      if (event.data?.size) chunks.push(event.data);
    });
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", resolve, {
        once: true
      });
      recorder.addEventListener("error", () => reject(new Error("Could not encode the animated sticker.")), {
        once: true
      });
    });
    recorder.start(120);
    video.muted = true;
    video.playbackRate = 1;
    await video.play().catch(() => {
      throw new Error("The selected video could not be played.");
    });
    const startedAt = performance.now();
    const paint = now => {
      drawFrame();
      if (now - startedAt >= duration * 1000 || Number(video.currentTime) >= end - 0.012) {
        stop();
        return;
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    safety = setTimeout(stop, Math.ceil(duration * 1000) + 900);
    await stopped;
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(safety);
    if (!done) stop();
  }
  if (!chunks.length) throw new Error("The browser did not produce an animated sticker.");
  return new Blob(chunks, {
    type: recorder?.mimeType || mimeType
  });
};
App.publishStickerBlob = async function (blob, details) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("The sticker output is empty.");
  if (blob.size > App.STICKER_MAX_OUTPUT_BYTES) throw new Error("The finished sticker is too large. Try a shorter clip.");
  const code = String(App.currentUser?.code || "").trim();
  const username = String(App.currentUser?.username || "").trim();
  const name = App.cleanStickerName(details?.name);
  if (!code || !username) throw new Error("Sign in before creating a sticker.");
  if (!name) throw new Error("Give your sticker a name.");
  const kind = details?.kind === "video" ? "video" : "image";
  const metaRef = App.db.ref(App.STICKER_META_PATH).push();
  const id = String(metaRef.key || "");
  if (!id) throw new Error("Could not reserve a sticker id.");
  const assetRef = App.db.ref(`${App.STICKER_ASSET_PATH}/${id}`);
  const cleanup = async () => {
    try {
      await App.db.ref().update({
        [`${App.STICKER_META_PATH}/${id}`]: null,
        [`${App.STICKER_ASSET_PATH}/${id}`]: null,
        [`${App.STICKER_OWNER_PATH}/${code}/${id}`]: null,
        [`${App.STICKER_COLLECTION_PATH}/${code}/${id}`]: null,
        [`${App.STICKER_SAVERS_PATH}/${id}/${code}`]: null
      });
    } catch {}
  };
  const scope = App.createFirebaseUploadScope({
    type: "sticker",
    place: `account:${code}`,
    disconnectRefs: [],
    cleanup
  });
  const disconnectCleanup = App.db.ref().onDisconnect();
  const disconnectFanout = {
    [`${App.STICKER_META_PATH}/${id}`]: null,
    [`${App.STICKER_ASSET_PATH}/${id}`]: null,
    [`${App.STICKER_OWNER_PATH}/${code}/${id}`]: null,
    [`${App.STICKER_COLLECTION_PATH}/${code}/${id}`]: null,
    [`${App.STICKER_SAVERS_PATH}/${id}/${code}`]: null
  };
  const cancelStickerDisconnectCleanup = async () => {
    // Cancelling the root operation also cancels presence and other uploads.
    // Preserve the bytes first, then cancel only this sticker's indexed paths.
    const paths = [
      `${App.STICKER_ASSET_PATH}/${id}`,
      ...Object.keys(disconnectFanout).filter(path => path !== `${App.STICKER_ASSET_PATH}/${id}`)
    ];
    for (const path of paths) await App.db.ref(path).onDisconnect().cancel();
  };
  try {
    // A single root-level onDisconnect update keeps every sticker index and
    // asset in one atomic cleanup operation if the connection disappears.
    await disconnectCleanup.update(disconnectFanout);
    const estimatedChunks = App.countDataURLChunksForBlob(blob);
    await metaRef.set({
      schemaVersion: 1,
      name,
      nameLower: name.toLowerCase(),
      kind,
      mimeType: String(blob.type || details?.mimeType || (kind === "video" ? "video/webm" : "image/webp")),
      creatorCode: code,
      creatorUsername: username,
      createdAt: App.firebase.database.ServerValue.TIMESTAMP,
      byteSize: blob.size,
      width: App.STICKER_OUTPUT_SIZE,
      height: App.STICKER_OUTPUT_SIZE,
      durationMs: kind === "video" ? Math.round(Math.max(0, Number(details?.durationSeconds) || 0) * 1000) : 0,
      state: "pending"
    });
    await assetRef.set({
      dataURL: "",
      dataChunkCount: estimatedChunks,
      uploadPending: 1
    });
    const chunkCount = await App.writeBlobDataURLToRef(assetRef, "dataURL", blob, {
      signal: scope.signal,
      onProgress: progress => {
        const status = App.$("sticker-editor-status");
        const button = App.$("btn-sticker-create");
        const text = `Saving ${App.formatUploadPercentText(progress)}`;
        if (status) status.textContent = text;
        if (button) button.textContent = text;
      }
    });
    App.throwIfUploadAborted(scope.signal);
    // The creator already owns these bytes; reuse them when the ready metadata
    // arrives instead of downloading the newly uploaded sticker immediately.
    App.evictStickerAsset(id);
    App.stickerAssetCache.set(id, {
      url: URL.createObjectURL(blob), byteSize: blob.size,
      dataChunkCount: chunkCount, touchedAt: Date.now()
    });
    App.enforceStickerAssetCacheBudget(id);
    const stamp = App.firebase.database.ServerValue.TIMESTAMP;
    await App.db.ref().update({
      [`${App.STICKER_ASSET_PATH}/${id}/dataChunkCount`]: chunkCount,
      [`${App.STICKER_ASSET_PATH}/${id}/uploadPending`]: null,
      [`${App.STICKER_META_PATH}/${id}/state`]: "ready",
      [`${App.STICKER_OWNER_PATH}/${code}/${id}`]: true,
      [`${App.STICKER_COLLECTION_PATH}/${code}/${id}`]: {
        savedAt: stamp
      },
      [`${App.STICKER_SAVERS_PATH}/${id}/${code}`]: true
    });
    await cancelStickerDisconnectCleanup();
    await App.finishFirebaseUploadScope(scope);
    return {
      id,
      name,
      kind
    };
  } catch (error) {
    App.evictStickerAsset(id);
    await App.cleanupFirebaseUploadScope(scope, error?.message || "sticker upload failed");
    try {
      await cancelStickerDisconnectCleanup();
    } catch {}
    throw error;
  }
};
App.openStickerEditor = async function (source = {}) {
  if (!App.currentUser) {
    App.showToast({
      title: "Sign In Required",
      body: "Sign in before creating a sticker.",
      duration: 2200
    });
    return;
  }
  const launchId = ++App.stickerEditorLaunchSeq;
  const launchController = new AbortController();
  let launchCancelled = false;
  const cancelPreparing = () => {
    launchCancelled = true;
    try {
      launchController.abort();
    } catch {}
  };
  App.closeStickerPopover({
    immediate: true
  });
  App.openModal({
    title: "Create Sticker",
    size: "sticker-editor-loading",
    bodyHTML: '<div class="sticker-editor-loading"><span class="sticker-message-placeholder" aria-hidden="true"></span><span>Preparing sticker editor…</span></div>',
    onBeforeClose: cancelPreparing
  });
  let blob = source.file instanceof Blob ? source.file : null;
  try {
    if (!blob) {
      const raw = String(source.dataURL || "").trim();
      if (!raw) throw new Error("Choose a photo or video first.");
      const response = await fetch(raw, {
        signal: launchController.signal
      });
      blob = await response.blob();
    }
    if (launchCancelled || launchId !== App.stickerEditorLaunchSeq) return;
    if (!(blob instanceof Blob) || !blob.size) throw new Error("That file is empty.");
    if (blob.size > App.STICKER_MAX_SOURCE_BYTES) throw new Error("Sticker source files must be 50 MB or smaller.");
  } catch (error) {
    if (launchCancelled || launchController.signal.aborted || launchId !== App.stickerEditorLaunchSeq) return;
    App.closeModal();
    App.showToast({
      title: "Sticker Failed",
      body: String(error?.message || "Could not read that file."),
      duration: 2800
    });
    return;
  }
  const mime = String(blob.type || source.mimeType || "").toLowerCase();
  const gifSignature = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
  const isAnimatedGif = String.fromCharCode(...gifSignature) === "GIF89a" || String.fromCharCode(...gifSignature) === "GIF87a";
  const hintedKind = String(source.kind || "").toLowerCase();
  const kind = mime.startsWith("video/") || hintedKind === "video" ? "video" : mime.startsWith("image/") || hintedKind === "image" || isAnimatedGif ? "image" : "";
  if (!kind) {
    App.closeModal();
    App.showToast({
      title: "Unsupported File",
      body: "Choose a photo or video file.",
      duration: 2500
    });
    return;
  }
  const sourceURL = URL.createObjectURL(blob);
  const media = kind === "video" ? document.createElement("video") : new Image();
  let editorRaf = 0;
  let editorClosed = false;
  try {
    if (kind === "video") {
      media.src = sourceURL;
      media.preload = "auto";
      media.muted = true;
      media.defaultMuted = true;
      media.playsInline = true;
      await App.waitForMediaEvent(media, "loadedmetadata", 15000, launchController.signal);
      if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error("That video has no playable duration.");
    } else {
      media.src = sourceURL;
      if (!media.complete || !media.naturalWidth) await App.waitForMediaEvent(media, "load", 15000, launchController.signal);
      if (!media.naturalWidth || !media.naturalHeight) throw new Error("That image could not be decoded.");
    }
  } catch (error) {
    try {
      URL.revokeObjectURL(sourceURL);
    } catch {}
    if (launchCancelled || launchController.signal.aborted || launchId !== App.stickerEditorLaunchSeq) return;
    App.closeModal();
    App.showToast({
      title: "Sticker Failed",
      body: String(error?.message || "Could not open that media."),
      duration: 2800
    });
    return;
  }
  const preparingIsCurrent = !launchCancelled && launchId === App.stickerEditorLaunchSeq && !App.modalEl.hidden && App.modalEl.dataset.size === "sticker-editor-loading" && App.modalBeforeClose === cancelPreparing;
  if (!preparingIsCurrent) {
    try {
      media.pause?.();
    } catch {}
    try {
      media.removeAttribute?.("src");
      media.load?.();
    } catch {}
    try {
      URL.revokeObjectURL(sourceURL);
    } catch {}
    return;
  }
  // Promote the loading shell into the editor without treating that internal
  // replacement as a user cancellation.
  App.modalBeforeClose = null;
  const duration = kind === "video" ? Number(media.duration) : 0;
  const defaultName = App.cleanStickerName(String(source.fileName || "").replace(/\.[^.]+$/, "")) || "New Sticker";
  const state = {
    zoom: 1,
    panX: 0,
    panY: 0,
    start: 0,
    end: kind === "video" ? Math.min(App.STICKER_MAX_VIDEO_SECONDS, duration) : 0
  };
  const cleanupEditor = () => {
    if (editorClosed) return;
    editorClosed = true;
    if (editorRaf) cancelAnimationFrame(editorRaf);
    try {
      media.pause?.();
    } catch {}
    try {
      media.removeAttribute?.("src");
      media.load?.();
    } catch {}
    try {
      URL.revokeObjectURL(sourceURL);
    } catch {}
  };
  App.openModal({
    title: "Create Sticker",
    subtitle: kind === "video" ? "Crop and select up to 5 seconds" : "Crop and choose the visible area",
    size: "sticker-editor",
    bodyHTML: `
      <div class="sticker-editor${isAnimatedGif ? " sticker-editor-gif" : ""}">
        <div class="sticker-editor-stage-wrap">
          <canvas class="sticker-editor-canvas" id="sticker-editor-canvas" width="${App.STICKER_OUTPUT_SIZE}" height="${App.STICKER_OUTPUT_SIZE}" aria-label="Sticker crop preview"></canvas>
          ${isAnimatedGif ? `<img class="sticker-editor-gif-preview" src="${App.escapeHtml(sourceURL)}" alt="Animated Sticker Preview" />` : ""}
          <div class="sticker-editor-drag-hint">Drag to reposition</div>
        </div>
        <div class="sticker-editor-controls">
          <label class="sticker-editor-field sticker-editor-name-field"><span>Name</span><span class="sticker-name-count" id="sticker-name-count">${Array.from(defaultName).length}/20</span><input class="input" id="sticker-name" value="${App.escapeHtml(defaultName)}" autocomplete="off" /></label>
          <label class="sticker-editor-field"><span>Zoom <output id="sticker-zoom-value">100%</output></span><input id="sticker-zoom" type="range" min="0.5" max="4" step="0.01" value="1" /></label>
          ${kind === "video" ? `
            <div class="sticker-clip-controls">
              <label class="sticker-editor-field"><span>Start <output id="sticker-start-value">0.00s</output></span><input id="sticker-start" type="range" min="0" max="${Math.max(0, duration - 0.1)}" step="0.05" value="0" /></label>
              <label class="sticker-editor-field"><span>End <output id="sticker-end-value">${state.end.toFixed(2)}s</output></span><input id="sticker-end" type="range" min="0.1" max="${duration}" step="0.05" value="${state.end}" /></label>
              <div class="sticker-clip-length" id="sticker-clip-length">Clip: ${(state.end - state.start).toFixed(2)}s / 5.00s maximum</div>
            </div>
          ` : ""}
          <div class="sticker-editor-status" id="sticker-editor-status" aria-live="polite">${isAnimatedGif ? "GIF animation and the full image are preserved in your sticker." : kind === "video" ? "Animated stickers loop automatically and are saved without sound." : "The crop is baked into a consistent sticker size."}</div>
        </div>
      </div>
    `,
    actionsHTML: '<button class="btn primary" id="btn-sticker-create" type="button">Create Sticker</button>',
    onBeforeClose: cleanupEditor
  });
  const canvas = App.$("sticker-editor-canvas");
  const zoom = App.$("sticker-zoom");
  const start = App.$("sticker-start");
  const end = App.$("sticker-end");
  const nameInput = App.$("sticker-name");
  const draw = () => App.drawStickerCrop(canvas, media, state);
  const sourceWidth = () => Number(media.videoWidth || media.naturalWidth || 1);
  const sourceHeight = () => Number(media.videoHeight || media.naturalHeight || 1);
  draw();
  if (kind === "video") {
    await App.seekStickerVideo(media, state.start).catch(() => {});
    media.play().catch(() => {});
    const loopPreview = () => {
      if (editorClosed || !canvas?.isConnected) return;
      if (Number(media.currentTime) >= state.end - 0.012 || Number(media.currentTime) < state.start - 0.012) {
        try {
          media.currentTime = state.start;
        } catch {}
      }
      draw();
      editorRaf = requestAnimationFrame(loopPreview);
    };
    editorRaf = requestAnimationFrame(loopPreview);
  }
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  canvas?.addEventListener("pointerdown", event => {
    if (event.button != null && event.button !== 0 && event.pointerType !== "touch") return;
    dragging = true;
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add("is-dragging");
    try {
      canvas.setPointerCapture(pointerId);
    } catch {}
    event.preventDefault();
  });
  canvas?.addEventListener("pointermove", event => {
    if (!dragging || event.pointerId !== pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = App.STICKER_OUTPUT_SIZE / Math.max(1, rect.width);
    state.panX += (event.clientX - lastX) * ratio;
    state.panY += (event.clientY - lastY) * ratio;
    lastX = event.clientX;
    lastY = event.clientY;
    App.clampStickerCrop(state, sourceWidth(), sourceHeight());
    draw();
  });
  const stopDrag = event => {
    if (!dragging || event?.pointerId != null && event.pointerId !== pointerId) return;
    dragging = false;
    canvas?.classList.remove("is-dragging");
    try {
      canvas?.releasePointerCapture?.(pointerId);
    } catch {}
    pointerId = null;
  };
  canvas?.addEventListener("pointerup", stopDrag);
  canvas?.addEventListener("pointercancel", stopDrag);
  zoom?.addEventListener("input", () => {
    state.zoom = Math.max(0.5, Math.min(4, Number(zoom.value) || 1));
    App.clampStickerCrop(state, sourceWidth(), sourceHeight());
    const output = App.$("sticker-zoom-value");
    if (output) output.textContent = `${Math.round(state.zoom * 100)}%`;
    draw();
  });
  nameInput?.addEventListener("input", () => {
    const chars = Array.from(nameInput.value || "").slice(0, 20);
    if (chars.join("") !== nameInput.value) nameInput.value = chars.join("");
    const count = App.$("sticker-name-count");
    if (count) count.textContent = `${chars.length}/20`;
  });
  const syncClipControls = changed => {
    if (kind !== "video") return;
    let nextStart = Math.max(0, Math.min(Math.max(0, duration - 0.1), Number(start?.value) || 0));
    let nextEnd = Math.max(0.1, Math.min(duration, Number(end?.value) || state.end));
    if (changed === "start") {
      if (nextEnd <= nextStart + 0.099) nextEnd = Math.min(duration, nextStart + Math.min(App.STICKER_MAX_VIDEO_SECONDS, Math.max(0.1, duration - nextStart)));
      if (nextEnd - nextStart > App.STICKER_MAX_VIDEO_SECONDS) nextEnd = nextStart + App.STICKER_MAX_VIDEO_SECONDS;
    } else {
      if (nextEnd <= nextStart + 0.099) nextStart = Math.max(0, nextEnd - 0.1);
      if (nextEnd - nextStart > App.STICKER_MAX_VIDEO_SECONDS) nextStart = nextEnd - App.STICKER_MAX_VIDEO_SECONDS;
    }
    state.start = Math.max(0, nextStart);
    state.end = Math.min(duration, Math.max(state.start + 0.1, nextEnd));
    if (start) start.value = String(state.start);
    if (end) end.value = String(state.end);
    if (App.$("sticker-start-value")) App.$("sticker-start-value").textContent = `${state.start.toFixed(2)}s`;
    if (App.$("sticker-end-value")) App.$("sticker-end-value").textContent = `${state.end.toFixed(2)}s`;
    if (App.$("sticker-clip-length")) App.$("sticker-clip-length").textContent = `Clip: ${(state.end - state.start).toFixed(2)}s / 5.00s maximum`;
    try {
      media.currentTime = state.start;
    } catch {}
    media.play().catch(() => {});
  };
  start?.addEventListener("input", () => syncClipControls("start"));
  end?.addEventListener("input", () => syncClipControls("end"));
  App.$("btn-sticker-create")?.addEventListener("click", async () => {
    const createButton = App.$("btn-sticker-create");
    const name = App.cleanStickerName(nameInput?.value || "");
    if (!name) {
      App.showToast({
        title: "Name Required",
        body: "Enter a sticker name up to 20 characters.",
        duration: 2300
      });
      try {
        nameInput?.focus?.();
      } catch {}
      return;
    }
    App.modalEl.dataset.busy = "1";
    App.modalEl.setAttribute("aria-busy", "true");
    if (createButton) createButton.disabled = true;
    try {
      let outputBlob;
      if (isAnimatedGif) {
        // A canvas image export flattens a GIF to its first frame. Preserve the
        // original compressed stream, timing, transparency and loop metadata.
        outputBlob = blob.type === "image/gif" ? blob : blob.slice(0, blob.size, "image/gif");
      } else if (kind === "video") {
        if (editorRaf) cancelAnimationFrame(editorRaf);
        editorRaf = 0;
        outputBlob = await App.exportAnimatedSticker(media, canvas, state, draw);
      } else {
        draw();
        outputBlob = await App.canvasToStickerBlob(canvas);
      }
      await App.publishStickerBlob(outputBlob, {
        name,
        kind,
        mimeType: outputBlob.type,
        durationSeconds: kind === "video" ? state.end - state.start : 0
      });
      delete App.modalEl.dataset.busy;
      App.modalEl.setAttribute("aria-busy", "false");
      App.ensureStickerCollectionListener();
      App.closeModal();
      App.showToast({
        title: "Sticker Created",
        body: `${name} is now in your sticker collection.`,
        duration: 2600
      });
    } catch (error) {
      delete App.modalEl.dataset.busy;
      App.modalEl.setAttribute("aria-busy", "false");
      if (createButton) {
        createButton.disabled = false;
        createButton.textContent = "Create Sticker";
      }
      const status = App.$("sticker-editor-status");
      if (status) status.textContent = String(error?.message || "Sticker creation failed.");
      App.showToast({
        title: "Sticker Failed",
        body: String(error?.message || "Could not create that sticker."),
        duration: 3200
      });
      if (kind === "video" && !editorClosed) {
        await App.seekStickerVideo(media, state.start).catch(() => {});
        media.play().catch(() => {});
        const resume = () => {
          if (editorClosed || !canvas?.isConnected) return;
          if (Number(media.currentTime) >= state.end - 0.012) try {
            media.currentTime = state.start;
          } catch {}
          draw();
          editorRaf = requestAnimationFrame(resume);
        };
        editorRaf = requestAnimationFrame(resume);
      }
    }
  });
};
App.teardownStickerRuntime = function () {
  App.stickerRuntimeEpoch += 1;
  App.stickerPrewarmBusy = false;
  if (App.stickerMenuRenderFrame) cancelAnimationFrame(App.stickerMenuRenderFrame);
  App.stickerMenuRenderFrame = 0;
  App.closeStickerPopover({
    immediate: true
  });
  App.stopStickerCollectionListener();
  App.stickerMetaChannels.forEach(channel => {
    try {
      channel.ref.off("value", channel.bound);
    } catch {}
  });
  App.stickerMetaChannels.clear();
  try {
    App.stickerVideoObserver?.disconnect?.();
  } catch {}
  App.stickerVideoObserver = null;
  try {
    App.stickerTileLoadObserver?.disconnect?.();
  } catch {}
  App.stickerTileLoadObserver = null;
  try {
    App.stickerMessageLoadObserver?.disconnect?.();
  } catch {}
  App.stickerMessageLoadObserver = null;
  Array.from(App.stickerAssetCache.keys()).forEach(App.evictStickerAsset);
};

App.register("stickers/editor", function initializeFeature() {
App.$("btn-stickers")?.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  App.toggleStickerPopover();
});
for (const type of ["pointerenter", "focus", "pointerdown"]) {
  App.$("btn-stickers")?.addEventListener(type, App.prepareStickerPicker, { passive: true });
}
App.$("sticker-search")?.addEventListener("input", App.queueStickerMenuRender);
App.$("btn-sticker-upload")?.addEventListener("click", () => App.$("sticker-file-input")?.click());
App.$("sticker-file-input")?.addEventListener("change", event => {
  const file = event.currentTarget?.files?.[0] || null;
  event.currentTarget.value = "";
  if (file) void App.openStickerEditor({
    file,
    fileName: file.name,
    mimeType: file.type
  });
});
document.addEventListener("pointerdown", event => {
  const contextMenu = App.$("sticker-context-menu");
  if (contextMenu && !contextMenu.hidden && !contextMenu.contains(event.target)) App.closeStickerContextMenu();
  if (!App.stickerPopoverOpen) return;
  const popover = App.$("sticker-popover");
  const button = App.$("btn-stickers");
  if (!popover?.contains(event.target) && !button?.contains(event.target) && !contextMenu?.contains(event.target)) App.closeStickerPopover();
}, true);
document.addEventListener("keydown", event => {
  const contextMenu = App.$("sticker-context-menu");
  if (contextMenu && !contextMenu.hidden && contextMenu.classList.contains("open")) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      App.closeStickerContextMenu(false, true);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const items = Array.from(contextMenu.querySelectorAll('[role="menuitem"]'));
      const current = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab") App.closeStickerContextMenu(true, true);
  }
  if (event.key === "Escape" && App.stickerPopoverOpen) {
    event.preventDefault();
    event.stopPropagation();
    App.closeStickerPopover();
    try {
      App.$("btn-stickers")?.focus?.({
        preventScroll: true
      });
    } catch {}
  }
}, true);
document.addEventListener("contextmenu", event => {
  const menu = App.$("sticker-context-menu");
  if (menu && !menu.hidden && !menu.contains(event.target)) App.closeStickerContextMenu();
}, true);
document.addEventListener("scroll", event => {
  const menu = App.$("sticker-context-menu");
  if (menu && !menu.hidden && !menu.contains(event.target)) App.closeStickerContextMenu();
}, { capture: true, passive: true });
window.addEventListener("blur", () => App.closeStickerContextMenu(true));
window.addEventListener("resize", () => App.closeStickerContextMenu(true));
window.visualViewport?.addEventListener("resize", () => App.closeStickerContextMenu(true));
window.addEventListener("pagehide", App.teardownStickerRuntime);
window.addEventListener("online", () => {
  App.queueStickerMenuRender();
  document.querySelectorAll(".sticker-message.is-unavailable").forEach(button => {
    try {
      button.__retrySticker?.();
    } catch {}
  });
});
});
})(globalThis.ChatApp);
