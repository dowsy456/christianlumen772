/* calling/lifecycle: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.callRememberEndedSession = function (sessionId) {
  if (!sessionId) return;
  App.callLocallyEndedSessions.add(String(sessionId));
  while (App.callLocallyEndedSessions.size > 64) App.callLocallyEndedSessions.delete(App.callLocallyEndedSessions.values().next().value);
};
App.callNow = function () { return Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0); };
App.callPublishDeparture = function (roomId = App.currentCallRoomId, code = App.currentUser?.code, sessionId = App.callSessionId) {
  if (!roomId || !code || !sessionId) return;
  // A single leaf write can leave the socket during pagehide without waiting
  // for a transaction round trip. Its session tag cannot dismiss a later join.
  try {
    void App.db.ref(`calls/${roomId}/members/${code}/departedSessionId`).set(String(sessionId)).catch(() => {});
  } catch {}
};
App.callHandlePageHide = function () {
  if (!App.currentCallRoomId || !App.callSessionId) return;
  // pagehide also fires for bfcache navigation: a restored tab is no longer in
  // the call. Do not run this on visibilitychange or a canceled beforeunload.
  void App.leaveCall({ quiet: true });
};
App.callAwaitSignaling = async function (operation, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The call server did not respond. Please try joining again.")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
};
App.callRunTransaction = async function (ref, update, { isCurrent = () => true } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ref.transaction(value => isCurrent() ? update(value) : undefined, undefined, false);
    } catch (error) {
      // Firebase cancels a local transaction when an overlapping set/update is
      // issued. Unlike a server CAS conflict, this rejects with Error("set").
      // Retry guarded membership/maintenance writes; never retry permissions
      // or an ended lifecycle. Routine media writes use independent leaves.
      if (!isCurrent() || attempt >= 4 || !/^(set|maxretry)$/i.test(String(error?.message || ""))) throw error;
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
};
App.callRemoveMembershipSession = async function (roomId, code, sessionId) {
  if (!roomId || !code || !sessionId) return;
  // Publish the small membership removal first. Fetching/transacting the whole
  // call (including every SDP and ICE candidate) delayed remote roster updates
  // and retried whenever another participant published unrelated signaling.
  await App.callRunTransaction(App.db.ref(`calls/${roomId}/members/${code}`), member => {
    // Null must reach the server CAS: an incomplete local cache is not proof
    // that the member is absent. A newer session must always survive cleanup.
    if (!member) return null;
    return String(member.sessionId || "") === String(sessionId) ? null : undefined;
  });
  // Retire an empty instance separately. Concurrent joins retry against this
  // CAS, and their live membership prevents it from erasing the new call.
  let retired = null;
  const retirement = await App.callRunTransaction(App.db.ref(`calls/${roomId}`), record => {
    retired = null;
    if (!record) return null;
    if (!App.callHasLiveMembers(record.members)) { retired = record; return null; }
    return undefined;
  });
  if (retirement?.committed && retired?.instanceId) void App.writeRoomSystemMessage?.(roomId, { type: "call_ended", createdAt: App.callNow() }, `call-ended:${retired.instanceId}`).catch(error => console.warn("Call end log could not be saved:", error));
};
App.callStartHeartbeat = /* Chat calling: lifecycle. Classic script; see CALLING.md. */function () {
  if (!App.myCallMemberRef) return;
  if (App.callHeartbeatTimer) clearInterval(App.callHeartbeatTimer);
  App.callHeartbeatTimer = setInterval(() => {
    if (!App.myCallMemberRef || !App.currentUser || !App.currentCallRoomId || App.callSignalingConnected === false) return;
    const observed = App.callObservedMembersSnapshot?.val?.()?.[App.currentUser.code];
    if (!observed?.sessionId && App.callMembershipPayload && !App.callMembershipRepairPending && App.callSignalingConnected !== false) {
      App.callMembershipRepairPending = true;
      const room = App.currentCallRoomId, session = App.callSessionId;
      void App.callCommitMembership(room, { ...App.callMembershipPayload,
        sessionId: session, connected: true, muted: !!App.callMuted, deafened: !!App.callDeafened,
        speaking: !!App.callVadSpeaking, sharing: !!App.callSharing,
        shareId: App.callScreenShareId || null, sharePreviewDataURL: App.callScreenPreviewDataURL || null,
        sharePaused: !!App.callScreenPaused, sharePauseFrame: App.callScreenPauseFrame || null, sharePauseVersion: App.callScreenPauseVersion || 0,
        cameraSharing: !!App.callCameraSharing, cameraShareId: App.callCameraShareId || null,
        cameraPreviewDataURL: App.callCameraPreviewDataURL || null,
        lastSeenAt: App.firebase.database.ServerValue.TIMESTAMP, updatedAt: App.firebase.database.ServerValue.TIMESTAMP
      }).then(() => {
        if (App.currentCallRoomId === room && App.callSessionId === session) void App.callEnsurePeers(room);
      }).catch(() => {}).finally(() => { App.callMembershipRepairPending = false; });
      return;
    }
    const heartbeatRef = App.myCallMemberRef;
    if (App.callHeartbeatPendingRef === heartbeatRef) return;
    App.callHeartbeatPendingRef = heartbeatRef;
    try {
      void heartbeatRef.update({
        connected: true,
        sharePaused: !!App.callScreenPaused, sharePauseFrame: App.callScreenPauseFrame || null, sharePauseVersion: App.callScreenPauseVersion || 0,
        lastSeenAt: App.firebase.database.ServerValue.TIMESTAMP,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP
      }).catch(() => {}).finally(() => {
        if (App.callHeartbeatPendingRef === heartbeatRef) App.callHeartbeatPendingRef = null;
      });
    } catch { App.callHeartbeatPendingRef = null; }
    // Treat local presence references as a cache and periodically reassert the
    // backend leaves in case a reconnect or delayed cleanup removed one.
    void App.callSyncViewerPresence({
      force: observed?.viewingSharesSessionId !== App.callSessionId ||
        App.callViewingSharesSignature(observed?.viewingShares) !== App.callPublishedViewingSharesSignature
    });
  }, App.CALL_HEARTBEAT_MS);
};
App.callStopHeartbeat = function () {
  if (App.callHeartbeatTimer) {
    try {
      clearInterval(App.callHeartbeatTimer);
    } catch {}
  }
  App.callHeartbeatTimer = null;
};
App.callCommitMembership = async function (roomId, payload) {
  const candidateInstanceId = App.makeCallSessionId();
  const lifecycleToken = App.callLifecycleToken;
  const isCurrent = () => App.callLifecycleToken === lifecycleToken && App.currentCallRoomId === roomId && App.callSessionId === payload.sessionId;
  const requireCurrent = () => { if (!isCurrent()) throw new Error("This call join was canceled. Please try joining again."); };
  const callRef = App.db.ref(`calls/${roomId}`);
  const previousMemberRef = App.myCallMemberRef;
  // Firebase cancels transactions when this client issues an overlapping set.
  // Hold this publishable reference until the atomic commit is acknowledged,
  // including reconnects, so heartbeat, VAD and viewer callbacks cannot race it.
  App.myCallMemberRef = null;
  try {
    requireCurrent();
    // Existing calls use a participant leaf transaction. Transacting the whole
    // room retries for every remote ICE candidate, heartbeat and speaking update.
    const [instanceSnapshot, membersSnapshot] = await Promise.all([
      callRef.child("instanceId").once("value"), callRef.child("members").once("value")
    ]);
    const instance = instanceSnapshot.val();
    requireCurrent();
    if (instance && App.callHasLiveMembers(membersSnapshot.val())) {
      const member = await App.callRunTransaction(callRef.child(`members/${payload.code}`), () => ({ ...payload, joinConfirmed: true }), { isCurrent });
      requireCurrent();
      const [confirmed, startedAt, startedBy, audioPreferences] = await Promise.all([
        callRef.child("instanceId").once("value"),
        callRef.child("startedAt").once("value"),
        callRef.child("startedBy").once("value"),
        callRef.child(`audioPreferences/${payload.code}`).once("value")
      ]);
      requireCurrent();
      if (member.committed && confirmed.val() === instance) {
        return { instanceId: instance, startedAt: startedAt.val(), startedBy: startedBy.val(), active: true,
          audioPreferences: { [payload.code]: audioPreferences.val() || {} },
          members: { ...(membersSnapshot.val() || {}), [payload.code]: member.snapshot.val() } };
      }
      // Empty calls can retire between the lookup and leaf commit. Initialization
      // below atomically adopts the member into a fresh instance in that case.
    }
    // The SDK's compare-and-swap fills an incomplete cache and retries with the
    // current server record. A preceding full-call read adds a round trip and
    // downloads signaling before anyone can see this join.
    const result = await App.callRunTransaction(callRef, record => {
      const continuing = record && App.callHasLiveMembers(record.members);
      const base = continuing ? record : {};
      return {
        ...base,
        instanceId: base.instanceId || candidateInstanceId,
        startedAt: base.startedAt || App.firebase.database.ServerValue.TIMESTAMP,
        startedBy: base.startedBy || payload.code,
        active: true,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP,
        members: { ...base.members, [payload.code]: { ...payload, joinConfirmed: true } }
      };
    }, { isCurrent });
    requireCurrent();
    const joined = result.snapshot?.val();
    if (!result.committed || joined?.members?.[payload.code]?.sessionId !== payload.sessionId) throw new Error("The call could not be joined. Please try again.");
    // Exactly one first participant owns the invitation, even when several
    // clients start the call before any of them receives a realtime snapshot.
    if (joined.instanceId === candidateInstanceId) {
      void App.writeRoomSystemMessage?.(roomId, { type: "call_started", userCode: payload.code, displayName: payload.displayName || payload.username || "User", username: payload.username || "User", createdAt: Number(joined.startedAt) || App.callNow() }, `call-started:${joined.instanceId}`).catch(error => console.warn("Call start log could not be saved:", error));
      void Promise.resolve(App.callRingOnCallStarted?.(roomId, joined, candidateInstanceId))
        .catch(error => console.warn("Room invitations could not be sent:", error));
    }
    return joined;
  } finally {
    if (isCurrent() && previousMemberRef) App.myCallMemberRef = previousMemberRef;
  }
};
App.joinCall = async function (roomId, {
  openMenu = true,
  preserveAudioState = null
} = {}) {
  if (!App.currentUser) return;
  const id = App.sanitizeCallRoom(roomId);
  if (!id) return;
  if (typeof window.RTCPeerConnection !== "function") {
    App.showToast({
      title: "Calling unavailable",
      body: "This browser does not support WebRTC calling.",
      duration: 3200
    });
    return;
  }
  if (App.callJoinPending || App.callLeavePending) return;
  if (App.currentCallRoomId) {
    if (openMenu) App.openCallMenu();
    return;
  }
  if (navigator.onLine === false) {
    App.showToast({ title: "Unable to join call", body: "You are offline. Reconnect and try joining again.", duration: 5000 });
    return;
  }
  const savedAudioState = preserveAudioState && typeof preserveAudioState === "object"
    ? { muted: preserveAudioState.muted === true, deafened: preserveAudioState.deafened === true } : null;
  if (savedAudioState) {
    App.callMuted = savedAudioState.muted || App.callGetInputVolumePercent() === 0;
    App.callDeafened = savedAudioState.deafened;
  }
  // Set the mobile conferencing category synchronously in the Join gesture.
  // This improves iOS microphone + playback coexistence; it is a routing hint,
  // not an attempt to override the user's OS-selected speaker/Bluetooth route.
  App.callSetMobileAudioSession(true);
  App.callPrimePlaybackContextFromGesture();
  App.callJoinPending = true;
  App.syncCallButton();
  App.syncCallControlsUI();
  let joiningStream = null;
  let joiningMemberRef = null;
  let joiningSessionId = null;
  let joiningToken = null;
  try {
    // Only a fresh join owns a new lifecycle; opening an existing call above
    // preserves its live microphone, share and peer callbacks.
    const opToken = ++App.callLifecycleToken;
    joiningToken = opToken;
    const sameCallRejoin = App.callLastLeave.roomId === id && Date.now() - Number(App.callLastLeave.at || 0) < 120000;

    if (App.callConnRef && App.callConnCb) {
      try {
        App.callConnRef.off("value", App.callConnCb);
      } catch {}
    }
    App.callConnRef = null;
    App.callConnCb = null;
    if (App.myCallMemberRef) {
      try {
        void App.myCallMemberRef.onDisconnect().cancel().catch(() => {});
      } catch {}
    }
    App.myCallMemberRef = null;

    // 1) Ask for microphone permission first
    // Membership observers can fire before the join transaction resolves.
    // Block media negotiation until this call's saved volume settings are loaded.
    App.callAudioPreferencesReady = false;
    App.callSetMobileAudioSession(true);
    App.callPrimePlaybackContextFromGesture();
    // Fetch relay credentials alongside the microphone prompt, never serially.
    const iceReady = App.callRefreshIceServers();
    let stream = await App.callRequestMicPermission();
    joiningStream = stream;
    if (savedAudioState && (App.callMuted || App.callDeafened)) {
      for (const track of stream?.getAudioTracks?.() || []) track.enabled = false;
    }
    await iceReady;
    if (!stream) {
      try {
        stream = new MediaStream();
        joiningStream = stream;
      } catch {
        return;
      }
    }
    const joiningAudioTrack = App.callGetLiveAudioTrack(stream);
    App.callListenOnly = !joiningAudioTrack;
    if (App.callLifecycleToken !== opToken) {
      try {
        stream.getTracks().forEach(t => {
          try {
            t.stop();
          } catch {}
          ;
        });
      } catch {}
      return;
    }

    // Ensure we observe this room now
    App.attachCallObserver(id);

    // Initialize local call audio state
    App.callAttachLocalStream(stream, { preserveAudioState: savedAudioState });
    if (App.callListenOnly) {
      App.callMuted = true;
      App.callApplyLocalMuteState();
    }
    if (App.callLifecycleToken !== opToken) {
      App.callStopWebRTC({
        roomId: id
      });
      return;
    }
    App.currentCallRoomId = id;
    const sessionId = App.makeCallSessionId();
    joiningSessionId = sessionId;
    App.callSessionId = sessionId;
    App.callPublishedViewingSharesSignature = null;
    if (joiningAudioTrack) App.callBindLocalMicrophoneHealth(joiningAudioTrack, id, sessionId);

    // Persist "in call" so refresh will force-leave on next load
    try {
      sessionStorage.setItem(App.LS.CALL_ROOM, id);
    } catch {}

    // Optimistically show yourself instantly in the menu (then realtime will correct)
    const self = {
      code: App.currentUser.code,
      sessionId,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.username || "User").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayName || App.currentUser.username || "User").toLowerCase(),
      photoDataURL: App.currentUser.photoDataURL || null,
      photoTransform: App.currentUser.photoTransform || null,
      muted: !!App.callMuted,
      deafened: !!App.callDeafened,
      speaking: false,
      sharing: false,
      cameraSharing: false,
      cameraShareId: null,
      cameraPreviewDataURL: null,
      shareId: "",
      viewingShares: {},
      viewingSharesSessionId: sessionId,
      connected: true,
      joinedAt: Date.now()
    };
    App.callJoiningMember = { roomId: id, member: self };
    if (!App.callMembersCache.some(x => String(x.code || "") === String(self.code))) {
      App.callMembersCache = [self, ...App.callMembersCache];
    } else {
      App.callMembersCache = App.callMembersCache.map(x => String(x.code || "") === String(self.code) ? {
        ...x,
        ...self
      } : x);
    }
    App.callMembersCache.sort((a, b) => String(a.displayNameLower || a.usernameLower || "").localeCompare(String(b.displayNameLower || b.usernameLower || "")));
    App.callActive = true;
    App.syncCallButton();
    App.callPublishDesktopOverlay?.();
    if (openMenu) App.openCallMenu();else if (App.callMenuOpen) App.renderCallMenu();

    // Create/refresh member record
    const memberRef = App.db.ref(`calls/${id}/members/${App.currentUser.code}`);
    joiningMemberRef = memberRef;
    // Do not expose a publishable reference until the membership is confirmed.
    // Opening the menu starts viewer/VAD callbacks before this join completes.
    const payload = {
      code: App.currentUser.code,
      sessionId,
      joinConfirmed: false,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.username || "User").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayName || App.currentUser.username || "User").toLowerCase(),
      photoDataURL: App.currentUser.photoDataURL || null,
      photoTransform: App.currentUser.photoTransform || null,
      muted: !!App.callMuted,
      deafened: !!App.callDeafened,
      speaking: false,
      sharing: false,
      cameraSharing: false,
      cameraShareId: null,
      cameraPreviewDataURL: null,
      shareId: null,
      viewingShares: null,
      viewingSharesSessionId: sessionId,
      connected: true,
      lastSeenAt: App.firebase.database.ServerValue.TIMESTAMP,
      joinedAt: App.firebase.database.ServerValue.TIMESTAMP,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    };

    // onDisconnect safety: if tab closes, user leaves call
    await App.callAwaitSignaling(memberRef.onDisconnect().update({
        connected: false,
        viewingShares: null,
        viewingSharesSessionId: null,
        disconnectedAt: App.firebase.database.ServerValue.TIMESTAMP,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    }));
    if (App.callLifecycleToken !== opToken) {
      try {
        void memberRef.onDisconnect().cancel().catch(() => {});
      } catch {}
      try {
        void App.callRemoveMembershipSession(id, App.currentUser.code, sessionId).catch(() => {});
      } catch {}
      return;
    }
    const joined = await App.callAwaitSignaling(App.callCommitMembership(id, payload));
    if (App.callLifecycleToken === opToken && App.currentCallRoomId === id && App.callSessionId === sessionId) {
      App.myCallMemberRef = memberRef;
      App.callMembershipPayload = payload;
      App.callJoiningMember = null;
      App.callLoadAudioPreferences(id, joined, { preserveAudioState: savedAudioState });
      App.callLoadDesktopOverlayPreferences?.(id, joined);
    }
    if (App.callLifecycleToken !== opToken || App.currentCallRoomId !== id || App.callSessionId !== sessionId || App.myCallMemberRef !== memberRef) {
      try {
        void memberRef.onDisconnect().cancel().catch(() => {});
      } catch {}
      try {
        void App.callRemoveMembershipSession(id, App.currentUser.code, sessionId).catch(() => {});
      } catch {}
      return;
    }

    // Re-assert on reconnect and force peer refreshes so rejoin/network blips do not leave stale media.
    App.callConnRef = App.db.ref(".info/connected");
    let signalingWasDisconnected = false;
    App.callConnCb = snap => {
      if (App.callLifecycleToken !== opToken || App.currentCallRoomId !== id || App.callSessionId !== sessionId) return;
      App.callSignalingConnected = snap.val() === true;
      void App.callUpdateConnectionQuality();
      App.callSetNotificationConnectionState?.(id, sessionId, snap.val() === true);
      if (snap.val() !== true) {
        signalingWasDisconnected = true;
        return;
      }
      const needsTransportCheck = signalingWasDisconnected;
      signalingWasDisconnected = false;
      if (App.callLifecycleToken !== opToken) return;
      if (snap.val() === true && App.myCallMemberRef === memberRef && App.currentUser && App.currentCallRoomId === id && App.callSessionId === sessionId) {
        try {
          void memberRef.onDisconnect().update({
            connected: false,
            viewingShares: null,
            viewingSharesSessionId: null,
            disconnectedAt: App.firebase.database.ServerValue.TIMESTAMP,
            updatedAt: App.firebase.database.ServerValue.TIMESTAMP
          }).catch(() => {});
        } catch {}
        try {
          const restoredMember = {
            ...payload,
            sessionId,
            joinConfirmed: true,
            muted: !!App.callMuted,
            deafened: !!App.callDeafened,
            speaking: !!App.callVadSpeaking,
            sharing: !!App.callSharing,
            sharePaused: !!App.callScreenPaused, sharePauseFrame: App.callScreenPauseFrame || null, sharePauseVersion: App.callScreenPauseVersion || 0,
            cameraSharing: !!App.callCameraSharing,
            cameraShareId: App.callCameraShareId || null,
            cameraPreviewDataURL: App.callCameraPreviewDataURL || null,
            shareId: App.callSharing ? String(App.callScreenShareId || "") : null,
            sharePreviewDataURL: App.callScreenPreviewDataURL || null,
            viewingSharesSessionId: sessionId,
            connected: true,
            lastSeenAt: App.firebase.database.ServerValue.TIMESTAMP,
            updatedAt: App.firebase.database.ServerValue.TIMESTAMP
          };
          if (needsTransportCheck) {
            void App.callCommitMembership(id, restoredMember).then(record => {
              if (App.callLifecycleToken === opToken && App.currentCallRoomId === id &&
                  App.callAudioPreferenceScope?.instanceId !== record.instanceId) {
                App.callLoadAudioPreferences(id, record);
              }
            }).catch(error => console.warn("Call membership could not be restored:", error));
          } else {
            void memberRef.update(restoredMember).catch(error => console.warn("Call membership could not be refreshed:", error));
          }
        } catch {}
        setTimeout(() => {
          if (App.currentCallRoomId === id && App.callSessionId === sessionId) {
            void App.callEnsurePeers(id);
            for (const peer of App.callPeerMap.keys()) {
              const pc = App.callPeerMap.get(peer);
              if (needsTransportCheck && pc && !globalThis.ChatCallPolicy.isConnected(pc)) pc.__requestRecovery?.("signaling-reconnected");
            }
            void App.callSyncViewerPresence({
              force: true
            });
          }
        }, 350);
      }
    };
    App.callConnRef.on("value", App.callConnCb);
    App.callStartHeartbeat();
    App.syncCallButton();
    App.syncCallControlsUI();
    App.callStartWebRTC(id);
    void App.callResumeRemoteAudio({
      fromGesture: false
    });
    if (App.callMenuOpen) App.renderCallMenu();
    App.callLastLeave = {
      roomId: "",
      at: 0
    };
    if (sameCallRejoin && !App.callListenOnly) {
      setTimeout(() => {
        if (App.currentCallRoomId === id && App.callSessionId === sessionId && !App.callLeavePending && !App.callGetLiveAudioTrack()) {
          void App.callRefreshMic({
            quiet: true,
            reason: "same-call-rejoin"
          });
        }
      }, 850);
    }
    App.callStartNotificationSession?.(id, sessionId, joined.members);
  } catch (error) {
    App.callRememberEndedSession(joiningSessionId);
    if (App.callJoiningMember?.member.sessionId === joiningSessionId) App.callJoiningMember = null;
    if (joiningToken === App.callLifecycleToken) {
      ++App.callLifecycleToken;
      App.callStopHeartbeat();
      App.callStopWebRTC({ roomId: id });
      App.currentCallRoomId = null;
      App.callSessionId = null;
      App.myCallMemberRef = null;
      App.callMembersCache = App.callMembersCache.filter(member => member.sessionId !== joiningSessionId);
      App.callActive = App.callMembersCache.length > 0;
      App.closeCallMenu();
      try { sessionStorage.removeItem(App.LS.CALL_ROOM); } catch {}
    }
    for (const track of joiningStream?.getTracks?.() || []) { try { track.stop(); } catch {} }
    try { void joiningMemberRef?.onDisconnect().cancel().catch(() => {}); } catch {}
    void App.callRemoveMembershipSession(id, App.currentUser?.code, joiningSessionId).catch(() => {});
    const message = String(error?.message || "");
    App.showToast({ title: "Unable to join call", body: /^(set|maxretry)$/i.test(message) ? "The call changed while you were joining. Please try again." : message || "Please try joining the call again.", duration: 6000 });
  } finally {
    App.callJoinPending = false;
    if (!App.currentCallRoomId) {
      App.callSetMobileAudioSession(false);
      App.callClosePlaybackContext();
      App.callDisposeMicrophoneGraph({ closeContext: true });
    }
    App.syncCallButton();
    App.syncCallControlsUI();
  }
};
App.leaveCall = async function ({
  roomId = null,
  quiet = false
} = {}) {
  const id = App.sanitizeCallRoom(roomId || App.currentCallRoomId);
  if (!id) return;
  if (App.callLeavePending) return;
  App.callLeavePending = true;
  App.syncCallButton();
  App.syncCallControlsUI();
  try {
    const opToken = ++App.callLifecycleToken;
    const leavingRoomId = String(App.currentCallRoomId || id);
    const leavingSessionId = App.callSessionId;
    App.callRememberEndedSession(leavingSessionId);
    if (App.callJoiningMember?.member.sessionId === leavingSessionId) App.callJoiningMember = null;
    const leavingCode = String(App.currentUser?.code || "");
    const leavingMemberRef = App.myCallMemberRef;
    const leavingConnRef = App.callConnRef;
    const leavingConnCb = App.callConnCb;
    App.callPublishDeparture(id, leavingCode, leavingSessionId);
    App.callClearAudioPreferenceScope();
    App.callClearDesktopOverlayScope?.();

    // Stop heartbeat + share first so others don't see frozen/share artifacts
    App.callStopHeartbeat();
    App.nativeScreenCapture?.stop();
    if (App.callSharing) App.callStopShareScreen(true);
    App.closeShareView(true);
    App.closeCallMenu();
    App.callStopWebRTC({
      roomId: id
    });
    try {
      sessionStorage.removeItem(App.LS.CALL_ROOM);
    } catch {}

    // Clear session state before network cleanup. This prevents a rapid rejoin
    // from reusing stopped tracks or publishing against the old session.
    App.currentCallRoomId = null;
    App.callSessionId = null;
    App.callStopNotificationSession?.(leavingRoomId, leavingSessionId);
    if (App.myCallMemberRef === leavingMemberRef) App.myCallMemberRef = null;
    if (App.currentUser) {
      App.callMembersCache = App.callMembersCache.filter(member => String(member?.code || "") !== String(App.currentUser.code || ""));
      App.callActive = App.callMembersCache.length > 0;
    }
    App.syncCallButton();
    App.callSyncMenuStatusDisplay();
    if (App.callMenuOpen) App.renderCallMenu();
    App.callPublishDesktopOverlay?.();

    // Detach connection listener
    if (leavingConnRef && leavingConnCb) {
      try {
        leavingConnRef.off("value", leavingConnCb);
      } catch {}
    }
    if (App.callConnRef === leavingConnRef) App.callConnRef = null;
    if (App.callConnCb === leavingConnCb) App.callConnCb = null;

    // Queue server cleanup without making Leave/Join wait for an offline
    // Firebase acknowledgement. Guard by session so a rapid rejoin survives.
    const cleanup = App.callRemoveMembershipSession(id, leavingCode, leavingSessionId).then(() => {
      // Keep server-side disconnect cleanup armed until removal succeeds.
      // Never cancel a newly joined session's replacement disconnect handler.
      if (leavingMemberRef && !App.currentCallRoomId) {
        try { void leavingMemberRef.onDisconnect().cancel().catch(() => {}); } catch {}
      }
    }).catch(() => {});
    // A healthy backend completes this before leave resolves, preserving clean
    // call-instance boundaries. An offline acknowledgement gets at most one
    // second; media has already stopped and the queued cleanup stays safe.
    try { await App.callAwaitSignaling(cleanup, 1000); } catch {}
    if (App.callLifecycleToken !== opToken) return;
    App.callLastLeave = {
      roomId: id,
      at: Date.now()
    };

    // Switch observer back to current room (if any)
    if (App.currentRoomId) {
      App.attachCallObserver(App.currentRoomId);
    } else App.detachCallObserver();
    App.syncCallButton();
    if (!quiet && leavingRoomId) {
      App.showToast({
        title: "Left call",
        body: `You left the call in ${App.roomDisplayName(id, App.roomsMetaCache.get(id) || null)}.`,
        duration: 2000
      });
    }
  } finally {
    App.callLeavePending = false;
    App.syncCallButton();
    App.syncCallControlsUI();
  }
};
App.leaveStaleCallFromPreviousSession = async function () {
  if (!App.currentUser) return;
  let storedRoom = "";
  try { storedRoom = sessionStorage.getItem(App.LS.CALL_ROOM) || ""; } catch {}
  const stale = App.sanitizeCallRoom(storedRoom);
  if (!stale) return;

  // A refresh is a leave. Remove both presence and the session-scoped
  // signaling inbox so old offers/candidates cannot affect a later rejoin.
  try {
    const memberSnap = await App.db.ref(`calls/${stale}/members/${App.currentUser.code}`).once("value");
    const staleSessionId = String(memberSnap.val()?.sessionId || "");
    const updates = {
      [`calls/${stale}/members/${App.currentUser.code}`]: null
    };
    if (staleSessionId) {
      updates[`calls/${stale}/webrtc/${App.currentUser.code}/${staleSessionId}`] = null;
    }
    await App.db.ref().update(updates);
  } catch {}

  // Cleanup only if it is still empty when the transaction commits.
  try {
    await App.db.ref(`calls/${stale}`).transaction(callRecord => {
      if (!callRecord) return null;
      return !App.callHasLiveMembers(callRecord.members) ? null : undefined;
    }, undefined, false);
  } catch {}
  try {
    sessionStorage.removeItem(App.LS.CALL_ROOM);
  } catch {}
};

App.register("calling/lifecycle", function initializeFeature() {
(function bindCallUI() {
  App.ensureCallRuntimeModals();
  const btn = App.$("btn-side-call");
  if (btn) {
    btn.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      if (App.currentCallRoomId) {
        if (App.callMenuOpen) App.closeCallMenu();else App.openCallMenu();
        return;
      }
      if (!App.currentRoomId) return;
      await App.joinCall(App.currentRoomId, {
        openMenu: true
      });
    });
  }
  App.$("btn-call-menu-chat")?.addEventListener("click", () => App.toggleExpandedCallChat?.());
  App.$("btn-call-menu-expand")?.addEventListener("click", () => App.setCallMenuExpanded(!App.callMenuExpanded));
  App.$("btn-call-mute")?.addEventListener("click", () => App.callToggleMute());
  App.$("btn-call-deafen")?.addEventListener("click", () => App.callToggleDeafen());
  App.$("btn-call-share")?.addEventListener("click", () => App.callToggleShareScreen());
  App.$("btn-call-camera")?.addEventListener("click", () => void App.callToggleCamera());
  App.$("btn-call-refreshmic")?.addEventListener("click", () => {
    void App.callRefreshMic();
  });
  App.$("btn-call-audio-resume")?.addEventListener("click", () => {
    void App.callResumeRemoteAudio({
      fromGesture: true
    });
  });
  App.$("btn-call-audio-output")?.addEventListener("click", () => {
    void App.callChooseAudioOutput();
  });
  App.$("btn-call-leave")?.addEventListener("click", async () => {
    await App.leaveCall({
      roomId: App.currentCallRoomId,
      quiet: true
    });
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || (App.modalEl && !App.modalEl.hidden)) return;
    if (App.callFocusedShareCode) {
      App.closeShareView();
      return;
    }
    if (App.callMenuExpanded) {
      App.setCallMenuExpanded(false);
      return;
    }
    if (App.callMenuOpen) App.closeCallMenu({ dismiss: true });
  });
  document.addEventListener("visibilitychange", () => {
    if (!App.currentCallRoomId) return;
    void App.callSyncViewerPresence({
      force: document.visibilityState !== "hidden"
    });
    if (document.visibilityState !== "hidden") {
      void App.callResumeRemoteAudio({
        fromGesture: false
      });
      void App.callAuditLocalMediaSenders();
      App.callAuditRemoteAudio();
      void App.callUpdateConnectionQuality();
    }
  });
  document.addEventListener("pointerdown", () => {
    if (!App.currentCallRoomId || App.callDeafened || !App.callAudioUnlockRequired) return;
    void App.callResumeRemoteAudio({
      fromGesture: true
    });
  }, {
    passive: true
  });
  document.addEventListener("touchend", () => {
    if (!App.currentCallRoomId || App.callDeafened || !App.callAudioUnlockRequired) return;
    void App.callResumeRemoteAudio({
      fromGesture: true
    });
  }, {
    passive: true
  });
  document.addEventListener("keydown", () => {
    if (!App.currentCallRoomId || App.callDeafened || !App.callAudioUnlockRequired) return;
    void App.callResumeRemoteAudio({
      fromGesture: true
    });
  });
  window.addEventListener('online', () => {
    if (!App.currentCallRoomId) return;
    void App.callRefreshIceServers();
    for (const pc of App.callPeerMap.values()) if (!globalThis.ChatCallPolicy.isConnected(pc)) pc.__requestRecovery?.('network-online');
  });
  window.addEventListener("pagehide", App.callHandlePageHide);
  navigator.connection?.addEventListener?.('change', () => App.callScheduleMediaBudget());
  window.addEventListener("pageshow", () => {
    if (!App.currentCallRoomId || App.callDeafened) return;
    App.callSetMobileAudioSession(true);
    void App.callResumeRemoteAudio({
      fromGesture: false
    });
  });
  // Utility modals leave the current call panel and watched streams open.
})();
});
})(globalThis.ChatApp);
