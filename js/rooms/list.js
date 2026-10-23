/* rooms/list: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.setRoomsCount = function (n) {
  const count = Number(n) || 0;
  const mini = App.$("rooms-mini");
  if (mini) {
    mini.textContent = String(count);
    mini.setAttribute("aria-label", `${count} ${count === 1 ? "room" : "rooms"}`);
  }
  if (App.roomsBlockEl) App.roomsBlockEl.hidden = count <= 0;
};
App.getSidebarRoomVisibilityState = function (allRooms = App.getSortedRoomEntries()) {
  const publicRooms = [];
  const privateRooms = [];
  for (const room of allRooms) {
    const meta = App.roomsMetaCache.get(room.roomId) || null;
    if (App.isPrivateRoomMeta(meta)) privateRooms.push(room);else publicRooms.push(room);
  }
  const hasPublic = publicRooms.length > 0;
  const hasPrivate = privateRooms.length > 0;
  const canToggle = hasPublic && hasPrivate;
  if (hasPublic && !App.sidebarRoomsHadPublic) {
    App.sidebarRoomsMode = "public";
  } else if (!hasPublic && hasPrivate) {
    App.sidebarRoomsMode = "all";
  } else if (!hasPrivate) {
    App.sidebarRoomsMode = "public";
  }
  App.sidebarRoomsHadPublic = hasPublic;
  const showAll = canToggle ? App.sidebarRoomsMode === "all" : !hasPublic && hasPrivate;
  return {
    allRooms,
    visibleRooms: showAll ? allRooms : publicRooms,
    hasPublic,
    hasPrivate,
    canToggle,
    showAll
  };
};
App.syncRoomsListToggleUI = function (state) {
  if (!App.roomsBlockEl) return;
  const title = state.showAll ? "All Rooms" : "Public Rooms";
  if (App.roomsTitleEl) App.roomsTitleEl.textContent = title;
  if (App.roomsSubtitleEl) {
    App.roomsSubtitleEl.textContent = state.showAll ? "Public and private rooms" : "Public rooms";
    App.roomsSubtitleEl.hidden = !state.showAll;
  }
  App.roomsBlockEl.classList.toggle("rooms-toggleable", !!state.canToggle);
  App.roomsBlockEl.classList.toggle("rooms-showing-all", !!state.showAll);
  App.roomsBlockEl.classList.toggle("rooms-has-private", !!state.hasPrivate);
  App.roomsBlockEl.setAttribute("aria-label", title);
  App.roomsBlockEl.removeAttribute("title");
  App.roomsBlockEl.removeAttribute("role");
  App.roomsBlockEl.removeAttribute("tabindex");
  App.roomsBlockEl.removeAttribute("aria-pressed");
  if (App.roomsModeToggleEl) {
    App.roomsModeToggleEl.hidden = !state.canToggle;
    App.roomsModeToggleEl.setAttribute("aria-pressed", state.showAll ? "true" : "false");
    const label = state.showAll ? "Show Public Rooms" : "Show All Rooms";
    App.roomsModeToggleEl.setAttribute("aria-label", label);
    App.roomsModeToggleEl.dataset.tooltip = label;
  }
};
App.toggleSidebarRoomsMode = function () {
  const state = App.getSidebarRoomVisibilityState();
  if (!state.canToggle) return;
  App.sidebarRoomsMode = state.showAll ? "public" : "all";
  App.roomsListLastSig = "";
  App.renderRoomsList();
};
App.isRoomsListChromeTarget = function (target) {
  return !!(target && App.roomsBlockEl?.contains?.(target) && !target.closest?.(".room-row, button, a, input, textarea, select, [contenteditable='true']"));
};
App.stopRoomMetaListeners = function () {
  for (const {
    ref,
    cb
  } of App.roomMetaListeners.values()) {
    try {
      ref.off("value", cb);
    } catch {}
  }
  App.roomMetaListeners.clear();
};
App.ensureRoomMetaListener = function (roomId) {
  if (App.roomMetaListeners.has(roomId)) return;
  const ref = App.fieldGroupRef(`rooms/${roomId}`, ["name", "nameLower", "createdBy", "createdAt", "private", "password", "passwordHash", "photoDataURL", "photoTransform", "lastMessageAt", "lastMessagePreview", "lastMessageKey", "messageCount", "messagesClearedAt"]);
  const cb = async snap => {
    const value = snap.val();
    const meta = value?.name || value?.createdBy ? value : null;
    const prevMeta = App.roomsMetaCache.get(roomId) || null;
    const displayName = App.roomDisplayName(roomId, meta || prevMeta);

    // Room deleted: force everyone out and reset UI.
    if (!meta) {
      App.roomsMetaCache.delete(roomId);

      // Prevent “ghost rooms” (don’t wait for the membership listener to eventually catch up).
      App.membershipMap.delete(roomId);
      App.scheduleRoomsListCacheSave();
      App.renderRoomsList();

      // Best-effort: remove membership in DB too (cleans up other devices).
      try {
        if (App.currentUser?.code) await App.db.ref(`memberships/${App.currentUser.code}/${roomId}`).remove();
      } catch {}

      // Stop listening to meta for a room that no longer exists.
      const rec = App.roomMetaListeners.get(roomId);
      if (rec) {
        try {
          rec.ref.off("value", rec.cb);
        } catch {}
      }
      App.roomMetaListeners.delete(roomId);
      if (App.currentRoomId === roomId) {
        App.clearReplyState({
          quiet: true
        });
        App.clearPendingFiles({
          quiet: true
        });
        App.$("msg-input").value = "";
        App.showLoggedInHome();
        App.showToast({
          title: "Room deleted",
          body: `${displayName} was deleted.`,
          duration: 2400
        });
      } else {
        // If we’re on Home overview, refresh it live (but never interrupt Schedules)
        const place = App.getStoredPlace() || "home";
        if (!App.currentRoomId && App.views.chat.dataset.active === "true" && place === "home") {
          App.clearMessagesToHome();
        }
      }
      return;
    }
    App.roomsMetaCache.set(roomId, meta);
    if (prevMeta?.photoDataURL !== meta.photoDataURL || JSON.stringify(prevMeta?.photoTransform) !== JSON.stringify(meta.photoTransform)) {
      App.refreshRenderedRoomIcon(roomId);
    }
    const changedOutsideMedia = !prevMeta || [...new Set([...Object.keys(prevMeta), ...Object.keys(meta)])]
      .some(key => key !== "photoDataURL" && key !== "photoTransform" && JSON.stringify(prevMeta[key]) !== JSON.stringify(meta[key]));
    if (!changedOutsideMedia) {
      App.scheduleRoomsListCacheSave();
      App.updateRoomListItem(roomId);
      return;
    }
    if ((Number(meta.messagesClearedAt) || 0) !== (Number(prevMeta?.messagesClearedAt) || 0)) {
      if (prevMeta) App.cancelRoomMessageWork?.(roomId);
      App.invalidateRecentRoomMessages?.(roomId);
      // A clear can retain pins, so the message query need not become empty.
      // Retire cached/in-flight history on the metadata epoch as well.
      App.invalidateMessageHistory?.(roomId);
      App.mergePendingRoomRead?.(roomId, App.membershipMap.get(roomId));
      App.syncUnreadTaskbarBadge?.();
    }
    if (prevMeta?.name !== meta.name) {
      App.refreshRoomNameUI?.(roomId);
    }
    App.scheduleRoomsListCacheSave();
    App.renderRoomsList();
    if (App.isRoomActivelyRead(roomId)) App.scheduleLastSeenBump(roomId);
    // If we’re on Home overview, refresh it live (but never interrupt Schedules)
    const place = App.getStoredPlace() || "home";
    if (!App.currentRoomId && App.views.chat.dataset.active === "true" && place === "home") {
      App.clearMessagesToHome();
    }
  };
  App.roomMetaListeners.set(roomId, { ref, cb });
  ref.on("value", cb);
};
App.applySidebarRoomAvatar = function (row, meta) {
  const avatarEl = row?._avatarEl || row?.querySelector(".room-avatar-image");
  if (!avatarEl) return;
  App.applyRoomIcon(avatarEl, row.dataset.roomRow, meta);
};
App.refreshRoomIconSurfaces = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  App.scheduleRoomsListCacheSave();
  App.updateRoomListItem(id);
  App.refreshRenderedRoomIcon(id);
};
App.getSidebarRoomPreview = function (meta) {
  return String(meta?.lastMessagePreview || "No recent messages");
};
App.renderSidebarRoomPreview = function (target, meta) {
  if (!target) return;
  const raw = App.getSidebarRoomPreview(meta).trim() || "No recent messages";
  const separator = raw.indexOf(": ");
  target.replaceChildren();
  delete target.dataset.tooltip;
  if (separator > 0 && separator < 36) {
    const author = document.createElement("span");
    author.className = "room-preview-author";
    author.textContent = raw.slice(0, separator);
    const message = document.createElement("span");
    message.className = "room-preview-text";
    message.textContent = raw.slice(separator + 2) || "Message";
    target.append(author, document.createTextNode(": "), message);
    return;
  }
  const message = document.createElement("span");
  message.className = "room-preview-text";
  message.textContent = raw;
  target.appendChild(message);
};
App.syncSidebarRoomActiveStates = function () {
  const activeRoomId = App.sanitizeRoomCode(App.currentRoomId);
  const shouldShowActive = !!activeRoomId && App.views.chat.dataset.active === "true";
  const rows = App.roomsListEl ? App.roomsListEl.querySelectorAll(".room-row") : [];
  rows.forEach(row => {
    const rowRoomId = App.sanitizeRoomCode(row.getAttribute("data-room-row"));
    row.classList.toggle("active", shouldShowActive && rowRoomId === activeRoomId);
  });
};
App.updateRoomListItem = function (roomId) {
  App.syncUnreadTaskbarBadge?.();
  const row = App.roomRowCache.get(roomId) || document.querySelector(`[data-room-row="${CSS.escape(roomId)}"]`);
  if (!row) return;
  const meta = App.getRoomDisplayMeta?.(roomId) || App.roomsMetaCache.get(roomId) || null;
  const titleEl = row._titleEl || row.querySelector(".room-name");
  const previewEl = row._previewEl || row.querySelector(".room-preview");
  const unreadLabelEl = row._unreadLabelEl || row.querySelector(".room-new-messages");
  const pinHostEl = row._pinHostEl || row.querySelector(".room-markers");
  const displayName = App.roomDisplayName(roomId, meta);
  if (titleEl) titleEl.textContent = displayName;
  row.setAttribute("aria-label", `Open room ${displayName}`);
  const avatarImg = row._avatarEl || row.querySelector(".room-avatar-image");
  if (avatarImg) avatarImg.alt = `Room ${displayName} icon`;
  App.renderSidebarRoomPreview(previewEl, meta);
  if (unreadLabelEl) {
    const missedCount = App.getRoomMissedCount(roomId);
    const missedText = App.formatNewMessagesLabel(missedCount);
    unreadLabelEl.hidden = !missedCount;
    unreadLabelEl.textContent = missedText;
    unreadLabelEl.dataset.count = missedCount > 99 ? "99+" : String(missedCount);
    unreadLabelEl.setAttribute("aria-label", missedText);
    row.setAttribute("aria-label", `Open room ${displayName}${missedCount ? `. ${missedText}` : ""}`);
  }
  if (pinHostEl) {
    const pinMark = App.getPinnedRoomSet().has(roomId) ? `<span class="room-pin-mark" aria-label="Pinned Room" data-tooltip="Pinned">${App.roomPinBadgeSVG()}</span>` : "";
    pinHostEl.innerHTML = `${App.privateRoomMarkHTML(meta)}${pinMark}`;
  }
  App.applySidebarRoomAvatar(row, meta);
  row.classList.toggle("active", App.sanitizeRoomCode(App.currentRoomId) === roomId && App.views.chat.dataset.active === "true");
};
App.renderRoomsList = function () {
  App.syncUnreadTaskbarBadge?.();
  if (!App.roomsListEl) return;
  const allRooms = App.getSortedRoomEntries();
  for (const room of allRooms) {
    App.ensureRoomMetaListener(room.roomId);
  }
  const state = App.getSidebarRoomVisibilityState(allRooms);
  const rooms = state.visibleRooms;
  const allIds = allRooms.map(item => item.roomId);
  const ids = rooms.map(item => item.roomId);
  const keep = new Set(allIds);
  for (const rid of Array.from(App.roomMetaListeners.keys())) {
    if (keep.has(rid)) continue;
    const rec = App.roomMetaListeners.get(rid);
    if (rec) {
      try {
        rec.ref.off("value", rec.cb);
      } catch {}
    }
    App.roomMetaListeners.delete(rid);
    App.roomsMetaCache.delete(rid);
  }
  App.setRoomsCount(allIds.length);
  App.syncRoomsListToggleUI(state);
  const sig = [state.showAll ? "all" : "public", state.canToggle ? 1 : 0, ...rooms.map(item => {
    const meta = App.roomsMetaCache.get(item.roomId) || null;
    return `${item.roomId}:${item.displayName}:${App.isPrivateRoomMeta(meta) ? 1 : 0}:${item.pinned ? 1 : 0}:${item.missedCount}:${item.lastAt}`;
  })].join("|");
  if (sig === App.roomsListLastSig) {
    for (const room of rooms) {
      App.ensureRoomMetaListener(room.roomId);
      App.updateRoomListItem(room.roomId);
    }
    return;
  }
  App.roomsListLastSig = sig;
  const keepRows = new Set(ids);
  for (const rid of Array.from(App.roomRowCache.keys())) {
    if (keepRows.has(rid)) continue;
    const row = App.roomRowCache.get(rid);
    if (row) row.remove();
    App.roomRowCache.delete(rid);
  }
  let cursor = App.roomsListEl.firstElementChild;
  for (const room of rooms) {
    const roomId = room.roomId;
    App.ensureRoomMetaListener(roomId);
    const meta = App.getRoomDisplayMeta?.(roomId) || App.roomsMetaCache.get(roomId) || null;
    let row = App.roomRowCache.get(roomId);
    if (!row) {
      row = document.createElement("div");
      row.className = "room-row";
      row.setAttribute("data-room-row", roomId);
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Open room ${App.roomDisplayName(roomId, meta)}`);
      const left = document.createElement("div");
      left.className = "room-left";
      const avatar = document.createElement("div");
      avatar.className = "room-avatar";
      const avatarImg = document.createElement("img");
      avatarImg.className = "room-avatar-image";
      avatarImg.alt = `Room ${App.roomDisplayName(roomId, meta)} icon`;
      avatarImg.draggable = false;
      avatar.appendChild(avatarImg);
      const content = document.createElement("div");
      content.className = "room-content";
      const nameRow = document.createElement("div");
      nameRow.className = "room-name-row";
      const title = document.createElement("div");
      title.className = "room-name";
      title.textContent = App.roomDisplayName(roomId, meta);
      const unreadLabel = document.createElement("span");
      unreadLabel.className = "room-new-messages";
      unreadLabel.hidden = true;
      const markers = document.createElement("div");
      markers.className = "room-markers";
      const metaRow = document.createElement("div");
      metaRow.className = "room-meta";
      const preview = document.createElement("div");
      preview.className = "room-preview";
      row._avatarEl = avatarImg;
      row._titleEl = title;
      row._previewEl = preview;
      row._unreadLabelEl = unreadLabel;
      row._pinHostEl = markers;
      nameRow.appendChild(title);
      nameRow.appendChild(unreadLabel);
      nameRow.appendChild(markers);
      metaRow.appendChild(preview);
      content.appendChild(nameRow);
      content.appendChild(metaRow);
      left.appendChild(avatar);
      left.appendChild(content);
      const openThisRoom = () => App.openRoom(roomId);
      row.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        App.openRoomButtonContextMenu(e, roomId, row);
      });
      row.addEventListener("click", () => {
        openThisRoom();
      });
      row.addEventListener("keydown", e => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        openThisRoom();
      });
      row.appendChild(left);
      App.roomRowCache.set(roomId, row);
    }
    const previewEl = row._previewEl || row.querySelector(".room-preview");
    App.renderSidebarRoomPreview(previewEl, meta);
    App.applySidebarRoomAvatar(row, meta);
    App.updateRoomListItem(roomId);
    if (row !== cursor) {
      App.roomsListEl.insertBefore(row, cursor);
    } else {
      cursor = cursor.nextElementSibling;
    }
  }
};

App.register("rooms/list", function initializeFeature() {
App.roomsBlockEl = App.$("rooms-list-card") || document.querySelector(".rooms-block.side-section");
App.roomsTitleEl = App.$("rooms-title");
App.roomsSubtitleEl = App.$("rooms-subtitle");
App.roomsModeToggleEl = App.$("rooms-mode-toggle");
App.sidebarRoomsMode = "public";
App.sidebarRoomsHadPublic = false;
App.roomsModeToggleEl?.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  App.toggleSidebarRoomsMode();
});
// Let wheel events use the browser's normal scroll chain. The list and the
// rest of the navigation then share the sidebar's native momentum and easing.
App.roomsListLastSig = "";
});
})(globalThis.ChatApp);
