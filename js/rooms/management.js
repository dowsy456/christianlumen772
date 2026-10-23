/* rooms/management: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.joinRoomMembership = async function (roomId, lastSeenCount = 0) {
  const user = { ...App.currentUser };
  const result = await App.db.ref(`memberships/${user.code}/${roomId}`).transaction(current => current ? undefined : {
    joinedAt: App.firebase.database.ServerValue.TIMESTAMP, lastSeenAt: 0, lastSeenCount
  }, undefined, false);
  if (result.snapshot.val()) await App.db.ref(`roomMembers/${roomId}/${user.code}`).set(true);
  if (result.committed) {
    const joinedAt = Number(result.snapshot.val()?.joinedAt) || Date.now();
    void App.writeRoomSystemMessage(roomId, { type: "member_joined", userCode: user.code, displayName: user.displayName || user.username || "User", username: user.username || "User", createdAt: joinedAt }, `member-joined:${user.code}:${joinedAt}`).catch(error => console.warn("Join log could not be saved:", error));
  }
  return result.snapshot.val();
};
App.confirmLeaveRoom = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  const displayName = App.roomDisplayName(id, App.roomsMetaCache.get(id) || null);
  const confirmId = `toast_confirm_${Math.random().toString(36).slice(2)}`;
  App.showToast({
    title: "Leave Room",
    bodyHTML: `
      <div class="muted small" style="margin-top:2px">Are you sure you want to leave <span class="strong">${App.escapeHtml(displayName)}</span>?</div>
      <div style="display:flex; gap:10px; margin-top:10px">
        <button class="btn tiny danger" id="${confirmId}" type="button">Leave</button>
      </div>
    `,
    duration: 10000
  });

  // Wire buttons (toast already in DOM)
  const confirmBtn = document.getElementById(confirmId);
  confirmBtn?.addEventListener("click", async () => {
    App.closeToast();
    const leavingUser = { ...App.currentUser };
    // If you’re in this room’s call, leave it before leaving the room
    try {
      if (App.currentCallRoomId === id) await App.leaveCall({
        roomId: id,
        quiet: true
      });
    } catch {}
    try {
      const membership = await App.db.ref(`memberships/${leavingUser.code}/${id}`).once("value");
      await App.db.ref().update({
        [`roomMembers/${id}/${leavingUser.code}`]: null,
        [`memberships/${App.currentUser.code}/${id}`]: null,
        [`${App.pinnedRoomsPath()}/${id}`]: null
      });
      if (membership.exists()) void App.writeRoomSystemMessage(id, { type: "member_left", userCode: leavingUser.code, displayName: leavingUser.displayName || leavingUser.username || "User", username: leavingUser.username || "User" }, `member-left:${leavingUser.code}:${Number(membership.val()?.joinedAt) || 0}`).catch(error => console.warn("Leave log could not be saved:", error));
    } catch (e) {
      console.error("leave failed:", e);
      App.showToast({
        title: "Leave failed",
        body: "Check console / rules.",
        duration: 2600
      });
      return;
    }

    // Immediately reflect locally (don’t wait for the membership listener).
    App.membershipMap.delete(id);
    App.roomsMetaCache.delete(id);
    const pins = App.getPinnedRoomSet();
    if (pins.delete(id)) App.setPinnedRoomSetLocal(pins);
    App.scheduleRoomsListCacheSave();
    App.renderRoomsList();

    // If we’re on Home overview, refresh it live (but never interrupt Schedules)
    const place = App.getStoredPlace() || "home";
    if (!App.currentRoomId && App.views.chat.dataset.active === "true" && place === "home") {
      App.clearMessagesToHome();
    }
    // If we left the current room, go home
    if (App.currentRoomId === id) App.showLoggedInHome();
    App.showToast({
      title: "Left room",
      body: `Removed ${displayName} from your list.`,
      duration: 2200
    });
  }, {
    once: true
  });
};
App.roomModalTabsHTML = function (mode) {
  return `
    <div style="width:100%">
      <div class="room-modal-switch" role="tablist" aria-label="Room actions">
        <button class="room-mode-btn ${mode === "create" ? "is-active" : ""}" id="room-mode-create" type="button" aria-pressed="${mode === "create"}">Create</button>
        <button class="room-mode-btn ${mode === "join" ? "is-active" : ""}" id="room-mode-join" type="button" aria-pressed="${mode === "join"}">Join</button>
      </div>
    </div>
  `;
};
App.roomCreateBodyHTML = function () {
  return `
    <div class="room-create-stack">
      <div>
        <div class="label">Room Name</div>
        <input class="input" id="room-modal-code" maxlength="20" placeholder="e.g. 1 or ABC123" />
      </div>
      <div>
        <div class="label">Room Password</div>
        <input class="input" id="room-modal-password" maxlength="64" autocomplete="off" placeholder="Leave blank for public" />
      </div>

      <input id="room-create-icon-file" type="file" accept="image/png,image/jpeg,image/jpg,image/gif" hidden />

      <div class="upload">
        <div class="upload-ui">
          <div class="upload-left">
            <div class="avatar-wrap">
              <div class="avatar-ring" style="width:132px; height:132px">
                <div class="avatar-clip" id="room-create-icon-clip">
                  <img id="room-create-icon-img" alt="Room Icon" draggable="false" />
                </div>
              </div>
            </div>
            <div class="upload-text">
              <div class="strong">Room icon</div>
              <div class="muted small">Choose a PNG, JPG, or GIF, then drag and zoom to crop it.</div>
            </div>
          </div>

          <div style="display:flex; gap:10px">
            <button class="btn tiny" id="btn-room-create-icon-choose" type="button">Choose</button>
            <button class="btn tiny" id="btn-room-create-icon-use-default" type="button">Use Default</button>
          </div>
        </div>
      </div>

      <div class="crop-controls" id="room-create-icon-controls">
        <div class="row">
          <div class="muted small">Drag the picture in the circle.</div>
        </div>
        <div class="row">
          <label class="label small" for="room-create-icon-zoom">Zoom</label>
          <input id="room-create-icon-zoom" type="range" min="1.0" max="3.0" step="0.01" value="1.0" style="width:100%" />
        </div>
        <div class="row">
          <button class="btn tiny" id="btn-room-create-icon-center" type="button">Center</button>
          <button class="btn tiny" id="btn-room-create-icon-reset" type="button">Reset</button>
        </div>
      </div>
    </div>
  `;
};
App.roomJoinBodyHTML = function () {
  return `
    <div>
      <div class="label">Room Name</div>
      <input class="input" id="room-modal-code" maxlength="20" placeholder="e.g. 1 or ABC123" />
      <div class="label">Room Password</div>
      <input class="input" id="room-modal-password" maxlength="64" autocomplete="off" placeholder="Leave blank for public rooms" />
    </div>
  `;
};
App.bindCreateRoomIconPicker = function () {
  const clip = App.$("room-create-icon-clip");
  const img = App.$("room-create-icon-img");
  const input = App.$("room-create-icon-file");
  const zoom = App.$("room-create-icon-zoom");
  const btnChoose = App.$("btn-room-create-icon-choose");
  const btnUseDefault = App.$("btn-room-create-icon-use-default");
  const btnCenter = App.$("btn-room-create-icon-center");
  const btnReset = App.$("btn-room-create-icon-reset");
  if (!clip || !img || !input || !zoom || !btnChoose || !btnUseDefault || !btnCenter || !btnReset) {
    return {
      getPayload() {
        return {
          photoDataURL: null,
          photoTransform: null
        };
      }
    };
  }
  img.addEventListener("dragstart", e => e.preventDefault());
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const state = {
    dataURL: App.defaultStickmanDataURL(),
    scale: 1,
    x: 0,
    y: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
    pointerId: null,
    useDefault: true
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
  function resetToDefault() {
    state.dataURL = App.defaultStickmanDataURL();
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    state.useDefault = true;
    zoom.value = "1";
    applyPreview();
  }
  resetToDefault();
  requestAnimationFrame(() => requestAnimationFrame(applyPreview));
  btnChoose.addEventListener("click", () => input.click());
  btnUseDefault.addEventListener("click", () => resetToDefault());
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
    if (e.button !== 0) return;
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
    state.x = state.startX + (e.clientX - state.dragStartX);
    state.y = state.startY + (e.clientY - state.dragStartY);
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
      state.useDefault = false;
      zoom.value = "1";
      applyPreview();
    } catch {
      App.showToast({
        title: "Read failed",
        body: "Could not read that file.",
        duration: 2600
      });
    }
  });
  return {
    getPayload() {
      if (state.useDefault) {
        return {
          photoDataURL: null,
          photoTransform: null
        };
      }
      return {
        photoDataURL: state.dataURL,
        photoTransform: packTransform()
      };
    }
  };
};
App.openRoomPasswordModal = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  const meta = id ? App.roomsMetaCache.get(id) || null : null;
  if (!id || !App.currentUser || !App.membershipMap.has(id) || !App.isPrivateRoomMeta(meta)) return;
  const password = String(meta?.password || "").trim();
  const legacyOnly = !password && String(meta?.passwordHash || "").trim();
  const displayPassword = password || (legacyOnly ? "Legacy password unavailable until migrated" : "No password set");
  App.openModal({
    title: "Room Password",
    bodyHTML: `
      <div class="label">Room Password</div>
      <input class="input mono-input" id="room-password-display" type="text" value="${App.escapeAttr(displayPassword)}" readonly />
      ${legacyOnly ? `<p class="muted small" style="margin-top:10px">This room still has a legacy hashed password. It will migrate to the password field after the next successful password join.</p>` : ""}
    `,
    actionsHTML: `<button class="btn primary" id="btn-copy-room-password" type="button"${password ? "" : " disabled"}>Copy</button>`
  });
  const input = App.$("room-password-display");
  App.$("btn-copy-room-password")?.addEventListener("click", async () => {
    if (!password) return;
    await App.copyTextToClipboard(password);
    try {
      input?.select?.();
    } catch {}
    App.showToast({
      title: "Copied",
      body: "Room password copied.",
      duration: 1800
    });
  });
};
App.openToggleRoomAccessModal = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  const meta = id ? App.roomsMetaCache.get(id) || null : null;
  if (!id || !App.currentUser || meta?.createdBy !== App.currentUser.code) return;
  if (App.isPrivateRoomMeta(meta)) {
    App.db.ref(`rooms/${id}`).update({
      private: false,
      password: null,
      passwordHash: null
    }).then(() => {
      App.roomsMetaCache.set(id, {
        ...(App.roomsMetaCache.get(id) || {}),
        private: false,
        password: null,
        passwordHash: null
      });
      App.refreshRoomIconSurfaces(id);
      App.showToast({
        title: "Room is public",
        body: `${App.roomDisplayName(id)} is now public.`,
        duration: 2200
      });
    }).catch(() => App.showToast({
      title: "Update failed",
      body: "Could not toggle room access.",
      duration: 2600
    }));
    return;
  }
  App.openModal({
    title: "Private Room Password",
    bodyHTML: `
      <div class="label">Room Password</div>
      <input class="input" id="toggle-room-password" maxlength="64" autocomplete="off" placeholder="Password" />
    `,
    actionsHTML: `<button class="btn primary" id="btn-toggle-room-access-save" type="button">Make Private</button>`
  });
  App.$("btn-toggle-room-access-save")?.addEventListener("click", async () => {
    const password = App.sanitizeRoomPassword(App.$("toggle-room-password")?.value || "");
    if (!password) {
      App.showToast({
        title: "Invalid password",
        body: "Enter a password that is not empty spaces.",
        duration: 2600
      });
      return;
    }
    try {
      await App.db.ref(`rooms/${id}`).update({
        private: true,
        password,
        passwordHash: null
      });
      App.roomsMetaCache.set(id, {
        ...(App.roomsMetaCache.get(id) || {}),
        private: true,
        password,
        passwordHash: null
      });
      App.refreshRoomIconSurfaces(id);
      App.closeModal();
      App.showToast({
        title: "Room is private",
        body: `${App.roomDisplayName(id)} now requires a password.`,
        duration: 2200
      });
    } catch {
      App.showToast({
        title: "Update failed",
        body: "Could not toggle room access.",
        duration: 2600
      });
    }
  });
};
App.openRoomComposerModal = function (mode = "create") {
  if (!App.currentUser) return;
  App.openModal({
    title: " ",
    bodyHTML: mode === "create" ? App.roomCreateBodyHTML() : App.roomJoinBodyHTML(),
    actionsHTML: `
      <button class="btn primary" id="btn-room-modal-confirm" type="button">${mode === "create" ? "Create" : "Join"}</button>
    `
  });
  App.$("modal-title").innerHTML = App.roomModalTabsHTML(mode);
  App.$("room-mode-create")?.addEventListener("click", () => App.openRoomComposerModal("create"));
  App.$("room-mode-join")?.addEventListener("click", () => App.openRoomComposerModal("join"));
  if (mode === "create") {
    const iconPicker = App.bindCreateRoomIconPicker();
    App.$("btn-room-modal-confirm").addEventListener("click", async () => {
      const roomName = App.sanitizeRoomName(App.$("room-modal-code")?.value || "");
      let roomId = App.sanitizeRoomCode(roomName);
      const passwordRaw = App.$("room-modal-password")?.value || "";
      const password = passwordRaw.trim() ? App.sanitizeRoomPassword(passwordRaw) : null;
      if (!roomId || !roomName) {
        App.showToast({
          title: "Invalid name",
          body: "Room name must be 1–20 printable characters and cannot include . # $ [ ] or /.",
          duration: 2600
        });
        return;
      }
      if (passwordRaw.trim() && !password) {
        App.showToast({
          title: "Invalid password",
          body: "Room password must use printable keyboard characters and cannot be only spaces.",
          duration: 2600
        });
        return;
      }
      const iconPayload = iconPicker.getPayload();
      try {
        roomId = await App.createNamedRoom(roomName, {
              name: roomName,
              private: !!password,
              password,
              passwordHash: null,
              createdAt: App.firebase.database.ServerValue.TIMESTAMP,
              createdBy: App.currentUser.code,
              lastMessageAt: 0,
              lastMessagePreview: "",
              messageCount: 0,
              photoDataURL: iconPayload.photoDataURL,
              photoTransform: iconPayload.photoTransform
        });
        if (!roomId) {
          App.showToast({
            title: "Room exists",
            body: "A room with that name already exists.",
            duration: 2600
          });
          return;
        }
        await App.joinRoomMembership(roomId, 0);
        App.membershipMap.set(roomId, {
          joinedAt: Date.now(),
          lastSeenAt: 0,
          lastSeenCount: 0
        });
        App.closeModal();
        App.showToast({
          title: "Room created",
          body: `Room ${roomName} is ready.`,
          duration: 2200
        });
        App.openRoom(roomId);
      } catch (e) {
        console.error("create room failed:", e);
        App.showToast({
          title: "Create failed",
          body: "Check console / rules.",
          duration: 2800
        });
      }
    });
    return;
  }
  App.$("btn-room-modal-confirm").addEventListener("click", async () => {
    const roomName = App.sanitizeRoomName(App.$("room-modal-code")?.value || "");
    let roomId = App.sanitizeRoomCode(roomName);
    const passwordRaw = App.$("room-modal-password")?.value || "";
    const password = passwordRaw.trim() ? App.sanitizeRoomPassword(passwordRaw) : null;
    if (!roomId || !roomName) {
      App.showToast({
        title: "Invalid name",
        body: "Enter a valid room name.",
        duration: 2400
      });
      return;
    }
    if (passwordRaw.trim() && !password) {
      App.showToast({
        title: "Invalid password",
        body: "Room password must use printable keyboard characters and cannot be only spaces.",
        duration: 2600
      });
      return;
    }
    try {
      const found = await App.findRoomByName(roomName);
      if (!found) {
        App.showToast({
          title: "Not found",
          body: "That room doesn’t exist. Create it first.",
          duration: 2800
        });
        return;
      }
      roomId = found.id;
      const roomMeta = found.meta || {};
      if (App.isPrivateRoomMeta(roomMeta) && !password) {
        App.showToast({
          title: "Password required",
          body: "Password required",
          duration: 2600
        });
        return;
      }
      if (App.isPrivateRoomMeta(roomMeta)) {
        const ok = await App.verifyRoomPassword(roomMeta, password, roomId);
        if (!ok) {
          App.showToast({
            title: "Incorrect password",
            body: "That password is incorrect.",
            duration: 2600
          });
          return;
        }
      }
      const roomMessageCount = Math.max(0, Number(roomMeta?.messageCount) || 0);
      await App.joinRoomMembership(roomId, roomMessageCount);
      App.membershipMap.set(roomId, {
        joinedAt: Date.now(),
        lastSeenAt: 0,
        lastSeenCount: roomMessageCount
      });
      App.closeModal();
      App.showToast({
        title: "Joined",
        body: `Room ${App.roomDisplayName(roomId, roomMeta)}.`,
        duration: 1800
      });
      App.openRoom(roomId);
    } catch (e) {
      console.error("join room failed:", e);
      App.showToast({
        title: "Join failed",
        body: "Check console / rules.",
        duration: 2800
      });
    }
  });
};

App.register("rooms/management", function initializeFeature() {
App.$("btn-room-plus")?.addEventListener("click", () => App.openRoomComposerModal("create"));
});
})(globalThis.ChatApp);
