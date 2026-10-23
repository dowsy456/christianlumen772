/* Room rings share a thirty-second Firebase lease; only desktop clients expose UI. */
(function (App) {
  "use strict";
  // One adapter connects the existing room/call handlers to installed mobile
  // shells. Desktop preloads remain authoritative on Windows.
  App.installMobileRuntime = function () {
    const native = typeof globalThis.ChatAppNative?.postMessage === "function";
    const mobile = native || matchMedia("(max-width: 820px)").matches ||
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    if (!mobile) return;
    let notificationResolve = null, notificationTimer = null;
    let lastCall = "", ringCallback = null, visibilityCallback = null;
    let publishedRings = new Map(), ringCard = null;
    App.mobileNativeAvailable = native;
    App.mobileNativeInfo = globalThis.ChatAppNativeInfo || {};
    App.mobilePost = function (type, payload = {}) {
      if (!native) return false;
      try { globalThis.ChatAppNative.postMessage(JSON.stringify({ ...payload, type })); return true; }
      catch { return false; }
    };
    App.mobileRequestNotifications = function () {
      if (!native) return Promise.resolve(false);
      if (App.mobileNativeInfo.notificationsPermission === "granted") return Promise.resolve(true);
      if (notificationResolve) return Promise.resolve(false);
      return new Promise(resolve => {
        notificationResolve = resolve;
        notificationTimer = setTimeout(() => { notificationResolve = null; resolve(false); }, 60000);
        App.mobilePost("requestNotifications");
      });
    };
    App.mobilePublishCall = function () {
      if (!native || App.callJoinPending) return;
      const active = !!(App.currentCallRoomId && App.callSessionId && App.currentUser && !App.callLeavePending);
      const state = { active, roomId: active ? String(App.currentCallRoomId) : "",
        sessionId: active ? String(App.callSessionId) : "", muted: !!App.callMuted, cameraSharing: !!App.callCameraSharing,
        title: active ? (App.roomDisplayName?.(App.currentCallRoomId, App.roomsMetaCache?.get(App.currentCallRoomId)) || "Chat App call") : "Chat App" };
      const signature = JSON.stringify(state);
      if (signature !== lastCall && App.mobilePost("call", state)) lastCall = signature;
    };
    const renderRings = rings => {
      ringCard?.remove(); ringCard = null;
      const ring = rings[0];
      if (!ring) return;
      ringCard = document.createElement("section");
      ringCard.className = "mobile-incoming-call";
      ringCard.setAttribute("role", "dialog"); ringCard.setAttribute("aria-label", "Incoming call");
      const label = document.createElement("small"); label.textContent = "INCOMING CALL";
      const title = document.createElement("strong"); title.textContent = ring.roomName || "Chat App";
      const actions = document.createElement("div"); actions.className = "mobile-ring-actions";
      for (const [action, text, className] of [["decline", "Decline", "btn"], ["join", "Answer", "btn primary"]]) {
        const button = document.createElement("button"); button.type = "button";
        button.className = className; button.textContent = text;
        button.addEventListener("click", () => ringCallback?.({ action, id: ring.id, roomId: ring.roomId }));
        actions.appendChild(button);
      }
      ringCard.append(label, title, actions); document.body.appendChild(ringCard);
    };
    if (!globalThis.chatDesktopRings) globalThis.chatDesktopRings = {
      version: 1,
      publish({ rings = [] }) {
        const next = new Map(rings.map(ring => [ring.id, ring]));
        for (const [id, ring] of publishedRings) if (!next.has(id)) App.mobilePost("clearRing", { id, roomId: ring.roomId });
        // The shared mixer owns ringtone preferences and custom sounds while
        // this runtime is alive. Native cards must not play a second tone.
        for (const ring of rings) if (!publishedRings.has(ring.id)) App.mobilePost("ring", { ...ring, title: ring.roomName, silent: true });
        publishedRings = next; renderRings(rings);
      },
      onCommand(callback) { ringCallback = callback; },
      onVisibility(callback) { visibilityCallback = callback; },
      getVisibility() { return Promise.resolve({ focused: !document.hidden }); }
    };
    document.addEventListener("visibilitychange", () => visibilityCallback?.({ focused: !document.hidden }));
    window.addEventListener("chatapp:native", event => {
      const command = event.detail;
      if (!native || !command || typeof command !== "object") return;
      if (command.action === "ready") App.mobileNativeInfo = { ...App.mobileNativeInfo, ...command.info };
      if (command.action === "updateReady") App.mobileReady?.();
      if (command.action === "error" && command.code !== "screenShare") {
        App.showToast?.({ title: "Phone call controls unavailable", body: String(command.message || "Keep Chat App open while using the call.").slice(0, 400), duration: 6000 });
      }
      if (command.action === "notificationPermission") {
        App.mobileNativeInfo.notificationsPermission = command.granted ? "granted" : "denied";
        clearTimeout(notificationTimer); notificationResolve?.(command.granted === true); notificationResolve = null;
      }
      if (["answer", "decline"].includes(command.action)) {
        ringCallback?.({ ...command, action: command.action === "answer" ? "join" : "decline", id: command.ringId || command.id });
      }
      if (command.action === "openRoom" && App.currentUser && App.membershipMap?.has(String(command.roomId))) {
        void Promise.resolve(App.openRoom(String(command.roomId))).catch(() => {});
      }
      // OS buttons can survive a previous call. Match both room and local
      // session before touching microphone state or ending the current call.
      if (!App.currentCallRoomId || !App.callSessionId || App.callJoinPending || App.callLeavePending ||
          command.roomId !== String(App.currentCallRoomId) || command.sessionId !== String(App.callSessionId)) return;
      if (command.action === "mute") {
        if (typeof command.muted !== "boolean" || command.muted !== !!App.callMuted) App.callToggleMute?.();
      } else if (command.action === "leave") void Promise.resolve(App.leaveCall?.()).catch(() => {});
    });
    App.mobileReady = function () {
      const draft = App.$?.("msg-input");
      App.mobilePost("ready", { readyToUpdate: !App.currentCallRoomId && !App.callJoinPending &&
        !App.voiceRecorder && !App.pendingSendCount && !App.pendingPoll && !App.pendingFiles?.length &&
        !String(draft?.value || draft?.textContent || "").trim() });
    };
  };

  const DURATION = 30000;
  const rooms = new Map();
  const cleanup = new Set();
  const dismissed = new Map();
  const ringIntents = new Map();
  const ringWrites = new Map();
  let sessionCode = "", memberships = {}, membershipsRef = null, membershipsCallback = null;
  let nativeFocused = false, lastPublication = "", lastRoster = "";
  let commandPending = false;
  let refreshQueued = false, refreshGeneration = 0, expiryTimer = null, expiryAt = 0;
  let offsetRef = null, offsetCallback = null, lastContext = "";
  let calledPlaying = false, ringingPlaying = false;

  App.callScheduleRingingRefresh = function () {
    if (!App.callRingingAvailable() || refreshQueued) return;
    refreshQueued = true;
    const generation = refreshGeneration;
    queueMicrotask(() => {
      if (generation !== refreshGeneration) return;
      refreshQueued = false;
      App.callRefreshRinging();
    });
  };

  App.CALL_RING_BELL = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  App.callRingingAvailable = () => true;
  App.callRingContextRoom = () => String(App.currentRoomId || App.currentCallRoomId || App.observedCallRoomId || "");
  App.callRingNow = () => Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
  App.callRingMembershipExists = value => value === true || !!(value && typeof value === "object" && !Array.isArray(value));
  App.callRingLeaseActive = function (ring, now = App.callRingNow()) {
    const createdAt = Number(ring?.createdAt);
    return !!(ring?.id && ring?.from && ring?.to && ring?.instanceId && ring.from !== ring.to &&
      Number.isFinite(createdAt) && createdAt > 0 && createdAt <= now + 2000 && now < createdAt + DURATION);
  };
  const memberLive = member => !!member && App.callHasLiveMembers({ member });
  const validUsername = value => typeof value === "string" && !!value.trim();
  const targetExists = (code, roomId) => code === sessionCode
    ? !!App.currentUser
    : validUsername(rooms.get(String(roomId))?.usernames.get(code));
  const memberOfRoom = (code, roomId) => code === sessionCode
    ? App.callRingMembershipExists(memberships?.[roomId])
    : (rooms.get(String(roomId))?.memberships.get(code)?.joined ?? rooms.get(String(roomId))?.membershipCache.get(code)) === true;
  const ringKey = (roomId, code) => `${roomId}/${code}`;
  function writeRingInOrder(key, operation) {
    const pending = (ringWrites.get(key) || Promise.resolve()).catch(() => {}).then(operation);
    ringWrites.set(key, pending);
    void pending.finally(() => { if (ringWrites.get(key) === pending) ringWrites.delete(key); }).catch(() => {});
    return pending;
  }

  App.callGetActiveRings = function (roomId) {
    const state = rooms.get(String(roomId));
    if (!state || !state.ready || !state.instanceId || !App.callHasLiveMembers(state.members)) return [];
    const rings = { ...state.rings };
    for (const intent of ringIntents.values()) if (intent.roomId === roomId) rings[intent.code] = intent.ring;
    return Object.entries(rings).filter(([code, ring]) => ring?.to === code &&
      ring.instanceId === state.instanceId && memberOfRoom(code, roomId) && targetExists(code, roomId) && !dismissed.has(ring.id) &&
      App.callRingLeaseActive(ring) && !memberLive(state.members[code])).map(([, ring]) => ({ ...ring, roomId }));
  };
  App.callGetRingingMembers = function (roomId) {
    if (!App.callRingingAvailable()) return [];
    return App.callGetActiveRings(roomId).map(ring => {
      const username = rooms.get(String(roomId))?.usernames.get(ring.to);
      const user = App.liveUserCache?.get(ring.to) || { code: ring.to, username, displayName: username };
      return { ...user, code: ring.to, ringing: true, connected: true, ringId: ring.id };
    });
  };
  App.getProfileRingAction = function (userCode, roomId = App.callRingContextRoom()) {
    const code = String(userCode || "");
    if (!App.callRingingAvailable() || !roomId || !App.currentUser ||
      code === String(App.currentUser.code) || !code || App.callJoinPending || App.callLeavePending ||
      !memberOfRoom(String(App.currentUser.code), roomId)) return null;
    const state = rooms.get(roomId);
    if (state) observeTargetMembership(state, code);
    if (!memberOfRoom(code, roomId) || !targetExists(code, roomId)) return null;
    if (!state?.ready || !state.instanceId || !App.callHasLiveMembers(state.members) || memberLive(state.members[code])) return null;
    const active = App.callGetActiveRings(roomId).find(ring => ring.to === code);
    return {
      label: active ? "Stop Ringing" : "Ring",
      active: !!active,
      action: () => active ? App.callStopRing(roomId, code, active.id) : App.callRingUser(code, roomId)
    };
  };
  App.callSyncRingMenu = function () {
    const menus = [
      [App.msgMenuEl, App.msgMenuCtx?.menu === "avatar" ? App.msgMenuCtx.userCode : "", App.currentRoomId || App.callRingContextRoom()],
      [App.callUserContextMenuEl, App.callUserContextMenuCtx?.peerCode, App.currentCallRoomId || App.observedCallRoomId || App.callRingContextRoom()]
    ];
    for (const [menu, code, roomId] of menus) {
      if (!menu || menu.hidden) continue;
      let button = menu._callRingButton || menu.querySelector("[data-call-ring]");
      const action = App.getProfileRingAction(code, roomId);
      if (!button && action) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "msg-menu-btn";
        button.setAttribute("data-call-ring", "");
        button.innerHTML = `<span class="msg-menu-icon" aria-hidden="true">${App.CALL_RING_BELL}</span><span class="msg-menu-label"></span>`;
        button.addEventListener("click", () => {
          const currentCode = menu === App.msgMenuEl ? App.msgMenuCtx?.userCode : App.callUserContextMenuCtx?.peerCode;
          const currentRoom = menu === App.msgMenuEl ? App.currentRoomId || App.callRingContextRoom() : App.currentCallRoomId || App.observedCallRoomId || App.callRingContextRoom();
          const current = App.getProfileRingAction(currentCode, currentRoom);
          if (!current) return;
          void Promise.resolve(current.action()).catch(error => App.showToast?.({ title: "Unable to ring", body: error?.message || "Please try again.", duration: 4000 })).finally(() => {
            App.callSyncRingMenu();
          });
        });
        menu.appendChild(button);
        menu._callRingButton = button;
      }
      if (button) {
        const labelText = action?.label || "";
        if (button._callRingLabel !== labelText) {
          button._callRingLabel = labelText;
          button.hidden = !action;
          button.style.display = action ? "" : "none";
          const label = button.querySelector(".msg-menu-label");
          if (label) label.textContent = action?.label || "Ring";
        }
      }
      if (menu === App.callUserContextMenuEl) {
        const volume = menu.querySelector(".call-user-volume-control");
        if (volume && volume.hidden !== !!action) volume.hidden = !!action;
      }
    }
    for (const state of rooms.values()) pruneTargetMemberships(state);
  };

  App.callStopRing = async function (roomId, code, ringId) {
    if (!roomId || !code || !ringId || !App.currentUser || !memberOfRoom(String(App.currentUser.code), roomId)) return false;
    const key = ringKey(roomId, code), self = String(App.currentUser.code);
    const intent = { roomId, code, ring: null };
    ringIntents.set(key, intent);
    dismissed.set(ringId, App.callRingNow() + DURATION);
    App.callRefreshRinging();
    try {
      const result = await writeRingInOrder(key, () => App.callRunTransaction(App.db.ref(`calls/${roomId}/rings/${code}`), current =>
        !current || current.id === ringId ? null : undefined,
      { isCurrent: () => String(App.currentUser?.code || "") === self && memberOfRoom(self, roomId) }));
      return !!result?.committed;
    } catch (error) {
      dismissed.delete(ringId);
      throw error;
    } finally {
      if (ringIntents.get(key) === intent) ringIntents.delete(key);
      App.callRefreshRinging();
    }
  };
  App.callRingUser = async function (userCode, roomId = App.callRingContextRoom()) {
    const code = String(userCode || ""), self = String(App.currentUser?.code || "");
    const action = App.getProfileRingAction(code, roomId);
    if (!action || action.active || !self) return false;
    const key = ringKey(roomId, code), instanceId = rooms.get(roomId)?.instanceId;
    const intent = { roomId, code, ring: { id: App.makeCallSessionId(), from: self, to: code, instanceId, createdAt: App.callRingNow() } };
    ringIntents.set(key, intent);
    App.callRefreshRinging();
    const isCurrent = () => ringIntents.get(key) === intent && String(App.currentUser?.code || "") === self &&
      memberOfRoom(self, roomId) && rooms.get(roomId)?.instanceId === instanceId;
    try {
      return await writeRingInOrder(key, async () => {
        if (!isCurrent()) return false;
        // Read small authoritative leaves; downloading every SDP/ICE candidate
        // delayed each press and gave unrelated signaling a chance to race it.
        const [membership, generation, target, username, ownMembership] = await Promise.all([
          App.db.ref(`memberships/${code}/${roomId}`).once("value"),
          App.db.ref(`calls/${roomId}/instanceId`).once("value"),
          App.db.ref(`calls/${roomId}/members/${code}`).once("value"),
          App.db.ref(`users/${code}/username`).once("value"),
          App.db.ref(`memberships/${self}/${roomId}`).once("value")
        ]);
        if (!isCurrent() || !App.callRingMembershipExists(membership.val()) || !validUsername(username.val()) ||
          generation.val() !== instanceId || !App.callRingMembershipExists(ownMembership.val()) ||
          !App.callHasLiveMembers(rooms.get(roomId)?.members || {}) || memberLive(target.val())) return false;
        const result = await App.callRunTransaction(App.db.ref(`calls/${roomId}/rings/${code}`), current => {
          if (current?.instanceId === instanceId && App.callRingLeaseActive(current) && !dismissed.has(current.id)) return undefined;
          return { ...intent.ring, createdAt: App.firebase.database.ServerValue.TIMESTAMP };
        }, { isCurrent });
        return !!result?.committed;
      });
    } finally {
      if (ringIntents.get(key) === intent) ringIntents.delete(key);
      App.callRefreshRinging();
    }
  };

  // The instanceId transaction elects exactly one starter even when people join
  // simultaneously. Web starters also send the protocol event to desktop users.
  App.callRingOnCallStarted = async function (roomId, call, candidateInstanceId) {
    if (!call?.instanceId || call.instanceId !== candidateInstanceId || !App.currentUser) return;
    const self = String(App.currentUser.code), session = String(App.callSessionId || "");
    const roomMemberships = (await App.db.ref(`roomMembers/${roomId}`).once("value")).val() || {};
    const current = (await App.db.ref(`calls/${roomId}`).once("value")).val();
    if (App.currentUser?.code !== self || App.currentCallRoomId !== roomId || App.callSessionId !== session ||
      current?.instanceId !== candidateInstanceId || current.members?.[self]?.sessionId !== session) return;
    const targets = Object.entries(roomMemberships).filter(([code, membership]) => code !== self &&
      App.callRingMembershipExists(membership) && !memberLive(current.members?.[code]));
    await Promise.all(targets.map(async ([code]) => {
      // Deleted accounts can leave room memberships behind. Verify the small
      // identity leaf rather than manufacturing a participant called "User".
      const username = (await App.db.ref(`users/${code}/username`).once("value")).val();
      if (!validUsername(username)) return;
      const id = App.makeCallSessionId();
      await App.callRunTransaction(App.db.ref(`calls/${roomId}/rings/${code}`), ring => {
        if (ring?.instanceId === candidateInstanceId && App.callRingLeaseActive(ring)) return undefined;
        return { id, from: self, to: code, instanceId: candidateInstanceId, createdAt: App.firebase.database.ServerValue.TIMESTAMP };
      }, { isCurrent: () => App.currentUser?.code === self && App.currentCallRoomId === roomId && App.callSessionId === session });
    }));
  };

  function observeTargetMembership(state, code) {
    if (!code || code === sessionCode || state.memberships.has(code)) return;
    const ref = App.db.ref(`memberships/${code}/${state.roomId}`);
    const userRef = App.db.ref(`users/${code}/username`);
    const entry = { ref, userRef, joined: null, cb: null, userCb: null };
    state.memberships.set(code, entry);
    entry.cb = snapshot => {
      if (rooms.get(state.roomId) !== state || state.memberships.get(code) !== entry) return;
      const joined = App.callRingMembershipExists(snapshot.val());
      if (entry.joined === joined) return;
      entry.joined = joined;
      state.membershipCache.set(code, joined);
      App.callScheduleRingingRefresh();
    };
    ref.on("value", entry.cb);
    entry.userCb = snapshot => {
      if (rooms.get(state.roomId) !== state || state.memberships.get(code) !== entry) return;
      const username = validUsername(snapshot.val()) ? snapshot.val() : "";
      if (state.usernames.get(code) === username) return;
      state.usernames.set(code, username);
      App.callScheduleRingingRefresh();
    };
    userRef.on("value", entry.userCb);
  }
  function pruneTargetMemberships(state) {
    const wanted = new Set(Object.entries(state.rings).filter(([, ring]) => App.callRingLeaseActive(ring)).map(([code]) => code));
    if ([App.callRingContextRoom(), App.currentCallRoomId, App.observedCallRoomId].includes(state.roomId)) {
      if (App.msgMenuEl && !App.msgMenuEl.hidden && App.msgMenuCtx?.menu === "avatar") wanted.add(String(App.msgMenuCtx.userCode || ""));
      if (App.callUserContextMenuEl && !App.callUserContextMenuEl.hidden) wanted.add(String(App.callUserContextMenuCtx?.peerCode || ""));
    }
    for (const [code, entry] of state.memberships) if (!wanted.has(code)) {
      entry.ref.off("value", entry.cb);
      entry.userRef.off("value", entry.userCb);
      state.memberships.delete(code);
    }
  }
  function detachRoomField(state, field) {
    const listener = state.listeners.get(field);
    if (listener) listener.ref.off("value", listener.cb);
    state.listeners.delete(field);
    state.loaded.delete(field);
  }
  function observeRoomField(state, field, path) {
    if (state.listeners.has(field)) return;
    const ref = App.db.ref(path);
    const cb = snapshot => {
      if (rooms.get(state.roomId) !== state || !state.listeners.has(field)) return;
      const value = snapshot.val();
      const first = !state.loaded.has(field);
      state.loaded.add(field);
      if (field.startsWith("meta:")) {
        const key = field.slice(5);
        state.meta ||= {};
        const signature = typeof value === "object" ? JSON.stringify(value) : value;
        if (!first && state.metaSignatures[key] === signature) return;
        state.metaSignatures[key] = signature;
        state.meta[key] = value;
      } else {
        state[field] = value || (field === "instanceId" ? "" : {});
        if (field === "members") {
          // VAD and heartbeats update this branch frequently. The ringing UI
          // only depends on joined sessions and whether those sessions are live.
          const signature = Object.entries(state.members).map(([code, member]) => `${code}:${member?.sessionId || ""}:${memberLive(member)}`).sort().join("|");
          if (!first && signature === state.memberSignature) return;
          state.memberSignature = signature;
        }
      }
      state.ready = ["members", "rings", "instanceId"].every(key => state.loaded.has(key));
      if (field === "rings") updateRoomSubscriptions(state);
      App.callScheduleRingingRefresh();
    };
    state.listeners.set(field, { ref, cb });
    ref.on("value", cb, () => {
      if (rooms.get(state.roomId) !== state) return;
      if (field === "rings") state.rings = {};
      else if (field === "members" || field === "instanceId") state.ready = false;
      App.callScheduleRingingRefresh();
    });
  }
  function updateRoomSubscriptions(state) {
    const liveRings = Object.entries(state.rings).filter(([, ring]) => App.callRingLeaseActive(ring));
    const needsCall = liveRings.length > 0 || state.roomId === App.currentCallRoomId || state.roomId === App.callRingContextRoom();
    if (needsCall) {
      observeRoomField(state, "members", `calls/${state.roomId}/members`);
      observeRoomField(state, "instanceId", `calls/${state.roomId}/instanceId`);
    } else {
      detachRoomField(state, "members"); detachRoomField(state, "instanceId");
      state.ready = false; state.members = {}; state.instanceId = "";
    }
    const needsMetadata = liveRings.some(([code]) => code === sessionCode);
    for (const key of ["name", "photoDataURL", "photoTransform"]) {
      if (needsMetadata) observeRoomField(state, `meta:${key}`, `rooms/${state.roomId}/${key}`);
      else detachRoomField(state, `meta:${key}`);
    }
    for (const [code] of liveRings) {
      observeTargetMembership(state, code);
      if (state.roomId === (App.currentCallRoomId || App.observedCallRoomId)) App.ensureLiveUserListener?.(code);
    }
    pruneTargetMemberships(state);
  }
  const dropRoom = roomId => {
    const state = rooms.get(roomId);
    if (state) {
      for (const { ref, cb } of state.listeners.values()) ref.off("value", cb);
      for (const { ref, cb, userRef, userCb } of state.memberships.values()) { ref.off("value", cb); userRef.off("value", userCb); }
    }
    rooms.delete(roomId);
  };
  const observeRoom = roomId => {
    if (rooms.has(roomId)) return;
    const state = { roomId, members: {}, rings: {}, instanceId: "", meta: null, metaSignatures: {}, ready: false, loaded: new Set(), listeners: new Map(), memberships: new Map(), membershipCache: new Map(), usernames: new Map(), memberSignature: "" };
    rooms.set(roomId, state);
    observeRoomField(state, "rings", `calls/${roomId}/rings`);
    updateRoomSubscriptions(state);
  };
  const suppressViewedRoom = roomId => nativeFocused && document.visibilityState !== "hidden" &&
    App.views?.chat?.dataset?.active === "true" && String(App.currentRoomId || "") === String(roomId);

  App.callRefreshRinging = function () {
    if (!App.callRingingAvailable()) return;
    for (const [id, expiresAt] of dismissed) if (expiresAt <= App.callRingNow()) dismissed.delete(id);
    const self = String(App.currentUser?.code || "");
    const allRings = self && self === sessionCode ? Array.from(rooms.keys()).flatMap(App.callGetActiveRings) : [];
    const incoming = allRings.filter(ring => ring.to === self && App.currentCallRoomId !== ring.roomId && !suppressViewedRoom(ring.roomId));
    const desktop = !!globalThis.chatDesktopOverlay || Number(globalThis.chatDesktopRings?.version) >= 2;
    const statusReady = !desktop || App.desktopNotificationPolicyReady?.() !== false;
    const doNotDisturb = !!App.isDoNotDisturb?.();
    // DND only suppresses delivery. The invitation remains active until its
    // lease ends or the recipient explicitly answers/declines it.
    const nextCalled = statusReady && incoming.length > 0 && !(desktop && doNotDisturb);
    const nextRinging = statusReady && allRings.some(ring => ring.from === self);
    if (nextCalled !== calledPlaying) { App.setNotificationLoop?.("Called", nextCalled); calledPlaying = nextCalled; }
    if (nextRinging !== ringingPlaying) { App.setNotificationLoop?.("Ringing", nextRinging); ringingPlaying = nextRinging; }
    const popups = !statusReady || doNotDisturb ? [] : incoming.map(ring => {
      const meta = rooms.get(ring.roomId)?.meta || App.roomsMetaCache?.get(ring.roomId) || {};
      return {
        id: ring.id, roomId: ring.roomId,
        roomName: App.roomDisplayName(ring.roomId, meta),
        roomIcon: String(meta.photoDataURL || App.defaultStickmanDataURL()),
        roomIconTransform: App.normalizeTransformToRel?.(meta.photoTransform, 132) || { x: 0, y: 0, scale: 1 },
        expiresAt: Number(ring.createdAt) + DURATION - (Number(App.firebaseServerTimeOffsetMs) || 0)
      };
    }).sort((a, b) => a.expiresAt - b.expiresAt || a.roomId.localeCompare(b.roomId));
    const snapshot = { rings: popups, doNotDisturb, statusReady };
    const publication = JSON.stringify(snapshot);
    if (publication !== lastPublication) {
      try { globalThis.chatDesktopRings.publish(snapshot); lastPublication = publication; } catch {}
    }
    const rosterRoom = App.currentCallRoomId || App.observedCallRoomId || "";
    const roster = JSON.stringify([rosterRoom, App.callGetActiveRings(rosterRoom).map(ring => [ring.to, ring.id])]);
    if (roster !== lastRoster) {
      lastRoster = roster;
      if (App.callMenuOpen) App.renderCallMenu?.();
      window.dispatchEvent(new CustomEvent("app:ring-state-changed"));
    }
    if ((App.msgMenuEl && !App.msgMenuEl.hidden) || (App.callUserContextMenuEl && !App.callUserContextMenuEl.hidden)) App.callSyncRingMenu();
    // A joined target accepts the lease; remove it so leaving again cannot
    // resurrect the old invitation. Expiry also works without any server write.
    for (const [roomId, state] of rooms) for (const [code, ring] of Object.entries(state.rings)) {
      // Sibling Firebase listeners can arrive in either order during a new
      // generation. Never delete a lease against a mismatched cached instance.
      if (!ring?.id || !state.ready || ring.instanceId !== state.instanceId) continue;
      const createdAt = Number(ring.createdAt);
      const expired = Number.isFinite(createdAt) && createdAt > 0 && App.callRingNow() >= createdAt + DURATION;
      const acceptedHere = code === self && App.currentCallRoomId === roomId && App.callSessionId &&
        state.members[code]?.sessionId === App.callSessionId && memberLive(state.members[code]);
      // Other clients may still have an old member snapshot when a fresh ring
      // arrives. Only the accepting session can cancel on join; everyone can
      // collect an actually expired lease (never a pending server timestamp).
      if (!expired && !acceptedHere) continue;
      const key = `${roomId}:${code}:${ring.id}`;
      if (cleanup.has(key)) continue;
      cleanup.add(key);
      void App.callStopRing(roomId, code, ring.id).catch(() => {}).finally(() => cleanup.delete(key));
    }
    // One timeout per next actual lease deadline replaces continuous polling.
    // Nothing is scheduled when there are no invitations.
    let nextExpiry = 0;
    const now = App.callRingNow();
    for (const state of rooms.values()) {
      for (const ring of Object.values(state.rings)) {
        const at = Number(ring?.createdAt) + DURATION;
        if (at > now && Number.isFinite(at) && App.callRingLeaseActive(ring, now) && (!nextExpiry || at < nextExpiry)) nextExpiry = at;
      }
      updateRoomSubscriptions(state);
    }
    const localExpiry = nextExpiry ? nextExpiry - (Number(App.firebaseServerTimeOffsetMs) || 0) : 0;
    if (localExpiry !== expiryAt) {
      clearTimeout(expiryTimer);
      expiryAt = localExpiry;
      expiryTimer = localExpiry ? setTimeout(() => {
        expiryTimer = null; expiryAt = 0;
        App.callRefreshRinging();
      }, Math.max(1, localExpiry - Date.now())) : null;
    }
  };
  App.callStopRingingSession = function () {
    ++refreshGeneration; refreshQueued = false;
    clearTimeout(expiryTimer); expiryTimer = null; expiryAt = 0;
    if (membershipsRef && membershipsCallback) membershipsRef.off("value", membershipsCallback);
    if (offsetRef && offsetCallback) offsetRef.off("value", offsetCallback);
    membershipsRef = membershipsCallback = null;
    offsetRef = offsetCallback = null;
    for (const roomId of Array.from(rooms.keys())) dropRoom(roomId);
    memberships = {};
    dismissed.clear();
    ringIntents.clear();
    sessionCode = "";
    lastContext = "";
    App.callRefreshRinging();
  };
  App.callSyncRingingSession = function () {
    if (!App.callRingingAvailable()) return;
    const self = String(App.currentUser?.code || "");
    if (self !== sessionCode) {
      App.callStopRingingSession();
      sessionCode = self;
      if (self) {
        membershipsRef = App.db.ref(`memberships/${self}`);
        membershipsCallback = snapshot => {
          if (sessionCode !== self || String(App.currentUser?.code || "") !== self) return;
          memberships = snapshot.val() || {};
          const joined = new Set(Object.entries(memberships).filter(([, value]) => App.callRingMembershipExists(value)).map(([id]) => id));
          const changed = joined.size !== rooms.size || Array.from(joined).some(id => !rooms.has(id));
          for (const roomId of Array.from(rooms.keys())) if (!joined.has(roomId)) dropRoom(roomId);
          for (const roomId of joined) observeRoom(roomId);
          if (changed) App.callScheduleRingingRefresh();
        };
        membershipsRef.on("value", membershipsCallback);
        offsetRef = App.db.ref(".info/serverTimeOffset");
        let lastOffset = Number(App.firebaseServerTimeOffsetMs) || 0;
        offsetCallback = snapshot => {
          if (sessionCode !== self) return;
          const offset = Number(snapshot.val()) || 0;
          if (offset === lastOffset) return;
          lastOffset = offset;
          App.callScheduleRingingRefresh();
        };
        offsetRef.on("value", offsetCallback);
      }
    }
    App.callRingingContextChanged();
  };
  App.callRingingContextChanged = function () {
    if (!App.callRingingAvailable()) return;
    const self = String(App.currentUser?.code || "");
    if (self !== sessionCode) { App.callSyncRingingSession(); return; }
    const next = [self, App.currentCallRoomId, App.callSessionId, App.callJoinPending, App.callLeavePending,
      App.observedCallRoomId, App.currentRoomId, App.views?.chat?.dataset?.active].join("|");
    if (next === lastContext) return;
    lastContext = next;
    for (const state of rooms.values()) updateRoomSubscriptions(state);
    App.callScheduleRingingRefresh();
  };
  App.callHandleRingCommand = async function (command) {
    if (!App.callRingingAvailable() || !App.currentUser ||
      !["join", "decline"].includes(command?.action)) return;
    const roomId = String(command.roomId || ""), self = String(App.currentUser.code);
    const ring = App.callGetActiveRings(roomId).find(item => item.to === self && item.id === command.id);
    if (!ring) return;
    if (command.action === "join" && (commandPending || App.callJoinPending || App.callLeavePending)) {
      App.showToast?.({ title: "Call in progress", body: "Please finish connecting or leaving your current call, then try again." });
      return;
    }
    // Dismiss locally before the Firebase transaction: a slow connection must
    // never leave Decline ringing, or hold Join behind a server acknowledgement.
    dismissed.set(ring.id, Number(ring.createdAt) + DURATION);
    App.callRefreshRinging();
    void App.callStopRing(roomId, self, ring.id).catch(error => {
      if (App.currentUser?.code !== self) return;
      App.showToast?.({ title: "Unable to update call", body: error?.message || "Please try again.", duration: 4500 });
    });
    if (command.action !== "join") return;
    commandPending = true;
    try {
      if (App.currentCallRoomId && App.currentCallRoomId !== roomId) await App.leaveCall();
      if (App.currentUser?.code !== self || !memberOfRoom(self, roomId)) return;
      if (String(App.currentRoomId || "") !== roomId) await App.openRoom(roomId);
      else if (App.views?.chat?.dataset?.active !== "true") App.showView?.("chat");
      if (App.currentUser?.code !== self) return;
      if (App.currentCallRoomId !== roomId) await App.joinCall(roomId);
      else App.openCallMenu?.();
    } catch (error) {
      App.showToast?.({ title: "Unable to answer call", body: error?.message || "Please try again.", duration: 4500 });
    } finally { commandPending = false; }
  };

  App.register("calling/ringing", function initializeFeature() {
    if (!App.callRingingAvailable()) return;
    if (!globalThis.chatDesktopRings && typeof CustomEvent !== "function") return;
    nativeFocused = document.hasFocus?.() === true;
    globalThis.chatDesktopRings?.onCommand?.(command => void App.callHandleRingCommand(command));
    globalThis.chatDesktopRings?.onVisibility?.(state => {
      const focused = state?.focused === true;
      if (focused === nativeFocused) return;
      nativeFocused = focused;
      App.callScheduleRingingRefresh();
    });
    Promise.resolve(globalThis.chatDesktopRings?.getVisibility?.()).then(state => {
      if (state) nativeFocused = state.focused === true;
      App.callScheduleRingingRefresh();
    }).catch(() => {});
    const startPresence = App.startAppPresence, stopPresence = App.stopAppPresence, showView = App.showView;
    if (typeof startPresence === "function") App.startAppPresence = function (...args) {
      const result = startPresence.apply(this, args);
      App.callSyncRingingSession();
      return result;
    };
    if (typeof stopPresence === "function") App.stopAppPresence = function (...args) {
      App.callStopRingingSession();
      return stopPresence.apply(this, args);
    };
    if (typeof showView === "function") App.showView = function (...args) {
      const result = showView.apply(this, args);
      App.callRingingContextChanged();
      return result;
    };
    window.addEventListener("app:status-changed", App.callScheduleRingingRefresh);
    document.addEventListener("visibilitychange", App.callScheduleRingingRefresh);
    window.addEventListener("beforeunload", App.callStopRingingSession);
    App.callSyncRingingSession();
  });
})(globalThis.ChatApp);
