/* calling/viewers: methods register before ordered initialization. */
(function (App) {
  "use strict";
// Keep legacy screen keys unchanged; camera keys carry their source explicitly.
App.callCameraKey = code => 'camera:' + String(code || '');
App.callShareOwner = key => String(key || '').replace(/^camera:/, '');
App.callShareIsCamera = key => String(key || '').startsWith('camera:');
App.callShareIsAvailable = function (key) {
  const code = App.callShareOwner(key), camera = App.callShareIsCamera(key);
  if (code === String(App.currentUser?.code || '')) return camera ? !!App.callCameraSharing : !!App.callSharing;
  const member = App.callGetMemberByCode(code);
  const recovering = member && globalThis.ChatCallPolicy.keepMember(member, App.callPeerMap.get(code), Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0), App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS);
  return (member?.connected !== false || recovering) && (camera ? !!member?.cameraSharing : !!member?.sharing);
};
App.callAvailableShareKeys = function () {
  const keys = new Set();
  for (const member of App.callMembersCache) {
    const code = String(member?.code || '');
    if (!code) continue;
    if (App.callShareIsAvailable(code)) keys.add(code);
    if (App.callShareIsAvailable(App.callCameraKey(code))) keys.add(App.callCameraKey(code));
  }
  return keys;
};
App.callGetShareStream = function (key) {
  const code = App.callShareOwner(key), camera = App.callShareIsCamera(key);
  if (!code || !App.callShareIsAvailable(key)) return null;
  return code === String(App.currentUser?.code || '')
    ? (camera ? App.callCameraStream : App.callScreenStream) || null
    : App.callRemoteVideoStreams.get(String(key)) || null;
};
App.callGetShareId = function (key) {
  const code = App.callShareOwner(key), camera = App.callShareIsCamera(key);
  if (!code) return '';
  if (code === String(App.currentUser?.code || '')) return String((camera ? App.callCameraShareId : App.callScreenShareId) || '');
  const member = App.callGetMemberByCode(code);
  if (camera) return member?.cameraSharing ? String(member.cameraShareId || '') : '';
  if (!member?.sharing) return '';
  return String(member.shareId || `legacy:${member.sessionId || code}`);
};
App.callGetSharePreview = function (key) {
  const code = App.callShareOwner(key), camera = App.callShareIsCamera(key);
  const member = App.callGetMemberByCode(code);
  const value = code === String(App.currentUser?.code || '')
    ? (camera ? App.callCameraPreviewDataURL : App.callScreenPreviewDataURL)
    : (camera ? member?.cameraPreviewDataURL : member?.sharePreviewDataURL);
  return typeof value === 'string' && value.length <= 96000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
};
App.callNormalizeViewingShares = function (raw) {
  if (!raw || typeof raw !== "object") return {};
  const normalized = {};
  for (const [ownerCodeRaw, shareIdRaw] of Object.entries(raw)) {
    const ownerCode = String(ownerCodeRaw || "");
    const shareId = String(shareIdRaw || "");
    if (ownerCode && shareId) normalized[ownerCode] = shareId;
  }
  return normalized;
};
App.callViewingSharesSignature = function (shares) {
  return JSON.stringify(Object.entries(App.callNormalizeViewingShares(shares)).sort(([a], [b]) => a.localeCompare(b)));
};
App.callGetShareViewerUsers = function (ownerCode, {
  optimistic = true
} = {}) {
  const owner = String(ownerCode || "");
  if (!owner) return [];
  const expectedShareId = App.callGetShareId(owner);
  const viewerCodes = new Set();
  const cached = App.callShareViewersCache.get(owner);
  if (cached instanceof Map) {
    for (const [viewerCode, sessionRecords] of cached.entries()) {
      const code = String(viewerCode || "");
      if (!code || code === App.callShareOwner(owner)) continue;
      const member = App.callGetMemberByCode(code);
      const memberSessionId = String(member?.sessionId || "");
      const mirrorIsAuthoritative = !!memberSessionId && String(member?.viewingSharesSessionId || "") === memberSessionId;
      if (mirrorIsAuthoritative) {
        const mirroredShareId = String(App.callNormalizeViewingShares(member?.viewingShares)[owner] || "");
        if (mirroredShareId && (!expectedShareId || mirroredShareId === expectedShareId)) viewerCodes.add(code);
        continue;
      }
      const records = sessionRecords instanceof Map ? Array.from(sessionRecords.values()) : [sessionRecords];
      const record = records.find(candidate => String(candidate?.sessionId || "") === memberSessionId) || records.filter(candidate => {
        const candidateShareId = String(candidate?.shareId || "");
        return !expectedShareId || !candidateShareId || candidateShareId === expectedShareId;
      }).sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0];
      const recordSessionId = String(record?.sessionId || "");
      const recordShareId = String(record?.shareId || "");
      const recordAge = Date.now() - Number(record?.updatedAt || 0);
      const exactCurrentSession = !!memberSessionId && recordSessionId === memberSessionId;
      const recentlyReassertedSession = !!recordSessionId && Number.isFinite(recordAge) && recordAge >= 0 && recordAge <= App.CALL_HEARTBEAT_MS * 3;
      if (!member || member.connected === false || !exactCurrentSession && !recentlyReassertedSession) continue;
      if (expectedShareId && recordShareId && recordShareId !== expectedShareId) continue;
      viewerCodes.add(code);
    }
  }

  // Mirror viewership on the viewer's member record as a second source of
  // truth. This keeps the owner UI live even when a deployment's database
  // rules have not yet granted access to the newer screenViewers branch.
  for (const member of App.callMembersCache) {
    const code = String(member?.code || "");
    if (!code || code === App.callShareOwner(owner) || member?.connected === false) continue;
    if (!member?.sessionId || String(member.viewingSharesSessionId || "") !== String(member.sessionId)) continue;
    const mirroredShareId = String(App.callNormalizeViewingShares(member?.viewingShares)[owner] || "");
    if (!mirroredShareId) continue;
    if (expectedShareId && mirroredShareId !== expectedShareId) continue;
    viewerCodes.add(code);
  }
  const selfCode = String(App.currentUser?.code || "");
  if (optimistic && selfCode && selfCode !== App.callShareOwner(owner) && App.currentCallRoomId && App.callWatchedShareCodes.has(owner)) {
    viewerCodes.add(selfCode);
  }
  return Array.from(viewerCodes).map(code => {
    if (code === selfCode && App.currentUser) return App.currentUser;
    const member = App.callGetMemberByCode(code);
    return App.getLiveOrStoredCallUser(member || App.liveUserCache.get(code) || {
      code
    });
  }).filter(Boolean).sort((a, b) => String(a?.displayName || a?.username || a?.code || "").localeCompare(String(b?.displayName || b?.username || b?.code || "")));
};
App.callStopShareViewerObserver = function ({
  roomId = null,
  sessionId = null
} = {}) {
  const id = App.sanitizeCallRoom(roomId || App.callShareViewersRoomId || App.currentCallRoomId);
  const sid = String(sessionId || App.callSessionId || "");
  App.callViewerPresenceSyncToken += 1;
  App.callViewerPresenceSyncQueued = false;
  App.callViewerPresenceForceQueued = false;
  if (App.callShareViewersRef && App.callShareViewersCb) {
    try {
      App.callShareViewersRef.off("value", App.callShareViewersCb);
    } catch {}
  }
  App.callShareViewersRef = null;
  App.callShareViewersCb = null;
  App.callShareViewersRoomId = null;
  App.callShareViewersCache.clear();
  App.callPublishDesktopOverlay?.();
  App.callPublishedViewingSharesSignature = null;
  for (const [ownerCode, entry] of Array.from(App.callViewerPresenceRefs.entries())) {
    if (id && entry?.roomId && entry.roomId !== id) continue;
    if (sid && entry?.sessionId && entry.sessionId !== sid) continue;
    try {
      entry.ref.onDisconnect().cancel();
    } catch {}
    try {
      entry.ref.remove();
    } catch {}
    App.callViewerPresenceRefs.delete(ownerCode);
  }
};
App.callStartShareViewerObserver = function (roomId) {
  const id = App.sanitizeCallRoom(roomId);
  if (!id || !App.currentUser || !App.callSessionId) return;
  if (App.callShareViewersRef && App.callShareViewersRoomId === id) return;
  App.callStopShareViewerObserver();
  App.callShareViewersRoomId = id;
  App.callShareViewersRef = App.db.ref(`calls/${id}/screenViewers`);
  App.callShareViewersCb = snap => {
    if (App.currentCallRoomId !== id || App.callShareViewersRoomId !== id) return;
    const root = snap.val() || {};
    const next = new Map();
    for (const [ownerCodeRaw, viewersRaw] of Object.entries(root)) {
      const ownerCode = String(ownerCodeRaw || "");
      if (!ownerCode || !viewersRaw || typeof viewersRaw !== "object") continue;
      const ownerMap = new Map();
      for (const [viewerCodeRaw, sessionsRaw] of Object.entries(viewersRaw)) {
        const viewerCode = String(viewerCodeRaw || "");
        if (!viewerCode || viewerCode === App.callShareOwner(ownerCode) || !sessionsRaw || typeof sessionsRaw !== "object") continue;
        const records = new Map();
        // Read the earlier non-session-nested shape defensively during rollout.
        if (sessionsRaw.sessionId) {
          records.set(String(sessionsRaw.sessionId), {
            sessionId: String(sessionsRaw.sessionId),
            shareId: String(sessionsRaw.shareId || ""),
            updatedAt: Number(sessionsRaw.updatedAt || 0)
          });
        } else {
          for (const [sessionKey, record] of Object.entries(sessionsRaw)) {
            if (!record || typeof record !== "object") continue;
            const recordSessionId = String(record.sessionId || sessionKey || "");
            if (!recordSessionId) continue;
            records.set(recordSessionId, {
              sessionId: recordSessionId,
              shareId: String(record.shareId || ""),
              updatedAt: Number(record.updatedAt || 0)
            });
          }
        }
        if (!records.size) continue;
        ownerMap.set(viewerCode, records);
        App.ensureLiveUserListener(viewerCode);
      }
      if (ownerMap.size) next.set(ownerCode, ownerMap);
    }
    App.callShareViewersCache = next;
    if (App.callMenuOpen) App.callRefreshScreenViewerDisplays();
    else App.callPublishDesktopOverlay?.();
  };
  App.callShareViewersRef.on("value", App.callShareViewersCb, error => {
    console.warn("screen viewer observer failed; using member-presence mirror:", error);
  });
};
App.callSyncViewerPresence = function ({
  force = false
} = {}) {
  App.callSyncScreenAudioPlayback();
  App.callViewerPresenceSyncQueued = true;
  App.callViewerPresenceForceQueued = App.callViewerPresenceForceQueued || !!force;
  if (App.callViewerPresenceSyncPromise) return App.callViewerPresenceSyncPromise;
  const drain = (async () => {
    while (App.callViewerPresenceSyncQueued) {
      const nextForce = App.callViewerPresenceForceQueued;
      App.callViewerPresenceSyncQueued = false;
      App.callViewerPresenceForceQueued = false;
      await App.callSyncViewerPresenceNow({
        force: nextForce
      });
    }
  })();
  App.callViewerPresenceSyncPromise = drain;
  const finish = () => {
    if (App.callViewerPresenceSyncPromise === drain) App.callViewerPresenceSyncPromise = null;
    if (App.callViewerPresenceSyncQueued) void App.callSyncViewerPresence({
      force: App.callViewerPresenceForceQueued
    });
  };
  void drain.then(finish, finish);
  return drain;
};
App.callSyncViewerPresenceNow = async function ({
  force = false
} = {}) {
  const token = ++App.callViewerPresenceSyncToken;
  const roomId = App.sanitizeCallRoom(App.currentCallRoomId);
  const sessionId = String(App.callSessionId || "");
  const selfCode = String(App.currentUser?.code || "");
  // Watching is a media subscription, independent of the call panel/chrome.
  // Navigation, minimization and fullscreen must not unsubscribe a selected
  // screen. Only closing that share, the share ending or leaving ends watching.
  const viewingSurfaceOpen = App.callWatchedShareCodes.size > 0;
  const desired = new Map();
  if (roomId && sessionId && selfCode && viewingSurfaceOpen) {
    for (const ownerCodeRaw of App.callWatchedShareCodes) {
      const ownerCode = String(ownerCodeRaw || "");
      const owner = App.callGetMemberByCode(App.callShareOwner(ownerCode));
      const shareId = App.callGetShareId(ownerCode);
      if (!ownerCode || App.callShareOwner(ownerCode) === selfCode || !owner || !App.callShareIsAvailable(ownerCode) || !shareId) continue;
      desired.set(ownerCode, shareId);
    }
  }
  // The member mirror controls sender attachment. Publish the new selection
  // before old viewer-leaf cleanup or heartbeat acknowledgements can delay it.
  const mirroredViewingShares = Object.fromEntries(Array.from(desired.entries()).sort(([a], [b]) => a.localeCompare(b)));
  const mirroredSignature = App.callViewingSharesSignature(mirroredViewingShares);
  if (App.myCallMemberRef && roomId && sessionId && selfCode && (force || mirroredSignature !== App.callPublishedViewingSharesSignature)) {
    try {
      await App.myCallMemberRef.update({
        viewingShares: Object.keys(mirroredViewingShares).length ? mirroredViewingShares : null,
        viewingSharesSessionId: sessionId
      });
      if (token === App.callViewerPresenceSyncToken && App.currentCallRoomId === roomId && App.callSessionId === sessionId) {
        App.callPublishedViewingSharesSignature = mirroredSignature;
      }
    } catch (e) {
      console.warn("member viewer-presence mirror failed:", e);
    }
  }
  if (token !== App.callViewerPresenceSyncToken) return;
  for (const [ownerCode, entry] of Array.from(App.callViewerPresenceRefs.entries())) {
    const wantedShareId = desired.get(ownerCode) || "";
    const keep = !!wantedShareId && entry.roomId === roomId && entry.sessionId === sessionId && entry.shareId === wantedShareId;
    if (keep) {
      if (force || Date.now() - Number(entry.lastWriteAt || 0) >= App.CALL_HEARTBEAT_MS) {
        try {
          await entry.ref.set({
            sessionId,
            shareId: wantedShareId,
            updatedAt: App.firebase.database.ServerValue.TIMESTAMP
          });
          entry.lastWriteAt = Date.now();
        } catch (e) {
          // Treat the local entry as a cache, not proof the backend leaf still
          // exists. Dropping it lets the creation pass below repair it.
          App.callViewerPresenceRefs.delete(ownerCode);
          console.warn("screen viewer presence reassert failed:", e);
        }
      }
      continue;
    }
    try {
      await entry.ref.onDisconnect().cancel();
    } catch {}
    try {
      await entry.ref.remove();
    } catch {}
    App.callViewerPresenceRefs.delete(ownerCode);
  }
  if (token !== App.callViewerPresenceSyncToken || !roomId || !sessionId || !selfCode || !viewingSurfaceOpen) return;
  for (const [ownerCode, shareId] of desired.entries()) {
    if (App.callViewerPresenceRefs.has(ownerCode)) continue;
    const ref = App.db.ref(`calls/${roomId}/screenViewers/${ownerCode}/${selfCode}/${sessionId}`);
    const entry = {
      ref,
      roomId,
      sessionId,
      shareId,
      lastWriteAt: 0
    };
    App.callViewerPresenceRefs.set(ownerCode, entry);
    try {
      await ref.onDisconnect().remove();
      if (token !== App.callViewerPresenceSyncToken || App.currentCallRoomId !== roomId || App.callSessionId !== sessionId) {
        try {
          await ref.onDisconnect().cancel();
        } catch {}
        try {
          await ref.remove();
        } catch {}
        if (App.callViewerPresenceRefs.get(ownerCode) === entry) App.callViewerPresenceRefs.delete(ownerCode);
        continue;
      }
      await ref.set({
        sessionId,
        shareId,
        updatedAt: App.firebase.database.ServerValue.TIMESTAMP
      });
      entry.lastWriteAt = Date.now();
    } catch (e) {
      if (App.callViewerPresenceRefs.get(ownerCode) === entry) App.callViewerPresenceRefs.delete(ownerCode);
      console.warn("screen viewer presence failed:", e);
    }
  }
};
App.callPruneWatchedShares = function (sharingCodes = null) {
  const available = sharingCodes instanceof Set ? sharingCodes : App.callAvailableShareKeys();
  for (const code of Array.from(App.callWatchedShareCodes)) {
    if (!available.has(code)) {
      App.callWatchedShareCodes.delete(code);
      App.callScreenTransforms?.delete(code);
    }
  }
  if (App.callFocusedShareCode && !App.callWatchedShareCodes.has(App.callFocusedShareCode)) {
    App.callFocusedShareCode = null;
  }
  if (App.shareViewUserCode && !available.has(String(App.shareViewUserCode))) {
    App.shareViewUserCode = null;
    App.shareViewUsername = null;
  }
  App.shareViewOpen = App.callWatchedShareCodes.size > 0;
  if (!App.shareViewOpen) App.callMultiViewEnabled = false;
  void App.callSyncViewerPresence();
};
App.callCanMultiView = function () {
  const selfCode = String(App.currentUser?.code || "");
  return !!App.callMenuExpanded && Array.from(App.callWatchedShareCodes).filter(key =>
    App.callShareOwner(key) !== selfCode && App.callShareIsAvailable(key)).length >= 2;
};
App.callSyncMultiViewButton = function () {
  let button = App.$("btn-call-multi-view");
  const expand = App.$("btn-call-menu-expand");
  if (!button && expand) {
    button = document.createElement("button");
    button.id = "btn-call-multi-view";
    button.type = "button";
    button.className = "icon-btn call-menu-chat call-multi-view-toggle";
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="8" height="16" rx="2" stroke="currentColor" stroke-width="2"/><rect x="14" y="4" width="7" height="16" rx="2" stroke="currentColor" stroke-width="2"/></svg>';
    button.addEventListener("click", () => {
      if (!App.callCanMultiView()) return;
      App.callMultiViewEnabled = !App.callMultiViewEnabled;
      App.callFocusedShareCode = null;
      App.callFocusedControlsCode = "";
      App.callResetScreenZoom();
      App.renderCallMenu();
    });
    (App.$("btn-call-menu-chat") || expand).before(button);
  }
  if (!App.callCanMultiView()) {
    if (App.callMultiViewEnabled) App.callResetScreenZoom();
    App.callMultiViewEnabled = false;
  }
  if (button) {
    button.hidden = !App.callCanMultiView();
    button.setAttribute("aria-pressed", String(App.callMultiViewEnabled));
    const label = App.callMultiViewEnabled ? "Close Multi Screen View" : "Multi Screen View";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
  }
};
App.openShareView = function (userCode, username, {
  multi = false
} = {}) {
  const code = String(userCode || "");
  if (!code) return;
  App.shareViewUserCode = code;
  App.shareViewUsername = String(username || "User");
  // Every media tile is an independent subscription, including your own
  // screen and camera. Opening another tile never closes an existing stream.
  App.callFocusedShareCode = null;
  App.callResetScreenZoom();
  App.callWatchedShareCodes.add(code);
  App.shareViewOpen = true;
  if (App.callMenuOpen) App.renderCallMenu();
  void App.callSyncViewerPresence();
  requestAnimationFrame(App.syncShareViewStream);
};
App.callCloseWatchedShare = function (userCode) {
  const code = String(userCode || "");
  if (!code) return;
  App.callWatchedShareCodes.delete(code);
  App.callResetScreenZoom();
  if (App.callFocusedShareCode === code) App.callFocusedShareCode = null;
  if (String(App.shareViewUserCode || "") === code) {
    const next = Array.from(App.callWatchedShareCodes).at(-1) || null;
    App.shareViewUserCode = next;
    App.shareViewUsername = next ? String(App.callGetMemberByCode(App.callShareOwner(next))?.displayName || App.callGetMemberByCode(App.callShareOwner(next))?.username || "User") : null;
  }
  if (App.callWatchedShareCodes.size < 2) App.callMultiViewEnabled = false;
  App.shareViewOpen = App.callWatchedShareCodes.size > 0;
  if (App.callMenuOpen) App.renderCallMenu();
  void App.callSyncViewerPresence();
};
App.callToggleShareFocus = function (userCode) {
  const code = String(userCode || "");
  if (!code || !App.callWatchedShareCodes.has(code)) return;
  App.callMultiViewEnabled = false;
  App.callResetScreenZoom();
  App.callFocusedShareCode = App.callFocusedShareCode === code ? null : code;
  App.callFocusedControlsVisible = !!App.callFocusedShareCode;
  App.shareViewOpen = true;
  App.shareViewUserCode = code;
  if (App.callMenuOpen) App.renderCallMenu();
  App.$("call-menu-list")?.querySelector(".call-view-tile.is-focused .call-view-body")?.focus({ preventScroll: true });
  void App.callSyncViewerPresence();
};
App.callFullscreenShare = async function (userCode) {
  const code = String(userCode || "");
  if (!App.callWatchedShareCodes.has(code) || App.callMultiViewEnabled) return;
  // The menu is a permanent ancestor. Presence rebuilds its contents, never
  // the fullscreen element itself; native video chrome is never requested.
  const target = App.$("call-menu");
  if (!target?.requestFullscreen) return;
  const request = App.callFullscreenRequest = (App.callFullscreenRequest || 0) + 1;
  App.callFullscreenPreviousFocus = App.callFocusedShareCode;
  App.callFocusedShareCode = code;
  App.callFullscreenCode = code;
  App.callResetScreenZoom();
  target.classList.add("is-screen-fullscreen");
  App.renderCallMenu();
  try {
    await target.requestFullscreen();
    if (request !== App.callFullscreenRequest || !App.callMenuOpen || !App.callWatchedShareCodes.has(code) || !App.callShareIsAvailable(code)) {
      if ((!App.callFullscreenCode || !App.callMenuOpen) && document.fullscreenElement === target) await document.exitFullscreen().catch(() => {});
      if (request === App.callFullscreenRequest) App.callExitScreenFullscreen();
    }
  } catch {
    if (request === App.callFullscreenRequest) App.callExitScreenFullscreen();
  }
};
App.callExitScreenFullscreen = function () {
  if (!App.callFullscreenCode) return;
  App.callFullscreenRequest = (App.callFullscreenRequest || 0) + 1;
  App.callFullscreenCode = "";
  App.callFocusedShareCode = App.callWatchedShareCodes.has(App.callFullscreenPreviousFocus) ? App.callFullscreenPreviousFocus : null;
  App.callFullscreenPreviousFocus = null;
  App.callResetScreenZoom();
  App.$("call-menu")?.classList.remove("is-screen-fullscreen");
  if (App.callMenuOpen) App.renderCallMenu();
};
// Each visible source owns its transform. Wheel/pointer events update numbers
// only; geometry is read on mount/resize and one compositor write is queued.
const screenControllers = new Set();
App.callScreenTransformState = function (code) {
  App.callScreenTransforms ||= new Map();
  let state = App.callScreenTransforms.get(code);
  const shareId = App.callGetShareId(code);
  if (!state || state.shareId !== shareId) {
    state = { percent: 100, x: 0, y: 0, shareId };
    App.callScreenTransforms.set(code, state);
  }
  return state;
};
App.callDisposeScreenTransforms = function (root) {
  for (const controller of screenControllers) {
    if (!controller.tile.isConnected || root?.contains(controller.tile)) controller.dispose();
  }
};
App.callResetScreenZoom = function (code = null) {
  if (code) App.callScreenTransforms?.delete(code);
  else App.callScreenTransforms?.clear();
  App.callScreenZoom = 100;
  App.callScreenZoomCode = "";
  for (const controller of screenControllers) if (!code || controller.code === code) controller.schedule();
};
App.callStepScreenZoom = function (value, direction) {
  const amount = direction > 0 ? (value >= 500 ? 100 : 50) : (value > 500 ? 100 : 50);
  return Math.max(100, Math.min(2000, value + (direction > 0 ? amount : -amount)));
};
// Crop the source to the visible viewport instead of allocating a video layer
// up to twenty times larger in each dimension. Work stays bounded at any zoom.
App.callScreenCropGeometry = function (g, state, sourceWidth, sourceHeight) {
  const width = g.frameWidth * state.percent / 100, height = g.frameHeight * state.percent / 100;
  const left = (g.width - width) / 2 + state.x, top = (g.height - height) / 2 + state.y;
  const x = Math.max(0, left), y = Math.max(0, top);
  const right = Math.min(g.width, left + width), bottom = Math.min(g.height, top + height);
  if (right <= x || bottom <= y || !sourceWidth || !sourceHeight) return null;
  return [(x - left) / width * sourceWidth, (y - top) / height * sourceHeight,
    (right - x) / width * sourceWidth, (bottom - y) / height * sourceHeight,
    x, y, right - x, bottom - y];
};
App.callApplyScreenZoom = function () {
  for (const controller of screenControllers) {
    if (!controller.tile.isConnected) { controller.dispose(); continue; }
    controller.schedule(true);
  }
};
App.callConsumeScreenGesture = function (tile, event) {
  if (App.callFullscreenCode) return true;
  const controller = tile.__screenTransform;
  if (!controller) return false;
  if (controller.suppressClick) { controller.suppressClick = false; return true; }
  if (!event.detail || !controller.geometry) return false;
  const g = controller.geometry, state = App.callScreenTransformState(controller.code);
  const x = (event.clientX - g.left) / g.scaleX, y = (event.clientY - g.top) / g.scaleY;
  const width = g.frameWidth * state.percent / 100, height = g.frameHeight * state.percent / 100;
  const left = (g.width - width) / 2 + state.x, top = (g.height - height) / 2 + state.y;
  return x < left || x > left + width || y < top || y > top + height;
};
App.callBindScreenZoom = function (tile, code) {
  if (!tile.classList.contains("is-focused") && !tile.closest(".call-stage-multi") && !App.callMultiViewEnabled) return;
  const body = tile.querySelector(".call-view-body"), video = tile.querySelector("video"), badge = tile.querySelector(".call-screen-zoom");
  if (!body || !video) return;
  const allowed = () => tile.isConnected && (tile.classList.contains("is-focused") || !!tile.closest(".call-stage-multi") || App.callFullscreenCode === code);
  const counters = App.callScreenTransformMetrics ||= { measurements: 0, frames: 0, wheels: 0, pointerMoves: 0 };
  let frame = 0, dirty = true, observer = null, drag = null;
  let cropCanvas = null, cropContext = null, cropActive = false, cropFrame = 0, cropVideoFrame = 0;
  let pausedSource = null;
  const controller = { tile, code, geometry: null, suppressClick: false,
    schedule(measure = false) { dirty ||= measure; if (!frame) frame = requestAnimationFrame(paint); },
    dispose() { if (frame) cancelAnimationFrame(frame); frame = 0; stopCrop(); cropCanvas?.remove(); pausedSource?.removeEventListener("load", drawCrop); observer?.disconnect(); video.removeEventListener("loadedmetadata", geometryChanged); video.removeEventListener("resize", geometryChanged); screenControllers.delete(controller); }
  };
  tile.__screenTransform = controller;
  screenControllers.add(controller);
  function stopCrop() {
    cropActive = false;
    if (cropFrame) cancelAnimationFrame(cropFrame);
    if (cropVideoFrame) video.cancelVideoFrameCallback?.(cropVideoFrame);
    cropFrame = cropVideoFrame = 0;
    if (cropCanvas) cropCanvas.hidden = true;
    body.classList.remove("is-crop-zoom");
  }
  function queueCrop() {
    if (!cropActive || cropFrame || cropVideoFrame || !tile.isConnected) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      cropVideoFrame = video.requestVideoFrameCallback(() => { cropVideoFrame = 0; drawCrop(); queueCrop(); });
    } else {
      cropFrame = requestAnimationFrame(() => { cropFrame = 0; drawCrop(); queueCrop(); });
    }
  }
  function drawCrop() {
    if (!cropActive || !controller.geometry || !tile.isConnected) return;
    const g = controller.geometry;
    const source = tile.classList.contains("is-screen-paused") ? body.querySelector(".call-screen-paused-frame") : video;
    const host = source && source !== video ? source.parentElement : body;
    if (cropCanvas.parentElement !== host) host.appendChild(cropCanvas);
    if (pausedSource !== (source === video ? null : source)) {
      pausedSource?.removeEventListener("load", drawCrop);
      pausedSource = source === video ? null : source;
      pausedSource?.addEventListener("load", drawCrop);
    }
    const sw = source?.videoWidth || source?.naturalWidth, sh = source?.videoHeight || source?.naturalHeight;
    if (!sw || !sh || source === video && video.readyState < 2) return;
    const crop = App.callScreenCropGeometry(g, App.callScreenTransformState(code), sw, sh);
    cropContext.setTransform(cropCanvas.width / g.width, 0, 0, cropCanvas.height / g.height, 0, 0);
    cropContext.clearRect(0, 0, g.width, g.height);
    if (crop) { try { cropContext.drawImage(source, ...crop); } catch { /* A replaced media track may not have a decoded frame yet. */ } }
    counters.cropFrames = (counters.cropFrames || 0) + 1;
  }
  function enableCrop(g) {
    if (!cropCanvas) {
      cropCanvas = document.createElement("canvas");
      cropCanvas.className = "call-screen-zoom-canvas";
      cropCanvas.setAttribute("aria-hidden", "true");
      cropContext = cropCanvas.getContext("2d");
      if (!cropContext) { cropCanvas = null; return false; }
      body.appendChild(cropCanvas);
    }
    // Cap backing pixels independently of zoom and high-DPI monitor size.
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3686400 / Math.max(1, g.width * g.height)));
    const width = Math.max(1, Math.round(g.width * ratio)), height = Math.max(1, Math.round(g.height * ratio));
    if (cropCanvas.width !== width || cropCanvas.height !== height) { cropCanvas.width = width; cropCanvas.height = height; }
    cropActive = true; cropCanvas.hidden = false;
    body.classList.add("is-crop-zoom");
    drawCrop(); queueCrop();
    return true;
  }
  function clamp(state) {
    const g = controller.geometry;
    if (!g || state.percent === 100) { state.x = 0; state.y = 0; return; }
    const maxX = Math.max(0, (g.frameWidth * state.percent / 100 - g.width) / 2);
    const maxY = Math.max(0, (g.frameHeight * state.percent / 100 - g.height) / 2);
    state.x = Math.max(-maxX, Math.min(maxX, state.x));
    state.y = Math.max(-maxY, Math.min(maxY, state.y));
  }
  function paint() {
    frame = 0;
    if (!tile.isConnected) { controller.dispose(); return; }
    if (dirty) {
      const rect = body.getBoundingClientRect(), label = badge?.getBoundingClientRect();
      const width = body.clientWidth || rect.width, height = body.clientHeight || rect.height;
      const scaleX = rect.width / (width || 1), scaleY = rect.height / (height || 1);
      const ratio = (video.videoWidth || 16) / (video.videoHeight || 9);
      const frameWidth = Math.min(width, height * ratio), frameHeight = frameWidth / ratio;
      controller.geometry = { left: rect.left, top: rect.top, width, height, scaleX: scaleX || 1, scaleY: scaleY || 1, frameWidth, frameHeight,
        badge: label && label.width ? { left: (label.left - rect.left) / scaleX, top: (label.top - rect.top) / scaleY, right: (label.right - rect.left) / scaleX, bottom: (label.bottom - rect.top) / scaleY } : null };
      dirty = false; counters.measurements++;
    }
    const state = App.callScreenTransformState(code); clamp(state);
    const g = controller.geometry;
    const cropped = state.percent >= 400 && enableCrop(g);
    if (!cropped && cropActive) stopCrop();
    const transform = state.percent === 100 || cropped ? "" : "translate3d(" + state.x + "px," + state.y + "px,0) scale(" + state.percent / 100 + ")";
    video.style.transform = transform;
    const pausedFrame = body.querySelector(".call-screen-paused-frame");
    if (pausedFrame) pausedFrame.style.transform = transform;
    body.classList.toggle("is-zoomed", state.percent > 100);
    if (badge) {
      const text = state.percent + "%";
      if (badge.textContent !== text) badge.textContent = text;
      badge.setAttribute("aria-label", "Zoom " + state.percent + " percent. Scroll to zoom; drag to pan; click to reset.");
      const width = g.frameWidth * state.percent / 100, height = g.frameHeight * state.percent / 100;
      const left = (g.width - width) / 2 + state.x, top = (g.height - height) / 2 + state.y, b = g.badge;
      badge.classList.toggle("over-content", !!b && b.right > left && b.left < left + width && b.bottom > top && b.top < top + height);
    }
    counters.frames++;
  }
  function geometryChanged() { controller.schedule(true); }
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(geometryChanged); observer.observe(body);
    const header = tile.querySelector(".call-view-head"); if (header) observer.observe(header);
  }
  video.addEventListener("loadedmetadata", geometryChanged);
  video.addEventListener("resize", geometryChanged);
  video.draggable = false;
  body.addEventListener("dragstart", event => event.preventDefault());
  tile.addEventListener("wheel", event => {
    if (!allowed() || event.target.closest(".call-viewers-eye,.call-viewers-tooltip") || !event.deltaY) return;
    event.preventDefault(); counters.wheels++;
    const state = App.callScreenTransformState(code), old = state.percent;
    state.percent = App.callStepScreenZoom(old, event.deltaY < 0 ? 1 : -1);
    const g = controller.geometry;
    if (g && (event.isTrusted || event.clientX || event.clientY)) {
      const x = (event.clientX - g.left) / g.scaleX - g.width / 2;
      const y = (event.clientY - g.top) / g.scaleY - g.height / 2;
      state.x = x - (x - state.x) * state.percent / old;
      state.y = y - (y - state.y) * state.percent / old;
    }
    clamp(state); App.callScreenZoom = state.percent; App.callScreenZoomCode = code;
    controller.schedule();
  }, { passive: false });
  body.addEventListener("pointerdown", event => {
    controller.suppressClick = false;
    if (!allowed() || event.button !== 0 || App.callScreenTransformState(code).percent <= 100) return;
    const state = App.callScreenTransformState(code);
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: state.x, y: state.y, moved: false };
    body.setPointerCapture?.(event.pointerId);
  });
  body.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId || !controller.geometry) return;
    const g = controller.geometry, dx = (event.clientX - drag.startX) / g.scaleX, dy = (event.clientY - drag.startY) / g.scaleY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; event.preventDefault(); counters.pointerMoves++;
    const state = App.callScreenTransformState(code); state.x = drag.x + dx; state.y = drag.y + dy; clamp(state);
    body.classList.add("is-panning"); controller.schedule();
  });
  const endDrag = event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) controller.suppressClick = true;
    drag = null; body.classList.remove("is-panning");
    if (body.hasPointerCapture?.(event.pointerId)) body.releasePointerCapture(event.pointerId);
  };
  body.addEventListener("pointerup", endDrag);
  body.addEventListener("pointercancel", endDrag);
  body.addEventListener("lostpointercapture", endDrag);
  controller.schedule(true);
};
App.closeShareView = function (immediate = false) {
  App.callResetScreenZoom();
  const code = String(App.shareViewUserCode || App.callFocusedShareCode || "");
  App.callFocusedShareCode = null;
  if (immediate && code) App.callWatchedShareCodes.delete(code);
  if (!App.callWatchedShareCodes.size) {
    App.shareViewOpen = false;
    App.shareViewUserCode = null;
    App.shareViewUsername = null;
    App.callMultiViewEnabled = false;
  }
  if (App.callMenuOpen) App.renderCallMenu();
  void App.callSyncViewerPresence();
};
App.syncShareViewStream = function () {
  document.querySelectorAll(".call-view-tile[data-share-code]").forEach(tile => {
    const code = String(tile.getAttribute("data-share-code") || "");
    const video = tile.querySelector(".call-view-video");
    const placeholder = tile.querySelector(".call-view-placeholder");
    if (!video || !placeholder || !code) return;
    const stream = App.callGetShareStream(code);
    const liveTrack = stream?.getVideoTracks?.().find(track => track.readyState === "live") || null;
    const hasLiveVideo = !!(liveTrack && !liveTrack.muted);
    App.callSyncScreenPauseTile?.(tile, code);
    placeholder.hidden = hasLiveVideo;
    video.hidden = !hasLiveVideo;
    if (!hasLiveVideo) {
      try {
        video.pause();
      } catch {}
      try {
        video.srcObject = null;
      } catch {}
      const isSelf = String(App.currentUser?.code || "") === App.callShareOwner(code);
      if (!isSelf && App.callShareIsAvailable(code)) {
        void App.callSyncViewerPresence();
      }
      return;
    }
    try {
      video.muted = true;
      video.controls = false;
    } catch {}
    if (video.srcObject !== stream) video.srcObject = stream;
    try {
      if (video.paused) video.play()?.catch?.(() => {});
    } catch {}
  });
  App.callApplyScreenZoom();
};
App.setCallMenuExpanded = function (expanded) {
  App.callMenuExpanded = !!expanded && !!App.callMenuOpen && !!App.currentCallRoomId;
  const menu = App.$("call-menu");
  const button = App.$("btn-call-menu-expand");
  menu?.classList.toggle("is-expanded", App.callMenuExpanded);
  document.body.classList.toggle("call-menu-expanded", App.callMenuExpanded);
  if (button) {
    const label = App.callMenuExpanded ? "Restore Call Menu" : "Expand Call Menu";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.setAttribute("aria-pressed", App.callMenuExpanded ? "true" : "false");
  }
  App.syncExpandedCallChat?.();
  const wasMulti = App.callMultiViewEnabled;
  App.callSyncMultiViewButton();
  if (wasMulti && !App.callMultiViewEnabled && App.callMenuOpen) App.renderCallMenu();
};

App.register("calling/viewers", function initializeFeature() {
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement !== App.$("call-menu")) App.callExitScreenFullscreen();
    else App.callApplyScreenZoom();
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => App.callApplyScreenZoom());
    const list = App.$("call-menu-list");
    if (list) observer.observe(list);
  }
});
})(globalThis.ChatApp);
