/* rooms/memberships: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.attachMemberships = function () {
  if (!App.currentUser) return;
  App.clearPendingRoomReads?.();
  if (App.membershipsRef) App.membershipsRef.off();
  App.attachPinnedRoomsSync();
  App.stopRoomMetaListeners();
  App.roomsMetaCache.clear();
  App.membershipMap.clear();
  App.restoreDone = false;

  // Fast first paint: reuse last-known rooms list immediately (then reconcile from Firebase)
  try {
    App.hydrateRoomsListFromCache();
  } catch {}
  App.membershipsRef = App.db.ref(`memberships/${App.currentUser.code}`);
  App.membershipsRef.on("value", snap => {
    const v = snap.exists() ? snap.val() || {} : {};
    const next = new Map();
    for (const [roomId, entry] of Object.entries(v)) {
      if (!roomId) continue;
      if (entry === true) {
        next.set(roomId, {
          joinedAt: 0,
          lastSeenAt: 0,
          lastSeenCount: 0
        });
      } else if (typeof entry === "object" && entry) {
        next.set(roomId, {
          joinedAt: Number(entry.joinedAt) || 0,
          lastSeenAt: Number(entry.lastSeenAt) || 0,
          lastSeenEpoch: Number(entry.lastSeenEpoch) || 0,
          lastSeenMessageKey: String(entry.lastSeenMessageKey || ""),
          lastSeenCount: Number(entry.lastSeenCount) || 0
        });
      }
    }
    for (const id of App.pendingRoomReads?.keys() || []) {
      const record = App.mergePendingRoomRead(id, next.get(id));
      if (record) next.set(id, record);
    }
    App.membershipMap = next;
    App.syncRoomMessageNotifications?.();
    App.renderRoomsList();
    App.scheduleRoomsListCacheSave();

    // If a ping toast is showing for a room you just left, close it immediately.
    if (App.activePingToastRoomId && !App.membershipMap.has(App.activePingToastRoomId)) {
      App.closeToast();
    }

    // Restore place (once). If the cached startup path already opened the room, do not reopen it.
    if (!App.restoreDone) {
      App.restoreDone = true;
      const place = App.getStoredPlace() || "home";
      if (place === "calendar" || place.startsWith("calendar:")) {
        if (place.startsWith("calendar:")) App.showCalendarDay(place.slice(9));
        else App.showCalendarPage();
        return;
      }
      if (place.startsWith("room:")) {
        const roomId = App.sanitizeRoomCode(place.slice(5));
        if (roomId && App.membershipMap.has(roomId)) {
          if (App.sanitizeRoomCode(App.currentRoomId) !== roomId) App.openRoom(roomId, {
            quiet: true
          });
          return;
        }
      }
      if (!App.currentRoomId) App.showLoggedInHome();
    }

    // If current room removed, go home
    if (App.currentRoomId && !App.membershipMap.has(App.currentRoomId)) {
      const displayName = App.roomDisplayName(App.currentRoomId, App.roomsMetaCache.get(App.currentRoomId) || null);
      App.showLoggedInHome();
      App.showToast({
        title: "Left room",
        body: `You left ${displayName}.`,
        duration: 2200
      });
    }

    // If we’re on Home overview, refresh it live when memberships change (join/leave/delete)
    const placeNow = App.getStoredPlace() || "home";
    if (App.restoreDone && !App.currentRoomId && App.views.chat.dataset.active === "true" && placeNow === "home") {
      App.clearMessagesToHome();
    }
  });
};

App.register("rooms/memberships", function initializeFeature() {

});
})(globalThis.ChatApp);
