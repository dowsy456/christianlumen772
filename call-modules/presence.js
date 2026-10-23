/* calling/presence: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.detachCallObserver = /* Chat calling: presence. Classic script; see CALLING.md. */function () {
  if (App.callPresenceExpiryTimer) clearInterval(App.callPresenceExpiryTimer);
  App.callPresenceExpiryTimer = null;
  App.callObservedMembersSnapshot = null;
  App.callMembersReady = false;
  if (App.callsRoomRef && App.callsRoomCb) {
    try {
      App.callsRoomRef.off("value", App.callsRoomCb);
    } catch {}
  }
  App.callsRoomRef = null;
  App.callsRoomCb = null;
  App.observedCallRoomId = null;
  App.callMembersCache = [];
  App.callMemberSharingCache.clear();
  App.callPeerTopologySignature = "";
  App.callMemberUiSignature = "";
  App.callActive = false;
};
App.callCleanupStaleMember = async function (roomId, member) {
  const id = App.sanitizeCallRoom(roomId);
  const code = String(member?.code || "");
  const staleSessionId = String(member?.sessionId || "");
  if (!id || !code || !staleSessionId) return;
  const cleanupKey = `${id}:${code}:${staleSessionId}`;
  if (App.callStaleCleanupPending.has(cleanupKey)) return;
  App.callStaleCleanupPending.add(cleanupKey);
  try {
    const memberRef = App.db.ref(`calls/${id}/members/${code}`);
    const result = await memberRef.transaction(current => {
      if (!current || String(current.sessionId || "") !== staleSessionId) return undefined;
      const now = Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
      if (!globalThis.ChatCallPolicy.shouldCleanupMember(current, App.callPeerMap.get(code), now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS)) return undefined;
      return null;
    }, undefined, false);
    if (result?.committed) {
      try {
        await App.db.ref(`calls/${id}/webrtc/${code}/${staleSessionId}`).remove();
      } catch {}
      try {
        await App.db.ref(`calls/${id}`).transaction(callRecord => {
          if (!callRecord) return null;
          return !App.callHasLiveMembers(callRecord.members) ? null : undefined;
        }, undefined, false);
      } catch {}
    }
  } catch {} finally {
    App.callStaleCleanupPending.delete(cleanupKey);
  }
};
App.attachCallObserver = function (roomId) {
  const id = App.sanitizeCallRoom(roomId);
  if (!id) {
    App.detachCallObserver();
    App.syncCallButton();
    return;
  }
  if (App.observedCallRoomId === id && App.callsRoomRef) return;
  App.detachCallObserver();
  App.observedCallRoomId = id;
  // Signaling candidates change frequently. Observing only the members branch
  // avoids re-rendering the call panel for every ICE candidate.
  App.callsRoomRef = App.db.ref(`calls/${id}/members`);
  const observedRef = App.callsRoomRef;
  App.callsRoomCb = (snap, options = null) => {
    const expiry = options?.expiry === true;
    if (App.observedCallRoomId !== id || App.callsRoomRef !== observedRef) return;
    App.callObservedMembersSnapshot = snap;
    App.callMembersReady = true;
    const membersObj = snap.val() || null;
    let allMembers = membersObj ? Object.entries(membersObj).map(([code, member]) => ({
      ...(member || {}),
      code
    })) : [];
    // A delayed initial/reconnect snapshot can arrive after Join has already
    // rendered its local tile, but before the server acknowledges membership.
    // Keep that exact pending session visible until acknowledgement or rollback.
    const joining = App.callJoiningMember;
    if (joining?.roomId === id && App.currentCallRoomId === id &&
        joining.member.sessionId === App.callSessionId && App.callJoinPending) {
      allMembers = allMembers.filter(member => String(member.code) !== String(joining.member.code));
      allMembers.push(joining.member);
    }
    const now = Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
    const isLocalSession = member => App.currentCallRoomId === id && String(member?.code || '') === String(App.currentUser?.code || '') && member.sessionId === App.callSessionId;
    for (const member of allMembers) {
      if (!member?.sessionId || isLocalSession(member)) continue;
      if (globalThis.ChatCallPolicy.shouldCleanupMember(member, App.callPeerMap.get(String(member.code)), now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS)) void App.callCleanupStaleMember(id, member);
    }
    const members = allMembers.filter(m => {
      if (!m || !m.sessionId) return false;
      // Local leave/failure is authoritative while its server cleanup is
      // queued offline. A cached snapshot must not resurrect the old call UI.
      if (App.callLocallyEndedSessions.has(String(m.sessionId))) return false;
      return isLocalSession(m) || globalThis.ChatCallPolicy.keepMember(m, App.callPeerMap.get(String(m.code)), now, App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS);
    });
    for (const m of members) {
      if (m && m.code) App.ensureLiveUserListener(String(m.code));
    }
    members.sort((a, b) => {
      const an = String(a?.displayNameLower || a?.usernameLower || a?.displayName || a?.username || "").toLowerCase();
      const bn = String(b?.displayNameLower || b?.usernameLower || b?.displayName || b?.username || "").toLowerCase();
      const c = an.localeCompare(bn);
      if (c) return c;
      return String(a?.code || "").localeCompare(String(b?.code || ""));
    });
    App.callMembersCache = members.map(m => ({
      code: m.code || "",
      sessionId: String(m.sessionId || ""),
      joinConfirmed: m.joinConfirmed !== false,
      username: m.username || "User",
      usernameLower: m.usernameLower || String(m.username || "user").toLowerCase(),
      displayName: m.displayName || m.username || "User",
      displayNameLower: m.displayNameLower || String(m.displayName || m.username || "user").toLowerCase(),
      photoDataURL: m.photoDataURL || null,
      photoTransform: m.photoTransform || null,
      muted: !!m.muted,
      deafened: !!m.deafened,
      speaking: isLocalSession(m) ? !!App.callVadSpeaking : !!m.speaking,
      sharing: !!m.sharing,
      sharePaused: !!m.sharePaused,
      sharePauseVersion: Number(m.sharePauseVersion) || 0,
      sharePauseFrame: typeof m.sharePauseFrame === "string" && m.sharePauseFrame.length <= 96000 ? m.sharePauseFrame : null,
      cameraSharing: !!m.cameraSharing,
      cameraShareId: String(m.cameraShareId || ""),
      cameraPreviewDataURL: typeof m.cameraPreviewDataURL === "string" && m.cameraPreviewDataURL.length <= 96000 ? m.cameraPreviewDataURL : null,
      shareId: String(m.shareId || ""),
      sharePreviewDataURL: typeof m.sharePreviewDataURL === 'string' && m.sharePreviewDataURL.length <= 96000 ? m.sharePreviewDataURL : null,
      viewingShares: App.callNormalizeViewingShares(m.viewingShares),
      viewingSharesSessionId: String(m.viewingSharesSessionId || ""),
      connected: m.connected !== false || globalThis.ChatCallPolicy.isConnected(App.callPeerMap.get(String(m.code))),
      lastSeenAt: Number(m.lastSeenAt) || 0,
      disconnectedAt: Number(m.disconnectedAt) || 0,
      updatedAt: Number(m.updatedAt) || 0,
      joinedAt: Number(m.joinedAt) || 0
    }));
    App.callObserveNotificationMembers?.(id, App.callMembersCache, { expiry });
    const nextMemberUiSignature = App.callMembersCache.map(member => JSON.stringify([member.code, member.sessionId, member.username, member.displayName, member.muted, member.deafened, member.sharing, member.sharePaused, member.sharePauseVersion, member.cameraSharing, member.cameraShareId, member.cameraPreviewDataURL, member.shareId, member.sharePreviewDataURL, App.callViewingSharesSignature(member.viewingShares), member.viewingSharesSessionId, member.connected])).join("|");
    const memberUiChanged = nextMemberUiSignature !== App.callMemberUiSignature;
    App.callMemberUiSignature = nextMemberUiSignature;
    const nextTopologySignature = App.callMembersCache.filter(member => member.code && member.sessionId).map(member => `${member.code}:${member.sessionId}`).sort().join("|");
    const topologyChanged = nextTopologySignature !== App.callPeerTopologySignature;
    App.callPeerTopologySignature = nextTopologySignature;
    try {
      const seen = new Set();
      for (const m of App.callMembersCache) {
        const code = String(m.code || "");
        if (!code) continue;
        seen.add(code);
        const nextShareSignature = m.sharing ? String(m.shareId || `legacy:${m.sessionId || ""}`) : "";
        const prev = String(App.callMemberSharingCache.get(code) || "");
        App.callMemberSharingCache.set(code, nextShareSignature);
        if (nextShareSignature && prev !== nextShareSignature && App.currentCallRoomId === id && code !== String(App.currentUser?.code || "")) {
          // ontrack can beat the Firebase `sharing/shareId` update. Preserve an
          // already healthy stream; deleting it here can strand the UI because
          // replacing media on the same transceiver does not have to fire ontrack again.
          const cachedStream = App.callRemoteVideoStreams.get(code) || null;
          const cachedTrack = cachedStream?.getVideoTracks?.().find(track => track.readyState === "live") || null;
          if (!cachedTrack) {
            try {
              App.callRemoteVideoStreams.delete(code);
            } catch {}
          }
          App.callScreenHealthState.delete(code);
          // Subscribe through viewer presence; sender media sync handles attachment.
        }
        if (prev && !nextShareSignature) {
          // Keep durable receivers: replaceTrack can restart a share on the
          // same live remote tracks without another ontrack event. Removing
          // the watch below immediately hides and silences the stopped share.
          App.callWatchedShareCodes.delete(code);
          if (App.callFocusedShareCode === code) App.callFocusedShareCode = null;
        }
      }
      for (const code of Array.from(App.callMemberSharingCache.keys())) {
        if (!seen.has(code)) {
          App.callRemoveRemoteScreenAudio(code);
          App.callMemberSharingCache.delete(code);
          try {
            App.callRemoteVideoStreams.delete(code);
          } catch {}
          App.callWatchedShareCodes.delete(code);
          if (App.callFocusedShareCode === code) App.callFocusedShareCode = null;
        }
      }
    } catch {}
    App.callPruneWatchedShares();
    App.callActive = App.callMembersCache.length > 0;
    App.callPublishDesktopOverlay?.();
    App.syncCallButton();
    App.callSyncMenuStatusDisplay();
    if (App.callMenuOpen && memberUiChanged) App.renderCallMenu();else App.callPatchSpeakingIndicators();
    if (App.currentCallRoomId === id) App.callScheduleMediaBudget();
    void App.callSyncViewerPresence();
    if (App.currentCallRoomId === id && topologyChanged) {
      App.callEnsurePeers(id);
    }
  };
  App.callsRoomRef.on("value", App.callsRoomCb);
  // An abandoned member emits no further Firebase events. Age the cached
  // snapshot too, so Start/Join and the preview cannot remain stale forever.
  App.callPresenceExpiryTimer = setInterval(() => {
    if (App.observedCallRoomId === id && App.callsRoomRef === observedRef && App.callObservedMembersSnapshot) {
      App.callsRoomCb(App.callObservedMembersSnapshot, { expiry: true });
    }
  }, App.CALL_HEARTBEAT_MS);
};

App.register("calling/presence", function initializeFeature() {

});
})(globalThis.ChatApp);
