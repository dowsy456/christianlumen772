/* chat/notifications: methods register before ordered initialization. */
(function (App) {
  "use strict";
const roomListeners = new Map();
const desktopPingKeys = new Set();
const pendingDesktopPings = new Map();
const notificationTimers = new Set();
const pingEpochReads = new Map();
let pingInboxGeneration = 0;
let desktopPingOpenSequence = 0;
let desktopPingNavigation = Promise.resolve();
App.getDesktopNotificationRoomId = function () {
  if (!App.currentUser || App.views?.chat?.dataset?.active !== "true") return "";
  return String(App.currentRoomId || "");
};
App.isDesktopNotificationRoomActive = function (roomId) {
  if (!roomId || App.getDesktopNotificationRoomId() !== String(roomId) || document.hidden) return false;
  // Native focus includes the enclosing BrowserWindow, even when an embedded
  // activity owns keyboard focus. Also reject an observed renderer blur while
  // the asynchronous native focus update is still crossing the bridge.
  return App.desktopPresenceFocused !== false && document.hasFocus?.() !== false;
};
App.openDesktopPingMessage = async function (command) {
  const roomId = String(command?.roomId || ""), messageKey = String(command?.messageKey || "");
  const code = App.currentUser?.code;
  if (!code || !roomId || !messageKey || !App.membershipMap.has(roomId)) return false;
  const sequence = ++desktopPingOpenSequence;
  const current = () => sequence === desktopPingOpenSequence && App.currentUser?.code === code && App.membershipMap.has(roomId);
  // Room entry may await activity teardown before changing currentRoomId.
  // Serialize entry so an older click cannot finish after a newer destination.
  // Recheck the room here, so consecutive pings never reopen the same room.
  const navigation = desktopPingNavigation.then(async () => {
    if (current() && App.currentRoomId !== roomId) await App.openRoom(roomId, { quiet: true });
  });
  desktopPingNavigation = navigation.catch(() => {});
  await navigation;
  if (!current() || App.currentRoomId !== roomId) return false;
  if (App.views?.chat?.dataset?.active !== "true") App.showView?.("chat");
  App.syncDesktopNotificationPolicy?.();
  // Use exactly the Filters/Pins jump: wait for the room's initial render,
  // fetch the bounded history window around an old message, then highlight it.
  await App.jumpToRoomMessage(messageKey, { roomId });
  return current() && App.currentRoomId === roomId;
};
const pingTimestamp = (record, pingId) => Number(record?.at) || App.firebasePushKeyTimestamp?.(pingId) || 0;
const readPingClearEpoch = roomId => {
  if (pingEpochReads.has(roomId)) return pingEpochReads.get(roomId);
  // The room-list bootstrap cache may predate a clear performed while this
  // recipient was offline. Read only its small epoch leaf, never memberships
  // or message history, and share an in-flight read across inbox callbacks.
  const pending = Promise.resolve().then(() => App.db.ref(`rooms/${roomId}/messagesClearedAt`).once("value"))
    .then(snap => Number(snap.val()) || 0)
    .catch(() => Number(App.roomsMetaCache?.get(roomId)?.messagesClearedAt) || 0)
    .finally(() => { if (pingEpochReads.get(roomId) === pending) pingEpochReads.delete(roomId); });
  pingEpochReads.set(roomId, pending);
  return pending;
};
App.notificationRoomHeads = new Map();
App.notificationRoomTails = new Map();
App.getRoomDisplayMeta = function (roomId, meta = App.roomsMetaCache?.get(roomId)) {
  const tail = App.notificationRoomTails.get(roomId);
  if (!tail) return meta || {};
  let latest = null;
  for (const [key, message] of tail) {
    if (!message || message.deleted) continue;
    const candidate = { ...message, _key: key };
    if (!latest || (App.compareMessagesChronologically ? App.compareMessagesChronologically(candidate, latest) > 0 : key > latest._key)) latest = candidate;
  }
  if (!latest) return { ...meta, lastMessageKey: "", lastMessageAt: 0, lastMessagePreview: "" };
  const authorCode = latest.userCode || latest.system?.userCode || "";
  if (authorCode) App.ensureLiveUserListener?.(authorCode);
  const text = App.getMessagePreviewText?.(latest) || String(latest.text || "");
  const preview = latest.t === "system" ? text : App.formatRoomLastMessagePreview?.(text, App.getUserDisplayName?.(latest.userCode, latest) || latest.displayName || latest.username) || text;
  return { ...meta, lastMessageKey: latest._key, lastMessageAt: App.getMessageSortTimestamp?.(latest, latest._key) || Number(latest.createdAt) || 0, lastMessagePreview: preview, lastMessageAuthorCode: authorCode };
};
App.messagePingsCurrentUser = function (message) {
  const username = String(App.currentUser?.username || "").toLowerCase();
  if (!username) return false;
  const mentions = String(message?.text || "").matchAll(/(^|\s)@([A-Za-z0-9_]{1,32})\b/g);
  for (const match of mentions) {
    const name = match[2].toLowerCase();
    if (name === username || name === "everyone" || name === "all" || name === "a") return true;
  }
  return false;
};
App.handleRoomNotificationMessage = function (roomId, key, message) {
  if (!App.currentUser || !App.membershipMap.has(roomId) || !message || message.deleted || message.t === "system") return;
  const isSelf = String(message.userCode || "") === String(App.currentUser.code);
  if (isSelf) return;
  const ping = App.messagePingsCurrentUser(message);
  const code = App.currentUser.code;
  const soundIfUnseen = () => {
    if (App.currentUser?.code !== code || !App.membershipMap.has(roomId)) return;
    if (!App.canSeeMessage?.(roomId, key)) App.playNotificationSound?.(ping ? "Ping" : "Message");
  };
  // Firebase's notification listener can run before the renderer's frame queue.
  // Give the active room a short paint window, then test this exact message.
  if (App.currentRoomId === roomId && !document.hidden) {
    const timer = setTimeout(() => { notificationTimers.delete(timer); soundIfUnseen(); }, 160);
    notificationTimers.add(timer);
  } else soundIfUnseen();
  if (App.mobileNativeAvailable && App.pushNotifsEnabled && !App.isDoNotDisturb?.() &&
      (document.hidden || App.currentRoomId !== roomId)) {
    const roomName = App.roomDisplayName?.(roomId, App.roomsMetaCache?.get(roomId)) || roomId;
    const nativeKey = `${roomId}/${key}`;
    if (!desktopPingKeys.has(nativeKey)) {
      App.mobilePost?.("notify", { id: nativeKey, roomId, silent: true,
        title: ping ? `${App.getUserDisplayName?.(message.userCode, message) || message.displayName || message.username || "Someone"} mentioned you` : roomName,
        body: String(message.text || "New attachment").slice(0, 200) });
      desktopPingKeys.add(nativeKey);
    }
  }
  if (ping) App.showDesktopPingNotification({ roomId, fromCode: message.userCode, fromUsername: message.username || message.displayName, messageKey: key, message });
};
App.detachRoomMessageNotifications = function () {
  for (const listener of roomListeners.values()) {
    listener.ref.off("child_added", listener.cb);
    listener.headRef?.off("value", listener.headCb);
  }
  roomListeners.clear();
  App.notificationRoomHeads.clear();
  App.notificationRoomTails.clear();
  desktopPingKeys.clear();
  pendingDesktopPings.clear();
  for (const timer of notificationTimers) clearTimeout(timer);
  notificationTimers.clear();
  App.lastTaskbarUnreadCount = 0;
  window.chatDesktopNotifications?.setUnreadCount?.(0);
};
App.syncRoomMessageNotifications = function () {
  const userCode = String(App.currentUser?.code || "");
  for (const [roomId, listener] of roomListeners) {
    if (listener.userCode === userCode && App.membershipMap.has(roomId)) continue;
    listener.ref.off("child_added", listener.cb);
    listener.headRef?.off("value", listener.headCb);
    App.notificationRoomHeads.delete(roomId);
    App.notificationRoomTails.delete(roomId);
    roomListeners.delete(roomId);
  }
  if (!userCode || !App.db) return;
  for (const roomId of App.membershipMap.keys()) {
    if (roomListeners.has(roomId)) continue;
    // Messages use chronological push keys, as does the room's live history.
    // Keys are indexed by Firebase automatically; cap the initial download
    // without requiring a createdAt index in every room's security rules.
    const since = App.appPresenceNow?.() || Date.now();
    const ref = App.db.ref(`messages/${roomId}`).orderByKey().limitToLast(50);
    const listener = { ref, userCode, ready: false, seen: new Set(), cb: null };
    roomListeners.set(roomId, listener);
    // A tiny head query prevents a metadata update from marking a message read
    // while that message is still waiting for its renderer frame.
    // Reuse the notification tail already downloaded by the SDK. Its value
    // fence is a complete current window, so closed rooms can open from memory
    // before a new subscription has to cross the network.
    listener.headRef = ref;
    listener.headCb = snap => {
      if (roomListeners.get(roomId) !== listener) return;
      let head = "";
      const tail = new Map();
      snap.forEach(child => { head = String(child.key || ""); tail.set(head, child.val()); });
      App.cacheRecentRoomMessages?.(roomId, tail);
      App.notificationRoomHeads.set(roomId, head);
      App.notificationRoomTails.set(roomId, tail);
      // Render directly from the same authoritative message stream as chat.
      // Sender metadata and mention fan-out can be delayed independently.
      App.renderRoomsList?.();
      App.syncUnreadTaskbarBadge?.();
      App.queueReadReceiptSync?.();
    };
    listener.headRef.on("value", listener.headCb);
    listener.cb = snap => {
      if (roomListeners.get(roomId) !== listener || String(App.currentUser?.code) !== userCode) return;
      const key = String(snap.key || "");
      if (!key || listener.seen.has(key)) return;
      listener.seen.add(key);
      const message = snap.val();
      // Keep history quiet even when deleting a tail entry brings an older
      // child back into the limited query. New arrivals before the initial
      // value fence must still notify, just as they do after it.
      const createdAt = Number(message?.createdAt || 0);
      if (!Number.isFinite(createdAt) || createdAt < since || !listener.ready && createdAt <= since) return;
      App.handleRoomNotificationMessage(roomId, key, message);
    };
    ref.on("child_added", listener.cb, error => console.warn("Room sound listener unavailable", error?.code));
    // Firebase delivers the initial child_added events before this value fence.
    // Later reconnects keep their seen keys, so they cannot replay an alert.
    ref.once("value").then(() => {
      if (roomListeners.get(roomId) === listener) listener.ready = true;
    }).catch(() => {});
  }
};
App.detachPingsInbox = function () {
  pingInboxGeneration += 1;
  pingEpochReads.clear();
  if (App.pingsInboxRef && App.pingsInboxCb) {
    try {
      App.pingsInboxRef.off("value", App.pingsInboxCb);
    } catch {}
  }
  App.pingsInboxRef = null;
  App.pingsInboxCb = null;
  App.pingsInboxFirstSnapshot = true;
  App.seenPingKeys.clear();
  App.activePingToastRoomId = null;
};
App.supportsDesktopNotifications = function () {
  if (globalThis.chatDesktopNotifications?.showPing) return true;
  if (App.mobileNativeAvailable) return true;
  try {
    return typeof Notification !== "undefined";
  } catch {
    return false;
  }
};
App.ensureDesktopNotificationPermission = async function () {
  if (globalThis.chatDesktopNotifications?.showPing) return true;
  if (App.mobileNativeAvailable) return App.mobileRequestNotifications();
  if (!App.supportsDesktopNotifications()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const p = await Notification.requestPermission();
    return p === "granted";
  } catch {
    return false;
  }
};
App.showDesktopPingNotification = function ({
  roomId,
  fromUsername,
  fromCode = "",
  messageKey = "",
  pingId = "",
  message = null
} = {}) {
  if (!App.pushNotifsEnabled) return;
  if (fromCode) { App.ensureLiveUserListener?.(fromCode); fromUsername = App.getUserDisplayName?.(fromCode, { username: fromUsername }) || fromUsername; }
  if (globalThis.chatDesktopNotifications?.showPing) {
    const rid = String(roomId || ""), key = `${rid}/${String(messageKey || pingId || `${fromUsername}:${Date.now()}`)}`;
    if (!rid || desktopPingKeys.has(key)) return;
    if (App.isDesktopNotificationRoomActive(rid)) {
      desktopPingKeys.add(key); pendingDesktopPings.delete(key);
      App.syncDesktopNotificationPolicy?.();
      return;
    }
    const details = { roomId: rid, fromUsername, fromCode, messageKey, pingId, message };
    if (App.desktopNotificationPolicyReady?.() === false) { pendingDesktopPings.set(key, details); return; }
    pendingDesktopPings.delete(key);
    desktopPingKeys.add(key);
    const code = App.currentUser?.code;
    const send = resolved => {
      if (App.currentUser?.code !== code || !App.pushNotifsEnabled || !App.membershipMap.has(rid)) return;
      if (App.isDesktopNotificationRoomActive(rid)) { App.syncDesktopNotificationPolicy?.(); return; }
      if (App.desktopNotificationPolicyReady?.() === false) {
        desktopPingKeys.delete(key); pendingDesktopPings.set(key, { ...details, message: resolved }); return;
      }
      if (resolved?.deleted) return;
      const meta = App.roomsMetaCache?.get(rid) || {};
      const doNotDisturb = !!App.isDoNotDisturb?.();
      App.syncDesktopNotificationPolicy?.();
      globalThis.chatDesktopNotifications.showPing({ id: key, roomId: rid, messageKey: String(messageKey || ""),
        roomName: App.roomDisplayName?.(rid, meta) || rid, roomIcon: meta.photoDataURL || App.defaultStickmanDataURL?.() || "",
        roomIconTransform: App.normalizeTransformToRel?.(meta.photoTransform, 132) || { x: 0, y: 0, scale: 1 },
        username: App.getUserDisplayName?.(fromCode, { username: fromUsername }) || fromUsername || "Someone",
        preview: doNotDisturb ? "" : String(App.getMessagePreviewText?.(resolved) || resolved?.text || "New attachment").slice(0, 300),
        doNotDisturb, silent: true });
    };
    const cached = message || App.notificationRoomTails.get(rid)?.get(messageKey);
    if (cached || !messageKey || App.isDoNotDisturb?.()) send(cached);
    else void App.db.ref(`messages/${rid}/${messageKey}`).once("value").then(snap => send(snap.val())).catch(() => send(null));
    return;
  }
  if (App.mobileNativeAvailable) {
    if (App.isDoNotDisturb?.()) return;
    const key = `${String(roomId || "")}/${String(messageKey || pingId || `${fromUsername}:${Date.now()}`)}`;
    if (desktopPingKeys.has(key)) return;
    desktopPingKeys.add(key);
    App.mobilePost?.("notify", { id: key, roomId: String(roomId || ""), silent: true, title: "You were mentioned",
      body: `${fromUsername || "Someone"} pinged you in ${App.roomDisplayName?.(roomId, App.roomsMetaCache?.get(roomId)) || roomId}` });
    return;
  }
  if (!App.supportsDesktopNotifications()) return;
  if (Notification.permission !== "granted") return;
  const rid = String(roomId || "").trim();
  const from = String(fromUsername || "Someone").trim() || "Someone";
  const key = `${rid}/${String(messageKey || pingId || `${from}:${Date.now()}`)}`;
  // A ping inbox event and its message can arrive in either order. Distinct
  // messages from the same sender are never throttled or folded together.
  if (desktopPingKeys.has(key)) return;
  desktopPingKeys.add(key);
  try {
    const roomName = App.roomDisplayName?.(rid, App.roomsMetaCache?.get(rid)) || rid;
    const title = `${from} pinged you in ${roomName}`;
    const n = new Notification(title, {
      silent: true,
      tag: `ping:${key}`
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {}
      try {
        if (rid) App.openRoom(rid);
      } catch {}
      try {
        n.close();
      } catch {}
    };
  } catch {}
};
App.showPingSummaryToast = function (countsByRoom, {
  onClose = null
} = {}) {
  const rooms = Object.keys(countsByRoom || {});
  if (!rooms.length) return;
  const total = rooms.reduce((sum, r) => sum + (Number(countsByRoom[r]) || 0), 0);
  const btnId = `toast_open_room_${Math.random().toString(36).slice(2)}`;
  const canOpen = rooms.length === 1;
  const listHtml = rooms.sort((a, b) => a.localeCompare(b)).map(r => `<div><span class="strong" data-panel-room-name="${App.escapeAttr(r)}">${App.escapeHtml(App.roomDisplayName?.(r) || r)}</span>: ${Number(countsByRoom[r]) || 0}</div>`).join("");
  App.showToast({
    title: `Pinged ${total} time${total === 1 ? "" : "s"}`,
    bodyHTML: `
      <div class="muted small" style="margin-top:2px">Rooms:</div>
      <div class="small" style="margin-top:6px">${listHtml}</div>
      ${canOpen ? `<div style="margin-top:10px"><button class="btn tiny" id="${btnId}" type="button">Open Room</button></div>` : ``}
    `,
    duration: 9000,
    onClose
  });
  if (canOpen) {
    App.activePingToastRoomId = rooms[0];
    setTimeout(() => {
      const btn = document.getElementById(btnId);
      btn?.addEventListener("click", () => {
        App.closeToast("manual");
        App.openRoom(rooms[0]);
      }, {
        once: true
      });
    }, 0);
  } else {
    App.activePingToastRoomId = null;
  }
};
App.showPingToast = function ({
  roomId,
  fromUsername,
  fromCode = "",
  onClose = null
}) {
  const btnId = `toast_open_room_${Math.random().toString(36).slice(2)}`;
  App.activePingToastRoomId = roomId;
  if (fromCode) App.ensureLiveUserListener?.(fromCode);
  const author = App.getUserDisplayName?.(fromCode, { username: fromUsername }) || fromUsername || "Someone";
  App.showToast({
    title: "Pinged",
    bodyHTML: `
      <div class="small" style="margin-top:2px">
        <span class="strong" data-display-name-usercode="${App.escapeAttr(fromCode)}">${App.escapeHtml(author)}</span> pinged you in
        <span class="strong" data-panel-room-name="${App.escapeAttr(roomId)}">${App.escapeHtml(App.roomDisplayName?.(roomId) || roomId)}</span>.
      </div>
      <div style="margin-top:10px">
        <button class="btn tiny" id="${btnId}" type="button">Open Room</button>
      </div>
    `,
    duration: 9000,
    onClose
  });
  setTimeout(() => {
    const btn = document.getElementById(btnId);
    btn?.addEventListener("click", () => {
      App.closeToast("manual");
      App.openRoom(roomId);
    }, {
      once: true
    });
  }, 0);
};
App.handlePingsSnapshot = async function (v, {
  isInitial = false
} = {}) {
  const expectedCode = App.currentUser?.code, generation = pingInboxGeneration;
  if (!expectedCode) return;
  const newEvents = [];
  for (const [roomId, byId] of Object.entries(v || {})) {
    if (!byId || typeof byId !== "object") continue;
    for (const [pingId, rec] of Object.entries(byId || {})) {
      const key = `${roomId}/${pingId}`;
      if (App.seenPingKeys.has(key)) continue;
      App.seenPingKeys.add(key);
      newEvents.push({
        roomId,
        pingId,
        rec: rec || {}
      });
    }
  }
  if (!newEvents.length) return;

  const rooms = Array.from(new Set(newEvents.map(event => event.roomId)));
  const epochs = new Map();
  let nextRoom = 0;
  // A large offline inbox must not start an unbounded number of reads at once.
  await Promise.all(Array.from({ length: Math.min(4, rooms.length) }, async () => {
    while (nextRoom < rooms.length) {
      if (App.currentUser?.code !== expectedCode || generation !== pingInboxGeneration) return;
      const room = rooms[nextRoom++];
      epochs.set(room, await readPingClearEpoch(room));
    }
  }));
  if (App.currentUser?.code !== expectedCode || generation !== pingInboxGeneration) return;
  for (let index = newEvents.length - 1; index >= 0; index--) {
    const event = newEvents[index], epoch = epochs.get(event.roomId) || 0;
    const at = pingTimestamp(event.rec, event.pingId);
    // Keep boundary/unknown timestamps: a new ping can share the same
    // millisecond as the clear and must never be deleted as old history.
    if (!epoch || !at || at >= epoch) continue;
    newEvents.splice(index, 1);
    const ref = App.db.ref(`pings/${expectedCode}/${event.roomId}/${event.pingId}`);
    void Promise.resolve().then(() => ref.transaction(current => {
      if (App.currentUser?.code !== expectedCode || generation !== pingInboxGeneration) return;
      const currentAt = pingTimestamp(current, event.pingId);
      return current && currentAt > 0 && currentAt < epoch ? null : undefined;
    }, undefined, false)).catch(() => {});
  }
  if (!newEvents.length) return;
  const placeNow = App.getStoredPlace() || "home";
  const isHome = !App.currentRoomId && App.views.chat.dataset.active === "true" && placeNow === "home";

  // Desktop push notification (only for new pings, not the initial snapshot)
  if (!isInitial) {
    for (const ev of newEvents) {
      if (!App.membershipMap.has(ev.roomId)) continue;
      App.showDesktopPingNotification({
        roomId: ev.roomId,
        fromUsername: ev.rec?.fromUsername,
        fromCode: ev.rec?.from,
        messageKey: ev.rec?.msgKey,
        pingId: ev.pingId
      });
    }
  }

  // Keep pings in Firebase until the toast closes/expires.
  // If the tab disconnects while the toast is visible, onDisconnect() removes them automatically.
  const handles = [];
  for (const ev of newEvents) {
    try {
      const ref = App.db.ref(`pings/${App.currentUser.code}/${ev.roomId}/${ev.pingId}`);
      const od = ref.onDisconnect();
      od.remove();
      handles.push({
        ref,
        od
      });
    } catch {}
  }
  const cleanup = () => {
    for (const h of handles) {
      try {
        h.od.cancel();
      } catch {}
      try {
        h.ref.remove();
      } catch {}
    }
  };
  let shown = false;
  if (isHome && isInitial) {
    const counts = {};
    for (const ev of newEvents) {
      counts[ev.roomId] = (counts[ev.roomId] || 0) + 1;
    }
    App.showPingSummaryToast(counts, {
      onClose: cleanup
    });
    shown = true;
  } else {
    const ev = newEvents[0] || null;
    if (ev) {
      if (ev.rec?.from) App.ensureLiveUserListener?.(ev.rec.from);
      if (App.currentRoomId && App.currentRoomId === ev.roomId) {
        App.showToast({
          title: "Pinged",
          bodyHTML: `
            <div class="small" style="margin-top:2px">
              <span class="strong" data-display-name-usercode="${App.escapeAttr(ev.rec?.from || "")}">${App.escapeHtml(App.getUserDisplayName?.(ev.rec?.from, { username: ev.rec?.fromUsername }) || ev.rec?.fromUsername || "Someone")}</span> pinged you in this room.
            </div>
          `,
          duration: 2000,
          onClose: cleanup
        });
        shown = true;
      } else {
        App.showPingToast({
          roomId: ev.roomId,
          fromUsername: ev.rec?.fromUsername,
        fromCode: ev.rec?.from,
          onClose: cleanup
        });
        shown = true;
      }
    }
  }

  // If we decided not to show a toast for any reason, delete immediately.
  if (!shown) cleanup();
};
App.attachPingsInbox = function () {
  if (!App.currentUser) return;
  App.detachPingsInbox();
  App.pingsInboxRef = App.db.ref(`pings/${App.currentUser.code}`);
  App.pingsInboxFirstSnapshot = true;
  App.pingsInboxCb = snap => {
    const v = snap.exists() ? snap.val() || {} : {};
    const isInitial = App.pingsInboxFirstSnapshot;
    App.pingsInboxFirstSnapshot = false;
    void App.handlePingsSnapshot(v, {
      isInitial
    }).catch(error => console.warn("Ping inbox unavailable", error?.code));
  };
  App.pingsInboxRef.on("value", App.pingsInboxCb);
};

App.register("chat/notifications", function initializeFeature() {
App.lastDesktopPingAt = 0;
App.lastDesktopPingKey = "";
globalThis.chatDesktopNotifications?.onPingCommand?.(command => {
  void App.openDesktopPingMessage(command).catch(() => App.showToast?.({ title: "Unable to open mention", body: "Please open the room and try again.", duration: 3500 }));
});
window.addEventListener("focus", () => App.syncDesktopNotificationPolicy?.());
window.addEventListener("blur", () => App.syncDesktopNotificationPolicy?.());
document.addEventListener("visibilitychange", () => App.syncDesktopNotificationPolicy?.());
window.addEventListener("app:status-changed", () => {
  if (App.desktopNotificationPolicyReady?.() === false) return;
  for (const [key, details] of pendingDesktopPings) { pendingDesktopPings.delete(key); App.showDesktopPingNotification(details); }
});
});
})(globalThis.ChatApp);
