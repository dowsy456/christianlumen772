/* Desktop-only call presence. The Electron preload owns the native window. */
(function (App) {
  "use strict";
  let lastSnapshot = "";
  let lastPhotos = new Map();
  let lastPhotoScope = '';
  App.callDesktopOverlayAvailable = function () {
    return globalThis.chatDesktopOverlay?.version === 1 && typeof globalThis.chatDesktopOverlay.publish === "function";
  };

  App.callLoadDesktopOverlayPreferences = function (roomId, record) {
    if (!App.callDesktopOverlayAvailable()) return;
    const instanceId = String(record?.instanceId || "");
    const userCode = String(App.currentUser?.code || "");
    const key = JSON.stringify([String(roomId), instanceId, userCode]);
    App.callDesktopOverlayScope = instanceId && userCode ? { roomId: String(roomId), instanceId, userCode, key } : null;
    // This runs on each successful join. A previous disabled choice must not
    // turn off the default overlay when joining (or rejoining) another call.
    App.callDesktopOverlayEnabled = true;
    App.callSyncDesktopOverlay();
  };

  App.callClearDesktopOverlayScope = function () {
    App.callDesktopOverlayScope = null;
    App.callDesktopOverlayEnabled = true;
    App.callSyncDesktopOverlay();
  };

  App.callDesktopOverlaySnapshot = function () {
    const scope = App.callDesktopOverlayScope;
    const active = !!(App.currentCallRoomId && App.callSessionId && App.currentUser && scope &&
      scope.roomId === String(App.currentCallRoomId) && scope.userCode === String(App.currentUser.code) &&
      !App.callJoinPending && !App.callLeavePending);
    const selfCode = String(App.currentUser?.code || "");
    const viewers = new Set(active && App.callSharing
      ? (App.callGetShareViewerUsers?.(selfCode, { optimistic: false }) || []).map(user => String(user.code || ""))
      : []);
    const cameraViewers = new Set(active && App.callCameraSharing
      ? (App.callGetShareViewerUsers?.(App.callCameraKey(selfCode), { optimistic: false }) || []).map(user => String(user.code || "")) : []);
    const members = new Map();
    const roster = [...(App.callMembersCache || [])];
    // Signaling may briefly clear/mark the cached self record disconnected
    // while reconnecting. The local joined session remains authoritative, so
    // keep its roster entry until the call actually ends.
    if (active && !roster.some(member => String(member?.code || "") === selfCode)) roster.push(App.currentUser);
    if (active) for (const raw of roster) {
      const code = String(raw?.code || "").trim();
      if (!code || (raw.connected === false && code !== selfCode)) continue;
      const user = App.getLiveOrStoredCallUser(raw);
      const self = code === selfCode;
      const muted = self ? !!App.callMuted : !!raw.muted;
      const deafened = self ? !!App.callDeafened : !!raw.deafened;
      const transform = App.normalizeTransformToRel(user.photoTransform, 84);
      const photo = String(user.photoDataURL || App.defaultStickmanDataURL());
      members.set(code, {
        code,
        displayName: String(user.displayName || user.username || "User"),
        photoDataURL: photo,
        photoTransform: { unit: "rel", x: transform.x, y: transform.y, scale: transform.scale },
        speaking: (self ? !!App.callVadSpeaking : !!raw.speaking) && !muted && !deafened,
        muted,
        deafened,
        sharing: self ? !!App.callSharing : !!raw.sharing,
        cameraSharing: self ? !!App.callCameraSharing : !!raw.cameraSharing,
        watchingYourCamera: cameraViewers.has(code),
        watchingYourScreen: viewers.has(code)
      });
    }
    return {
      active,
      enabled: App.callDesktopOverlayEnabled !== false,
      roomId: active ? String(App.currentCallRoomId) : "",
      sessionId: active ? String(App.callSessionId) : "",
      controls: { muted: !!App.callMuted, deafened: !!App.callDeafened, listenOnly: !!App.callListenOnly,
        sharing: !!App.callSharing, cameraSharing: !!App.callCameraSharing,
        screenPending: !!App.callScreenCapturePending, cameraPending: !!App.callCameraCapturePending },
      members: Array.from(members.values()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }) || a.code.localeCompare(b.code))
    };
  };

  App.callPublishDesktopOverlay = function () {
    if (!App.callDesktopOverlayAvailable()) return;
    const snapshot = App.callDesktopOverlaySnapshot();
    const signature = JSON.stringify({ ...snapshot, members: snapshot.members.map(({ photoDataURL, ...member }) => member) });
    const photosChanged = snapshot.members.some(member => lastPhotos.get(member.code) !== member.photoDataURL);
    if (signature === lastSnapshot && !photosChanged) return;
    const photoScope = JSON.stringify([snapshot.roomId, snapshot.sessionId]);
    const reusePhotos = globalThis.chatDesktopOverlay.deltaPhotos === true && photoScope === lastPhotoScope;
    const payload = reusePhotos ? { ...snapshot, members: snapshot.members.map(member => {
      if (lastPhotos.get(member.code) !== member.photoDataURL) return member;
      const { photoDataURL, ...rest } = member;
      return { ...rest, reusePhoto: true };
    }) } : snapshot;
    try {
      globalThis.chatDesktopOverlay.publish(payload);
      lastSnapshot = signature;
      lastPhotos = new Map(snapshot.members.map(member => [member.code, member.photoDataURL]));
      lastPhotoScope = photoScope;
    } catch {
      // A desktop window shutting down must never interrupt a call or profile update.
    }
  };

  App.callSyncDesktopOverlay = function () {
    App.mobilePublishCall?.();
    const button = App.$("btn-call-overlay");
    if (button) {
      button.hidden = !App.callDesktopOverlayAvailable() || !App.currentCallRoomId;
      button.disabled = !!(App.callJoinPending || App.callLeavePending || !App.callDesktopOverlayScope);
      const enabled = App.callDesktopOverlayEnabled !== false;
      const label = enabled ? "Turn Off Call Overlay" : "Turn On Call Overlay";
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(enabled));
      button.dataset.tooltip = "Call Overlay";
      button.classList.toggle("is-active", enabled);
    }
    App.callPublishDesktopOverlay();
  };

  App.callToggleDesktopOverlay = function () {
    const scope = App.callDesktopOverlayScope;
    if (!App.callDesktopOverlayAvailable() || !scope || !App.currentCallRoomId ||
      scope.roomId !== String(App.currentCallRoomId) || scope.userCode !== String(App.currentUser?.code || "") ||
      App.callJoinPending || App.callLeavePending) return;
    App.callDesktopOverlayEnabled = App.callDesktopOverlayEnabled === false;
    App.callSyncDesktopOverlay();
  };

  App.callHandleDesktopCommand = function (command) {
    // A thumbnail may outlive a call or renderer. Only act on the exact local
    // session which supplied that button, and use the regular call handlers.
    if (!App.callDesktopOverlayAvailable() || !command || App.callJoinPending || App.callLeavePending ||
      !App.currentCallRoomId || String(command.roomId || "") !== String(App.currentCallRoomId) ||
      !App.callSessionId || String(command.sessionId || "") !== String(App.callSessionId)) return;
    if (command.action === "mute") App.callToggleMute?.();
    else if (command.action === "deafen") App.callToggleDeafen?.();
    else if (command.action === "share" || command.action === "camera") {
      App.callCaptureAnchor = App.$('btn-sidebar-call-share') || App.$(command.action === 'camera' ? 'btn-call-camera' : 'btn-call-share');
      void Promise.resolve(command.action === 'camera' ? App.callToggleCamera?.() : App.callToggleShareScreen?.()).catch(() => {}).finally(() => { App.callCaptureAnchor = null; });
    }
    else if (command.action === "overlay") App.callToggleDesktopOverlay();
    else if (command.action === "leave") void Promise.resolve(App.leaveCall?.()).catch(() => {});
  };

  App.register("calling/desktop-overlay", function initializeFeature() {
    App.callDesktopOverlayScope = null;
    App.callDesktopOverlayEnabled = true;
    if (App.callDesktopOverlayAvailable()) {
      App.$("btn-call-overlay")?.addEventListener("click", App.callToggleDesktopOverlay);
      globalThis.chatDesktopOverlay.onCommand?.(App.callHandleDesktopCommand);
    }
    App.callSyncDesktopOverlay();
  });
})(globalThis.ChatApp);
