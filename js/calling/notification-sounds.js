/* Call sounds follow confirmed participation, not panel renders or ring cards. */
(function (App) {
  "use strict";
  let session = null;
  function confirmedMembers(members) {
    const confirmed = new Map();
    const fromConfirmedRecord = members && !Array.isArray(members) && typeof members === "object";
    const list = fromConfirmedRecord ? Object.entries(members).map(([code, member]) => ({ ...(member || {}), code })) : Array.isArray(members) ? members : [];
    const now = Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
    for (const member of list) {
      const code = String(member?.code || "");
      if (!code || !member.sessionId || member.joinConfirmed === false || member.ringing || member.isRinging) continue;
      if (fromConfirmedRecord && globalThis.ChatCallPolicy?.keepMember && !globalThis.ChatCallPolicy.keepMember(member, App.callPeerMap?.get(code), now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS)) continue;
      confirmed.set(code, member);
    }
    return confirmed;
  }
  function screenState(members) {
    const screens = new Map();
    for (const [owner, member] of members) {
      for (const camera of [false, true]) {
        const localField = camera ? "localCamera" : "localShare";
        const local = owner === session?.selfCode && session[localField] !== undefined;
        const sharing = camera ? member.cameraSharing : member.sharing;
        const publishedId = camera ? member.cameraShareId : member.shareId;
        const shareId = local ? session[localField] : sharing ? String(publishedId || `legacy:${member.sessionId}`) : "";
        if (!shareId) continue;
        const key = camera ? `camera:${owner}` : owner;
        const viewers = new Set();
        for (const [code, viewer] of members) {
          if (code === owner || viewer.connected === false || viewer.viewingSharesSessionId !== viewer.sessionId) continue;
          if (viewer.viewingShares?.[key] === shareId) viewers.add(code);
        }
        screens.set(key, { owner, id: `${member.sessionId}:${shareId}`, shareId, viewers });
      }
    }
    return screens;
  }
  function observeScreens(next) {
    const previous = session.screens;
    session.screens = next;
    for (const [key, screen] of previous) {
      if (next.get(key)?.id !== screen.id) App.playNotificationSound?.("EndScreen");
    }
    for (const [key, screen] of next) {
      const before = previous.get(key);
      if (before?.id !== screen.id) {
        App.playNotificationSound?.("StartScreen");
        continue;
      }
      // A watcher hears only changes to the share they continue watching.
      // The person starting/stopping a watch does not hear their own effect.
      const self = session.selfCode;
      if (screen.owner !== self && !(before.viewers.has(self) && screen.viewers.has(self))) continue;
      for (const code of screen.viewers) if (code !== self && !before.viewers.has(code)) App.playNotificationSound?.("StartWatching");
      for (const code of before.viewers) if (code !== self && !screen.viewers.has(code)) App.playNotificationSound?.("StopWatching");
    }
  }
  function current(roomId, sessionId = App.callSessionId) {
    return session && session.roomId === String(roomId || "") && session.sessionId === String(sessionId || "");
  }
  App.callStartNotificationSession = function (roomId, sessionId, members) {
    const room = String(roomId || ""), id = String(sessionId || "");
    const selfCode = String(App.currentUser?.code || "");
    if (!room || !id || !selfCode || App.currentCallRoomId !== room || App.callSessionId !== id || current(room, id)) return;
    const confirmed = confirmedMembers(members);
    session = { roomId: room, sessionId: id, selfCode, members: new Set([...confirmed.keys()].filter(code => code !== selfCode)), screens: new Map(), connected: true, needsBaseline: false };
    session.screens = screenState(confirmed);
    App.playNotificationSound?.("JoinCall");
  };
  App.callStopNotificationSession = function (roomId, sessionId) {
    if (!current(roomId, sessionId)) return;
    session = null;
    App.playNotificationSound?.("LeaveCall");
  };
  App.callSetNotificationConnectionState = function (roomId, sessionId, connected) {
    if (!current(roomId, sessionId)) return;
    session.connected = connected === true;
    // A disconnected device cannot determine which cached roster changes are
    // real. Rebase once on the next realtime snapshot after reconnect.
    if (!session.connected) session.needsBaseline = true;
  };
  function notifyLocalMediaState(roomId, sessionId, shareId, camera) {
    if (!current(roomId, sessionId)) return;
    const id = String(shareId || "");
    session[camera ? "localCamera" : "localShare"] = id;
    const key = camera ? `camera:${session.selfCode}` : session.selfCode;
    const next = new Map(session.screens);
    const generation = `${session.sessionId}:${id}`;
    // A committed Firebase transaction may arrive before its local callback.
    // Keep its viewers when confirming the same generation instead of emitting
    // duplicate start or false stop-watching effects.
    if (id && next.get(key)?.id !== generation) next.set(key, { owner: session.selfCode, id: generation, shareId: id, viewers: new Set() });
    else if (!id) next.delete(key);
    // Local capture actions remain audible while leaving; the general roster
    // observer intentionally ignores teardown and reconnect churn.
    observeScreens(next);
  }
  App.callNotifyLocalScreenState = function (roomId, sessionId, shareId) {
    notifyLocalMediaState(roomId, sessionId, shareId, false);
  };
  App.callNotifyLocalCameraState = function (roomId, sessionId, shareId) {
    notifyLocalMediaState(roomId, sessionId, shareId, true);
  };
  App.callObserveNotificationMembers = function (roomId, members, { expiry = false } = {}) {
    if (!current(roomId) || App.currentCallRoomId !== session.roomId || !session.connected || App.callJoinPending || App.callLeavePending) return;
    const confirmed = confirmedMembers(members);
    const next = new Set([...confirmed.keys()].filter(code => code !== session.selfCode));
    const screens = screenState(confirmed);
    if (session.needsBaseline) {
      if (expiry) return;
      session.members = next;
      session.screens = screens;
      session.needsBaseline = false;
      return;
    }
    const previous = session.members;
    session.members = next;
    for (const code of next) if (!previous.has(code)) App.playNotificationSound?.("JoinCall");
    for (const code of previous) if (!next.has(code)) App.playNotificationSound?.("LeaveCall");
    observeScreens(screens);
  };
  App.register("calling/notification-sounds", function () {});
})(globalThis.ChatApp);
