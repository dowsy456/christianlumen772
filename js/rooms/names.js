/* Room IDs remain stable so a live rename never disconnects chat or calls. */
(function (App) {
  "use strict";
  const normalized = name => App.sanitizeRoomCode(name);
  const pendingRenames = new Map();
  App.pendingRoomNames = new Map();
  App.refreshRoomNameUI = function (id) {
    App.updateRoomListItem?.(id);
    App.syncSidebarDock?.(); App.callSyncMenuStatusDisplay?.();
    App.callPublishDesktopOverlay?.(); App.callPublishIncomingRings?.();
    const displayName = App.roomDisplayName(id);
    App.syncRoomActivityDisplayName?.(id);
    if (App.currentRoomId === id) {
      App.syncMobileChrome?.();
      App.syncRoomToolbar?.();
      const subtitle = App.$?.("room-activities-subtitle");
      if (subtitle) subtitle.textContent = `Play together in ${displayName}`;
      const loadingTitle = App.$?.("room-loading-state")?.querySelector(".room-loading-title");
      if (loadingTitle) loadingTitle.textContent = displayName;
    }
    // Commit the lightweight startup cache immediately: a close/relaunch after
    // saving a name must not restore the old label from the debounce window.
    if (!App.pendingRoomNames.has(id)) App.saveRoomsListCacheNow?.();
    if (App.msgMenuCtx?.roomId === id && App.msgMenuUserEl) App.msgMenuUserEl.textContent = displayName;
    for (const el of globalThis.document?.querySelectorAll?.('[data-panel-room-name]') || []) {
      if (el.dataset.panelRoomName === id) el.textContent = displayName;
    }
    if (!App.currentRoomId && App.views?.chat?.dataset.active === "true" && App.getStoredPlace?.() === "home") App.clearMessagesToHome?.();
  };
  const awaitRename = async operation => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The room server has not confirmed the save. Check your connection and the room name before trying again.")), 12000);
      })]);
    } finally { clearTimeout(timer); }
  };
  App.roomNameTaken = function (rooms, name, exceptId = "") {
    const wanted = normalized(name);
    return Object.entries(rooms || {}).some(([id, room]) => room && id !== exceptId && normalized(room.name || id) === wanted);
  };
  App.acquireRoomNameLock = async function (roomId, isCurrent = () => true) {
    const token = App.db.ref("roomNameLocks").push().key;
    const parent = App.db.ref(`roomNameLocks/${roomId}`);
    const entry = App.db.ref(`roomNameLocks/${roomId}/${token}`);
    const disconnected = entry.onDisconnect?.();
    const connection = App.db.ref(".info/connected");
    let lost = false, owned = false;
    const callback = snap => { if (snap.val() === false) lost = true; };
    const valid = () => !lost && isCurrent();
    connection.on?.("value", callback);
    const release = async () => {
      connection.off?.("value", callback);
      if (owned) await entry.remove().catch(() => {});
      await disconnected?.cancel().catch(() => {});
    };
    try {
      // Arm a token-specific disconnect cleanup before acquiring the lock.
      // It can never remove a different device's later reservation.
      await disconnected?.remove();
      const result = await parent.transaction(value => !valid() ? undefined : value === null || !Object.keys(value).length ? { [token]: true } : undefined, undefined, false);
      owned = result.committed;
      if (!owned || !valid()) throw new Error("This room name is being edited on another device or the connection was lost. Try again.");
      return { valid, release };
    } catch (error) { await release(); throw error; }
  };
  App.releaseRoomName = function (name, roomId) {
    const key = normalized(name);
    if (!key || !roomId) return Promise.resolve();
    return App.db.ref(`roomNames/${key}`).transaction(value => value === roomId ? null : undefined, undefined, false);
  };
  App.createNamedRoom = async function (name, record) {
    const clean = App.sanitizeRoomName(name), base = normalized(clean);
    if (!base || !App.currentUser) throw new Error("Invalid room name.");
    // Only the small unique-name directory participates in name reservations.
    // No creation downloads other rooms, avatars, presence, or message counts.
    const occupied = (await App.db.ref(`rooms/${base}/name`).once("value")).exists();
    const id = occupied ? App.sanitizeRoomCode(App.db.ref("rooms").push().key) : base;
    const claim = await App.db.ref(`roomNames/${base}`).transaction(value => value === null ? id : undefined, undefined, false);
    if (!claim.committed) return null;
    try {
      const result = await App.db.ref(`rooms/${id}`).transaction(value => value === null ? { ...record, name: clean, nameLower: base } : undefined, undefined, false);
      if (!result.committed) throw new Error("That room ID is already in use. Try again.");
      return id;
    } catch (error) { await App.releaseRoomName(clean, id).catch(() => {}); throw error; }
  };
  App.findRoomByName = async function (name) {
    const wanted = normalized(name);
    if (!wanted) return null;
    const index = await App.db.ref(`roomNames/${wanted}`).once("value");
    const id = typeof index.val() === "string" ? index.val() : "";
    if (!id) return null;
    const meta = (await App.db.ref(`rooms/${id}`).once("value")).val();
    return meta && normalized(meta.name) === wanted ? { id, meta } : null;
  };
  App.renameRoomData = function (root, roomId, name, owner) {
    const clean = App.sanitizeRoomName(name);
    if (!clean || !root?.rooms?.[roomId] || root.rooms[roomId].createdBy !== owner) throw new Error("Only the room creator can edit its name.");
    if (App.roomNameTaken(root.rooms, clean, roomId)) throw new Error("A room with that name already exists.");
    const next = JSON.parse(JSON.stringify(root));
    next.rooms[roomId].name = clean;
    next.rooms[roomId].nameLower = normalized(clean);
    // Refresh denormalized notification/call labels as part of the same commit.
    function labels(value, path = []) {
      if (!value || typeof value !== "object") return;
      if (value.roomId === roomId || value.room === roomId || path[0] === 'calls' && path[1] === roomId || path[0] === 'pings' && path[2] === roomId) {
        if (Object.hasOwn(value, 'roomName')) value.roomName = clean;
        if (Object.hasOwn(value, 'roomDisplayName')) value.roomDisplayName = clean;
      }
      for (const [key, item] of Object.entries(value)) labels(item, [...path, key]);
    }
    labels(next);
    return next;
  };
  App.syncRenamedRoomReferences = async function (roomId, name, previousName) {
    const base = String(App.firebaseConfig?.databaseURL || "").replace(/\/+$/, "");
    if (!base || typeof fetch !== "function") return;
    const authUser = App.firebase?.auth?.()?.currentUser;
    const token = authUser ? await authUser.getIdToken() : "";
    const shallowKeys = async path => {
      const url = new URL(`${base}/${path.split("/").map(encodeURIComponent).join("/")}.json`);
      url.searchParams.set("shallow", "true");
      if (token) url.searchParams.set("auth", token);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Room label access failed (${response.status}).`);
        const value = await response.json();
        return value && typeof value === "object" ? Object.keys(value) : [];
      } finally { clearTimeout(timer); }
    };
    // Older versions duplicated display labels in notifications. Enumerate only
    // their key indexes and visit this room's label leaves, never payloads,
    // attachments, other rooms' messages, or WebRTC signaling.
    const paths = [`calls/${roomId}`, `activities/boplRoyale/rooms/${roomId}`, `activities/mergeParty/rooms/${roomId}`];
    const [ringKeys, recipients] = await Promise.all([shallowKeys(`calls/${roomId}/rings`), shallowKeys("pings")]);
    for (const code of ringKeys) paths.push(`calls/${roomId}/rings/${code}`);
    const each = async (items, job) => {
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) await job(items[cursor++]);
      }));
    };
    await each(recipients, async code => {
      for (const key of await shallowKeys(`pings/${code}/${roomId}`)) paths.push(`pings/${code}/${roomId}/${key}`);
    });
    await each(paths, async path => {
      for (const field of ["roomName", "roomDisplayName"]) {
        const ref = App.db.ref(`${path}/${field}`);
        const existing = (await ref.once("value")).val();
        if (typeof existing !== "string" || existing === name) continue;
        if (existing !== previousName && normalized(existing) !== normalized(roomId)) continue;
        await ref.transaction(value => value === existing ? name : undefined, undefined, false);
      }
    });
  };
  App.renameRoom = async function (roomId, name) {
    const id = App.sanitizeRoomCode(roomId), owner = App.currentUser?.code;
    if (!id || !owner) throw new Error("Open a room first.");
    const clean = App.sanitizeRoomName(name);
    if (!clean) throw new Error("Use 1–20 printable characters without . # $ [ ] or /.");
    // A root transaction downloaded every attachment and was canceled by call
    // signaling and presence writes. Keep the atomic name/owner checks inside
    // room metadata only; labels resolve from each room's stable ID.
    if (pendingRenames.has(id)) return awaitRename(pendingRenames.get(id));
    const cached = App.roomsMetaCache.get(id);
    if (cached && cached.createdBy !== owner) throw new Error("Only the room creator can edit its name.");
    if (App.roomNameTaken(Object.fromEntries(App.roomsMetaCache), clean, id)) throw new Error("A room with that name already exists.");
    // Show the new label immediately while the server atomically checks the
    // owner and uniqueness. IDs used by messages, members, polls and calls stay
    // unchanged. A failed save removes this preview without losing live data.
    App.pendingRoomNames.set(id, clean);
    App.refreshRoomNameUI(id);
    let active = true;
    const operation = (async () => {
      const ref = App.db.ref(`rooms/${id}`);
      const nameRef = App.db.ref(`roomNames/${normalized(clean)}`);
      let claimed = false, saved = false, lock = null;
      try {
        lock = await App.acquireRoomNameLock(id, () => active);
        const before = (await awaitRename(ref.once("value"))).val();
        if (!lock.valid()) return;
        if (!before) throw new Error("This room no longer exists.");
        if (before.createdBy !== owner) throw new Error("Only the room creator can edit its name.");
        const claim = await nameRef.transaction(value => !lock.valid() ? undefined : value === null ? id : undefined, undefined, false);
        claimed = claim.committed;
        if (!claim.committed && claim.snapshot?.val() !== id) throw new Error("A room with that name already exists.");
        if (!lock.valid()) throw new Error("The room name save expired or the connection was lost. Try again.");
        let result, failure;
        for (let attempt = 0; ; attempt += 1) {
          try {
            result = await ref.transaction(meta => {
              failure = null;
              if (!lock.valid()) return;
              if (meta === null) return null;
              if (meta.createdBy !== owner || App.currentUser?.code !== owner) failure = new Error("Only the room creator can edit its name.");
              else if (normalized(meta.name || id) !== normalized(before.name || id)) failure = new Error("The room name changed on another device. Try again.");
              if (failure) return;
              return { ...meta, name: clean, nameLower: normalized(clean) };
            }, undefined, false);
            break;
          } catch (error) {
            if (!active || attempt >= 4 || !/^set$/i.test(String(error?.message || ""))) throw error;
            await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
          }
        }
        if (!lock.valid()) throw new Error("The connection changed while saving. Reopen the room to check its name.");
        const meta = result?.snapshot?.val();
        if (!meta) throw failure || new Error("This room no longer exists.");
        if (!result?.committed || meta.name !== clean) throw failure || new Error("The room name was not saved. Please try again.");
        saved = true;
        if (normalized(before.name || id) !== normalized(clean)) await App.releaseRoomName(before.name || id, id).catch(() => {});
        App.roomsMetaCache.set(id, meta);
        App.pendingRoomNames.delete(id);
        App.refreshRoomNameUI(id); App.saveRoomsListCacheNow?.();
        App.roomNameReferenceSync = App.syncRenamedRoomReferences(id, clean, before.name || id).catch(error => {
          console.warn("Room labels could not be refreshed:", error.message);
          return false;
        });
        return clean;
      } finally {
        if (claimed && !saved && lock?.valid()) await App.releaseRoomName(clean, id).catch(() => {});
        await lock?.release();
      }
    })();
    pendingRenames.set(id, operation);
    operation.then(() => pendingRenames.delete(id), () => pendingRenames.delete(id));
    try { return await awaitRename(operation); }
    catch (error) {
      active = false;
      App.pendingRoomNames.delete(id);
      App.refreshRoomNameUI(id);
      if (/permission.denied/i.test(String(error?.code || error?.message || ""))) throw new Error("The database did not allow this room name to be saved. Check this room's write permissions.");
      throw error;
    }
  };
  App.openRoomNameEditor = function (roomId) {
    const meta = App.roomsMetaCache.get(roomId);
    if (!App.currentUser || meta?.createdBy !== App.currentUser.code) return;
    App.openModal({ title: "Edit Name", bodyHTML: `<label class="label" for="room-name-edit">Room Name</label><input class="input" id="room-name-edit" maxlength="20" value="${App.escapeAttr(App.roomDisplayName(roomId, meta))}" /><div class="muted small" id="room-name-error" role="alert"></div>`, actionsHTML: '<button class="btn primary" id="room-name-save" type="button">Save</button>' });
    const input = App.$("room-name-edit"), button = App.$("room-name-save"), errorEl = App.$("room-name-error");
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = "Saving…"; errorEl.textContent = "";
      try { await App.renameRoom(roomId, input.value); if (App.$("room-name-edit") === input) App.closeModal(); }
      catch (error) { if (errorEl.isConnected) errorEl.textContent = error.message; }
      finally { button.disabled = false; button.textContent = "Save"; }
    });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') button.click(); });
    input.focus(); input.select();
  };
  App.register("rooms/names", function () {});
})(globalThis.ChatApp);
