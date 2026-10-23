/* rooms/cache: methods register before ordered initialization. */
(function (App) {
  "use strict";
// Session-only acceleration. Cold starts always use a small indexed query;
// no browser storage is required for either navigation or message history.
const recentRoomMessages = new Map();
App.getRecentRoomMessages = function (roomId) {
  const key = `${App.currentUser?.code || ""}:${roomId}`;
  const entry = recentRoomMessages.get(key);
  if (!entry) return [];
  recentRoomMessages.delete(key);
  recentRoomMessages.set(key, entry);
  return entry;
};
App.cacheRecentRoomMessages = function (roomId, payloads) {
  if (!App.currentUser?.code || !roomId) return;
  const key = `${App.currentUser.code}:${roomId}`;
  const items = [];
  let bytes = 0;
  for (const [messageKey, value] of Array.from(payloads).sort(([a], [b]) => App.compareMessageKeys(b, a)).slice(0, App.MSG_LIVE_TAIL)) {
    if (!value || value.__stub) continue;
    // Keep large inline attachments from turning the session cache into an
    // unbounded media store. The live query still delivers every attachment.
    const size = JSON.stringify(value).length * 2;
    // A partial cached tail produces the latest-message flash during entry.
    // Either retain the complete bounded tail or wait for its live snapshot.
    if (bytes + size > 2 * 1024 * 1024) { items.length = 0; break; }
    bytes += size;
    items.push({ key: messageKey, value });
  }
  recentRoomMessages.delete(key);
  if (items.length) recentRoomMessages.set(key, items.reverse());
  while (recentRoomMessages.size > 8) recentRoomMessages.delete(recentRoomMessages.keys().next().value);
};
App.clearRecentRoomMessages = function () { recentRoomMessages.clear(); };
App.invalidateRecentRoomMessages = function (roomId) {
  recentRoomMessages.delete(`${App.currentUser?.code || ""}:${roomId}`);
};
App.roomsListCacheKey = function () {
  const code = String(App.currentUser?.code || "").trim();
  return code ? App.ROOMS_LIST_CACHE_PREFIX + code : null;
};
App.hydrateRoomsListFromCache = function () {
  if (!App.currentUser) return false;
  const k = App.roomsListCacheKey();
  if (!k) return false;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    const rooms = Array.isArray(obj?.rooms) ? obj.rooms.map(r => String(r || "").trim()).filter(Boolean) : [];
    if (!rooms.length) return false;

    // Memberships: joinedAt/lastSeenAt will be replaced by the live listener shortly.
    App.membershipMap = new Map(rooms.map(rid => [rid, {
      joinedAt: 0,
      lastSeenAt: 0,
      lastSeenCount: 0
    }]));

    // Pinned state paints instantly; live pinned-room sync reconciles shortly.
    const cachedPins = Array.isArray(obj?.pinnedRooms) ? obj.pinnedRooms.map(r => App.sanitizeRoomCode(r)).filter(Boolean) : [];
    if (cachedPins.length) App.setPinnedRoomSetLocal(new Set(cachedPins));

    // Meta (preview/time) paints instantly; per-room listeners will reconcile.
    App.roomsMetaCache = new Map();
    const meta = obj && typeof obj.meta === "object" && obj.meta ? obj.meta : {};
    for (const [rid, m] of Object.entries(meta)) {
      if (rid && m && typeof m === "object") App.roomsMetaCache.set(rid, m);
    }
    App.renderRoomsList();
    return true;
  } catch {
    return false;
  }
};
App.saveRoomsListCacheNow = function () {
  if (!App.currentUser) return;
  const k = App.roomsListCacheKey();
  if (!k) return;
  try {
    const rooms = Array.from(new Set(App.membershipMap.keys())).sort((a, b) => a.localeCompare(b));
    const pinnedRooms = Array.from(App.getPinnedRoomSet()).sort((a, b) => a.localeCompare(b));
    const meta = {};
    for (const rid of rooms) {
      const m = App.roomsMetaCache.get(rid);
      if (!m || typeof m !== "object") continue;
      meta[rid] = {
        name: String(m.name || ""),
        createdBy: String(m.createdBy || ""),
        private: !!m.private,
        photoDataURL: String(m.photoDataURL || ""),
        photoTransform: m.photoTransform && typeof m.photoTransform === "object" ? m.photoTransform : null,
        lastMessagePreview: m.lastMessagePreview || "",
        lastMessageAt: m.lastMessageAt || 0,
        messageCount: Number(m.messageCount) || 0,
        messagesClearedAt: Number(m.messagesClearedAt) || 0
      };
    }
    localStorage.setItem(k, JSON.stringify({
      savedAt: Date.now(),
      rooms,
      pinnedRooms,
      meta
    }));
  } catch {}
};
App.scheduleRoomsListCacheSave = function () {
  if (App.roomsListCacheSaveTimer) return;
  App.roomsListCacheSaveTimer = setTimeout(() => {
    App.roomsListCacheSaveTimer = null;
    App.saveRoomsListCacheNow();
  }, 260);
};
App.accidentalCloseBeforeUnload = function (e) {
  e.preventDefault();
  e.returnValue = "";
  return "";
};
App.syncAccidentalClosePrevention = function () {
  if (App.accidentalClosePreventionEnabled) {
    if (!App.accidentalCloseBeforeUnloadBound) {
      window.addEventListener("beforeunload", App.accidentalCloseBeforeUnload);
      App.accidentalCloseBeforeUnloadBound = true;
    }
  } else {
    if (App.accidentalCloseBeforeUnloadBound) {
      window.removeEventListener("beforeunload", App.accidentalCloseBeforeUnload);
      App.accidentalCloseBeforeUnloadBound = false;
    }
  }
};

App.register("rooms/cache", function initializeFeature() {
App.ROOMS_LIST_CACHE_PREFIX = `chatapp_rooms_cache_v6:${App.firebaseConfig.projectId}:`;
App.roomsListCacheSaveTimer = null;
App.roomMetaListeners = new Map();
App.msgAddedRef = null;
App.msgRef = null;
App.msgCb = null;
App.msgChangedCb = null;
App.msgRemovedCb = null;
App.msgValCb = null;
App.renderedMsgKeys = new Set();
App.replyTargetPreviewCache = new Map();
App.replyTargetHydratePending = new Set();
App.liveUserCache = new Map();
App.liveUserListeners = new Map();
App.pingsInboxRef = null;
App.pingsInboxCb = null;
App.pingsInboxFirstSnapshot = true;
App.seenPingKeys = new Set();
App.activePingToastRoomId = null;
App.autoScrollEnabled = true;
App.suspendAutoScrollUntil = 0;
App.suppressHistoryAutoLoadUntil = 0;
App.stickyBottomPinUntil = 0;
App.stickyBottomPinRaf = 0;
App.pushNotifsEnabled = true;
App.accidentalClosePreventionEnabled = false;
App.accidentalCloseBeforeUnloadBound = false;
App.restoreDone = false;
});
})(globalThis.ChatApp);
