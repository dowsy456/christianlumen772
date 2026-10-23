/* stickers/library: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.cleanStickerName = function (value) {
  return Array.from(String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ")).slice(0, 20).join("");
};
App.normalizeStickerMessageReference = function (msg) {
  if (!msg || typeof msg !== "object") return null;
  const snap = msg.sticker && typeof msg.sticker === "object" ? msg.sticker : {};
  const id = String(snap.id || msg.stickerId || "").trim();
  if (!id) return null;
  return {
    id,
    name: App.cleanStickerName(snap.name || "Sticker") || "Sticker",
    kind: String(snap.kind || "image") === "video" ? "video" : "image",
    mimeType: String(snap.mimeType || ""),
    creatorCode: String(snap.creatorCode || ""),
    creatorUsername: String(snap.creatorUsername || "Unknown")
  };
};
App.normalizeStickerMeta = function (id, value) {
  if (!value || typeof value !== "object") return null;
  const name = App.cleanStickerName(value.name);
  const kind = String(value.kind || "") === "video" ? "video" : String(value.kind || "") === "image" ? "image" : "";
  if (!id || !name || !kind) return null;
  return {
    id: String(id),
    schemaVersion: Math.max(1, Number(value.schemaVersion) || 1),
    name,
    nameLower: String(value.nameLower || name.toLowerCase()),
    kind,
    mimeType: String(value.mimeType || (kind === "video" ? "video/webm" : "image/webp")),
    creatorCode: String(value.creatorCode || ""),
    creatorUsername: String(value.creatorUsername || "Unknown"),
    createdAt: Number(value.createdAt || 0),
    byteSize: Math.max(0, Number(value.byteSize) || 0),
    width: Math.max(1, Number(value.width) || App.STICKER_OUTPUT_SIZE),
    height: Math.max(1, Number(value.height) || App.STICKER_OUTPUT_SIZE),
    durationMs: Math.max(0, Math.min(App.STICKER_MAX_VIDEO_SECONDS * 1000, Number(value.durationMs) || 0)),
    state: String(value.state || "pending")
  };
};
App.normalizeStickerAsset = function (value) {
  if (!value || typeof value !== "object") return null;
  const expected = Math.max(1, Number(value.dataChunkCount) || 1);
  if (!App.hasAllChunkedFieldParts(value, "dataURL", expected)) return null;
  const dataURL = App.readChunkedField(value, "dataURL");
  if (!dataURL || Number(value.uploadPending || 0) > 0) return null;
  return {
    dataURL,
    dataChunkCount: expected
  };
};
App.watchStickerMeta = function (stickerId, callback) {
  const id = String(stickerId || "").trim();
  if (!id || typeof callback !== "function") return () => {};
  let channel = App.stickerMetaChannels.get(id);
  if (!channel) {
    const ref = App.db.ref(`${App.STICKER_META_PATH}/${id}`);
    channel = {
      ref,
      callbacks: new Set(),
      value: undefined,
      bound: null
    };
    channel.bound = snap => {
      const meta = App.normalizeStickerMeta(id, snap.val());
      channel.value = meta;
      if (!meta) App.evictStickerAsset(id);
      channel.callbacks.forEach(fn => {
        try {
          fn(meta);
        } catch {}
      });
    };
    ref.on("value", channel.bound);
    App.stickerMetaChannels.set(id, channel);
  }
  channel.callbacks.add(callback);
  if (channel.value !== undefined) queueMicrotask(() => {
    if (channel.callbacks.has(callback)) callback(channel.value);
  });
  return () => {
    const current = App.stickerMetaChannels.get(id);
    if (!current) return;
    current.callbacks.delete(callback);
    if (!current.callbacks.size) {
      try {
        current.ref.off("value", current.bound);
      } catch {}
      App.stickerMetaChannels.delete(id);
    }
  };
};
App.evictStickerAsset = function (stickerId) {
  const id = String(stickerId || "");
  const cached = App.stickerAssetCache.get(id);
  if (cached?.url && String(cached.url).startsWith("blob:")) {
    try {
      URL.revokeObjectURL(cached.url);
    } catch {}
  }
  App.stickerAssetCache.delete(id);
};
App.stickerAssetUrlIsMounted = function (url) {
  const want = String(url || "");
  if (!want) return false;
  return Array.from(document.querySelectorAll(".sticker-message img,.sticker-message video,.sticker-tile img,.sticker-tile video,.sticker-media-viewer img,.sticker-media-viewer video")).some(media => String(media.currentSrc || media.src || "") === want);
};
App.enforceStickerAssetCacheBudget = function (exemptId = "") {
  const readyEntries = Array.from(App.stickerAssetCache.entries()).filter(([, entry]) => entry?.url).sort((a, b) => Number(a[1].touchedAt || 0) - Number(b[1].touchedAt || 0));
  let totalBytes = readyEntries.reduce((sum, [, entry]) => sum + Math.max(0, Number(entry.byteSize || 0)), 0);
  let totalItems = readyEntries.length;
  for (const [id, entry] of readyEntries) {
    if (totalItems <= 36 && totalBytes <= 48 * 1024 * 1024) break;
    if (id === exemptId || App.stickerAssetUrlIsMounted(entry.url)) continue;
    totalBytes -= Math.max(0, Number(entry.byteSize || 0));
    totalItems -= 1;
    App.evictStickerAsset(id);
  }
};
App.runStickerAssetLoad = async function (load) {
  if (App.stickerAssetLoadCount >= 2) await new Promise(resolve => App.stickerAssetLoadQueue.push(resolve));
  else App.stickerAssetLoadCount++;
  try { return await load(); }
  finally {
    const next = App.stickerAssetLoadQueue.shift();
    if (next) next(); else App.stickerAssetLoadCount--;
  }
};
App.loadStickerAsset = async function (meta) {
  const id = String(meta?.id || "");
  if (!id) throw new Error("Sticker is missing an id.");
  const cached = App.stickerAssetCache.get(id);
  if (cached?.url) {
    cached.touchedAt = Date.now();
    return cached;
  }
  if (cached?.promise) return cached.promise;
  const runtimeEpoch = App.stickerRuntimeEpoch;
  const slot = {
    promise: null
  };
  const promise = App.runStickerAssetLoad(async () => {
    if (runtimeEpoch !== App.stickerRuntimeEpoch) throw new DOMException("Sticker loading was cancelled.", "AbortError");
    const snap = await App.db.ref(`${App.STICKER_ASSET_PATH}/${id}`).once("value");
    const asset = App.normalizeStickerAsset(snap.val());
    if (!asset) throw new Error("Sticker is still loading or was deleted.");
    const response = await fetch(asset.dataURL);
    const rawBlob = await response.blob();
    const type = String(meta?.mimeType || rawBlob.type || "").trim();
    const blob = type && rawBlob.type !== type ? rawBlob.slice(0, rawBlob.size, type) : rawBlob;
    const url = URL.createObjectURL(blob);
    if (runtimeEpoch !== App.stickerRuntimeEpoch || App.stickerAssetCache.get(id) !== slot) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
      throw new DOMException("Sticker loading was cancelled.", "AbortError");
    }
    // Do not retain the multi-megabyte base64 value after creating its compact
    // browser URL. The sticker cache exclusively owns and revokes this URL.
    const result = {
      dataChunkCount: asset.dataChunkCount,
      url,
      byteSize: Math.max(0, Number(meta?.byteSize || blob.size || 0)),
      touchedAt: Date.now()
    };
    App.stickerAssetCache.set(id, result);
    App.enforceStickerAssetCacheBudget(id);
    return result;
  }).catch(error => {
    if (App.stickerAssetCache.get(id) === slot) App.stickerAssetCache.delete(id);
    throw error;
  });
  slot.promise = promise;
  App.stickerAssetCache.set(id, slot);
  return promise;
};
App.ensureStickerVideoObserver = function () {
  if (App.stickerVideoObserver || typeof IntersectionObserver !== "function") return App.stickerVideoObserver;
  App.stickerVideoObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const video = entry.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (entry.isIntersecting) {
        video.muted = true;
        video.play().catch(() => {});
      } else {
        try {
          video.pause();
        } catch {}
      }
    });
  }, {
    rootMargin: "120px",
    threshold: 0.01
  });
  return App.stickerVideoObserver;
};
App.observeStickerVideo = function (video) {
  if (!(video instanceof HTMLVideoElement)) return;
  const observer = App.ensureStickerVideoObserver();
  if (observer) observer.observe(video);else video.play().catch(() => {});
};
App.unobserveStickerVideosWithin = function (root) {
  if (!root || !App.stickerVideoObserver) return;
  root.querySelectorAll?.("video").forEach(video => {
    try {
      App.stickerVideoObserver.unobserve(video);
    } catch {}
  });
};
App.ensureStickerTileLoadObserver = function () {
  if (App.stickerTileLoadObserver || typeof IntersectionObserver !== "function") return App.stickerTileLoadObserver;
  App.stickerTileLoadObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const tile = entry.target;
      try {
        App.stickerTileLoadObserver?.unobserve(tile);
      } catch {}
      const load = tile.__loadStickerTile;
      delete tile.__loadStickerTile;
      try {
        load?.();
      } catch {}
    });
  }, {
    root: App.$("sticker-grid"),
    rootMargin: "560px 0px",
    threshold: 0.01
  });
  return App.stickerTileLoadObserver;
};
App.ensureStickerMessageLoadObserver = function () {
  if (App.stickerMessageLoadObserver || typeof IntersectionObserver !== "function") return App.stickerMessageLoadObserver;
  App.stickerMessageLoadObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const button = entry.target;
      try {
        App.stickerMessageLoadObserver?.unobserve(button);
      } catch {}
      const load = button.__loadStickerMessage;
      delete button.__loadStickerMessage;
      try {
        load?.();
      } catch {}
    });
  }, {
    rootMargin: "900px 0px",
    threshold: 0.01
  });
  return App.stickerMessageLoadObserver;
};
App.queueStickerMenuRender = function () {
  if (!App.stickerPopoverOpen || App.stickerMenuRenderFrame) return;
  App.stickerMenuRenderFrame = requestAnimationFrame(() => {
    App.stickerMenuRenderFrame = 0;
    if (App.stickerPopoverOpen) App.renderStickerMenu();
  });
};
App.queueStickerPrewarm = function () {
  if (!App.stickerPrewarmWanted || !App.currentUser || App.stickerPrewarmTimer) return;
  App.stickerPrewarmTimer = setTimeout(() => {
    App.stickerPrewarmTimer = 0;
    void App.prewarmStickerAssets();
  }, 100);
};
App.prewarmStickerAssets = async function () {
  // Warm only the recent first screen, with two background requests at a time.
  // Foreground tiles use the same promise cache, so opening the picker never
  // downloads a second copy of an asset that is already on its way.
  const connection = globalThis.navigator?.connection;
  if (!App.stickerPrewarmWanted || App.stickerPrewarmBusy || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || "")) return;
  const epoch = App.stickerRuntimeEpoch;
  const code = String(App.currentUser?.code || "");
  if (!code) return;
  const recentIds = Array.from(App.savedStickerIds).sort((a, b) => (App.savedStickerTimes.get(b) || 0) - (App.savedStickerTimes.get(a) || 0)).slice(0, 8);
  let byteBudget = 12 * 1024 * 1024;
  const records = recentIds.map(id => App.stickerLibraryMeta.get(id)).filter(meta => {
    if (meta?.state !== "ready") return false;
    const size = Number(meta.byteSize) || App.STICKER_MAX_OUTPUT_BYTES;
    if (size > byteBudget) return false;
    byteBudget -= size;
    return !App.stickerAssetCache.has(meta.id);
  });
  App.stickerPrewarmBusy = true;
  let cursor = 0;
  const worker = async () => {
    while (cursor < records.length && epoch === App.stickerRuntimeEpoch && code === String(App.currentUser?.code || "") && App.stickerPrewarmWanted) {
      const meta = records[cursor++];
      try {
        await App.loadStickerAsset(meta);
      } catch {} // A foreground tile offers retry if this speculative read fails.
    }
  };
  try {
    await Promise.all([worker(), worker()]);
  } finally {
    if (epoch === App.stickerRuntimeEpoch) App.stickerPrewarmBusy = false;
  }
};
App.prepareStickerPicker = function () {
  if (!App.currentUser?.code) return;
  App.ensureStickerCollectionListener();
  // Sign-in and hovering can prepare lightweight metadata. Download media
  // only once the picker is open or a sticker becomes visible in chat.
  App.stickerPrewarmWanted = !!App.stickerPopoverOpen;
  App.queueStickerPrewarm();
};
App.stopStickerCollectionListener = function () {
  clearTimeout(App.stickerPrewarmTimer);
  App.stickerPrewarmTimer = 0;
  App.stickerPrewarmWanted = false;
  App.closeStickerContextMenu(true);
  App.$("sticker-grid")?.querySelectorAll(".sticker-tile").forEach(tile => {
    try { App.stickerTileLoadObserver?.unobserve(tile); } catch {}
    tile.__disposeStickerTile?.();
    App.unobserveStickerVideosWithin(tile);
    tile.remove();
  });
  if (App.stickerCollectionRef && App.stickerCollectionCb) {
    try {
      App.stickerCollectionRef.off("value", App.stickerCollectionCb);
    } catch {}
  }
  App.stickerCollectionRef = null;
  App.stickerCollectionCb = null;
  App.stickerCollectionUserCode = "";
  App.stickerLibraryMetaUnsubs.forEach(off => {
    try {
      off();
    } catch {}
  });
  App.stickerLibraryMetaUnsubs.clear();
  App.stickerLibraryMeta.clear();
  App.savedStickerIds = new Set();
  App.savedStickerTimes = new Map();
  App.syncStickerSavedUI();
};
App.reconcileStickerLibraryMeta = function () {
  for (const id of App.savedStickerIds) {
    if (App.stickerLibraryMetaUnsubs.has(id)) continue;
    const off = App.watchStickerMeta(id, meta => {
      if (meta) App.stickerLibraryMeta.set(id, meta);else {
        App.stickerLibraryMeta.delete(id);
        if (App.savedStickerIds.has(id)) void App.unsaveSticker(id, {
          quiet: true
        });
      }
      App.queueStickerMenuRender();
      App.queueStickerPrewarm();
    });
    App.stickerLibraryMetaUnsubs.set(id, off);
  }
  for (const [id, off] of Array.from(App.stickerLibraryMetaUnsubs.entries())) {
    if (App.savedStickerIds.has(id)) continue;
    try {
      off();
    } catch {}
    App.stickerLibraryMetaUnsubs.delete(id);
    App.stickerLibraryMeta.delete(id);
  }
};
App.ensureStickerCollectionListener = function () {
  const code = String(App.currentUser?.code || "").trim();
  if (!code) return;
  if (App.stickerCollectionRef && App.stickerCollectionUserCode === code) return;
  App.stopStickerCollectionListener();
  App.stickerCollectionUserCode = code;
  App.stickerCollectionRef = App.db.ref(`${App.STICKER_COLLECTION_PATH}/${code}`);
  App.stickerCollectionCb = snap => {
    const raw = snap.val() || {};
    const nextIds = new Set();
    const nextTimes = new Map();
    Object.entries(raw).forEach(([id, record]) => {
      if (!id || !record) return;
      nextIds.add(id);
      nextTimes.set(id, Number(record?.savedAt || 0));
    });
    App.savedStickerIds = nextIds;
    App.savedStickerTimes = nextTimes;
    App.reconcileStickerLibraryMeta();
    App.syncStickerSavedUI();
    App.queueStickerMenuRender();
  };
  App.stickerCollectionRef.on("value", App.stickerCollectionCb);
};
App.updateStickerSaveButton = function (stickerId) {
  const button = App.$("btn-sticker-save");
  if (!button || button.hidden) return;
  const saved = App.savedStickerIds.has(String(stickerId || ""));
  const label = saved ? "Unsave Sticker" : "Save Sticker";
  button.classList.toggle("is-saved", saved);
  button.setAttribute("aria-pressed", saved ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
};
App.syncStickerSavedUI = function () {
  document.querySelectorAll("[data-sticker-id]").forEach(el => {
    const id = String(el.getAttribute("data-sticker-id") || "");
    el.classList.toggle("is-saved", App.savedStickerIds.has(id));
  });
  const viewerId = String(App.$("btn-sticker-save")?.dataset?.stickerId || "");
  if (viewerId) App.updateStickerSaveButton(viewerId);
};
App.saveSticker = async function (stickerId, {
  quiet = false
} = {}) {
  const id = String(stickerId || "").trim();
  const code = String(App.currentUser?.code || "").trim();
  if (!id || !code) return false;
  try {
    const metaSnap = await App.db.ref(`${App.STICKER_META_PATH}/${id}`).once("value");
    const meta = App.normalizeStickerMeta(id, metaSnap.val());
    if (!meta || meta.state !== "ready") throw new Error("Sticker is unavailable.");
    const stamp = App.firebase.database.ServerValue.TIMESTAMP;
    await App.db.ref().update({
      [`${App.STICKER_COLLECTION_PATH}/${code}/${id}`]: {
        savedAt: stamp
      },
      [`${App.STICKER_SAVERS_PATH}/${id}/${code}`]: true
    });
    if (!quiet) App.showToast({
      title: "Sticker Saved",
      body: `${meta.name} was added to your stickers.`,
      duration: 2200
    });
    return true;
  } catch (error) {
    if (!quiet) App.showToast({
      title: "Save Failed",
      body: String(error?.message || "Could not save that sticker."),
      duration: 2500
    });
    return false;
  }
};
App.unsaveSticker = async function (stickerId, {
  quiet = false
} = {}) {
  const id = String(stickerId || "").trim();
  const code = String(App.currentUser?.code || "").trim();
  if (!id || !code) return false;
  try {
    await App.db.ref().update({
      [`${App.STICKER_COLLECTION_PATH}/${code}/${id}`]: null,
      [`${App.STICKER_SAVERS_PATH}/${id}/${code}`]: null
    });
    if (!quiet) App.showToast({
      title: "Sticker Unsaved",
      body: "Removed from your sticker collection.",
      duration: 2000
    });
    return true;
  } catch {
    if (!quiet) App.showToast({
      title: "Unsave Failed",
      body: "Could not update your sticker collection.",
      duration: 2400
    });
    return false;
  }
};
App.toggleStickerSaved = async function (stickerId) {
  App.ensureStickerCollectionListener();
  if (App.savedStickerIds.has(String(stickerId || ""))) return App.unsaveSticker(stickerId);
  return App.saveSticker(stickerId);
};
App.renderStickerMedia = function (host, meta, asset, {
  message = false
} = {}) {
  if (!host?.isConnected || !meta || !asset?.url) return;
  App.unobserveStickerVideosWithin(host);
  host.textContent = "";
  if (meta.kind === "video") {
    const video = document.createElement("video");
    video.src = asset.url;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", meta.name);
    host.appendChild(video);
    App.observeStickerVideo(video);
  } else {
    const image = document.createElement("img");
    image.src = asset.url;
    image.alt = meta.name;
    image.decoding = "async";
    // Asset fetching is already gated by the viewport observer. A second lazy
    // image gate delayed the actual decode even after the sticker was fetched.
    image.loading = "eager";
    image.draggable = false;
    host.appendChild(image);
  }
};
App.renderStickerMessageInto = function (bubble, row, stickerRef) {
  bubble.classList.add("has-sticker");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sticker-message is-loading";
  button.dataset.stickerId = stickerRef.id;
  button.setAttribute("aria-label", `Open sticker ${stickerRef.name}`);
  button.innerHTML = '<span class="sticker-message-placeholder" aria-hidden="true"></span>';
  bubble.appendChild(button);
  let activeMeta = null;
  let retryTimer = 0;
  let mountFrame = 0;
  let disposed = false;
  let hydrateToken = 0;
  const hydrate = (meta, attempt = 0) => {
    if (disposed || !meta || meta.state !== "ready" || !button.isConnected) return;
    const token = ++hydrateToken;
    clearTimeout(retryTimer);
    button.disabled = false;
    button.className = "sticker-message is-loading";
    App.unobserveStickerVideosWithin(button);
    button.innerHTML = '<span class="sticker-message-placeholder" aria-hidden="true"></span>';
    App.loadStickerAsset(meta).then(asset => {
      if (!button.isConnected || token !== hydrateToken || activeMeta?.id !== meta.id) return;
      App.renderStickerMedia(button, meta, asset, {
        message: true
      });
      button.classList.remove("is-loading", "is-unavailable");
    }).catch(() => {
      if (!button.isConnected || token !== hydrateToken || activeMeta?.id !== meta.id) return;
      if (attempt < 3) {
        retryTimer = setTimeout(() => hydrate(meta, attempt + 1), [500, 1400, 3600][attempt] || 3600);
        return;
      }
      button.className = "sticker-message is-unavailable";
      button.disabled = false;
      App.unobserveStickerVideosWithin(button);
      button.innerHTML = '<span class="sticker-deleted-copy">Tap to retry sticker</span>';
    });
  };
  const queueHydrate = (meta, {
    immediate = false
  } = {}) => {
    if (disposed || !meta || meta.state !== "ready") return;
    clearTimeout(retryTimer);
    try {
      App.stickerMessageLoadObserver?.unobserve(button);
    } catch {}
    App.unobserveStickerVideosWithin(button);
    button.disabled = false;
    button.className = "sticker-message is-loading";
    button.innerHTML = '<span class="sticker-message-placeholder" aria-hidden="true"></span>';
    button.__loadStickerMessage = () => {
      if (!button.isConnected || activeMeta?.id !== meta.id || activeMeta?.state !== "ready") return;
      delete button.__loadStickerMessage;
      hydrate(activeMeta, 0);
    };
    const observer = App.ensureStickerMessageLoadObserver();
    // History is assembled inside a DocumentFragment. Cached metadata can
    // arrive before it is mounted: observing that detached button preserves
    // the load until the real message becomes visible instead of losing it.
    if (button.isConnected && (immediate || App.stickerAssetCache.get(meta.id)?.url || !observer)) {
      try {
        observer?.unobserve(button);
      } catch {}
      const load = button.__loadStickerMessage;
      delete button.__loadStickerMessage;
      load?.();
    } else if (observer) {
      observer.observe(button);
    } else {
      const loadAfterMount = () => {
        mountFrame = 0;
        if (disposed || !button.__loadStickerMessage) return;
        if (button.isConnected) button.__loadStickerMessage();
        else mountFrame = requestAnimationFrame(loadAfterMount);
      };
      if (!mountFrame) mountFrame = requestAnimationFrame(loadAfterMount);
    }
  };
  button.__retrySticker = () => {
    if (activeMeta?.state === "ready") queueHydrate(activeMeta, {
      immediate: true
    });
  };
  const unsubscribe = App.watchStickerMeta(stickerRef.id, meta => {
    if (disposed) return;
    activeMeta = meta;
    hydrateToken += 1;
    clearTimeout(retryTimer);
    if (!meta || meta.state !== "ready") {
      try {
        App.stickerMessageLoadObserver?.unobserve(button);
      } catch {}
      delete button.__loadStickerMessage;
      const deleted = !meta || meta.state === "deleting" || meta.state === "deleted";
      button.className = deleted ? "sticker-message is-deleted" : "sticker-message is-loading";
      button.disabled = true;
      App.unobserveStickerVideosWithin(button);
      button.innerHTML = deleted ? '<span class="sticker-deleted-copy">Sticker deleted</span>' : '<span class="sticker-message-placeholder" aria-hidden="true"></span>';
      return;
    }
    button.setAttribute("aria-label", `Open sticker ${meta.name}`);
    queueHydrate(meta);
  });
  row.__stickerUnsubscribe = () => {
    disposed = true;
    hydrateToken += 1;
    clearTimeout(retryTimer);
    if (mountFrame) cancelAnimationFrame(mountFrame);
    mountFrame = 0;
    try {
      unsubscribe();
    } catch {}
    try {
      App.stickerMessageLoadObserver?.unobserve(button);
    } catch {}
    delete button.__loadStickerMessage;
    App.unobserveStickerVideosWithin(button);
  };
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    if (button.classList.contains("is-loading") && typeof button.__loadStickerMessage === "function") {
      const load = button.__loadStickerMessage;
      delete button.__loadStickerMessage;
      try {
        App.stickerMessageLoadObserver?.unobserve(button);
      } catch {}
      load();
      return;
    }
    if (button.classList.contains("is-unavailable")) {
      button.__retrySticker?.();
      return;
    }
    if (activeMeta?.state === "ready") void App.openStickerViewer(activeMeta);
  });
};
App.retryUnavailableStickerMessages = function () {
  // A room kept open while offline should recover its existing history once
  // connectivity returns, without reloading that room or resending messages.
  for (const button of document.querySelectorAll(".sticker-message.is-unavailable")) button.__retrySticker?.();
};
App.closeStickerContextMenu = function (immediate = false, restoreFocus = false) {
  const menu = App.$("sticker-context-menu");
  if (!menu) return;
  clearTimeout(App.stickerContextCloseTimer);
  if (App.stickerContextCloseOnEnd) menu.removeEventListener("animationend", App.stickerContextCloseOnEnd);
  App.stickerContextCloseOnEnd = null;
  const anchor = App.stickerContextAnchor;
  App.stickerContextAnchor = null;
  const seq = ++App.stickerContextCloseSeq;
  const finish = event => {
    if ((event && event.target !== menu) || seq !== App.stickerContextCloseSeq) return;
    clearTimeout(App.stickerContextCloseTimer);
    menu.removeEventListener("animationend", finish);
    App.stickerContextCloseOnEnd = null;
    menu.hidden = true;
    menu.classList.remove("open", "closing");
    menu.textContent = "";
  };
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  if (immediate || menu.hidden) {
    finish();
    return;
  }
  menu.classList.remove("open");
  menu.classList.add("closing");
  App.stickerContextCloseOnEnd = finish;
  menu.addEventListener("animationend", finish);
  // Reduced motion, background tabs, and interrupted animations must still close.
  App.stickerContextCloseTimer = setTimeout(finish, 180);
};
App.canDeleteSticker = function (meta) {
  if (!meta?.id || !App.currentUser) return false;
  return String(meta.creatorCode || "") === String(App.currentUser.code || "") || App.isVinny();
};
App.openStickerContextMenu = function (meta, clientX, clientY, anchor = null) {
  const menu = App.$("sticker-context-menu");
  const popover = App.$("sticker-popover");
  if (!menu || !popover || !meta || !App.stickerPopoverOpen) return;
  App.closeStickerContextMenu(true);
  App.closeMsgMenu?.(true);
  App.closeMsgTextMenu?.(true);
  App.closeEmojiCtxMenu?.(true);
  App.closeCallUserContextMenu?.(true);
  App.closeHtmlHubContextMenu?.(true);
  App.stickerContextAnchor = anchor;
  // Use the same surface, mobile targets, and motion as every message menu.
  // Portaling keeps the menu out of the picker's transformed/clipped container.
  menu.className = "msg-menu sticker-picker-menu";
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  const canDelete = App.canDeleteSticker(meta);
  menu.innerHTML = `
    <button class="msg-menu-btn" type="button" data-sticker-menu-action="unsave" role="menuitem">
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="m12 3.6 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.62 6.9 19.3l.97-5.68L3.75 9.6l5.7-.83L12 3.6Z" stroke="currentColor" stroke-width="1.85" stroke-linejoin="round"/></svg>
      </span>
      <span class="msg-menu-label">Unsave</span>
    </button>
    ${canDelete ? `
      <button class="msg-menu-btn danger" type="button" data-sticker-menu-action="delete" role="menuitem">
        <span class="msg-menu-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 7h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M8 7l.6 12.1A2 2 0 0 0 10.6 21h2.8a2 2 0 0 0 2-1.9L16 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            <path d="M9.5 7l.5-3h4l.5 3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="msg-menu-label">Delete</span>
      </button>
    ` : ""}
  `;
  menu.hidden = false;
  App.positionContextMenu(menu, { x: clientX, y: clientY, anchor });
  menu.classList.add("open");
  menu.querySelector('[data-sticker-menu-action="unsave"]')?.addEventListener("click", () => {
    App.closeStickerContextMenu();
    void App.unsaveSticker(meta.id);
  });
  menu.querySelector('[data-sticker-menu-action="delete"]')?.addEventListener("click", () => {
    App.closeStickerContextMenu();
    App.confirmDeleteSticker(meta);
  });
  menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
};
App.renderStickerMenu = function () {
  const grid = App.$("sticker-grid");
  const status = App.$("sticker-popover-status");
  if (!grid || !status) return;
  const query = String(App.$("sticker-search")?.value || "").trim().toLowerCase();
  const records = Array.from(App.stickerLibraryMeta.values()).filter(meta => meta?.state === "ready").filter(meta => !query || meta.nameLower.includes(query) || String(meta.creatorUsername || "").toLowerCase().includes(query)).sort((a, b) => (App.savedStickerTimes.get(b.id) || b.createdAt || 0) - (App.savedStickerTimes.get(a.id) || a.createdAt || 0));
  const oldTiles = new Map(Array.from(grid.querySelectorAll(".sticker-tile"), tile => [tile.dataset.stickerId, tile]));
  const releaseTile = tile => {
    if (App.stickerContextAnchor === tile) App.closeStickerContextMenu(true);
    try {
      App.stickerTileLoadObserver?.unobserve?.(tile);
    } catch {}
    delete tile.__loadStickerTile;
    tile.__disposeStickerTile?.();
    App.unobserveStickerVideosWithin(tile);
    tile.remove();
  };
  const waiting = App.savedStickerIds.size > App.stickerLibraryMeta.size;
  if (!records.length) {
    oldTiles.forEach(releaseTile);
    status.textContent = query ? "No stickers match your search." : waiting ? "Loading stickers…" : "Upload or save a sticker to start your collection.";
    status.hidden = false;
    return;
  }
  status.hidden = true;
  records.forEach((meta, index) => {
    const signature = JSON.stringify([meta.name, meta.kind, meta.creatorCode, meta.createdAt]);
    const previous = oldTiles.get(meta.id);
    oldTiles.delete(meta.id);
    if (previous?.__stickerSignature === signature) {
      if (grid.children[index] !== previous) grid.insertBefore(previous, grid.children[index] || null);
      if (index < 6 && previous.__loadStickerTile && !previous.classList.contains("is-unavailable")) void previous.__loadStickerTile();
      return;
    }
    if (previous) releaseTile(previous);
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "sticker-tile is-loading";
    tile.dataset.stickerId = meta.id;
    tile.__stickerSignature = signature;
    tile.setAttribute("aria-label", `Send sticker ${meta.name}`);
    tile.innerHTML = `<span class="sticker-tile-media"><span class="sticker-message-placeholder" aria-hidden="true"></span></span><span class="sticker-tile-name">${App.escapeHtml(meta.name)}</span>`;
    let longPressOpened = false;
    let longPressReset = 0;
    tile.addEventListener("click", event => {
      if (longPressOpened) {
        event.preventDefault();
        event.stopPropagation();
        longPressOpened = false;
        clearTimeout(longPressReset);
        return;
      }
      if (tile.classList.contains("is-unavailable") && typeof tile.__loadStickerTile === "function") {
        tile.classList.add("is-loading");
        tile.classList.remove("is-unavailable");
        tile.querySelector(".sticker-tile-media").innerHTML = '<span class="sticker-message-placeholder" aria-hidden="true"></span>';
        void tile.__loadStickerTile();
        return;
      }
      void App.sendStickerMessage(meta);
    });
    tile.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      App.openStickerContextMenu(meta, event.clientX, event.clientY, tile);
    });
    tile.addEventListener("keydown", event => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      event.stopPropagation();
      App.openStickerContextMenu(meta, undefined, undefined, tile);
    });
    let holdTimer = 0;
    let holdX = 0;
    let holdY = 0;
    tile.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse") return;
      holdX = event.clientX;
      holdY = event.clientY;
      holdTimer = setTimeout(() => {
        longPressOpened = true;
        if (tile.isConnected && App.stickerPopoverOpen) App.openStickerContextMenu(meta, event.clientX, event.clientY, tile);
      }, 560);
    });
    const finishLongPressPointer = () => {
      clearTimeout(holdTimer);
      if (!longPressOpened) return;
      clearTimeout(longPressReset);
      // A normal click follows pointerup in the same event turn. Keep the
      // suppression armed until that click consumes it, with this timeout only
      // covering browsers that omit the click after a long press.
      longPressReset = setTimeout(() => {
        longPressOpened = false;
      }, 700);
    };
    tile.addEventListener("pointerup", finishLongPressPointer, {
      passive: true
    });
    tile.addEventListener("pointercancel", finishLongPressPointer, {
      passive: true
    });
    tile.addEventListener("pointerleave", () => clearTimeout(holdTimer), { passive: true });
    tile.addEventListener("pointermove", event => {
      if (!longPressOpened && Math.hypot(event.clientX - holdX, event.clientY - holdY) > 10) clearTimeout(holdTimer);
    }, {
      passive: true
    });
    tile.__disposeStickerTile = () => {
      clearTimeout(holdTimer);
      clearTimeout(longPressReset);
    };
    grid.insertBefore(tile, grid.children[index] || null);
    let tileLoadPromise = null;
    const loadTile = () => {
      if (tileLoadPromise) return tileLoadPromise;
      try { App.stickerTileLoadObserver?.unobserve(tile); } catch {}
      tileLoadPromise = App.loadStickerAsset(meta).then(asset => {
        if (!tile.isConnected) return;
        App.renderStickerMedia(tile.querySelector(".sticker-tile-media"), meta, asset);
        tile.classList.remove("is-loading", "is-unavailable");
        delete tile.__loadStickerTile;
      }).catch(() => {
        if (!tile.isConnected) return;
        tile.classList.add("is-unavailable");
        tile.classList.remove("is-loading");
        const media = tile.querySelector(".sticker-tile-media");
        if (media) media.innerHTML = '<span class="sticker-retry-copy">Tap to retry</span>';
        tile.__loadStickerTile = loadTile;
      }).finally(() => { tileLoadPromise = null; });
      return tileLoadPromise;
    };
    tile.__loadStickerTile = loadTile;
    const loadObserver = App.ensureStickerTileLoadObserver();
    // Start the first two rows immediately; prefetch the following rows before
    // scrolling reaches them. Existing media survives metadata/search updates.
    if (index < 6 || App.stickerAssetCache.get(meta.id)?.url || !loadObserver) void loadTile();else loadObserver.observe(tile);
  });
  oldTiles.forEach(releaseTile);
  App.syncStickerSavedUI();
};
App.closeStickerPopover = function ({
  immediate = false
} = {}) {
  const popover = App.$("sticker-popover");
  const button = App.$("btn-stickers");
  if (!popover) return;
  App.stickerPopoverOpen = false;
  App.stickerPrewarmWanted = false;
  clearTimeout(App.stickerPrewarmTimer);
  App.stickerPrewarmTimer = 0;
  button?.setAttribute("aria-expanded", "false");
  popover.classList.remove("open");
  App.closeStickerContextMenu(immediate);
  const finish = () => {
    if (!App.stickerPopoverOpen) popover.hidden = true;
  };
  if (immediate) finish();else setTimeout(finish, 150);
};
App.openStickerPopover = function () {
  const place = App.getStoredPlace() || "home";
  if (!App.currentUser || !App.currentRoomId || !place.startsWith("room:")) {
    App.showToast({
      title: "Pick a Room",
      body: "Open a room before choosing a sticker.",
      duration: 2200
    });
    return;
  }
  App.closeRoomActivitiesMenu?.();
  App.closeEmojiPopover();
  App.closeVoicePopover();
  App.closeComposerMoreMenu({
    immediate: true
  });
  const popover = App.$("sticker-popover");
  const button = App.$("btn-stickers");
  if (!popover || !button) return;
  popover.hidden = false;
  App.stickerPopoverOpen = true;
  App.prepareStickerPicker();
  App.layoutChatPopovers?.();
  button.setAttribute("aria-expanded", "true");
  App.renderStickerMenu();
  requestAnimationFrame(() => {
    if (!App.stickerPopoverOpen) return;
    popover.classList.add("open");
    try {
      App.$("sticker-search")?.focus?.({
        preventScroll: true
      });
    } catch {}
  });
};
App.toggleStickerPopover = function () {
  if (App.stickerPopoverOpen) App.closeStickerPopover();else App.openStickerPopover();
};
App.configureMediaStickerAction = function (source) {
  const button = App.$("btn-media-create-sticker");
  const wrap = document.querySelector(".modal-head-actions");
  if (!button) return;
  button.hidden = false;
  wrap?.classList.add("media-original-actions");
  button.onclick = () => void App.openStickerEditor(source);
};
App.hydrateStickerViewerUploader = function (meta) {
  const root = document.querySelector(".sticker-viewer-meta");
  if (!root || !meta) return;
  const code = String(meta.creatorCode || "").trim();
  const avatar = root.querySelector(".sticker-viewer-uploader-avatar");
  const username = root.querySelector("[data-username-usercode]");
  const uploader = root.querySelector(".sticker-viewer-uploader");
  const cached = code === String(App.currentUser?.code || "") ? App.currentUser : App.liveUserCache.get(code);
  const user = cached || {
    code,
    username: String(meta.creatorUsername || "Unknown"),
    photoDataURL: App.defaultStickmanDataURL(),
    photoTransform: null
  };
  root.dataset.stickerId = String(meta.id || "");
  if (uploader) uploader.dataset.stickerUploaderCode = code;
  if (avatar) {
    avatar.dataset.avatarUsercode = code;
    App.applyAvatar(avatar, user);
  }
  if (username) {
    username.dataset.usernameUsercode = code;
    username.textContent = String(user.username || meta.creatorUsername || "Unknown");
  }
  if (code) App.ensureLiveUserListener(code);
};
App.configureStickerViewerActions = function (meta) {
  App.ensureStickerCollectionListener();
  const button = App.$("btn-sticker-save");
  const remove = App.$("btn-sticker-delete");
  const wrap = document.querySelector(".modal-head-actions");
  if (!button || !meta?.id) return;
  button.hidden = false;
  button.dataset.stickerId = meta.id;
  if (remove && App.canDeleteSticker(meta)) {
    remove.hidden = false;
    remove.dataset.deleteStickerId = meta.id;
    remove.onclick = () => App.confirmDeleteSticker(meta);
  }
  wrap?.classList.add("sticker-viewer-actions");
  App.updateStickerSaveButton(meta.id);
  button.onclick = () => void App.toggleStickerSaved(meta.id);
};
App.openStickerViewer = async function (meta) {
  if (!meta?.id || meta.state !== "ready") return;
  const runtimeEpoch = App.stickerRuntimeEpoch;
  const viewerUserCode = String(App.currentUser?.code || "");
  try {
    const asset = await App.loadStickerAsset(meta);
    if (runtimeEpoch !== App.stickerRuntimeEpoch || !viewerUserCode || String(App.currentUser?.code || "") !== viewerUserCode) return;
    App.openMediaModal(meta.kind === "video" ? "sticker-video" : "image", asset.url, {
      fileName: meta.name,
      mimeType: meta.mimeType,
      stickerRecord: meta
    });
    const priorClose = App.modalBeforeClose;
    const off = App.watchStickerMeta(meta.id, next => {
      if (App.modalEl.hidden || String(App.$("btn-sticker-save")?.dataset?.stickerId || "") !== meta.id) return;
      if (!next || next.state !== "ready") {
        App.closeModal();
        App.showToast({
          title: "Sticker Deleted",
          body: "This sticker is no longer available.",
          duration: 2400
        });
        return;
      }
      const name = document.querySelector("[data-sticker-viewer-name]");
      if (name) name.textContent = next.name;
      App.hydrateStickerViewerUploader(next);
    });
    App.modalBeforeClose = () => {
      try {
        off();
      } catch {}
      try {
        priorClose?.();
      } catch {}
    };
  } catch {
    App.showToast({
      title: "Sticker Unavailable",
      body: "This sticker could not be loaded.",
      duration: 2400
    });
  }
};
App.sendStickerMessage = async function (meta) {
  if (App.passwordChangeInFlight || App.accountSessionRevoked) return;
  const roomId = App.sanitizeRoomCode(App.currentRoomId);
  const senderCode = String(App.currentUser?.code || "");
  if (!App.currentUser || !roomId) {
    App.showToast({
      title: "Pick a Room",
      body: "Open a room before sending a sticker.",
      duration: 2200
    });
    return;
  }
  App.closeStickerPopover();
  try {
    const latestSnap = await App.db.ref(`${App.STICKER_META_PATH}/${meta.id}`).once("value");
    if (App.passwordChangeInFlight || App.accountSessionRevoked) return;
    const latest = App.normalizeStickerMeta(meta.id, latestSnap.val());
    if (!latest || latest.state !== "ready") throw new Error("That sticker was deleted.");
    const placeNow = App.getStoredPlace() || "home";
    if (String(App.currentUser?.code || "") !== senderCode || App.sanitizeRoomCode(App.currentRoomId) !== roomId || placeNow !== `room:${roomId}`) {
      App.showToast({
        title: "Sticker Not Sent",
        body: "The active room changed before the sticker was ready.",
        duration: 2400
      });
      return;
    }
    const newRef = App.db.ref(`messages/${roomId}`).push();
    const msg = {
      t: "sticker",
      text: "",
      sticker: {
        id: latest.id,
        name: latest.name,
        kind: latest.kind,
        mimeType: latest.mimeType,
        creatorCode: latest.creatorCode,
        creatorUsername: latest.creatorUsername
      },
      userCode: App.currentUser.code,
      username: App.currentUser.username,
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      createdAt: App.firebase.database.ServerValue.TIMESTAMP
    };
    if (App.replyState?.key) {
      const replyTarget = App.getReplyTargetMessage(App.replyState.key, roomId);
      msg.replyTo = {
        key: App.replyState.key,
        userCode: App.replyState.userCode || String(replyTarget?.userCode || ""),
        username: App.replyState.username || replyTarget?.username || "User",
        displayName: App.normalizeReplyDisplayName(App.replyState.displayName || replyTarget?.displayName || App.replyState.username || "User"),
        previewText: App.getReplyTargetPreviewText(replyTarget),
        attachmentCount: App.getReplyTargetAttachmentCount(replyTarget)
      };
      App.clearReplyState({
        quiet: true
      });
    }
    const key = String(newRef.key || "");
    const stubCreatedAt = App.firebasePushKeyTimestamp(key) || Date.now();
    if (key) {
      App.renderedMsgKeys.add(key);
      App.appendMessageRow({
        ...msg,
        _key: key,
        createdAt: stubCreatedAt,
        __stub: 1
      });
      App.forceScrollToBottomFor(1100, {
        reason: "send-sticker"
      });
    }
    App.enqueueSendTask(async () => {
      try {
        await App.setRefWithRetry(newRef, msg, App.RTDB_CHUNK_UPLOAD_RETRIES);
        const stillViewingRoom = App.sanitizeRoomCode(App.currentRoomId) === roomId && (App.getStoredPlace() || "") === `room:${roomId}`;
        if (key && stillViewingRoom) App.replaceMessageRowByKey({
          ...msg,
          _key: key,
          createdAt: stubCreatedAt
        });
        await App.updateRoomLastMessage(roomId, `[Sticker: ${latest.name}]`, key, msg.userCode);
        App.scheduleLastSeenBump(roomId, {
          immediate: true
        });
      } catch (error) {
        if (key) {
          try {
            App.msgElByKey.get(key)?.__stickerUnsubscribe?.();
          } catch {}
          try {
            App.msgElByKey.get(key)?.remove();
          } catch {}
          App.msgElByKey.delete(key);
          App.msgDataByKey.delete(key);
          App.renderedMsgKeys.delete(key);
        }
        App.showToast({
          title: "Send Failed",
          body: String(error?.message || "Could not send that sticker."),
          duration: 2600
        });
      }
    });
  } catch (error) {
    App.showToast({
      title: "Sticker Unavailable",
      body: String(error?.message || "That sticker cannot be sent."),
      duration: 2400
    });
  }
};
App.confirmDeleteSticker = function (meta) {
  if (!App.canDeleteSticker(meta)) return;
  const confirmId = `sticker_delete_${Math.random().toString(36).slice(2)}`;
  App.showToast({
    title: "Delete Sticker?",
    bodyHTML: `<div class="muted small">Delete <span class="strong">${App.escapeHtml(meta.name)}</span> for everyone? This cannot be undone.</div><div class="toast-inline-actions"><button class="btn tiny danger" id="${confirmId}" type="button">Delete</button></div>`,
    duration: 12000
  });
  App.$(confirmId)?.addEventListener("click", async () => {
    App.closeToast();
    const deletingCode = String(App.currentUser?.code || "");
    const deletingAsVinny = App.isVinny();
    const metaRef = App.db.ref(`${App.STICKER_META_PATH}/${meta.id}`);
    let deleteClaimed = false;
    try {
      const claim = await metaRef.transaction(current => {
        if (!current || typeof current !== "object") return;
        const ownsSticker = String(current.creatorCode || "") === deletingCode;
        if (!ownsSticker && !deletingAsVinny || String(current.state || "ready") !== "ready") return;
        return {
          ...current,
          state: "deleting",
          deletingAt: App.accurateNowMs(),
          deletingBy: deletingCode
        };
      }, undefined, false);
      if (!claim.committed) throw new Error("Only the creator or Vinny can delete this available sticker.");
      deleteClaimed = true;
      const latest = App.normalizeStickerMeta(meta.id, claim.snapshot.val());
      if (!latest) throw new Error("Sticker has already been deleted.");
      // Let saves that began just before the delete claim finish, then sweep
      // their reverse-index entries in the same atomic deletion.
      await App.sleep(260);
      const saverSnap = await App.db.ref(`${App.STICKER_SAVERS_PATH}/${meta.id}`).once("value");
      const savers = saverSnap.val() || {};
      const updates = {
        [`${App.STICKER_META_PATH}/${meta.id}`]: null,
        [`${App.STICKER_ASSET_PATH}/${meta.id}`]: null,
        [`${App.STICKER_OWNER_PATH}/${latest.creatorCode}/${meta.id}`]: null,
        [`${App.STICKER_COLLECTION_PATH}/${latest.creatorCode}/${meta.id}`]: null,
        [`${App.STICKER_COLLECTION_PATH}/${deletingCode}/${meta.id}`]: null,
        [`${App.STICKER_SAVERS_PATH}/${meta.id}`]: null
      };
      Object.keys(savers).forEach(code => {
        updates[`${App.STICKER_COLLECTION_PATH}/${code}/${meta.id}`] = null;
      });
      await App.db.ref().update(updates);
      // A second bounded sweep catches a save request that had already read the
      // old ready state but completed unusually late.
      await App.sleep(260);
      const lateSaverSnap = await App.db.ref(`${App.STICKER_SAVERS_PATH}/${meta.id}`).once("value");
      const lateSavers = lateSaverSnap.val() || {};
      if (Object.keys(lateSavers).length) {
        const lateUpdates = {
          [`${App.STICKER_SAVERS_PATH}/${meta.id}`]: null
        };
        Object.keys(lateSavers).forEach(code => {
          lateUpdates[`${App.STICKER_COLLECTION_PATH}/${code}/${meta.id}`] = null;
        });
        await App.db.ref().update(lateUpdates);
      }
      App.evictStickerAsset(meta.id);
      App.showToast({
        title: "Sticker Deleted",
        body: "The sticker was removed for everyone.",
        duration: 2400
      });
    } catch (error) {
      if (deleteClaimed) {
        try {
          await metaRef.transaction(current => {
            if (!current || String(current.deletingBy || "") !== deletingCode || String(current.state || "") !== "deleting") return;
            const restored = {
              ...current,
              state: "ready"
            };
            delete restored.deletingAt;
            delete restored.deletingBy;
            return restored;
          }, undefined, false);
        } catch {}
      }
      App.showToast({
        title: "Delete Failed",
        body: String(error?.message || "Could not delete that sticker."),
        duration: 2800
      });
    }
  }, {
    once: true
  });
};

App.register("stickers/library", function initializeFeature() {
App.STICKER_META_PATH = "stickers/meta";
App.STICKER_ASSET_PATH = "stickers/assets";
App.STICKER_OWNER_PATH = "stickers/byOwner";
App.STICKER_COLLECTION_PATH = "stickerCollections";
App.STICKER_SAVERS_PATH = "stickerSavers";
App.STICKER_OUTPUT_SIZE = 512;
App.STICKER_MAX_VIDEO_SECONDS = 5;
App.STICKER_MAX_SOURCE_BYTES = 50 * 1024 * 1024;
App.STICKER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
App.stickerCollectionRef = null;
App.stickerCollectionCb = null;
App.stickerCollectionUserCode = "";
App.savedStickerIds = new Set();
App.savedStickerTimes = new Map();
App.stickerLibraryMeta = new Map();
App.stickerLibraryMetaUnsubs = new Map();
App.stickerMetaChannels = new Map();
App.stickerAssetCache = new Map();
App.stickerAssetLoadCount = 0;
App.stickerAssetLoadQueue = [];
App.stickerVideoObserver = null;
App.stickerTileLoadObserver = null;
App.stickerMessageLoadObserver = null;
App.stickerMenuRenderFrame = 0;
App.stickerPrewarmTimer = 0;
App.stickerPrewarmWanted = false;
App.stickerPrewarmBusy = false;
App.stickerContextCloseSeq = 0;
App.stickerContextCloseTimer = 0;
App.stickerContextCloseOnEnd = null;
App.stickerContextAnchor = null;
App.stickerRuntimeEpoch = 0;
App.stickerEditorLaunchSeq = 0;
window.addEventListener("online", App.retryUnavailableStickerMessages);
});
})(globalThis.ChatApp);
