/* rooms/icon-editor: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.readFileAsDataURL = function (file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error || new Error("read failed"));
    fr.readAsDataURL(file);
  });
};
App.getRoomIconMenuPayload = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  const meta = id ? App.roomsMetaCache.get(id) || null : null;
  const dataURL = String(meta?.photoDataURL || App.defaultStickmanDataURL());
  return {
    id,
    dataURL,
    fileName: id ? `room-${id}-icon.${App.inferImageExt(dataURL)}` : `room-icon.${App.inferImageExt(dataURL)}`
  };
};
App.openRoomIconContextMenu = function (e, roomId, anchorEl) {
  e.preventDefault();
  e.stopPropagation();
  const payload = App.getRoomIconMenuPayload(roomId);
  if (!payload.id || !payload.dataURL) return;
  App.closeMsgMenu(true);
  App.openMsgMenuFor(anchorEl || e.currentTarget || document.body, {
    menu: "roomIcon",
    username: "Room Icon",
    roomId: payload.id,
    imageDataURL: payload.dataURL,
    imageFileName: payload.fileName,
    pointerX: e.clientX,
    pointerY: e.clientY
  });
};
App.openRoomButtonContextMenu = function (e, roomId, anchorEl) {
  e.preventDefault();
  e.stopPropagation();
  const payload = App.getRoomIconMenuPayload(roomId);
  if (!payload.id || !payload.dataURL) return;
  App.closeMsgMenu(true);
  const meta = App.roomsMetaCache.get(payload.id) || null;
  App.openMsgMenuFor(anchorEl || e.currentTarget || document.body, {
    menu: "roomButton",
    username: App.roomDisplayName(payload.id, meta),
    roomId: payload.id,
    imageDataURL: payload.dataURL,
    imageFileName: payload.fileName,
    pointerX: e.clientX,
    pointerY: e.clientY
  });
};
App.openRoomIconEditor = function (roomIdOverride = App.currentRoomId) {
  const id = App.sanitizeRoomCode(roomIdOverride);
  if (!id || !App.currentUser) {
    App.showToast({
      title: "Pick a room",
      body: "Open a room first.",
      duration: 2200
    });
    return;
  }
  const meta = App.roomsMetaCache.get(id) || null;
  const initialDataURL = String(meta?.photoDataURL || App.defaultStickmanDataURL());
  const initialTransform = App.normalizeTransformToRel(meta?.photoTransform, 132);
  App.openModal({
    title: `Edit ${App.roomDisplayName(id, meta)} Icon`,
    bodyHTML: `
      <input id="room-icon-editor-file" type="file" accept="image/png,image/jpeg,image/jpg,image/gif" hidden />

      <div class="upload" style="margin-top:8px">
        <div class="upload-ui">
          <div class="upload-left">
            <div class="avatar-wrap">
              <div class="avatar-ring" style="width:132px; height:132px">
                <div class="avatar-clip" id="room-icon-editor-clip">
                  <img id="room-icon-editor-img" alt="Room Icon" draggable="false" />
                </div>
              </div>
            </div>
            <div class="upload-text">
              <div class="strong">Room icon</div>
              <div class="muted small">Choose a PNG, JPG, or GIF, then drag and zoom to crop it.</div>
            </div>
          </div>

          <div class="upload-actions-stack">
            <div class="upload-actions-row">
              <button class="btn tiny" id="btn-room-icon-choose" type="button">Choose</button>
              <button class="btn tiny" id="btn-room-icon-use-default" type="button">Use Default</button>
            </div>
            <div class="upload-actions-row">
              <button class="btn tiny" id="btn-room-icon-download" type="button">Download Icon</button>
              <button class="btn tiny" id="btn-room-icon-copy-address" type="button">Copy Icon Address</button>
            </div>
          </div>
        </div>
      </div>

      <div class="crop-controls" id="room-icon-editor-controls">
        <div class="row">
          <div class="muted small">Drag the picture in the circle.</div>
        </div>
        <div class="row">
          <label class="label small" for="room-icon-editor-zoom">Zoom</label>
          <input id="room-icon-editor-zoom" type="range" min="1.0" max="3.0" step="0.01" value="1.0" style="width:100%" />
        </div>
        <div class="row">
          <button class="btn tiny" id="btn-room-icon-center" type="button">Center</button>
          <button class="btn tiny" id="btn-room-icon-reset" type="button">Reset</button>
        </div>
      </div>
    `,
    actionsHTML: `
      <button class="btn tiny primary" id="btn-room-icon-save" type="button">Save</button>
    `
  });
  const clip = App.$("room-icon-editor-clip");
  const img = App.$("room-icon-editor-img");
  const input = App.$("room-icon-editor-file");
  const zoom = App.$("room-icon-editor-zoom");
  const btnChoose = App.$("btn-room-icon-choose");
  const btnUseDefault = App.$("btn-room-icon-use-default");
  const btnDownloadIcon = App.$("btn-room-icon-download");
  const btnCopyIconAddress = App.$("btn-room-icon-copy-address");
  const btnCenter = App.$("btn-room-icon-center");
  const btnReset = App.$("btn-room-icon-reset");
  const btnSave = App.$("btn-room-icon-save");
  if (!clip || !img || !input || !zoom || !btnChoose || !btnUseDefault || !btnDownloadIcon || !btnCopyIconAddress || !btnCenter || !btnReset || !btnSave) {
    return;
  }
  img.addEventListener("dragstart", e => e.preventDefault());
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const state = {
    dataURL: initialDataURL,
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
    pointerId: null
  };
  function clipSize() {
    const r = clip.getBoundingClientRect();
    const w = Math.round(r.width || 0);
    return Math.max(1, w || 132);
  }
  function applyPreview() {
    App.applyCroppedImage(img, state.dataURL, packTransform(), clipSize(), 132);
  }
  function packTransform() {
    const size = clipSize();
    return {
      unit: "rel",
      scale: state.scale,
      x: (state.x || 0) / size,
      y: (state.y || 0) / size
    };
  }
  function loadFromCurrent() {
    img.src = state.dataURL;
    const px = App.transformToPixels(initialTransform, clipSize(), 132);
    state.scale = clamp(Number(px.scale) || 1, 0.2, 3.0);
    state.x = Number(px.x) || 0;
    state.y = Number(px.y) || 0;
    zoom.value = String(state.scale);
    applyPreview();
  }
  loadFromCurrent();
  requestAnimationFrame(() => requestAnimationFrame(loadFromCurrent));
  btnChoose.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    App.closeMsgMenu(true);
    try {
      input.value = "";
    } catch {}
    setTimeout(() => {
      try {
        input.click();
      } catch {}
    }, 0);
  });
  btnDownloadIcon.addEventListener("click", async () => {
    if (!state.dataURL) return;
    await App.downloadFileViaObjectURL(state.dataURL, `room-${id}-icon.${App.inferImageExt(state.dataURL)}`);
  });
  btnCopyIconAddress.addEventListener("click", async () => {
    if (!state.dataURL) return;
    await App.copyImageAddress(state.dataURL);
  });
  btnUseDefault.addEventListener("click", async () => {
    btnUseDefault.disabled = true;
    try {
      const patch = {
        photoDataURL: null,
        photoTransform: null
      };
      App.roomsMetaCache.set(id, {
        ...(App.roomsMetaCache.get(id) || {}),
        ...patch
      });
      App.refreshRoomIconSurfaces(id);
      await App.db.ref(`rooms/${id}`).update(patch);
      App.closeModal();
      App.showToast({
        title: "Room icon reset",
        body: `${App.roomDisplayName(id)} is using the default icon again.`,
        duration: 2200
      });
    } catch {
      btnUseDefault.disabled = false;
      App.showToast({
        title: "Reset failed",
        body: "Could not restore the default room icon.",
        duration: 2600
      });
    }
  });
  btnCenter.addEventListener("click", () => {
    state.x = 0;
    state.y = 0;
    applyPreview();
  });
  btnReset.addEventListener("click", () => {
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    zoom.value = "1";
    applyPreview();
  });
  function endDrag() {
    if (!state.dragging) return;
    state.dragging = false;
    state.pointerId = null;
  }
  clip.addEventListener("pointerdown", e => {
    state.dragging = true;
    state.pointerId = e.pointerId;
    state.dragStartX = e.clientX;
    state.dragStartY = e.clientY;
    state.startX = state.x;
    state.startY = state.y;
    try {
      clip.setPointerCapture(e.pointerId);
    } catch {}
  });
  clip.addEventListener("pointermove", e => {
    if (!state.dragging) return;
    if (state.pointerId !== null && e.pointerId !== state.pointerId) return;
    const dx = e.clientX - state.dragStartX;
    const dy = e.clientY - state.dragStartY;
    state.x = state.startX + dx;
    state.y = state.startY + dy;
    applyPreview();
  });
  clip.addEventListener("pointerup", () => endDrag());
  clip.addEventListener("pointercancel", () => endDrag());
  zoom.addEventListener("input", () => {
    state.scale = clamp(Number(zoom.value) || 1, 0.2, 3.0);
    applyPreview();
  });
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0] ? input.files[0] : null;
    input.value = "";
    if (!file) return;
    if (!App.fileTypeOk(file)) {
      App.showToast({
        title: "Invalid file",
        body: "Room icons must be PNG, JPG/JPEG, or GIF.",
        duration: 2600
      });
      return;
    }
    try {
      state.dataURL = await App.readFileAsDataURL(file);
      state.scale = 1;
      state.x = 0;
      state.y = 0;
      zoom.value = "1";
      img.src = state.dataURL;
      applyPreview();
    } catch {
      App.showToast({
        title: "Read failed",
        body: "Could not read that file.",
        duration: 2600
      });
    }
  });
  btnSave.addEventListener("click", async () => {
    btnSave.disabled = true;
    try {
      const patch = {
        photoDataURL: state.dataURL,
        photoTransform: packTransform()
      };
      App.roomsMetaCache.set(id, {
        ...(App.roomsMetaCache.get(id) || {}),
        ...patch
      });
      App.refreshRoomIconSurfaces(id);
      await App.db.ref(`rooms/${id}`).update(patch);
      App.closeModal();
      App.showToast({
        title: "Room icon updated",
        body: `Updated the icon for room ${App.roomDisplayName(id, App.roomsMetaCache.get(id) || null)}.`,
        duration: 2200
      });
    } catch {
      btnSave.disabled = false;
      App.showToast({
        title: "Upload failed",
        body: "Could not update the room icon.",
        duration: 2600
      });
    }
  });
};

App.register("rooms/icon-editor", function initializeFeature() {

});
})(globalThis.ChatApp);
