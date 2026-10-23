/* activities/room-games: methods register before ordered initialization. */
(function (App) {
  "use strict";
const claimOperations = new Set();
App.openHtmlStage = async function (game) {
  App.closeModal();
  const nextResumeKey = App.getHtmlHubResumeKey(game);
  const currentResumeKey = App.getHtmlHubResumeKey(App.selectedGame);
  if (!App.gamesStageOpen && App.selectedGame?.roomActivityId && currentResumeKey && currentResumeKey !== nextResumeKey) {
    await App.closeGamesStage({
      preserve: false
    });
  }
  const isSwitchingGames = !!(App.gamesStageOpen && currentResumeKey && nextResumeKey && currentResumeKey !== nextResumeKey);
  if (isSwitchingGames) {
    await App.closeGamesStage({
      preserve: true
    });
  } else if (App.gamesStageOpen) {
    App.destroyGamesFrame({
      preserve: true
    });
  }
  App.clearOtherParkedGamesFrames(nextResumeKey);
  const shouldResumePaused = App.isHtmlHubPaused(game) || App.hasPausedMergeParty?.(game);
  App.selectedGame = {
    ...game,
    lastProgressSnapshot: null
  };
  App.gamesStageOpen = true;
  App.gamesStageLoaded = shouldResumePaused;
  void App.syncMyHtmlActivityPresence();
  void App.syncMyRoomActivityPresence();
  App.gamesStageMaximized = false;
  App.gamesWindowRectBeforeMaximize = null;
  App.gamesWindowRect = App.getDefaultGamesWindowRect();
  App.ensureGamesStage();
  const overlay = App.$("games-stage-overlay");
  if (overlay) overlay.classList.add("open");
  if (game.roomActivityId) App.enterRoomActivityMode?.();
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
  await App.renderGamesStage();
};
App.getBoplRoyaleActivityHTML = function () {
  return window.ChatActivities.load("bopl-royale");
};
App.getMergePartyActivityHTML = function () {
  return window.ChatActivities.load("merge-party");
};
App.syncRoomActivityDisplayName = function (roomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  const name = App.roomDisplayName(id);
  // Reuse room metadata already observed by the host. Games need no separate
  // database listener, and a rename never changes their multiplayer room key.
  for (const key of ["__boplRoyaleLaunchConfig", "__mergePartyLaunchConfig"]) {
    const launch = window[key];
    if (launch && App.sanitizeRoomCode(launch.roomId) === id) launch.roomName = name;
  }
  if (App.sanitizeRoomCode(App.selectedGame?.roomActivityRoomId) !== id) return;
  try { App.$("games-frame")?.contentWindow?.__boplRoyale?.updateRoomDisplayName?.(name); } catch {}
};
App.roomActivityClaimPath = function (code = App.currentUser?.code) {
  return code ? `activities/roomActivityClaims/${code}` : "";
};
App.makeRoomActivityClaimToken = function (activityId, roomId) {
  const activityPart = String(activityId || "activity").replace(/[.#$\[\]\/]/g, "_");
  const roomPart = String(roomId || "room").replace(/[.#$\[\]\/]/g, "_");
  return `${App.CLIENT_INSTANCE_ID}_${activityPart}_${roomPart}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
};
App.getLiveRoomActivityClaimSessions = function (rawSessions, now) {
  const source = rawSessions && typeof rawSessions === "object" ? rawSessions : {};
  const sessions = {};
  Object.entries(source).forEach(([token, raw]) => {
    if (!raw || typeof raw !== "object") return;
    const expiresAt = Math.max(0, Number(raw.expiresAt || 0));
    if (!expiresAt || expiresAt <= now) return;
    const activityId = String(raw.activityId || "").trim();
    const roomId = App.sanitizeRoomCode(raw.roomId);
    if (!activityId || !roomId) return;
    sessions[token] = {
      token,
      clientId: String(raw.clientId || ""),
      activityId,
      title: String(raw.title || "Activity"),
      roomId,
      joinedAt: Math.max(0, Number(raw.joinedAt || now)) || now,
      updatedAt: Math.max(0, Number(raw.updatedAt || now)) || now,
      expiresAt
    };
  });
  return sessions;
};
App.pickRoomActivityClaimOwner = function (sessions, preferredToken = "") {
  if (preferredToken && sessions[preferredToken]) return sessions[preferredToken];
  return Object.values(sessions).sort((a, b) => {
    const timeDelta = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    return timeDelta || String(b.token || "").localeCompare(String(a.token || ""));
  })[0] || null;
};
App.buildRoomActivityClaimValue = function (sessions, owner, now) {
  if (!owner) return null;
  return {
    schemaVersion: App.ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION,
    activityId: owner.activityId,
    title: owner.title,
    roomId: owner.roomId,
    claimToken: owner.token,
    clientId: owner.clientId,
    joinedAt: owner.joinedAt,
    updatedAt: now,
    leaseExpiresAt: owner.expiresAt,
    sessions
  };
};
App.clearRoomActivityClaimHeartbeat = function (token = App.roomActivityClaimToken) {
  if (token && App.roomActivityClaimToken && token !== App.roomActivityClaimToken) return;
  if (App.roomActivityClaimHeartbeatTimer) {
    clearInterval(App.roomActivityClaimHeartbeatTimer);
    App.roomActivityClaimHeartbeatTimer = 0;
  }
};
App.renewRoomActivityClaim = async function (token, activityId, roomId, title) {
  if (App.roomActivityPasswordSuspension || !token || token !== App.roomActivityClaimToken || !App.roomActivityClaimRef) return false;
  const ref = App.roomActivityClaimRef, code = App.currentUser?.code;
  const now = App.accurateNowMs();
  try {
    const result = await ref.transaction(current => {
      if (App.roomActivityPasswordSuspension || code !== App.currentUser?.code || ref !== App.roomActivityClaimRef || token !== App.roomActivityClaimToken) return;
      const existing = current && typeof current === "object" ? current : {};
      const sessions = App.getLiveRoomActivityClaimSessions(existing.sessions, now);
      let session = sessions[token];
      if (!session) {
        const conflict = Object.values(sessions).find(candidate => candidate.activityId !== activityId || candidate.roomId !== roomId);
        if (conflict) return;
        if (Number(existing.schemaVersion || 0) < App.ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION) {
          const legacyActivityId = String(existing.activityId || "").trim();
          const legacyRoomId = App.sanitizeRoomCode(existing.roomId);
          const legacyUpdatedAt = Math.max(0, Number(existing.updatedAt || existing.joinedAt || 0));
          const legacyIsFresh = !!legacyActivityId && !!legacyRoomId && (!legacyUpdatedAt || now - legacyUpdatedAt < App.ROOM_ACTIVITY_LEGACY_STALE_MS);
          if (legacyIsFresh && (legacyActivityId !== activityId || legacyRoomId !== roomId)) return;
        }
        session = {
          token,
          clientId: App.CLIENT_INSTANCE_ID,
          activityId,
          title,
          roomId,
          joinedAt: now,
          updatedAt: now,
          expiresAt: now + App.ROOM_ACTIVITY_CLAIM_LEASE_MS
        };
      }
      if (session.clientId !== App.CLIENT_INSTANCE_ID) return;
      if (session.activityId !== activityId || session.roomId !== roomId) return;
      sessions[token] = {
        ...session,
        title,
        updatedAt: now,
        expiresAt: now + App.ROOM_ACTIVITY_CLAIM_LEASE_MS
      };
      const owner = App.pickRoomActivityClaimOwner(sessions, String(existing.claimToken || ""));
      return App.buildRoomActivityClaimValue(sessions, owner, now);
    }, undefined, false);
    return !!result?.committed;
  } catch (err) {
    console.warn("Room activity claim heartbeat failed:", err);
    return false;
  }
};
App.startRoomActivityClaimHeartbeat = function (token, activityId, roomId, title) {
  App.clearRoomActivityClaimHeartbeat();
  App.roomActivityClaimHeartbeatTimer = window.setInterval(() => {
    if (token !== App.roomActivityClaimToken) {
      App.clearRoomActivityClaimHeartbeat(token);
      return;
    }
    void App.renewRoomActivityClaim(token, activityId, roomId, title);
  }, App.ROOM_ACTIVITY_CLAIM_HEARTBEAT_MS);
};
App.showRoomActivityClaimConflict = function (conflict) {
  const existingRoomId = App.sanitizeRoomCode(conflict?.roomId);
  if (existingRoomId) {
    App.showToast({
      title: "Already in an activity",
      body: `Leave the activity in room ${App.roomDisplayName(existingRoomId)} before joining one in this room.`,
      duration: 3600
    });
    return;
  }
  App.showToast({
    title: "Already in an activity",
    body: "Leave your current room activity first.",
    duration: 3200
  });
};
App.claimRoomActivity = async function ({
  activityId,
  title,
  roomId,
  errorLabel
}) {
  const activityRoomId = App.sanitizeRoomCode(roomId);
  const path = App.roomActivityClaimPath();
  const normalizedActivityId = String(activityId || "").trim();
  if (App.roomActivityPasswordSuspension || !App.currentUser?.code || !activityRoomId || !normalizedActivityId || !path) return false;
  const ownerCode = App.currentUser.code;
  if (App.roomActivityClaimToken) {
    if (App.roomActivityClaimActivityId === normalizedActivityId && App.roomActivityClaimRoomId === activityRoomId) {
      const renewed = await App.renewRoomActivityClaim(App.roomActivityClaimToken, normalizedActivityId, activityRoomId, title);
      if (renewed) return true;
      App.showToast({
        title: "Connection unavailable",
        body: "The room activity is reconnecting. Try again in a moment.",
        duration: 2800
      });
      return false;
    }
    App.showRoomActivityClaimConflict({
      roomId: App.roomActivityClaimRoomId
    });
    return false;
  }
  const ref = App.db.ref(path);
  const token = App.makeRoomActivityClaimToken(normalizedActivityId, activityRoomId);
  const sessionRef = ref.child(`sessions/${token}`);
  let conflict = null;
  try {
    await sessionRef.onDisconnect().remove();
    const now = App.accurateNowMs();
    const result = await ref.transaction(current => {
      if (App.roomActivityPasswordSuspension || App.currentUser?.code !== ownerCode) return;
      conflict = null;
      const existing = current && typeof current === "object" ? current : {};
      const sessions = App.getLiveRoomActivityClaimSessions(existing.sessions, now);
      const liveConflict = Object.values(sessions).find(session => session.activityId !== normalizedActivityId || session.roomId !== activityRoomId);
      if (liveConflict) {
        conflict = liveConflict;
        return;
      }
      if (Number(existing.schemaVersion || 0) < App.ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION && !Object.keys(sessions).length) {
        const legacyActivityId = String(existing.activityId || "").trim();
        const legacyRoomId = App.sanitizeRoomCode(existing.roomId);
        const legacyUpdatedAt = Math.max(0, Number(existing.updatedAt || existing.joinedAt || 0));
        const legacyIsFresh = !!legacyActivityId && !!legacyRoomId && (!legacyUpdatedAt || now - legacyUpdatedAt < App.ROOM_ACTIVITY_LEGACY_STALE_MS);
        if (legacyIsFresh && (legacyActivityId !== normalizedActivityId || legacyRoomId !== activityRoomId)) {
          conflict = {
            activityId: legacyActivityId,
            roomId: legacyRoomId
          };
          return;
        }
      }
      sessions[token] = {
        token,
        clientId: App.CLIENT_INSTANCE_ID,
        activityId: normalizedActivityId,
        title,
        roomId: activityRoomId,
        joinedAt: now,
        updatedAt: now,
        expiresAt: now + App.ROOM_ACTIVITY_CLAIM_LEASE_MS
      };
      return App.buildRoomActivityClaimValue(sessions, sessions[token], now);
    }, undefined, false);
    if (!result?.committed) {
      try {
        await sessionRef.onDisconnect().cancel();
      } catch {}
      if (conflict) App.showRoomActivityClaimConflict(conflict);else App.showToast({
        title: "Activity unavailable",
        body: "Could not reserve this room activity. Try again.",
        duration: 3200
      });
      return false;
    }
    App.roomActivityClaimRef = ref;
    App.roomActivityClaimSessionRef = sessionRef;
    App.roomActivityClaimToken = token;
    App.roomActivityClaimActivityId = normalizedActivityId;
    App.roomActivityClaimRoomId = activityRoomId;
    App.startRoomActivityClaimHeartbeat(token, normalizedActivityId, activityRoomId, title);
    return true;
  } catch (err) {
    try {
      await sessionRef.onDisconnect().cancel();
    } catch {}
    console.error(`${errorLabel || title || "Room activity"} activity claim failed:`, err);
    App.showToast({
      title: "Activity unavailable",
      body: "Could not reserve this room activity. Try again.",
      duration: 3200
    });
    return false;
  }
};
App.releaseRoomActivityClaim = async function (expectedActivityId) {
  const path = App.roomActivityClaimPath();
  const ref = App.roomActivityClaimRef || (path ? App.db.ref(path) : null);
  const token = App.roomActivityClaimToken;
  const sessionRef = App.roomActivityClaimSessionRef || (ref && token ? ref.child(`sessions/${token}`) : null);
  if (!ref) return;
  if (expectedActivityId && App.roomActivityClaimActivityId && expectedActivityId !== App.roomActivityClaimActivityId) return;
  App.clearRoomActivityClaimHeartbeat(token);
  App.roomActivityClaimRef = null;
  App.roomActivityClaimSessionRef = null;
  App.roomActivityClaimToken = "";
  App.roomActivityClaimActivityId = "";
  App.roomActivityClaimRoomId = "";
  let released = false;
  try {
    const now = App.accurateNowMs();
    const result = await ref.transaction(current => {
      if (!current || typeof current !== "object") return null;
      const sessions = App.getLiveRoomActivityClaimSessions(current.sessions, now);
      let ownsCurrentClaim = false;
      if (token) {
        const rawSession = current.sessions?.[token];
        const session = sessions[token];
        const ownsSession = String(rawSession?.clientId || session?.clientId || "") === App.CLIENT_INSTANCE_ID;
        const ownsAggregate = String(current.claimToken || "") === token && String(current.clientId || "") === App.CLIENT_INSTANCE_ID;
        ownsCurrentClaim = ownsSession || ownsAggregate;
        if (!ownsCurrentClaim) return current;
        delete sessions[token];
      } else {
        Object.entries(sessions).forEach(([sessionToken, session]) => {
          if (session.clientId === App.CLIENT_INSTANCE_ID && (!expectedActivityId || session.activityId === expectedActivityId)) {
            ownsCurrentClaim = true;
            delete sessions[sessionToken];
          }
        });
        if (!ownsCurrentClaim && Number(current.schemaVersion || 0) < App.ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION) return current;
      }
      const owner = App.pickRoomActivityClaimOwner(sessions, String(current.claimToken || "") === token ? "" : String(current.claimToken || ""));
      return App.buildRoomActivityClaimValue(sessions, owner, now);
    }, undefined, false);
    released = !!result?.committed;
  } catch (err) {
    console.warn("Room activity claim release transaction failed:", err);
    if (sessionRef) {
      try {
        await sessionRef.remove();
        released = true;
      } catch {}
    }
  }
  if (released && sessionRef) {
    try {
      await sessionRef.onDisconnect().cancel();
    } catch {}
  }
};
App.claimBoplRoyaleRoomActivity = async function (roomId) {
  return App.claimRoomActivity({
    activityId: App.ROOM_ACTIVITY_BOPL_ROYALE,
    title: "Bopl Royale",
    roomId,
    errorLabel: "Bopl Royale"
  });
};
App.boplRoyalePlayerSessionIsLive = function (player, now) {
  if (!player || typeof player !== "object") return false;
  const sessions = player.sessions && typeof player.sessions === "object" ? Object.values(player.sessions) : [];
  if (Number(player.presenceVersion || 0) >= 1) {
    return sessions.some(session => {
      if (!session || session.connected === false) return false;
      const stamp = Math.max(0, Number(session.heartbeatAt || session.updatedAt || 0));
      return !stamp || now - stamp < 90 * 1000;
    });
  }
  const stamp = Math.max(0, Number(player.heartbeatAt || player.updatedAt || player.joinedAt || 0));
  return player.connected !== false && (!stamp || now - stamp < App.ROOM_ACTIVITY_LEGACY_STALE_MS);
};
App.cleanupEmptyBoplRoyaleActivity = async function (roomId) {
  const normalizedRoomId = App.sanitizeRoomCode(roomId);
  if (!normalizedRoomId) return false;
  const root = App.db.ref(`activities/boplRoyale/rooms/${normalizedRoomId}`);
  try {
    const now = App.accurateNowMs();
    const result = await root.transaction(activity => {
      if (!activity || typeof activity !== "object") return null;
      const players = activity.players && typeof activity.players === "object" ? Object.values(activity.players) : [];
      if (players.some(player => App.boplRoyalePlayerSessionIsLive(player, now))) return;
      return null;
    }, undefined, false);
    return !!(result?.committed && !result.snapshot?.exists());
  } catch (err) {
    console.warn("Bopl Royale empty activity cleanup failed:", err);
    return false;
  }
};
App.releaseBoplRoyaleRoomActivity = async function (game = App.selectedGame) {
  if (!game?.roomActivityId || game.roomActivityId !== App.ROOM_ACTIVITY_BOPL_ROYALE) return;
  await App.cleanupEmptyBoplRoyaleActivity(game.roomActivityRoomId);
  await App.releaseRoomActivityClaim(App.ROOM_ACTIVITY_BOPL_ROYALE);
};
App.claimMergePartyRoomActivity = async function (roomId) {
  return App.claimRoomActivity({
    activityId: App.ROOM_ACTIVITY_MERGE_PARTY,
    title: "Merge Party",
    roomId,
    errorLabel: "Merge Party"
  });
};
App.releaseMergePartyRoomActivity = async function (game = App.selectedGame) {
  if (!game?.roomActivityId || game.roomActivityId !== App.ROOM_ACTIVITY_MERGE_PARTY) return;
  await App.releaseRoomActivityClaim(App.ROOM_ACTIVITY_MERGE_PARTY);
};
// Passwords are the legacy account keys. Hold every captured claim writer
// before moving that key; a kept-alive iframe must never recreate the old one.
App.suspendRoomActivityForPasswordChange = async function () {
  if (App.roomActivityPasswordSuspension) return App.roomActivityPasswordSuspension;
  const game = App.selectedGame;
  const controller = game?.roomActivityId === App.ROOM_ACTIVITY_BOPL_ROYALE
    ? App.$("games-frame")?.contentWindow?.__boplRoyale : null;
  const snapshot = {
    code: String(App.currentUser?.code || ""), game,
    activityId: App.roomActivityClaimActivityId || game?.roomActivityId || "",
    roomId: App.roomActivityClaimRoomId || game?.roomActivityRoomId || "",
    title: game?.label || "Activity", hadClaim: !!App.roomActivityClaimToken,
    reopenBopl: !!controller && controller.isOnline?.() !== false,
    wasOnline: controller?.isOnline?.() === true,
    pausedMergeParty: App.pausedMergeParty || null
  };
  App.roomActivityPasswordSuspension = snapshot;
  App.clearRoomActivityClaimHeartbeat();
  // Transactions already in flight must settle before the password transaction
  // takes its root snapshot. New claims/renewals are blocked while suspended.
  await Promise.allSettled([...claimOperations]);
  snapshot.hadClaim ||= !!App.roomActivityClaimToken;
  snapshot.activityId ||= App.roomActivityClaimActivityId || "";
  snapshot.roomId ||= App.roomActivityClaimRoomId || "";
  if (snapshot.reopenBopl) await App.closeGamesStage({ preserve: false });
  else if (snapshot.hadClaim) await App.releaseRoomActivityClaim(snapshot.activityId);
  return snapshot;
};
App.resumeRoomActivityAfterPasswordChange = async function (snapshot = App.roomActivityPasswordSuspension) {
  if (!snapshot || App.roomActivityPasswordSuspension !== snapshot) return false;
  App.roomActivityPasswordSuspension = null;
  const code = String(App.currentUser?.code || "");
  if (!code) return false;
  if (snapshot.pausedMergeParty && App.pausedMergeParty === snapshot.pausedMergeParty) {
    App.pausedMergeParty.userCode = code;
    App.$("merge-party-paused-frame")?.contentWindow?.__mergeParty?.updateAccountPassword?.(code);
  }
  for (const name of ["__mergePartyLaunchConfig", "__boplRoyaleLaunchConfig"]) {
    if (window[name]?.user?.code === snapshot.code) window[name].user.code = code;
  }
  if (snapshot.reopenBopl) {
    if (App.selectedGame || String(App.currentRoomId || "") !== String(snapshot.roomId)) return false;
    await App.openBoplRoyaleActivity(snapshot.roomId);
    if (snapshot.wasOnline && App.currentUser?.code === code) {
      const frame = App.$("games-frame");
      let controller = frame?.contentWindow?.__boplRoyale;
      if (!controller && frame) controller = await new Promise(resolve => {
        let timer;
        const done = () => {
          clearTimeout(timer); frame.removeEventListener("load", done);
          resolve(App.$("games-frame") === frame && App.currentUser?.code === code ? frame.contentWindow?.__boplRoyale : null);
        };
        frame.addEventListener("load", done, { once: true });
        timer = setTimeout(done, 10000);
      });
      if (App.currentUser?.code === code) await controller?.reconnectOnline?.();
    }
    return true;
  }
  if (App.selectedGame !== snapshot.game) return false;
  const frame = App.$("games-frame")?.contentWindow;
  frame?.__mergeParty?.updateAccountPassword?.(code);
  frame?.__boplRoyale?.updateLocalAccountPassword?.(code);
  if (!snapshot.hadClaim) return true;
  const claimed = await App.claimRoomActivity({ activityId: snapshot.activityId, roomId: snapshot.roomId, title: snapshot.title });
  if (claimed) await App.syncMyRoomActivityPresence();
  return claimed;
};
for (const name of ["claimRoomActivity", "renewRoomActivityClaim"]) {
  const operation = App[name];
  App[name] = function (...args) {
    const pending = Promise.resolve(operation.apply(this, args));
    claimOperations.add(pending);
    void pending.finally(() => claimOperations.delete(pending)).catch(() => {});
    return pending;
  };
}
App.getCurrentRoomActivityPayload = function (roomId = App.currentRoomId) {
  const activeRoomId = App.sanitizeRoomCode(roomId);
  const activityRoomId = App.sanitizeRoomCode(App.selectedGame?.roomActivityRoomId);
  const activityId = String(App.selectedGame?.roomActivityId || "").trim();
  const isRunningOrParked = App.gamesStageOpen;
  if (!isRunningOrParked || !activityId || !activeRoomId || activityRoomId !== activeRoomId) return null;
  return {
    id: activityId,
    title: String(App.selectedGame?.label || "Activity"),
    startedAt: Math.max(0, Number(App.selectedGame?.roomActivityStartedAt || 0)) || Date.now()
  };
};
App.syncMyRoomActivityPresence = async function () {
  if (!App.myPresenceRef || !App.currentUser?.code) return;
  const roomActivity = App.getCurrentRoomActivityPayload();
  try {
    await App.myPresenceRef.update({
      roomActivity: roomActivity || null,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    });
  } catch {}
};
App.syncRoomActivitiesButton = function () {
  App.renderRoomActivitiesParticipants?.();
  const btn = App.$("btn-activities");
  if (!btn) return;
  const placeNow = App.getStoredPlace() || "home";
  const inRoom = !!(App.currentUser && App.currentRoomId && placeNow.startsWith("room:") && App.views.chat?.dataset?.active === "true");
  const selfCode = String(App.currentUser?.code || "");
  const hasOtherParticipant = inRoom && Array.from(App.onlinePresenceCache.entries()).some(([code, rec]) => {
    if (!code || String(code) === selfCode) return false;
    return ["online", "idle"].includes(App.appPresenceCache?.get(code)) && !!String(rec?.roomActivity?.id || "").trim();
  });
  btn.classList.toggle("has-active-room-activity", hasOtherParticipant);
  btn.setAttribute("aria-label", hasOtherParticipant ? "Open room activities; someone is participating" : "Open room activities");
  btn.dataset.tooltip = hasOtherParticipant ? "Activities — Someone Is Participating" : "Activities";
  btn.removeAttribute("title");
};
App.roomActivitiesBodyHTML = function () {
  return `
    <div class="room-activities-grid" aria-label="Available room activities">
      <button class="room-activity-card" id="room-activity-bopl-royale" type="button" aria-label="Open Bopl Royale">
        <span class="room-activity-thumbnail" aria-hidden="true"></span>
        <span class="room-activity-card-footer">
          <span class="room-activity-card-title">Bopl Royale</span>
        </span>
      </button>
      <button class="room-activity-card" id="room-activity-merge-party" type="button" aria-label="Open Merge Party">
        <span class="room-activity-thumbnail merge-party-thumbnail" aria-hidden="true"></span>
        <span class="room-activity-card-footer">
          <span class="room-activity-card-title">Merge Party</span>
        </span>
      </button>
    </div>
  `;
};
App.openRoomActivitiesModal = function () {
  const placeNow = App.getStoredPlace() || "home";
  const roomId = App.sanitizeRoomCode(App.currentRoomId);
  if (!App.currentUser || !roomId || !placeNow.startsWith("room:") || App.views.chat?.dataset?.active !== "true") {
    App.showToast({
      title: "Pick a room",
      body: "Create or join a room first.",
      duration: 2200
    });
    return;
  }
  let menu = App.$("room-activities-menu");
  if (menu && !menu.hidden) { App.closeRoomActivitiesMenu(); return; }
  if (App.voiceRecorder) return;
  App.closeEmojiPopover?.();
  App.closeStickerPopover?.();
  App.closeVoicePopover?.();
  App.closeComposerMoreMenu?.({ immediate: true });
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "room-activities-menu";
    menu.className = "room-activities-menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Room Activities");
    menu.innerHTML = '<div class="room-activities-menu-head"><div><strong>Room Activities</strong><span id="room-activities-subtitle"></span></div><button type="button" class="icon-btn" aria-label="Close activities menu" id="room-activities-close">×</button></div>' + App.roomActivitiesBodyHTML();
    document.querySelector(".composer").appendChild(menu);
    App.$("room-activities-close").onclick = () => { App.closeRoomActivitiesMenu(); App.$("btn-activities")?.focus(); };
    menu.querySelectorAll(".room-activity-card").forEach(card => {
      const activityId = card.id.replace("room-activity-", "");
      const players = document.createElement("span");
      players.className = "room-activity-players";
      players.dataset.activityPlayers = activityId;
      card.appendChild(players);
      card.addEventListener("click", async () => {
        const currentRoom = App.currentRoomId;
        App.closeRoomActivitiesMenu();
        if (App.gamesStageOpen) await App.closeGamesStage({ preserve: App.selectedGame?.roomActivityId === App.ROOM_ACTIVITY_MERGE_PARTY });
        if (activityId === App.ROOM_ACTIVITY_BOPL_ROYALE) await App.openBoplRoyaleActivity(currentRoom);
        else await App.openMergePartyActivity(currentRoom);
      });
    });
  }
  menu.hidden = false;
  menu.classList.add("open");
  App.$("room-activities-subtitle").textContent = `Play together in ${App.roomDisplayName(roomId)}`;
  App.$("btn-activities")?.setAttribute("aria-expanded", "true");
  App.renderRoomActivitiesParticipants();
  App.layoutChatPopovers?.();
};
App.closeRoomActivitiesMenu = function () {
  const menu = App.$("room-activities-menu");
  if (menu) { menu.hidden = true; menu.classList.remove("open"); }
  App.$("btn-activities")?.setAttribute("aria-expanded", "false");
};
App.renderRoomActivitiesParticipants = function () {
  const menu = App.$("room-activities-menu");
  if (!menu || menu.hidden) return;
  menu.querySelectorAll("[data-activity-players]").forEach(host => {
    const players = Array.from(App.onlinePresenceCache.entries()).filter(([code, presence]) =>
      code !== App.currentUser?.code && presence?.roomActivity?.id === host.dataset.activityPlayers && ["online", "idle"].includes(App.appPresenceCache?.get(code)) && !App.isGhostModeEnabledForRoom?.(App.currentRoomId, code));
    host.replaceChildren();
    host.hidden = players.length === 0;
    for (const [code, presence] of players) {
      App.ensureLiveUserListener?.(code);
      const user = App.liveUserCache.get(code) || { code, username: presence.username };
      const row = document.createElement("span");
      row.className = "room-activity-player";
      const avatar = document.createElement("span");
      avatar.className = "call-viewer-avatar room-activity-player-avatar";
      avatar.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.dataset.displayNameUsercode = code;
      name.textContent = user.displayName || user.username || "Player";
      row.append(avatar, name);
      host.appendChild(row);
      App.applyAvatar(avatar, user);
    }
  });
};
App.openBoplRoyaleActivity = async function (roomId = App.currentRoomId) {
  const activityRoomId = App.sanitizeRoomCode(roomId);
  if (!App.currentUser || !activityRoomId || activityRoomId !== App.sanitizeRoomCode(App.currentRoomId)) return;
  const launchUser = App.currentUser;
  let activityHTML;
  try {
    activityHTML = await App.getBoplRoyaleActivityHTML();
  } catch (error) {
    console.error("Activity files failed to load", error);
    App.showToast({
      title: "Activity unavailable",
      body: "The activity files could not load. Check that the whole app folder is present, then try again.",
      duration: 5000
    });
    return;
  }
  if (App.currentUser !== launchUser || activityRoomId !== App.sanitizeRoomCode(App.currentRoomId)) return;
  const claimed = await App.claimBoplRoyaleRoomActivity(activityRoomId);
  if (!claimed) return;
  const liveProfile = App.liveUserCache.get(String(App.currentUser.code || "")) || {};
  window.__boplRoyaleLaunchConfig = {
    roomId: activityRoomId,
    roomName: App.roomDisplayName(activityRoomId),
    activityId: App.ROOM_ACTIVITY_BOPL_ROYALE,
    activityVersion: "2026.09.01-editing-rays-missile-v24",
    networkProtocol: 22,
    performanceProfile: "multiplayer-smooth",
    databaseURL: String(App.firebaseConfig?.databaseURL || ""),
    user: {
      code: String(App.currentUser.code || ""),
      username: String(liveProfile.username || App.currentUser.username || "Player"),
      displayName: String(liveProfile.displayName || App.currentUser.displayName || liveProfile.username || App.currentUser.username || "Player")
    }
  };
  try {
    await App.openHtmlStage({
      id: `room-activity:${activityRoomId}:${App.ROOM_ACTIVITY_BOPL_ROYALE}`,
      label: "Bopl Royale",
      activityLabel: "Bopl Royale",
      uploadFileName: "Bopl Royale",
      html: activityHTML,
      __upload: true,
      hubId: null,
      roomActivityId: App.ROOM_ACTIVITY_BOPL_ROYALE,
      roomActivityRoomId: activityRoomId,
      roomActivityStartedAt: Date.now()
    });
  } catch (err) {
    await App.releaseBoplRoyaleRoomActivity({
      roomActivityId: App.ROOM_ACTIVITY_BOPL_ROYALE
    });
    throw err;
  }
  App.gamesStageLoaded = true;
  App.gamesWindowRectBeforeMaximize = App.getDefaultGamesWindowRect();
  App.gamesStageMaximized = true;
  App.gamesWindowRect = App.getMaximizedGamesWindowRect();
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
  await App.renderGamesStage(true);
  App.syncGamesStageFullscreenButton();
  await App.syncMyRoomActivityPresence();
};
App.openMergePartyActivity = async function (roomId = App.currentRoomId) {
  const activityRoomId = App.sanitizeRoomCode(roomId);
  if (!App.currentUser || !activityRoomId || activityRoomId !== App.sanitizeRoomCode(App.currentRoomId)) return;
  const launchUser = App.currentUser;
  let activityHTML;
  try {
    activityHTML = await App.getMergePartyActivityHTML();
  } catch (error) {
    console.error("Activity files failed to load", error);
    App.showToast({
      title: "Activity unavailable",
      body: "The activity files could not load. Check that the whole app folder is present, then try again.",
      duration: 5000
    });
    return;
  }
  if (App.currentUser !== launchUser || activityRoomId !== App.sanitizeRoomCode(App.currentRoomId)) return;
  const claimed = await App.claimMergePartyRoomActivity(activityRoomId);
  if (!claimed) return;
  window.__mergePartyLaunchConfig = {
    roomId: activityRoomId,
    roomName: App.roomDisplayName(activityRoomId),
    activityId: App.ROOM_ACTIVITY_MERGE_PARTY,
    activityVersion: "2026.09.03-physics-v5",
    offline: true,
    user: {
      code: String(App.currentUser.code || ""),
      username: String(App.currentUser.username || "Player"),
      displayName: String(App.currentUser.displayName || App.currentUser.username || "Player"),
      photoDataURL: String(App.currentUser.photoDataURL || App.defaultStickmanDataURL())
    }
  };
  try {
    await App.openHtmlStage({
      id: `room-activity:${activityRoomId}:${App.ROOM_ACTIVITY_MERGE_PARTY}`,
      label: "Merge Party",
      activityLabel: "Merge Party",
      uploadFileName: "Merge Party",
      html: activityHTML,
      __upload: true,
      hubId: null,
      roomActivityId: App.ROOM_ACTIVITY_MERGE_PARTY,
      roomActivityRoomId: activityRoomId,
      roomActivityStartedAt: Date.now()
    });
  } catch (err) {
    await App.releaseMergePartyRoomActivity({
      roomActivityId: App.ROOM_ACTIVITY_MERGE_PARTY
    });
    throw err;
  }
  App.gamesStageLoaded = true;
  App.gamesWindowRectBeforeMaximize = App.getDefaultGamesWindowRect();
  App.gamesStageMaximized = true;
  App.gamesWindowRect = App.getMaximizedGamesWindowRect();
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
  await App.renderGamesStage();
  App.syncGamesStageFullscreenButton();
  await App.syncMyRoomActivityPresence();
};
App.openSavedHtmlFromHub = async function (id) {
  const items = await App.readHtmlHub();
  const item = items.find(x => x.id === id);
  if (!item) return;
  await App.openHtmlStage({
    id: `hub:${item.id}`,
    label: item.title,
    html: null,
    __upload: true,
    hubId: item.id
  });
  void App.ensureHtmlHubGameLoaded(App.selectedGame);
};

App.register("activities/room-games", function initializeFeature() {
App.$("btn-activities")?.setAttribute("aria-haspopup", "dialog");
App.$("btn-activities")?.setAttribute("aria-expanded", "false");
document.addEventListener("pointerdown", event => {
  if (!event.target.closest?.("#room-activities-menu, #btn-activities")) App.closeRoomActivitiesMenu();
}, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && App.$("room-activities-menu")?.hidden === false) {
    App.closeRoomActivitiesMenu();
    App.$("btn-activities")?.focus();
    event.preventDefault();
  }
});
App.ROOM_ACTIVITY_BOPL_ROYALE = "bopl-royale";
App.ROOM_ACTIVITY_MERGE_PARTY = "merge-party";
App.ROOM_ACTIVITY_CLAIM_SCHEMA_VERSION = 2;
App.ROOM_ACTIVITY_CLAIM_LEASE_MS = 60 * 1000;
App.ROOM_ACTIVITY_CLAIM_HEARTBEAT_MS = 15 * 1000;
App.ROOM_ACTIVITY_LEGACY_STALE_MS = 2 * 60 * 1000;
window.__boplRoyaleRoomClosed = function (message) {
  const body = String(message || "The online Bopl Royale activity closed.");
  App.showToast({
    title: "Bopl Royale room closed",
    body,
    duration: 5200
  });
};
window.__mergePartyRoomClosed = function (message) {
  const body = String(message || "The Merge Party activity closed.");
  App.showToast({
    title: "Merge Party closed",
    body,
    duration: 5200
  });
  window.setTimeout(() => {
    void App.closeGamesStage({
      preserve: false
    });
  }, 450);
};
});
})(globalThis.ChatApp);
