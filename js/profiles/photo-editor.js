/* profiles/photo-editor: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.clipSizePx = function () {
  const r = App.pfpClip.getBoundingClientRect();
  return Math.max(1, Math.round(r.width || 84));
};
App.packTransformForStorage = function () {
  const size = App.clipSizePx();
  return {
    unit: "rel",
    scale: App.pfpState.scale,
    x: (App.pfpState.x || 0) / size,
    y: (App.pfpState.y || 0) / size
  };
};
App.normalizeTransformToRel = function (t, legacySizePx = 84) {
  if (!t) return {
    unit: "rel",
    scale: 1,
    x: 0,
    y: 0
  };
  if (t.unit === "rel") return {
    unit: "rel",
    scale: Number(t.scale) || 1,
    x: Number(t.x) || 0,
    y: Number(t.y) || 0
  };
  // Legacy: pixel offsets were saved from the editor surface that created them.
  const assumed = Math.max(1, Number(legacySizePx) || 84);
  return {
    unit: "rel",
    scale: Number(t.scale) || 1,
    x: (Number(t.x) || 0) / assumed,
    y: (Number(t.y) || 0) / assumed
  };
};
App.transformToPixels = function (t, sizePx, legacySizePx = 84) {
  const size = Math.max(1, Number(sizePx) || 1);
  const tr = App.normalizeTransformToRel(t, legacySizePx);
  return {
    scale: tr.scale,
    x: tr.x * size,
    y: tr.y * size,
    unit: "px"
  };
};
App.applyPfpTransformPreview = function () {
  App.applyCroppedImage(App.pfpImg, App.pfpState.dataURL, App.packTransformForStorage(), App.clipSizePx());
};
App.setDefaultPfp = function () {
  App.pfpState.usingDefault = true;
  App.pfpState.dataURL = App.defaultStickmanDataURL();
  App.pfpState.scale = 1.0;
  App.pfpState.x = 0;
  App.pfpState.y = 0;
  App.zoomSlider.value = String(App.pfpState.scale);
  App.cropControls.hidden = false;
  App.pfpImg.src = App.pfpState.dataURL;
  App.applyPfpTransformPreview();
};
App.setUploadedPfp = function (dataURL) {
  App.pfpState.usingDefault = false;
  App.pfpState.dataURL = dataURL;
  App.pfpState.scale = 1.0;
  App.pfpState.x = 0;
  App.pfpState.y = 0;
  App.zoomSlider.value = String(App.pfpState.scale);
  App.cropControls.hidden = false;
  App.pfpImg.src = App.pfpState.dataURL;
  App.applyPfpTransformPreview();
};
App.fileTypeOk = function (file) {
  const t = (file.type || "").toLowerCase();
  return t === "image/png" || t === "image/jpeg" || t === "image/jpg" || t === "image/gif";
};
App.chatFileKind = function (file) {
  const t = (file.type || "").toLowerCase();
  const n = (file.name || "").toLowerCase();
  if (t === "image/png" || t === "image/jpeg" || t === "image/jpg" || t === "image/gif") return "image";
  if (t === "video/mp4" || t === "video/webm" || t === "video/ogg" || t === "video/quicktime" || n.endsWith(".mov")) return "video";
  if (t.startsWith("audio/") || n.endsWith(".mp3") || n.endsWith(".wav") || n.endsWith(".ogg") || n.endsWith(".m4a") || n.endsWith(".aac") || n.endsWith(".flac")) return "audio";
  if (t === "text/html" || t === "application/xhtml+xml" || n.endsWith(".html") || n.endsWith(".htm")) return "html";

  // Any other/unknown/custom type -> download-only
  return "code";
};
App.getMediaMimeType = function (item) {
  const raw = String(item?.mimeType || item?.type || item?.sub || "").trim().toLowerCase();
  if (raw) return raw;
  const name = String(item?.fileName || item?.name || "").trim().toLowerCase();
  if (name.endsWith(".mov") || name.endsWith(".qt")) return "video/quicktime";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".ogv") || name.endsWith(".ogg")) return "video/ogg";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".flac")) return "audio/flac";
  return "";
};
App.canInlineVideoMedia = function (item) {
  const mimeType = App.getMediaMimeType(item);
  const fileName = String(item?.fileName || item?.name || "").trim().toLowerCase();
  const looksQuickTime = mimeType === "video/quicktime" || fileName.endsWith(".mov") || fileName.endsWith(".qt");
  if (!mimeType) return !looksQuickTime;
  try {
    const probe = document.createElement("video");
    const support = String(probe.canPlayType(mimeType) || "").toLowerCase();
    if (support === "probably" || support === "maybe") return true;
  } catch {}
  return !looksQuickTime;
};
App.shouldDeferInlineVideoPreview = function (item) {
  return Number(item?.size || 0) >= App.INLINE_VIDEO_LIGHTBOX_THRESHOLD_BYTES;
};
App.videoSourceMarkup = function (src, mimeType = "") {
  const safeSrc = App.escapeHtml(String(src || ""));
  const safeType = App.escapeHtml(String(mimeType || "").trim());
  return safeType ? `<source src="${safeSrc}" type="${safeType}" />` : `<source src="${safeSrc}" />`;
};

App.register("profiles/photo-editor", function initializeFeature() {
App.pfpImg = App.$("pfp-img");
App.pfpClip = App.$("pfp-clip");
App.pfpInput = App.$("create-pfp");
App.cropControls = App.$("crop-controls");
App.zoomSlider = App.$("zoom");
App.pfpState = {
  usingDefault: true,
  dataURL: App.defaultStickmanDataURL(),
  scale: 1.0,
  x: 0,
  y: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startX: 0,
  startY: 0
};
App.INLINE_VIDEO_LIGHTBOX_THRESHOLD_BYTES = 80 * 1024 * 1024;
App.pfpClip.addEventListener("pointerdown", e => {
  App.pfpState.dragging = true;
  App.pfpState.dragStartX = e.clientX;
  App.pfpState.dragStartY = e.clientY;
  App.pfpState.startX = App.pfpState.x;
  App.pfpState.startY = App.pfpState.y;
  App.pfpClip.setPointerCapture(e.pointerId);
});
App.pfpClip.addEventListener("pointermove", e => {
  if (!App.pfpState.dragging) return;
  const dx = e.clientX - App.pfpState.dragStartX;
  const dy = e.clientY - App.pfpState.dragStartY;
  App.pfpState.x = App.pfpState.startX + dx;
  App.pfpState.y = App.pfpState.startY + dy;
  App.applyPfpTransformPreview();
});
App.pfpClip.addEventListener("pointerup", () => {
  App.pfpState.dragging = false;
});
App.zoomSlider.addEventListener("input", () => {
  App.pfpState.scale = Number(App.zoomSlider.value);
  App.applyPfpTransformPreview();
});
App.$("btn-create-choose-pfp").addEventListener("click", () => {
  try {
    App.pfpInput.click();
  } catch {}
});
App.$("btn-create-use-default").addEventListener("click", () => {
  try {
    App.pfpInput.value = "";
  } catch {}
  App.setDefaultPfp();
});
App.$("btn-center").addEventListener("click", () => {
  App.pfpState.x = 0;
  App.pfpState.y = 0;
  App.applyPfpTransformPreview();
});
App.$("btn-reset").addEventListener("click", () => {
  App.pfpState.scale = 1.0;
  App.pfpState.x = 0;
  App.pfpState.y = 0;
  App.zoomSlider.value = String(App.pfpState.scale);
  App.applyPfpTransformPreview();
});
App.pfpInput.addEventListener("change", async () => {
  App.hideError("create");
  const file = App.pfpInput.files?.[0];
  if (!file) {
    App.setDefaultPfp();
    return;
  }
  if (!App.fileTypeOk(file)) {
    App.setError("create", "Profile picture must be PNG, JPG/JPEG, or GIF.");
    App.pfpInput.value = "";
    App.setDefaultPfp();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => App.setUploadedPfp(String(reader.result));
  reader.onerror = () => {
    App.setError("create", "Could not read that file.");
    App.pfpInput.value = "";
    App.setDefaultPfp();
    return;
  };
  reader.readAsDataURL(file);
});
});
})(globalThis.ChatApp);
