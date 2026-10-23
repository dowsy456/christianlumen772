/* rooms/actions: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.hardClearComposerAndOverlays = function () {
  App.clearPendingPoll?.();
  try {
    App.cancelEditMessage({
      quiet: true
    });
  } catch {}
  try {
    App.clearReplyState({
      quiet: true
    });
  } catch {}
  try {
    App.clearPendingFiles({
      quiet: true
    });
  } catch {}
  try {
    App.closePingBar({
      quiet: true
    });
  } catch {}
  try {
    App.$("msg-input").value = "";
  } catch {}
  try {
    App.syncChatOverlayMetrics();
  } catch {}
  try {
    App.closeMsgMenu(true);
  } catch {}
};
App.readRoomAttachmentKeys = async function (roomId) {
  const base = String(App.firebaseConfig?.databaseURL || "").replace(/\/+$/, "");
  if (!base) return [];
  const url = new URL(`${base}/attachmentBlobs/${encodeURIComponent(roomId)}.json`);
  url.searchParams.set("shallow", "true");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const user = App.firebase?.auth?.()?.currentUser;
    if (user) url.searchParams.set("auth", await user.getIdToken());
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Attachment cleanup unavailable (${response.status}).`);
    const value = await response.json();
    return value && typeof value === "object" ? Object.keys(value).filter(key => !/[.#$\[\]/\u0000-\u001f\u007f]/.test(key)) : [];
  } finally { clearTimeout(timer); }
};
App.cleanupClearedAttachmentBlobs = async function (roomId, keys, retained, clearedAt) {
  const keep = new Set(Object.keys(retained || {}));
  const keepExternal = new Set();
  // Preserve the original owner too when a retained record references its files.
  for (const message of Object.values(retained || {})) {
    for (const file of Array.isArray(message?.files) ? message.files : []) {
      if (App.isExternalBlobDescriptor?.(file)) keepExternal.add(file.objectKey.split("/").slice(0, 3).join("/") + "/");
      const parts = String(file?.storagePath || "").split("/");
      if (parts.length === 5 && parts[0] === "attachmentBlobs" && parts[1] === roomId && parts[3] === "files") keep.add(parts[2]);
    }
  }
  const candidates = keys.filter(key => {
    const createdAt = Number(App.firebasePushKeyTimestamp?.(key)) || 0;
    return !keep.has(key) && !keepExternal.has(App.externalAttachmentPrefix?.(roomId, key)) && createdAt > 0 && createdAt <= clearedAt;
  });
  // Check only small identity leaves: cleanup never downloads old file bodies.
  // The key snapshot, cutoff, and live checks protect messages sent after clear.
  for (let offset = 0; offset < candidates.length; offset += 32) {
    const updates = {};
    await Promise.all(candidates.slice(offset, offset + 32).map(async key => {
      const [message, pin] = await Promise.all([
        App.db.ref(`messages/${roomId}/${key}/createdAt`).once("value"),
        App.db.ref(`pinnedMessages/${roomId}/${key}/createdAt`).once("value")
      ]);
      if (message.val() == null && pin.val() == null) {
        const provider = (await App.db.ref(`attachmentBlobs/${roomId}/${key}/files/0/provider`).once("value")).val();
        if (provider === "b2-worker-v1") await App.deleteExternalBlobPrefix(App.externalAttachmentPrefix(roomId, key));
        updates[`attachmentBlobs/${roomId}/${key}`] = null;
      }
    }));
    if (Object.keys(updates).length) await App.db.ref().update(updates);
  }
};
App.clearRoomMessages = async function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.isVinny()) return false;

  // A key-only snapshot protects later sends. If this read fails, leave the
  // room untouched rather than claim that its external files were deleted.
  const attachmentKeys = await App.readRoomAttachmentKeys(id);
  const pinSnapshot = await App.db.ref(`pinnedMessages/${id}`).once("value");
  const retained = pinSnapshot.val() || {};
  const pendingPins = Object.keys(retained);
  const retiredPins = {};
  // Refresh only pinned records in small batches; polls/media may have changed
  // since the pin was created. Their retained fallback also supports old clears.
  for (let offset = 0; offset < pendingPins.length; offset += 8) {
    await Promise.all(pendingPins.slice(offset, offset + 8).map(async key => {
      const snapshot = await App.db.ref(`messages/${id}/${key}`).once("value");
      const current = snapshot.val();
      if (current && !current.pinned) { delete retained[key]; retiredPins[`pinnedMessages/${id}/${key}`] = null; }
      else if (current) retained[key] = current;
    }));
  }
  // Read only the retained pin index, never scan the room's message history.
  const pinnedKeys=Object.keys(retained);
  // One atomic write clears the stream, receipts, polls and room metadata.
  // Firebase immediately delivers its local events and rolls back on denial;
  // the live room listener performs the same reset on every connected client.
  const clearedMetaPatch = {
    messagesClearedAt: App.pollNow(),
    countedSystemMessages: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    messageCount: pinnedKeys.length
  };
  App.invalidateRecentRoomMessages?.(id);
  App.invalidateMessageHistory?.(id, { resetTail: false });
  App.cancelRoomMessageWork?.(id, new Set(pinnedKeys));
  await App.db.ref().update({ [`messages/${id}`]: pinnedKeys.length ? retained : null, [`activePolls/${id}`]: null, [`readReceipts/${id}`]: { _clearedAt: clearedMetaPatch.messagesClearedAt },
    ...retiredPins,
    ...Object.fromEntries(Object.entries(clearedMetaPatch).map(([key, value]) => [`rooms/${id}/${key}`, value])) });
  try {
    await App.cleanupClearedAttachmentBlobs(id, attachmentKeys, retained, clearedMetaPatch.messagesClearedAt);
  } catch (error) {
    // The compact index remains until provider deletion is acknowledged, so
    // repeating Clear retries cleanup without downloading old file bodies.
    throw new Error(`Messages were cleared, but file cleanup failed. Use Clear Messages again to retry. ${error?.message || ""}`);
  }
  // Auxiliary cleanup must never hold the visible clear hostage, reload the
  // room, or overwrite reads/new messages that arrived after the clear.
  void (async () => {
    const ms = await App.db.ref(`roomMembers/${id}`).once("value");
    const updates = {};
    for (const userCode of Object.keys(ms.val() || {})) {
        updates[`users/${userCode}/prefs/videoPlayerByRoom/${id}`] = null;
    }
    if (Object.keys(updates).length) await App.db.ref().update(updates);
  })().catch(error => console.warn("Room preference cleanup unavailable", error?.code));
  return true;
};
App.confirmClearRoomMessages = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.isVinny()) return;
  const displayName = App.roomDisplayName(id, App.roomsMetaCache.get(id) || null);
  App.openModal({
    title: "Clear Messages",
    bodyHTML: `
      <div class="muted small">
        This will permanently clear every unpinned message in <span class="strong">${App.escapeHtml(displayName)}</span> for everyone in the room.
      </div>
    `,
    actionsHTML: `
      <button class="btn danger" id="btn-confirm-clear-room-messages" type="button">Clear Messages</button>
    `
  });
  App.$("btn-confirm-clear-room-messages")?.addEventListener("click", async () => {
    const confirmBtn = App.$("btn-confirm-clear-room-messages");
    if (confirmBtn) confirmBtn.disabled = true;
    App.closeModal();
    try {
      const cleared = await App.clearRoomMessages(id);
      if (!cleared) return;
      App.showToast({
        title: "Messages cleared",
        body: `Cleared unpinned messages in ${displayName}.`,
        duration: 2200
      });
    } catch (err) {
      console.error("clear room messages failed:", err);
      App.showToast({
        title: "Clear failed",
        body: err?.message || "Could not clear that room's messages. Check console / rules.",
        duration: 2800
      });
    }
  }, {
    once: true
  });
};
App.deleteRoomEverywhere = async function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.isVinny()) return;
  const lock = await App.acquireRoomNameLock(id);
  try {
  const roomName = (await App.db.ref(`rooms/${id}/name`).once("value")).val() || id;
  const fileKeys = await App.readRoomAttachmentKeys(id);
  let hasExternalFiles = false;
  for (let offset = 0; offset < fileKeys.length && !hasExternalFiles; offset += 16) {
    const providers = await Promise.all(fileKeys.slice(offset, offset + 16).map(key => App.db.ref(`attachmentBlobs/${id}/${key}/files/0/provider`).once("value")));
    hasExternalFiles = providers.some(snapshot => snapshot.val() === "b2-worker-v1");
  }
  let externalStorageReady = false;
  try { App.assertExternalStorageConfigured(); externalStorageReady = true; }
  catch (error) { if (hasExternalFiles) throw error; }
  // List keys only, never download users' settings, images or personal data.
  // Former members can still have a pin or playback setting for this room.
  const base = String(App.firebaseConfig.databaseURL).replace(/\/+$/, "");
  const response = await fetch(`${base}/users.json?shallow=true`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Could not read the account index for room cleanup.");
  const users = await response.json();

  // Root multi-path delete (null removes)
  const updates = {
    [`rooms/${id}`]: null,
    [`messages/${id}`]: null,
    [`pinnedMessages/${id}`]: null,
    ...(externalStorageReady ? {} : { [`attachmentBlobs/${id}`]: null }),
    [`calls/${id}`]: null
  };
  updates[`activePolls/${id}`] = null;
  updates[`roomSystemEvents/${id}`] = null;
  updates[`pendingCallEnds/${id}`] = null;
  updates[`roomMembers/${id}`] = null;
  updates[`readReceipts/${id}`] = null;
  updates[`activities/boplRoyale/rooms/${id}`] = null;
  updates[`activities/mergeParty/rooms/${id}`] = null;
  for (const userCode of Object.keys(users || {})) {
    updates[`memberships/${userCode}/${id}`] = null;
    updates[`users/${userCode}/prefs/videoPlayerByRoom/${id}`] = null;
    updates[`users/${userCode}/${App.ADMIN_GHOST_ROOMS_NODE}/${id}`] = null;
    updates[`users/${userCode}/prefs/pinnedRooms/${id}`] = null;
    updates[`pings/${userCode}/${id}`] = null;
  }
  if (!lock.valid()) throw new Error("Connection lost during room deletion. Try again.");
  // Name and content disappear together while rename owns the same lock.
  updates[`roomNames/${App.sanitizeRoomCode(roomName)}`] = null;
  const deletedAt = App.pollNow();
  await App.db.ref().update(updates);
  // Snapshot after deleting the stream catches uploads committed during the
  // earlier reads. Later unfinished uploads fail their manifest transaction
  // and clean themselves. Per-message prefixes plus live identity checks keep
  // a newly recreated room with the same ID safe throughout cleanup/retry.
  if (externalStorageReady) {
    const cleanupFiles = async () => App.cleanupClearedAttachmentBlobs(id, await App.readRoomAttachmentKeys(id), {}, deletedAt);
    try { await cleanupFiles(); }
    catch (cause) {
      const error = new Error(`Room deleted, but file cleanup failed. Retry file cleanup to finish. ${cause?.message || ""}`);
      error.retryFileCleanup = cleanupFiles;
      throw error;
    }
  }
  if (App.pinnedRoomIds.has(id)) {
    const nextPins = App.getPinnedRoomSet();
    nextPins.delete(id);
    App.setPinnedRoomSetLocal(nextPins);
    App.refreshRoomCollectionsUI();
  }

  // If I’m in it, leave to Home immediately
  if (App.currentRoomId === id) {
    App.hardClearComposerAndOverlays();
    App.showLoggedInHome();
  }
  } finally { await lock.release(); }
};
App.syncFileUploadLimitInput = function () {
  const input = document.getElementById("panel-file-upload-limit");
  if (!input) return;
  const state = App.fileUploadLimitSaveState;
  const editing = state?.owner === App.currentUser?.code && state.editor === input;
  if (!editing || state.revision <= state.saved) input.value = String(App.fileUploadLimitMB ?? App.FILE_UPLOAD_LIMIT_DEFAULT_MB);
  input.disabled = !App.fileUploadLimitLoaded;
  const error = (editing && state.error) || App.fileUploadLimitError || "";
  input.setCustomValidity(error);
  input.title = error;
  if (error) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
};
App.openAdminPanel = function () {
  if (!App.isVinny()) return;
  let flushUpdateURL = () => {};
  let flushFileUploadLimit = () => {};
  App.openModal({
    title: "Admin Panel",
    bodyHTML: `
      <label class="label" for="panel-update-url" style="display:block;margin:0 0 10px">Update URL</label>
      <input class="input" id="panel-update-url" type="url" maxlength="4096" autocomplete="off" placeholder="https://drive.google.com/…" value="${App.escapeHtml(App.nativeUpdatePolicy?.url || "")}" style="width:100%">
      <div id="panel-update-status" class="muted small" role="status" style="margin-top:8px">${App.escapeHtml(App.nativeUpdatePolicyError || "Leave empty to allow older EXEs.")}</div>
      <div style="height:16px"></div>

      <div id="panel-file-upload-setting">
        <label class="label" for="panel-file-upload-limit" style="display:block;margin:0 0 10px">File Upload Limit</label>
        <input class="input" id="panel-file-upload-limit" type="text" inputmode="decimal" autocomplete="off" aria-label="File Upload Limit in MB" value="${App.escapeHtml(String(App.fileUploadLimitMB ?? App.FILE_UPLOAD_LIMIT_DEFAULT_MB))}" style="width:100%">
      </div>
      <div style="height:16px"></div>

      <div class="label" style="margin:0 0 10px">Schedule Type</div>
      <div class="settings-choice-row" id="panel-schedtypes">
        <button class="btn tiny" data-panel-schedtype="full" type="button">Full Day</button>
        <button class="btn tiny" data-panel-schedtype="half" type="button">Half Day</button>
        <button class="btn tiny" data-panel-schedtype="delay2" type="button">2 HR Delay</button>
        <button class="btn tiny" data-panel-schedtype="noschool" type="button">No School</button>
      </div>

      <div style="height:16px"></div>

      <div class="label" style="margin:0 0 10px">Account Creation</div>
      <div class="settings-choice-row" id="panel-account-creation">
        <button class="btn tiny" data-panel-account-creation="enabled" type="button">Enabled</button>
        <button class="btn tiny primary" data-panel-account-creation="disabled" type="button">Disabled</button>
      </div>

      <div style="height:16px"></div>

      <div class="label" style="margin:0 0 10px">Room Management</div>
      <div class="panel-rooms" id="panel-rooms"><div class="muted small">Loading…</div></div>
      <section class="panel-database" id="panel-database"></section>
    `,
    actionsHTML: "",
    onBeforeClose: () => { flushUpdateURL(); flushFileUploadLimit(); App.stopAdminDatabase?.(); }
  });
  App.bindAdminDatabase();

  App.startNativeUpdateListener();
  const updateInput = App.$("panel-update-url"), updateStatus = App.$("panel-update-status");
  const owner = App.currentUser.code;
  // One writer per account survives modal close/reopen. A detached editor must
  // never enqueue its old draft after a newer editor has saved a newer URL.
  let updateState = App.nativeUpdateURLSaveState;
  if (!updateState || updateState.owner !== owner) {
    updateState = App.nativeUpdateURLSaveState = { owner, value: updateInput.value, revision: 0, requested: 0, saved: 0, running: false, timer: 0, error: "" };
  }
  updateState.editor = { input: updateInput, status: updateStatus };
  const isCurrentEditorOwner = () => App.nativeUpdateURLSaveState === updateState && App.currentUser?.code === owner && App.isVinny();
  const paintUpdateURL = () => {
    if (!isCurrentEditorOwner()) return;
    const editor = updateState.editor;
    if (!editor?.input.isConnected) return;
    const dirty = updateState.revision > updateState.saved;
    editor.input.dataset.dirty = dirty ? "1" : "0";
    editor.status.textContent = updateState.error || (updateState.running ? "Saving…" : dirty ? "Unsaved Changes" : updateState.value.trim() ? "Update URL Saved" : "Update URL Cleared");
  };
  if (updateState.revision > updateState.saved) {
    updateInput.value = updateState.value;
    paintUpdateURL();
  }
  const saveUpdateURL = async () => {
    clearTimeout(updateState.timer);
    if (!isCurrentEditorOwner()) return;
    updateState.requested = updateState.revision;
    if (updateState.running || updateState.saved >= updateState.requested) return;
    updateState.running = true;
    try {
      while (isCurrentEditorOwner() && updateState.saved < updateState.requested) {
        const value = updateState.value, revision = updateState.revision;
        try { App.normalizeNativeUpdateURL(value); }
        catch (error) { updateState.error = error.message; break; }
        updateState.error = "";
        paintUpdateURL();
        try {
          await App.setNativeUpdateURL(value);
          updateState.saved = revision;
        } catch (error) {
          // Failure of a superseded save must not discard the newest request.
          if (updateState.requested > revision) continue;
          updateState.error = error.message || "The Update URL could not be saved.";
          break;
        }
      }
    } finally { updateState.running = false; paintUpdateURL(); }
  };
  flushUpdateURL = () => { clearTimeout(updateState.timer); void saveUpdateURL(); };
  updateInput?.addEventListener("input", () => {
    if (!isCurrentEditorOwner() || updateState.editor.input !== updateInput) return;
    updateState.value = updateInput.value;
    updateState.revision++;
    updateState.error = "";
    paintUpdateURL();
    clearTimeout(updateState.timer); updateState.timer = setTimeout(saveUpdateURL, 400);
  });
  updateInput?.addEventListener("blur", flushUpdateURL);
  updateInput?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); flushUpdateURL(); } });

  App.startFileUploadLimitListener();
  const limitInput = App.$("panel-file-upload-limit");
  let limitState = App.fileUploadLimitSaveState;
  if (!limitState || limitState.owner !== owner) {
    limitState = App.fileUploadLimitSaveState = { owner, value: limitInput.value, revision: 0, saved: 0, running: false, error: "" };
  }
  limitState.editor = limitInput;
  const isLimitOwner = () => App.fileUploadLimitSaveState === limitState && App.currentUser?.code === owner && App.isVinny();
  if (limitState.revision > limitState.saved) limitInput.value = limitState.value;
  const saveFileUploadLimit = async () => {
    if (!isLimitOwner() || limitState.running) return;
    limitState.running = true;
    try {
      while (isLimitOwner() && limitState.saved < limitState.revision) {
        const value = limitState.value, revision = limitState.revision;
        if (App.parseFileUploadLimitMB(value) === null) {
          limitState.error = "Enter a positive file size in MB.";
          break;
        }
        try {
          await App.setFileUploadLimitMB(value);
          limitState.saved = revision;
          limitState.error = "";
        } catch (error) {
          if (limitState.revision > revision) continue;
          limitState.error = error.message || "The File Upload Limit could not be saved.";
          break;
        }
      }
    } finally {
      limitState.running = false;
      if (isLimitOwner()) App.syncFileUploadLimitInput();
    }
  };
  flushFileUploadLimit = () => { void saveFileUploadLimit(); };
  limitInput.addEventListener("input", () => {
    if (!isLimitOwner() || limitState.editor !== limitInput) return;
    limitState.value = limitInput.value;
    limitState.revision++;
    limitState.error = "";
    void saveFileUploadLimit();
    App.syncFileUploadLimitInput();
  });
  limitInput.addEventListener("blur", flushFileUploadLimit);
  limitInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); flushFileUploadLimit(); } });
  App.syncFileUploadLimitInput();

  // Schedule Type + Account Creation controls (Vinny only)
  App.startScheduleTypeListener();
  App.startAccountCreationListener();
  App.startSchedulesPeopleListener();
  const schedWrap = App.$("panel-schedtypes");
  const accountWrap = App.$("panel-account-creation");
  if (schedWrap) {
    schedWrap.querySelectorAll("[data-panel-schedtype]").forEach(btn => {
      const k = btn.getAttribute("data-panel-schedtype") || "full";
      btn.classList.toggle("primary", App._normalizeScheduleType(k) === App._normalizeScheduleType(App.scheduleType));
    });
    if (schedWrap.dataset.bound !== "1") {
      schedWrap.dataset.bound = "1";
      schedWrap.addEventListener("click", async e => {
        const btn = e.target.closest("button[data-panel-schedtype]");
        if (!btn) return;
        const k = btn.getAttribute("data-panel-schedtype") || "full";
        try {
          await App.setScheduleType(k);
          App.showToast({
            title: "Schedule type saved",
            body: `Now set to ${App._scheduleTypeLabel(k)}.`,
            duration: 1700
          });
        } catch (err) {
          console.error("set scheduleType failed:", err);
          App.showToast({
            title: "Failed",
            body: "Could not save schedule type. Check console / rules.",
            duration: 2600
          });
        }
      });
    }
  }
  if (accountWrap) {
    accountWrap.querySelectorAll("[data-panel-account-creation]").forEach(btn => {
      const k = btn.getAttribute("data-panel-account-creation") || "disabled";
      btn.classList.toggle("primary", k === "enabled" === App.accountCreationEnabled);
    });
    if (accountWrap.dataset.bound !== "1") {
      accountWrap.dataset.bound = "1";
      accountWrap.addEventListener("click", async e => {
        const btn = e.target.closest("button[data-panel-account-creation]");
        if (!btn) return;
        const enabled = (btn.getAttribute("data-panel-account-creation") || "disabled") === "enabled";
        try {
          await App.setAccountCreationEnabled(enabled);
          App.showToast({
            title: "Account creation saved",
            body: `Account creation ${enabled ? "enabled" : "disabled"}.`,
            duration: 1700
          });
        } catch (err) {
          console.error("set account creation failed:", err);
          App.showToast({
            title: "Failed",
            body: "Could not save account creation. Check console / rules.",
            duration: 2600
          });
        }
      });
    }
  }
  const listEl = App.$("panel-rooms");
  if (listEl && listEl.dataset.bound !== "1") {
    listEl.dataset.bound = "1";
    listEl.addEventListener("click", async e => {
      const btn = e.target.closest("button[data-panel-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-panel-act");
      const rid = btn.getAttribute("data-room-id");
      if (!act || !rid) return;
      btn.disabled = true;
      try {
        if (act === "clear") {
          await App.clearRoomMessages(rid);
          App.showToast({
            title: "Messages cleared",
            body: `Cleared all messages in ${rid}.`,
            duration: 2000
          });
          await App.loadAdminPanelRooms();
        } else if (act === "join") {
          await App.joinRoomFromPanel(rid);
        } else if (act === "ghost") {
          await App.setGhostModeForRoom(rid, !App.isGhostModeEnabledForRoom(rid, App.currentUser.code));
          await App.loadAdminPanelRooms();
        } else if (act === "delete") {
          await App.deleteRoomFromPanel(rid);
        }
      } catch (err) {
        console.error("panel action failed:", err);
        App.showToast({
          title: "Action failed",
          body: "Check console / rules.",
          duration: 2600
        });
      } finally {
        btn.disabled = false;
      }
    });
  }
  App.loadAdminPanelRooms();
};
App.loadAdminPanelRooms = async function () {
  if (!App.isVinny()) return;
  const listEl = App.$("panel-rooms");
  if (!listEl) return;
  try {
    const base = String(App.firebaseConfig?.databaseURL || "").replace(/\/+$/, "");
    if (!base) throw new Error("Missing databaseURL.");
    const [roomsRes, ghostSnap] = await Promise.all([fetch(`${base}/rooms.json?shallow=true`, {
      cache: "no-store"
    }), App.db.ref(`users/${App.currentUser.code}/${App.ADMIN_GHOST_ROOMS_NODE}`).once("value")]);
    if (!roomsRes.ok) throw new Error(`Room key fetch failed: ${roomsRes.status}`);
    const roomKeyData = await roomsRes.json();
    const ghostRooms = App.normalizeAdminGhostRooms(ghostSnap.val() || {});
    const rooms = roomKeyData && typeof roomKeyData === "object" ? Object.keys(roomKeyData).map(rawId => App.sanitizeRoomCode(rawId)).filter(Boolean).map(id => ({
      id,
      displayName: App.roomDisplayName(id, App.roomsMetaCache.get(id) || null) || id
    })) : [];
    rooms.sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));
    if (!rooms.length) {
      listEl.innerHTML = `<div class="empty"><div class="empty-title">No rooms.</div><div class="empty-sub">Nothing to manage yet.</div></div>`;
      return;
    }
    listEl.innerHTML = `
      <div class="panel-room-grid">
        ${rooms.map(({
      id,
      displayName
    }) => {
      const ghostOn = !!ghostRooms[id];
      return `
            <div class="panel-room ${ghostOn ? "ghost-active" : ""}">
              <div class="panel-room-card-main">
                <div class="panel-room-name" data-panel-room-name="${App.escapeAttr(id)}">${App.escapeHtml(displayName)}</div>
              </div>
              <div class="panel-room-actions">
                <button class="btn tiny" type="button" data-panel-act="join" data-room-id="${App.escapeAttr(id)}">Join</button>
                <button class="btn tiny" type="button" data-panel-act="clear" data-room-id="${App.escapeAttr(id)}">Clear</button>
                <button class="btn tiny ${ghostOn ? "primary" : ""}" type="button" data-panel-act="ghost" data-room-id="${App.escapeAttr(id)}">${ghostOn ? "Ghost On" : "Ghost Off"}</button>
                <button class="btn tiny danger" type="button" data-panel-act="delete" data-room-id="${App.escapeAttr(id)}">Delete</button>
              </div>
            </div>
          `;
    }).join("")}
      </div>
    `;
    rooms.forEach(({
      id
    }) => {
      App.db.ref(`rooms/${id}/name`).once("value").then(nameSnap => {
        const name = String(nameSnap.val() || id);
        const currentMeta = App.roomsMetaCache.get(id) || {};
        App.roomsMetaCache.set(id, {
          ...currentMeta,
          name
        });
        const nameEl = listEl.querySelector(`[data-panel-room-name="${CSS.escape(id)}"]`);
        if (nameEl) nameEl.textContent = name;
      }).catch(() => {});
    });
  } catch (e) {
    console.error("panel load rooms failed:", e);
    listEl.innerHTML = `<div class="muted small">Failed to load rooms.</div>`;
  }
};
App.joinRoomFromPanel = async function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.currentUser || !App.isVinny()) return;
  const roomSnap = await App.db.ref(`rooms/${id}`).once("value");
  if (!roomSnap.exists()) {
    App.showToast({
      title: "Not found",
      body: "That room doesn’t exist anymore.",
      duration: 2400
    });
    await App.loadAdminPanelRooms();
    return;
  }
  const roomMeta = roomSnap.val() || {};
  const displayName = App.roomDisplayName(id, roomMeta);
  const roomMessageCount = Math.max(0, Number(roomMeta?.messageCount) || 0);

  // Admin-panel join intentionally bypasses private room passwords.
  let membership;
  try {
    membership = await App.joinRoomMembership(id, roomMessageCount);
  } catch (error) {
    App.showToast({ title: "Join failed", body: "Could not join this room. Please try again.", duration: 2600 });
    return;
  }

  // Immediately reflect locally (no wait for listener)
  App.membershipMap.set(id, {
    joinedAt: Number(membership?.joinedAt) || 0,
    lastSeenAt: Number(membership?.lastSeenAt) || 0,
    lastSeenCount: Number(membership?.lastSeenCount) || 0
  });
  App.roomsMetaCache.set(id, roomMeta);
  App.renderRoomsList();
  App.closeModal();
  App.showToast({
    title: "Joined",
    body: `Joined ${displayName}.`,
    duration: 2000
  });
  App.openRoom(id);
};
App.deleteRoomFromPanel = async function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  const displayName = App.roomDisplayName(id, App.roomsMetaCache.get(id) || null);
  const confirmId = `panel_delete_confirm_${Math.random().toString(36).slice(2)}`;
  App.showToast({
    title: "Delete Room",
    bodyHTML: `
      <div class="muted small" style="margin-top:2px">Really delete <span class="strong">${App.escapeHtml(displayName)}</span>? This removes the room and its data.</div>
      <div style="display:flex; gap:10px; margin-top:10px">
        <button class="btn tiny danger" id="${confirmId}" type="button">Delete Room</button>
      </div>
    `,
    duration: 15000
  });
  const confirmBtn = document.getElementById(confirmId);
  confirmBtn?.addEventListener("click", async () => {
    App.closeToast();
    try {
      // If this room is open, clear UI instantly
      if (App.currentRoomId === id) App.hardClearComposerAndOverlays();
      await App.deleteRoomEverywhere(id);
      App.showToast({
        title: "Room deleted",
        body: `Deleted room ${displayName}.`,
        duration: 2200
      });

      // Refresh panel list if it’s still open
      try {
        await App.loadAdminPanelRooms();
      } catch {}
    } catch (err) {
      console.error("delete room failed:", err);
      const retryId = `panel_delete_retry_${Math.random().toString(36).slice(2)}`;
      const showFailure = error => {
      App.showToast({
        title: "Delete failed",
        bodyHTML: `<div>${App.escapeHtml(error?.message || "Check console / rules.")}</div>${err.retryFileCleanup ? `<button class="btn tiny danger" id="${retryId}" type="button" style="margin-top:10px">Retry File Cleanup</button>` : ""}`,
        duration: err.retryFileCleanup ? 60000 : 6000
      });
      document.getElementById(retryId)?.addEventListener("click", async () => {
        App.closeToast();
        try {
          await err.retryFileCleanup();
          App.showToast({ title: "Files deleted", body: `Finished deleting files from ${displayName}.`, duration: 3000 });
        } catch (retryError) { showFailure(retryError); }
      }, { once: true });
      };
      showFailure(err);
    }
  }, {
    once: true
  });
};

App.register("rooms/actions", function initializeFeature() {
App.membershipsRef = null;
App.membershipMap = new Map();
App.roomsMetaCache = new Map();
App.roomRowCache = new Map();
App.pinnedRoomsRef = null;
App.pinnedRoomsCb = null;
App.pinnedRoomIds = new Set();
App.pinnedRoomWriteSeq = 0;
App.pendingPinnedRoomWrites = new Map();
});
})(globalThis.ChatApp);
