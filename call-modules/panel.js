/* calling/panel: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.setCallButtonHidden = /* Chat calling: panel. Classic script; see CALLING.md. */function (hidden) {
  const btn = App.$("btn-side-call");
  if (!btn) return;
  btn.hidden = !!hidden;
};
App.syncCallButton = function () {
  App.callRingingContextChanged?.();
  App.syncSidebarCallDock?.();
  const btn = App.$("btn-side-call");
  if (!btn) {
    App.detachCallObserver();
    return;
  }
  const place = App.getStoredPlace() || "";
  const viewingRoom = /^room:/.test(place);
  const targetRoom = App.currentCallRoomId || (viewingRoom ? App.currentRoomId : null) || null;

  // Button only exists if a room is open OR you are actively in a call.
  App.setCallButtonHidden(!targetRoom);

  // If not visible, also close menu.
  if (!targetRoom) {
    App.closeCallMenu();
    return;
  }

  // Observe calls for the active room context:
  // - If you are in a call, always observe that call's room.
  // - Else, observe the currently opened room.
  const observeRoom = App.currentCallRoomId || (viewingRoom ? App.currentRoomId : null);
  App.attachCallObserver(observeRoom);
  const amInCall = !!(App.currentCallRoomId && App.currentUser);
  const isThisRoomsCall = !!(observeRoom && App.sanitizeCallRoom(observeRoom) === App.sanitizeCallRoom(targetRoom));

  // Determine tooltip + state
  let state = "none";
  let tooltipTitle = "Start Call";
  if (amInCall && isThisRoomsCall) {
    state = "in";
    tooltipTitle = "Call Menu";
  } else if (App.callActive && App.sanitizeCallRoom(App.observedCallRoomId) === App.sanitizeCallRoom(targetRoom)) {
    state = "active";
    tooltipTitle = "Join Call";
  } else {
    state = "none";
    tooltipTitle = "Start Call";
  }
  const pending = !!(App.callJoinPending || App.callLeavePending);
  const checking = !amInCall && App.callMembersReady === false;
  if (checking) tooltipTitle = "Checking Call…";
  if (App.callLeavePending) tooltipTitle = "Leaving Call…";
  else if (App.callJoinPending) tooltipTitle = "Joining Call…";
  btn.disabled = pending;
  btn.setAttribute("aria-busy", String(pending || checking));
  btn.dataset.callState = state;
  btn.classList.toggle("call-active", state === "active");
  btn.classList.toggle("call-in", state === "in");
  const label = App.$("call-label");
  if (label) label.textContent = tooltipTitle;
  btn.setAttribute("aria-label", tooltipTitle);
  btn.dataset.tooltip = tooltipTitle;
  App.callSyncRoomPreview();
};
App.callResetRoomPreview = function () {
  App.callPreviewDismissedRoom = "";
  App.callPreviewContextRoom = "";
};
App.callSyncJoinControl = function () {
  const join = App.$("btn-call-join");
  if (!join) return;
  const icon = join.querySelector(".call-control-icon");
  const joinIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.36 1.9.7 2.79a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.34 1.83.58 2.79.7A2 2 0 0 1 22 16.92Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  if (icon && icon.innerHTML !== joinIcon) icon.innerHTML = joinIcon;
  join.hidden = !!App.currentCallRoomId || !!App.callLeavePending || !App.callMenuOpen || !App.$("call-menu")?.classList.contains("is-preview");
  join.disabled = !!(App.callJoinPending || App.callLeavePending);
  const label = App.callJoinPending ? "Joining Call…" : "Join Call";
  join.setAttribute("aria-label", label);
  join.dataset.tooltip = label;
  join.setAttribute("aria-busy", String(!!App.callJoinPending));
};
App.callSyncRoomPreview = function () {
  const menu = App.$("call-menu");
  const viewingRoom = /^room:/.test(App.getStoredPlace() || "");
  const room = viewingRoom ? App.sanitizeCallRoom(App.currentRoomId) : "";
  if (App.callPreviewContextRoom !== room) {
    App.callPreviewContextRoom = room;
    App.callPreviewDismissedRoom = "";
  }
  const active = !!room && App.observedCallRoomId === room && App.callActive;
  if (!active) App.callPreviewDismissedRoom = "";
  if (App.currentCallRoomId) {
    menu?.classList.remove("is-preview");
  } else if (active && App.callPreviewDismissedRoom !== room) {
    if (!App.callMenuOpen || !menu?.classList.contains("is-preview")) App.openCallMenu();
  } else if (menu?.classList.contains("is-preview") && App.callMenuOpen) {
    App.closeCallMenu();
  }
  App.callSyncJoinControl();
};
App.ensureCallRuntimeModals = function () {
  const callMenu = App.$("call-menu");
  const callHost = document.querySelector(".chat-shell");

  // Screen shares now stay inside the call panel. Remove the legacy popup if
  // an older cached build left one mounted in the document.
  document.querySelectorAll("#share-menu").forEach(node => node.remove());
  if (callHost && callMenu && callMenu.parentNode !== callHost) {
    callHost.prepend(callMenu);
  }
  return {
    callMenu,
    shareMenu: null
  };
};
App.openCallMenu = function () {
  const room = App.currentCallRoomId || (/^room:/.test(App.getStoredPlace() || "") ? App.currentRoomId : null);
  const preview = !App.currentCallRoomId;
  if (!App.currentUser || !room || preview && !App.callActive) return false;
  const {
    callMenu: el
  } = App.ensureCallRuntimeModals();
  if (!el) return false;
  App.attachCallObserver(room);
  App.callPrimeCapturePicker?.();
  App.callMenuOpen = true;
  el.hidden = false;
  el.classList.add("is-open");
  el.classList.toggle("is-preview", preview);
  App.callSyncJoinControl();
  App.renderCallMenu();
  App.syncCallControlsUI();
  App.setCallMenuExpanded(App.callMenuExpanded);
  void App.callSyncViewerPresence();
  return true;
};
App.closeCallMenu = function ({ dismiss = false } = {}) {
  const el = App.$("call-menu");
  if (dismiss && el?.classList.contains("is-preview")) App.callPreviewDismissedRoom = App.sanitizeCallRoom(App.currentRoomId);
  App.callMenuOpen = false;
  App.callCloseCapturePicker?.({ immediate: true });
  App.callSyncJoinControl();
  App.callMenuExpanded = false;
  App.callMultiViewEnabled = false;
  App.callResetScreenZoom();
  App.callDisposeScreenTransforms(el);
  App.$("call-menu-list")?.firstElementChild?.removeAttribute("data-presentation-key");
  if (document.fullscreenElement === el) void document.exitFullscreen?.().catch(() => {});
  App.callExitScreenFullscreen();
  App.closeCallUserContextMenu(true);
  App.closeCallScreenContextMenu(true);
  App.callHideScreenViewersFloating({
    remove: true
  });
  document.body.classList.remove("call-menu-expanded");
  App.syncExpandedCallChat?.();
  if (!el) return;
  el.classList.remove("is-open", "is-expanded", "is-preview");
  el.hidden = true;
  App.syncSidebarCallDock?.();
  void App.callSyncViewerPresence();
};
App.getLiveOrStoredCallUser = function (m) {
  const base = m || {};
  const code = String(base?.code || "").trim();
  if (!code) return base;
  const live = App.liveUserCache.get(code);
  if (!live) return base;

  // Merge live (display name/username/pfp) into call-state (mute/deafen/speaking)
  return {
    ...base,
    username: live.username ?? base.username,
    usernameLower: (live.usernameLower ?? base.usernameLower) || String(live.username || base.username || "user").toLowerCase(),
    displayName: live.displayName ?? base.displayName ?? live.username ?? base.username,
    displayNameLower: (live.displayNameLower ?? base.displayNameLower) || String(live.displayName || base.displayName || live.username || base.username || "user").toLowerCase(),
    photoDataURL: live.photoDataURL ?? base.photoDataURL,
    photoTransform: live.photoTransform ?? base.photoTransform
  };
};
App.callBuildViewersTooltip = function (ownerCode, {
  allowEmpty = true
} = {}) {
  const inCall = ownerCode === "__call__";
  const users = inCall ? Array.from(new Map(App.callMembersCache.filter(member => member?.code && member.connected !== false).map(member => [String(member.code), App.getLiveOrStoredCallUser(member)])).values()) : App.callGetShareViewerUsers(ownerCode);
  if (!allowEmpty && !users.length) return null;
  const tooltip = document.createElement("div");
  tooltip.className = "call-viewers-tooltip";
  tooltip.id = `call-viewers-tooltip-${++App.callViewersTooltipSeq}`;
  tooltip.dataset.viewerCount = String(users.length);
  tooltip.setAttribute("role", "tooltip");
  const label = document.createElement("div");
  label.className = "call-viewers-label";
  label.textContent = inCall ? "In Call" : "Viewers";
  tooltip.appendChild(label);
  if (users.length) {
    const row = document.createElement("div");
    row.className = "call-viewers-row";
    row.setAttribute("aria-label", `${users.length} ${inCall ? "people in call" : "viewers"}`);
    for (const user of users) {
      const avatar = document.createElement("span");
      avatar.className = "call-viewer-avatar";
      avatar.setAttribute("role", "img");
      avatar.setAttribute("aria-label", String(user.displayName || user.username || user.code || "User"));
      App.applyAvatar(avatar, user);
      row.appendChild(avatar);
    }
    tooltip.appendChild(row);
  } else {
    const empty = document.createElement("div");
    empty.className = "call-viewers-empty";
    empty.textContent = inCall ? "No one in call" : "No viewers yet";
    tooltip.appendChild(empty);
  }
  return tooltip;
};
App.callBuildFocusedViewerEye = function (ownerCode) {
  const tooltip = App.callBuildViewersTooltip(ownerCode, {
    allowEmpty: false
  });
  if (!tooltip) return null;
  const viewerCount = Number(tooltip.dataset.viewerCount || 0);
  const eye = document.createElement("span");
  eye.className = "call-view-action call-viewers-eye";
  eye.dataset.ownerCode = String(ownerCode || "");
  eye.setAttribute("role", "group");
  eye.setAttribute("aria-label", `Viewers, ${viewerCount} ${viewerCount === 1 ? "person" : "people"}`);
  eye.setAttribute("aria-describedby", tooltip.id);
  eye.setAttribute("tabindex", "0");
  eye.innerHTML = App.CALL_VIEWERS_EYE_SVG;
  eye.appendChild(tooltip);
  // Presented media clips its contents; use the same viewport portal as roster
  // tooltips so the label cannot be clipped by the title or video viewport.
  App.callBuildScreenViewerHover(ownerCode, eye);
  return eye;
};
App.callClearScreenViewersFloatingHide = function () {
  if (App.callScreenViewersFloatingHideTimer) {
    try {
      clearTimeout(App.callScreenViewersFloatingHideTimer);
    } catch {}
  }
  App.callScreenViewersFloatingHideTimer = null;
};
App.callClearScreenViewersDescriptionTarget = function () {
  const target = App.callScreenViewersDescriptionTarget;
  if (target) {
    try {
      if (App.callScreenViewersPreviousDescription == null) target.removeAttribute("aria-describedby");else target.setAttribute("aria-describedby", App.callScreenViewersPreviousDescription);
    } catch {}
  }
  App.callScreenViewersDescriptionTarget = null;
  App.callScreenViewersPreviousDescription = null;
};
App.callSetScreenViewersDescriptionTarget = function (target, tooltipId) {
  App.callClearScreenViewersDescriptionTarget();
  if (!target || !tooltipId) return;
  const previous = target.getAttribute?.("aria-describedby");
  const ids = String(previous || "").split(/\s+/).filter(Boolean);
  if (!ids.includes(tooltipId)) ids.push(tooltipId);
  App.callScreenViewersDescriptionTarget = target;
  App.callScreenViewersPreviousDescription = previous;
  try {
    target.setAttribute("aria-describedby", ids.join(" "));
  } catch {}
};
App.callHideScreenViewersFloating = function ({
  remove = false,
  immediate = false
} = {}) {
  App.callClearScreenViewersFloatingHide();
  if (App.callViewersPositionFrame) cancelAnimationFrame(App.callViewersPositionFrame);
  App.callViewersPositionFrame = 0;
  App.callClearScreenViewersDescriptionTarget();
  App.callScreenViewersFloatingAnchor = null;
  App.callScreenViewersFloatingOwner = "";
  App.callScreenViewersFloatingTrigger = "";
  App.callScreenViewersFloatingFocusKey = "";
  if (!App.callScreenViewersFloating) return;
  const floating = App.callScreenViewersFloating;
  floating.classList.remove("is-visible");
  let reducedMotion = false;
  try {
    reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {}
  if (remove || immediate || reducedMotion) {
    floating.hidden = true;
  } else {
    App.callScreenViewersFloatingHideTimer = setTimeout(() => {
      App.callScreenViewersFloatingHideTimer = null;
      if (App.callScreenViewersFloating === floating && !floating.classList.contains("is-visible")) floating.hidden = true;
    }, App.CALL_VIEWERS_TOOLTIP_TRANSITION_MS);
  }
  if (remove) {
    try {
      floating.remove();
    } catch {}
    App.callScreenViewersFloating = null;
  }
};
App.callScheduleScreenViewersFloatingHide = function () {
  // Begin the exit motion immediately; only display:none waits for the motion.
  App.callHideScreenViewersFloating();
};
App.callEnsureScreenViewersFloating = function () {
  const host = document.fullscreenElement || document.body;
  if (App.callScreenViewersFloating?.isConnected) {
    if (App.callScreenViewersFloating.parentNode !== host) host.appendChild(App.callScreenViewersFloating);
    return App.callScreenViewersFloating;
  }
  const floating = document.createElement("div");
  floating.className = "call-viewers-floating";
  floating.hidden = true;
  host.appendChild(floating);
  App.callScreenViewersFloating = floating;
  return floating;
};
App.callPositionScreenViewersFloating = function () {
  const floating = App.callScreenViewersFloating;
  const anchor = App.callScreenViewersFloatingAnchor;
  if (!floating || floating.hidden || !anchor?.isConnected || anchor.hidden) {
    if (floating && !floating.hidden) App.callHideScreenViewersFloating();
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  const floatingRect = floating.getBoundingClientRect();
  const margin = 8;
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportWidth = Math.max(1, viewport?.width || Number(window.innerWidth) || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, viewport?.height || Number(window.innerHeight) || document.documentElement.clientHeight || 1);
  let left = anchorRect.left + (anchorRect.width - floatingRect.width) / 2;
  let top = App.callScreenViewersFloatingOwner === "__call__" ? anchorRect.top - floatingRect.height - 7 : anchorRect.bottom + 7;
  left = Math.max(viewportLeft + margin, Math.min(left, viewportLeft + viewportWidth - floatingRect.width - margin));
  if (top + floatingRect.height > viewportTop + viewportHeight - margin) top = anchorRect.top - floatingRect.height - 7;
  top = Math.max(viewportTop + margin, Math.min(top, viewportTop + viewportHeight - floatingRect.height - margin));
  // Rects include CSS zoom. Fixed offsets are in the portal's local CSS pixels.
  const scale = floating.offsetWidth ? floatingRect.width / floating.offsetWidth : 1;
  floating.style.left = `${Math.round(left / (scale || 1))}px`;
  floating.style.top = `${Math.round(top / (scale || 1))}px`;
};
App.callTrackScreenViewersPosition = function () {
  if (App.callViewersPositionFrame) return;
  const tick = () => {
    App.callViewersPositionFrame = 0;
    if (!App.callScreenViewersFloating || App.callScreenViewersFloating.hidden || !App.callScreenViewersFloatingAnchor) return;
    App.callPositionScreenViewersFloating();
    if (App.callScreenViewersFloatingAnchor) App.callViewersPositionFrame = requestAnimationFrame(tick);
  };
  App.callViewersPositionFrame = requestAnimationFrame(tick);
};
App.callGetScreenViewerFocusKey = function (target, tile) {
  if (!target || !tile?.contains?.(target)) return "";
  if (target === tile) return "tile";
  const keys = ["call-view-focus", "call-view-fullscreen", "call-view-close", "call-share-open", "call-share-multi"];
  return keys.find(className => target.classList?.contains?.(className)) || "";
};
App.callFindScreenViewerFocusTarget = function (tile, focusKey) {
  if (!tile || !focusKey) return null;
  if (focusKey === "tile") return tile;
  return tile.querySelector(`.${focusKey}`);
};
App.callShowScreenViewersFloating = function (tile, ownerCode, {
  trigger = "pointer",
  focusTarget = null
} = {}) {
  if (!tile?.isConnected || !App.callMenuOpen) return;
  if (ownerCode === "__call__" && (tile.hidden || !App.callFocusedControlsVisible || trigger !== "pointer")) return;
  if (App.callScreenContextMenuEl && !App.callScreenContextMenuEl.hidden) return;
  App.callClearScreenViewersFloatingHide();
  const floating = App.callEnsureScreenViewersFloating();
  floating.classList.toggle("is-in-call", ownerCode === "__call__");
  App.callScreenViewersFloatingAnchor = tile;
  App.callScreenViewersFloatingOwner = String(ownerCode || "");
  App.callScreenViewersFloatingTrigger = trigger === "focus" ? "focus" : "pointer";
  App.callScreenViewersFloatingFocusKey = App.callScreenViewersFloatingTrigger === "focus" ? App.callGetScreenViewerFocusKey(focusTarget || document.activeElement, tile) : "";
  const tooltip = App.callBuildViewersTooltip(ownerCode, {
    allowEmpty: true
  });
  floating.replaceChildren(tooltip);
  const wasHidden = floating.hidden;
  if (wasHidden) floating.classList.remove("is-visible");
  floating.hidden = false;
  const active = focusTarget || document.activeElement;
  const descriptionTarget = App.callScreenViewersFloatingTrigger === "focus" && active && tile.contains(active) ? active : tile;
  App.callSetScreenViewersDescriptionTarget(descriptionTarget, tooltip.id);
  App.callPositionScreenViewersFloating();
  // A layout boundary is required when reviving display:none so the starting
  // opacity/translation is painted before the visible state is applied.
  if (wasHidden) void floating.offsetWidth;
  floating.classList.add("is-visible");
  App.callTrackScreenViewersPosition();
};
App.callRefreshScreenViewerDisplays = function () {
  App.callPublishDesktopOverlay?.();
  document.querySelectorAll(".call-view-tile.is-presented[data-share-code]").forEach(tile => {
    const ownerCode = String(tile.getAttribute("data-share-code") || "");
    const titleBlock = tile.querySelector(".call-view-title-block");
    if (!ownerCode || !titleBlock) return;
    const existingEye = titleBlock.querySelector(".call-viewers-eye");
    const nextEye = App.callBuildFocusedViewerEye(ownerCode);
    if (!nextEye) {
      if (existingEye) {
        const restoreTarget = tile.querySelector(".call-view-focus, .call-view-fullscreen, .call-view-close");
        const hadFocus = existingEye === document.activeElement || existingEye.contains(document.activeElement);
        existingEye.remove();
        if (hadFocus) {
          try {
            restoreTarget?.focus({
              preventScroll: true
            });
          } catch {}
        }
      }
      return;
    }
    if (!existingEye) {
      titleBlock.querySelector(".call-view-readouts")?.appendChild(nextEye);
      return;
    }
    const nextTooltip = nextEye.querySelector(".call-viewers-tooltip");
    const oldTooltip = existingEye.querySelector(".call-viewers-tooltip");
    if (oldTooltip && nextTooltip) oldTooltip.replaceWith(nextTooltip);else if (nextTooltip) existingEye.appendChild(nextTooltip);
    existingEye.setAttribute("aria-label", nextEye.getAttribute("aria-label") || "Viewers");
    existingEye.setAttribute("aria-describedby", nextTooltip?.id || "");
  });
  if (App.callScreenViewersFloating && !App.callScreenViewersFloating.hidden && App.callScreenViewersFloatingOwner) {
    const tooltip = App.callBuildViewersTooltip(App.callScreenViewersFloatingOwner, {
      allowEmpty: true
    });
    App.callScreenViewersFloating.replaceChildren(tooltip);
    const target = App.callScreenViewersDescriptionTarget || App.callScreenViewersFloatingAnchor;
    App.callSetScreenViewersDescriptionTarget(target, tooltip.id);
    App.callPositionScreenViewersFloating();
  }
};
App.callScrollScreenViewersRow = function (ownerCode, event) {
  if (App.callScreenViewersFloatingOwner !== String(ownerCode || "")) return;
  const row = App.callScreenViewersFloating?.querySelector?.(".call-viewers-row");
  if (!row || row.scrollWidth <= row.clientWidth) return;
  const delta = Math.abs(Number(event.deltaX || 0)) > Math.abs(Number(event.deltaY || 0)) ? Number(event.deltaX || 0) : Number(event.deltaY || 0);
  const current = Number(row.scrollLeft || 0);
  const next = Math.max(0, Math.min(current + delta, row.scrollWidth - row.clientWidth));
  if (next === current) return;
  row.scrollLeft = next;
  event.preventDefault();
};
App.callBuildScreenViewerHover = function (ownerCode, tile) {
  if (!tile) return;
  const showPointer = () => {
    const active = document.activeElement;
    if (active && tile.contains(active)) {
      App.callShowScreenViewersFloating(tile, ownerCode, {
        trigger: "focus",
        focusTarget: active
      });
    } else {
      App.callShowScreenViewersFloating(tile, ownerCode, {
        trigger: "pointer"
      });
    }
  };
  const showFocus = event => App.callShowScreenViewersFloating(tile, ownerCode, {
    trigger: "focus",
    focusTarget: event.target
  });
  const hide = event => {
    if (App.callScreenViewersFloating?.contains?.(event?.relatedTarget)) return;
    if (tile.contains(document.activeElement)) {
      App.callClearScreenViewersFloatingHide();
      return;
    }
    App.callScheduleScreenViewersFloatingHide();
  };
  tile.addEventListener("mouseenter", showPointer);
  tile.addEventListener("mouseleave", hide);
  tile.addEventListener("focusin", showFocus);
  tile.addEventListener("focusout", hide);
  tile.addEventListener("wheel", event => App.callScrollScreenViewersRow(ownerCode, event), {
    passive: false
  });
};
App.callBindInCallHover = function (target) {
  if (!target) return;
  // This informational target has no focus, activation, or persistent state.
  target.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch" || target.hidden) return;
    App.callShowScreenViewersFloating(target, "__call__");
  });
  target.addEventListener("pointerleave", () => {
    if (App.callScreenViewersFloatingOwner === "__call__") App.callScheduleScreenViewersFloatingHide();
  });
  target.addEventListener("pointerdown", event => event.preventDefault());
  target.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
  });
  target.addEventListener("wheel", event => App.callScrollScreenViewersRow("__call__", event), { passive: false });
};
App.callPatchSpeakingIndicators = function () {
  App.callPublishDesktopOverlay?.();
  if (!App.callMenuOpen) return;
  const speaking = new Map(App.callMembersCache.map(member => [String(member.code), !!member.speaking && !member.muted && !member.deafened]));
  document.querySelectorAll('#call-menu-list .call-user-avatar[data-usercode]').forEach(avatar => {
    avatar.classList.toggle('speaking', speaking.get(avatar.dataset.usercode) === true);
  });
};
// Keep one visibility state for the call bars and the focused screen overlay.
// Presence updates rebuild the tiles without changing the user's last toggle.
App.callSyncFocusedControls = function (focusedCode) {
  const code = String(focusedCode || "");
  if (App.callFocusedControlsCode !== code) {
    App.callHideScreenViewersFloating({ immediate: true });
    App.callFocusedControlsCode = code;
    App.callFocusedControlsVisible = !!code;
  }
  const visible = !!code && App.callFocusedControlsVisible;
  if (code && !visible && App.callScreenViewersFloatingOwner !== "__call__") App.callHideScreenViewersFloating({ immediate: true });
  App.$("call-menu")?.classList.toggle("is-focus-controls-visible", visible);
  const roster = App.$("call-in-call");
  if (roster) roster.hidden = !visible || !App.currentCallRoomId;
  if ((!visible || !App.currentCallRoomId) && App.callScreenViewersFloatingOwner === "__call__") App.callHideScreenViewersFloating({ immediate: true });
  const body = App.$("call-menu-list")?.querySelector(".call-view-tile.is-focused .call-view-body");
  body?.setAttribute("aria-pressed", String(visible));
};
App.callToggleFocusedControls = function (userCode) {
  if (App.callFullscreenCode) return;
  const code = String(userCode || "");
  if (!code || code !== App.callFocusedShareCode && !(code === "__multi__" && App.callMultiViewEnabled)) return;
  App.callSyncFocusedControls(code);
  App.callFocusedControlsVisible = !App.callFocusedControlsVisible;
  App.callSyncFocusedControls(code);
};
let callMenuRendering = false;
let callMenuRenderQueued = false;
let callMenuRenderFrame = 0;
let callMenuRenderVersion = 0;
App.renderCallMenu = function () {
  // Firebase may deliver a cached presence update synchronously while a render
  // publishes viewership. A nested render must not append another whole stage.
  if (callMenuRendering) {
    callMenuRenderQueued = true;
    return;
  }
  callMenuRendering = true;
  callMenuRenderVersion += 1;
  try {
    renderCallMenuNow();
  } finally {
    callMenuRendering = false;
    if (callMenuRenderQueued && !callMenuRenderFrame) {
      callMenuRenderQueued = false;
      callMenuRenderFrame = requestAnimationFrame(() => {
        callMenuRenderFrame = 0;
        App.renderCallMenu();
      });
    }
  }
};
function renderCallMenuNow() {
  const renderVersion = callMenuRenderVersion;
  let floatingWasHovered = false;
  try {
    floatingWasHovered = !!App.callScreenViewersFloating?.matches?.(":hover");
  } catch {}
  const floatingViewerRestore = !App.callScreenViewersFloating?.hidden && App.callScreenViewersFloatingOwner ? {
    ownerCode: String(App.callScreenViewersFloatingOwner),
    trigger: String(App.callScreenViewersFloatingTrigger || "pointer"),
    focusKey: String(App.callScreenViewersFloatingFocusKey || ""),
    floatingWasHovered
  } : null;
  const list = App.$("call-menu-list");
  if (!list) return;
  const focusedViewerOwner = String(document.activeElement?.closest?.(".call-viewers-eye[data-owner-code]")?.dataset?.ownerCode || "");
  const restoreScreenKeyboardFocus = document.activeElement?.matches?.(".call-view-tile.is-focused .call-view-body");
  const preservedShareVideos = new Map();
  list.querySelectorAll(".call-view-tile[data-share-code] .call-view-video").forEach(video => {
    const code = String(video.closest(".call-view-tile")?.getAttribute("data-share-code") || "");
    if (code) preservedShareVideos.set(code, video);
  });
  App.callSyncMenuStatusDisplay();
  if (!App.callMembersCache.length) {
    App.callHideScreenViewersFloating();
    App.callDisposeScreenTransforms(list);
    list.classList.remove("has-shares", "has-watched-shares", "many-participants", "is-crowded", "is-focused", "is-multiview");
    list.removeAttribute("data-participants");
    list.removeAttribute("data-shares");
    list.removeAttribute("data-tiles");
    App.callSyncMultiViewButton();
    App.callSyncFocusedControls("");
    const empty = document.createElement("div");
    empty.className = "call-menu-empty";
    empty.textContent = App.currentCallRoomId ? "Connecting you to the call..." : "The call has ended.";
    list.replaceChildren(empty);
    App.syncCallControlsUI();
    return;
  }
  const selfCode = String(App.currentUser?.code || "");
  const membersByCode = new Map();
  for (const member of App.callMembersCache) {
    const code = String(member?.code || "").trim();
    const recovering = member?.connected === false && globalThis.ChatCallPolicy.keepMember(member, App.callPeerMap.get(code), Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0), App.CALL_STALE_MEMBER_MS, App.CALL_HEARTBEAT_STALE_MS);
    if (code && (member?.connected !== false || recovering)) membersByCode.set(code, { ...member, code });
  }
  // Invitations are display-only tiles. Never add them to callMembersCache,
  // which drives WebRTC connections, audio and the actual participant count.
  for (const member of App.callGetRingingMembers?.(App.currentCallRoomId || App.observedCallRoomId) || []) {
    if (!membersByCode.has(member.code)) membersByCode.set(member.code, member);
  }
  const members = Array.from(membersByCode.values()).map(member => {
    const raw = String(member?.code || "") === selfCode ? {
      ...member,
      speaking: !!App.callVadSpeaking && !App.callMuted && !App.callDeafened,
      sharing: !!App.callSharing,
      cameraSharing: !!App.callCameraSharing,
      cameraShareId: App.callCameraShareId || "",
      shareId: String(App.callScreenShareId || "")
    } : member;
    return {
      raw,
      user: App.getLiveOrStoredCallUser(raw)
    };
  });
  const sharingMembers = App.currentCallRoomId ? members.flatMap(member => [
    ...(member.raw.sharing ? [{ ...member, shareCode: String(member.raw.code), camera: false }] : []),
    ...(member.raw.cameraSharing ? [{ ...member, shareCode: App.callCameraKey(member.raw.code), camera: true }] : [])
  ]) : [];
  const sharingCodes = new Set(sharingMembers.map(member => member.shareCode));
  const hasShares = sharingMembers.length > 0;
  App.callPruneWatchedShares(sharingCodes);
  App.callSyncMultiViewButton();
  const multiView = App.callMultiViewEnabled;
  const watchedCodes = Array.from(App.callWatchedShareCodes).filter(code => sharingCodes.has(code));
  const watchedCodeSet = new Set(watchedCodes);
  let focusedCode = !multiView && App.callFocusedShareCode && watchedCodeSet.has(App.callFocusedShareCode) ? String(App.callFocusedShareCode) : "";
  if (App.callFullscreenCode && !watchedCodeSet.has(App.callFullscreenCode)) {
    if (document.fullscreenElement === App.$("call-menu")) void document.exitFullscreen?.().catch(() => {});
    App.callExitScreenFullscreen();
  }
  if (focusedCode && !sharingCodes.has(focusedCode)) {
    App.callFocusedShareCode = null;
    focusedCode = "";
  }
  list.dataset.participants = String(members.length);
  list.dataset.shares = String(sharingMembers.length);
  list.classList.toggle("has-shares", hasShares);
  list.classList.toggle("has-watched-shares", watchedCodes.length > 0);
  list.classList.toggle("many-participants", members.length > 6);
  list.classList.toggle("is-crowded", sharingMembers.length + members.length > 6);
  list.classList.toggle("is-focused", !!focusedCode);
  list.classList.toggle("is-multiview", App.callMultiViewEnabled && watchedCodes.length > 1);
  const screenEntries = multiView ? sharingMembers.filter(member => watchedCodeSet.has(member.shareCode) && member.raw.code !== selfCode).sort((a, b) => {
    const name = member => String(member.user?.displayName || member.user?.username || member.raw.code);
    return name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) || String(a.raw.code).localeCompare(String(b.raw.code)) || Number(a.camera) - Number(b.camera);
  }) : focusedCode ? sharingMembers.filter(member => member.shareCode === focusedCode) : sharingMembers;
  // Heartbeats, speaking and viewer updates must not detach playing media or
  // interrupt a drag. Rebuild only when the presented sources or labels change.
  const presentationKey = focusedCode || multiView ? JSON.stringify([multiView ? "multi" : focusedCode,
    screenEntries.map(member => [member.shareCode, App.callGetShareId(member.shareCode), member.user?.displayName, member.user?.username])]) : "";
  if (presentationKey && list.firstElementChild?.dataset.presentationKey === presentationKey) {
    App.callSyncFocusedControls(multiView ? "__multi__" : focusedCode);
    App.callRefreshScreenViewerDisplays();
    App.syncShareViewStream();
    App.syncCallControlsUI();
    return;
  }
  App.callHideScreenViewersFloating();
  App.callDisposeScreenTransforms(list);
  const stage = document.createElement("div");
  if (presentationKey) stage.dataset.presentationKey = presentationKey;
  stage.className = `call-stage call-roster-grid ${hasShares ? "call-stage-shares" : "call-stage-avatars"}${focusedCode ? " call-stage-focused" : ""}`;
  if (multiView) stage.classList.add("call-stage-multi");
  stage.setAttribute("aria-label", focusedCode ? "Focused shared screen" : "Call participants and shared screens");
  const makeViewAction = (className, label, svg, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `call-view-action ${className}`;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.innerHTML = svg;
    button.addEventListener("click", event => {
      event.stopPropagation();
      handler();
    });
    return button;
  };
  const buildWatchedScreenTile = ({
    raw,
    user,
    shareCode,
    camera
  }) => {
    const code = shareCode;
    const ownerCode = String(raw?.code || "");
    const sourceName = camera ? "Camera" : "Screen";
    const displayName = String(user?.displayName || user?.username || "User");
    const isFocused = focusedCode === code;
    const tile = document.createElement("section");
    tile.className = `call-stage-tile call-screen-tile call-view-tile${isFocused ? " is-focused" : ""}`;
    tile.classList.toggle("is-presented", isFocused || multiView);
    tile.dataset.shareCode = code;
    tile.dataset.shareKind = camera ? "camera" : "screen";
    tile.setAttribute("aria-label", `${displayName}'s ${sourceName.toLowerCase()} share`);
    const tileHead = document.createElement("div");
    tileHead.className = "call-view-head";
    const tileTitleBlock = document.createElement("div");
    tileTitleBlock.className = "call-view-title-block";
    const tileTitle = document.createElement("div");
    tileTitle.className = "call-view-title";
    const titleText = document.createElement("span");
    titleText.textContent = ownerCode === selfCode ? `Your ${sourceName}` : `${displayName}'s ${sourceName}`;
    tileTitle.appendChild(titleText);
    tileTitleBlock.appendChild(tileTitle);
    if (isFocused || multiView) {
      const readouts = document.createElement("div");
      readouts.className = "call-view-readouts";
      const zoom = document.createElement("button");
      zoom.type = "button";
      zoom.className = "call-screen-zoom";
      zoom.textContent = "100%";
      zoom.addEventListener("click", event => { event.stopPropagation(); App.callResetScreenZoom(code); });
      readouts.appendChild(zoom);
      const viewerEye = App.callBuildFocusedViewerEye(code);
      if (viewerEye) readouts.appendChild(viewerEye);
      tileTitleBlock.appendChild(readouts);
    }
    const tileActions = document.createElement("div");
    tileActions.className = "call-view-actions";
    tileActions.appendChild(makeViewAction("call-view-focus", isFocused ? `Unfocus ${sourceName}` : `Focus ${sourceName}`, isFocused ? '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' : '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>', () => App.callToggleShareFocus(code)));
    tileActions.appendChild(makeViewAction("call-view-fullscreen", "Full Screen", '<svg viewBox="0 0 24 24" fill="none"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>', () => void App.callFullscreenShare(code)));
    tileActions.appendChild(makeViewAction("call-view-close", `Close ${sourceName}`, '<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>', () => App.callCloseWatchedShare(code)));
    tileHead.appendChild(tileTitleBlock);
    if (!multiView) tileHead.appendChild(tileActions);
    const tileBody = document.createElement("div");
    tileBody.className = "call-view-body";
    const placeholder = document.createElement("div");
    placeholder.className = "call-view-placeholder";
    placeholder.innerHTML = '<span class="call-view-spinner" aria-hidden="true"></span><span>Connecting to ' + sourceName.toLowerCase() + '...</span>';
    const video = preservedShareVideos.get(code) || document.createElement("video");
    preservedShareVideos.delete(code);
    placeholder.hidden = !!video.srcObject;
    video.className = "call-view-video";
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.controls = false;
    video.removeAttribute("controls");
    video.disablePictureInPicture = true;
    if (!isFocused && !multiView) video.style.transform = "";
    video.hidden = !video.srcObject;
    tileBody.append(placeholder, video);
    if (isFocused || multiView) {
      tileBody.tabIndex = 0;
      tileBody.setAttribute("role", "button");
      tileBody.setAttribute("aria-label", `Toggle ${sourceName.toLowerCase()} and call controls`);
      tileBody.addEventListener("click", event => {
        if (App.callConsumeScreenGesture(tile, event)) return;
        App.callToggleFocusedControls(multiView ? "__multi__" : code);
      });
      tileBody.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (App.callFullscreenCode) return;
        App.callToggleFocusedControls(multiView ? "__multi__" : code);
      });
    }
    tile.append(tileHead, tileBody);
    App.callBindScreenZoom(tile, code);
    App.callSyncScreenPauseTile?.(tile, code);
    if (!isFocused && !multiView) App.callBuildScreenViewerHover(code, tile);
    return tile;
  };
  const buildScreenOfferTile = ({
    raw,
    user,
    shareCode,
    camera
  }) => {
    const code = shareCode;
    const ownerCode = String(raw?.code || "");
    const sourceName = camera ? "Camera" : "Screen";
    const displayName = String(user?.displayName || user?.username || "User");
    const offer = document.createElement("article");
    offer.className = "call-stage-tile call-screen-tile call-share-offer";
    offer.dataset.shareCode = code;
    offer.dataset.shareKind = camera ? "camera" : "screen";
    offer.setAttribute("aria-label", `${displayName}'s ${sourceName.toLowerCase()} is available to watch`);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "call-share-open";
    open.setAttribute("aria-label", ownerCode === selfCode ? `Watch your ${sourceName.toLowerCase()}` : `Watch ${displayName}'s ${sourceName.toLowerCase()}`);
    open.addEventListener("click", () => App.openShareView(code, displayName));
    const poster = document.createElement("div");
    poster.className = "call-share-poster";
    const preview = App.callGetSharePreview(code);
    if (preview) {
      const image = document.createElement("img");
      image.className = "call-share-preview";
      image.alt = "";
      image.src = preview;
      poster.appendChild(image);
    }
    const posterAvatar = document.createElement("span");
    posterAvatar.className = "call-share-avatar";
    App.applyAvatar(posterAvatar, user);
    const posterArt = document.createElement("span");
    posterArt.className = "call-share-art";
    posterArt.setAttribute("aria-hidden", "true");
    posterArt.innerHTML = camera ? App.CALL_CAMERA_SVG : '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 21h6M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const overlay = document.createElement("div");
    overlay.className = "call-share-overlay";
    const offerName = document.createElement("div");
    offerName.className = "call-share-name";
    offerName.textContent = ownerCode === selfCode ? `Your ${sourceName}` : `${displayName}'s ${sourceName}`;
    overlay.append(posterAvatar, offerName);
    open.append(poster, overlay, posterArt);
    offer.appendChild(open);
    App.callSyncScreenPauseTile?.(offer, code);

    App.callBuildScreenViewerHover(code, offer);
    return offer;
  };
  const buildParticipantTile = ({
    raw,
    user
  }) => {
    const code = String(raw?.code || "");
    const displayName = String(user?.displayName || user?.username || "User");
    const peerStatus = App.callPeerStatusCache.get(code);
    const reconnecting = !raw?.ringing && (!raw?.connected || code !== selfCode && peerStatus && (["connecting", "disconnected", "failed"].includes(String(peerStatus.connectionState || "")) || ["checking", "disconnected", "failed"].includes(String(peerStatus.iceConnectionState || ""))));
    const participant = document.createElement("div");
    participant.className = "call-stage-tile call-participant";
    participant.classList.toggle("is-ringing", !!raw?.ringing);
    participant.dataset.usercode = code;
    participant.setAttribute("role", "img");
    participant.setAttribute("aria-label", `${displayName}${raw?.ringing ? ", ringing" : reconnecting ? ", reconnecting" : ""}`);
    participant.dataset.tooltip = displayName;
    const avatarShell = document.createElement("div");
    avatarShell.className = "call-participant-avatar-shell";
    const avatar = document.createElement("div");
    avatar.className = "call-user-avatar";
    avatar.dataset.usercode = code;
    avatar.classList.toggle("speaking", !!raw?.speaking && !raw?.muted && !raw?.deafened);
    App.applyAvatar(avatar, user);
    avatarShell.appendChild(avatar);
    const states = document.createElement("div");
    states.className = "call-participant-states";
    const addState = (kind, label, svg) => {
      const state = document.createElement("span");
      state.className = `call-participant-state ${kind}`;
      state.setAttribute("aria-label", label);
      state.dataset.tooltip = label;
      state.innerHTML = svg;
      states.appendChild(state);
    };
    if (raw?.ringing) addState("ringing", "Ringing…", App.CALL_RING_BELL || "");
    if (raw?.muted) {
      addState("muted", "Muted", '<svg viewBox="0 0 24 24" fill="none"><path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 11 5.7M12 18v3M8.5 21h7M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>');
    }
    if (raw?.deafened) {
      addState("deafened", "Deafened", '<svg viewBox="0 0 24 24" fill="none"><path d="M4 13v-1a8 8 0 0 1 13.5-5.8M4 13v5h4v-7H6.5A2.5 2.5 0 0 0 4 13.5ZM20 13.5A2.5 2.5 0 0 0 17.5 11H16v7h2.2M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    }
    if (raw?.cameraSharing) addState("camera", "Sharing camera", App.CALL_CAMERA_SVG);
    if (raw?.sharing) {
      addState("sharing", "Sharing screen", '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="13" rx="3" stroke="currentColor" stroke-width="2"/><path d="M9 21h6M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>');
    }
    if (reconnecting) {
      addState("reconnecting", "Reconnecting", '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12a7 7 0 0 1 12-4.9L19 9M19 5v4h-4M19 12a7 7 0 0 1-12 4.9L5 15M5 19v-4h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    }
    if (states.childElementCount) avatarShell.appendChild(states);
    const participantName = document.createElement("div");
    participantName.className = "call-participant-name";
    participantName.textContent = displayName;
    participant.append(avatarShell, participantName);
    if (raw?.ringing) {
      const ringLabel = document.createElement("span");
      ringLabel.className = "call-ringing-label";
      ringLabel.textContent = "Ringing…";
      participant.appendChild(ringLabel);
    }
    return participant;
  };
  for (const member of screenEntries) {
    const code = member.shareCode;
    stage.appendChild(watchedCodeSet.has(code) ? buildWatchedScreenTile(member) : buildScreenOfferTile(member));
  }
  if (!focusedCode && !multiView) {
    for (const member of members) stage.appendChild(buildParticipantTile(member));
  }
  stage.dataset.items = String(stage.childElementCount);
  stage.dataset.screens = String(screenEntries.length);
  list.dataset.tiles = String(stage.childElementCount);
  list.replaceChildren(stage);
  App.callSyncFocusedControls(multiView ? "__multi__" : focusedCode);
  for (const video of preservedShareVideos.values()) {
    try {
      video.pause();
    } catch {}
    try {
      video.srcObject = null;
    } catch {}
  }
  requestAnimationFrame(() => {
    if (renderVersion !== callMenuRenderVersion || !stage.isConnected) return;
    list.scrollTop = 0;
    App.syncShareViewStream();
    if (restoreScreenKeyboardFocus) {
      list.querySelector(".call-view-tile.is-focused .call-view-body")?.focus({ preventScroll: true });
    }
    if (focusedViewerOwner) {
      const ownerTile = Array.from(list.querySelectorAll(".call-screen-tile[data-share-code]")).find(tile => String(tile.dataset.shareCode || "") === focusedViewerOwner);
      const replacementEye = ownerTile?.querySelector(".call-viewers-eye[data-owner-code]");
      const fallbackControl = ownerTile?.querySelector(".call-view-focus, .call-view-fullscreen, .call-view-close, .call-share-open");
      try {
        (replacementEye || fallbackControl)?.focus({
          preventScroll: true
        });
      } catch {}
    }
    if (floatingViewerRestore?.ownerCode) {
      if (floatingViewerRestore.ownerCode === "__call__") {
        const anchor = App.$("call-in-call");
        if (anchor && !anchor.hidden && anchor.matches(":hover")) {
          App.callShowScreenViewersFloating(anchor, "__call__");
        }
        return;
      }
      const replacementTile = Array.from(list.querySelectorAll(".call-screen-tile[data-share-code]:not(.is-focused)")).find(tile => String(tile.dataset.shareCode || "") === floatingViewerRestore.ownerCode);
      if (replacementTile && floatingViewerRestore.trigger === "focus") {
        const focusTarget = App.callFindScreenViewerFocusTarget(replacementTile, floatingViewerRestore.focusKey);
        if (focusTarget) {
          try {
            focusTarget.focus({
              preventScroll: true
            });
          } catch {}
          App.callShowScreenViewersFloating(replacementTile, floatingViewerRestore.ownerCode, {
            trigger: "focus",
            focusTarget
          });
        }
      } else if (replacementTile && floatingViewerRestore.trigger === "pointer") {
        let stillHovered = false;
        try {
          stillHovered = replacementTile.matches(":hover");
        } catch {}
        if (stillHovered || floatingViewerRestore.floatingWasHovered) {
          App.callShowScreenViewersFloating(replacementTile, floatingViewerRestore.ownerCode, {
            trigger: "pointer"
          });
          if (!stillHovered && floatingViewerRestore.floatingWasHovered) {
            requestAnimationFrame(() => {
              let pointerStillInside = false;
              try {
                pointerStillInside = !!App.callScreenViewersFloating?.matches?.(":hover") || replacementTile.matches(":hover");
              } catch {}
              if (!pointerStillInside && App.callScreenViewersFloatingTrigger === "pointer") App.callHideScreenViewersFloating();
            });
          }
        }
      }
    }
  });
  App.syncCallControlsUI();
  if (App.callScreenContextMenuCtx && !sharingCodes.has(App.callScreenContextMenuCtx.peerCode)) {
    App.closeCallScreenContextMenu(true);
  }
};
App.syncCallUserContextMenu = function () {
  const menu = App.callUserContextMenuEl;
  const code = App.callUserContextMenuCtx?.peerCode;
  if (!menu || !code) return;
  const muted = App.callIsUserMuted(code);
  const value = muted ? 0 : App.callGetUserVolumePercent(code);
  const slider = menu.querySelector("[data-call-volume-slider]");
  slider.value = String(value);
  slider.setAttribute("aria-valuetext", `${value}%`);
  App.syncPreciseRangeVisual(slider);
  menu.querySelector("[data-call-volume-value]").textContent = `${value}%`;
  const mute = menu.querySelector("[data-call-user-mute]");
  mute.setAttribute("aria-pressed", String(muted));
  mute.querySelector(".msg-menu-label").textContent = muted ? "Unmute" : "Mute";
};
App.ensureCallUserContextMenu = function () {
  if (App.callUserContextMenuEl) return App.callUserContextMenuEl;
  const menu = document.createElement("div");
  menu.id = "call-user-context-menu";
  menu.className = "msg-menu call-user-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Call user audio settings");
  menu.innerHTML = `
    <div class="msg-menu-user" data-call-volume-username></div>
    <button class="msg-menu-btn" type="button" data-call-user-mute aria-pressed="false">
      <span class="msg-menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M11 5 6 9H3v6h3l5 4V5Zm5 4 5 6m0-6-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="msg-menu-label">Mute</span>
    </button>
    <div class="call-user-volume-control">
      <div class="call-user-volume-label">
        <span>User Volume</span>
        <output data-call-volume-value>100%</output>
      </div>
      <input
        class="call-user-volume-slider"
        data-call-volume-slider
        type="range"
        min="0"
        max="400"
        step="1"
        value="100"
        aria-label="User Volume"
      />
      <div class="call-user-volume-scale" aria-hidden="true"><span>0%</span><span>400%</span></div>
    </div>
  `;
  document.body.appendChild(menu);
  App.callUserContextMenuEl = menu;
  menu.querySelector("[data-call-user-mute]").addEventListener("click", event => {
    const code = App.callUserContextMenuCtx?.peerCode;
    if (!code) return;
    App.callSetUserMuted(code, !App.callIsUserMuted(code), { fromGesture: !!event.isTrusted });
    App.syncCallUserContextMenu();
  });
  const slider = menu.querySelector("[data-call-volume-slider]");
  const valueEl = menu.querySelector("[data-call-volume-value]");
  slider?.addEventListener("input", event => {
    const peer = String(App.callUserContextMenuCtx?.peerCode || "");
    if (!peer) return;
    const value = App.callSetUserVolumePercent(peer, event.currentTarget.value, {
      smooth: true,
      fromGesture: !!event.isTrusted
    });
    event.currentTarget.setAttribute("aria-valuetext", `${value}%`);
    if (valueEl) {
      valueEl.textContent = `${value}%`;
    }
    App.syncCallUserContextMenu();
  });
  document.addEventListener("pointerdown", event => {
    if (!App.callUserContextMenuEl || App.callUserContextMenuEl.hidden) return;
    if (App.callUserContextMenuEl.contains(event.target)) return;
    App.closeCallUserContextMenu();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") App.closeCallUserContextMenu(true);
  }, true);
  window.addEventListener("resize", () => App.closeCallUserContextMenu(true));
  window.addEventListener("blur", () => App.closeCallUserContextMenu(true));
  document.addEventListener("scroll", event => {
    if (!App.callUserContextMenuEl || App.callUserContextMenuEl.hidden) return;
    if (App.callUserContextMenuEl.contains(event.target)) return;
    App.closeCallUserContextMenu(true);
  }, true);
  App.initPreciseRangeSliders(menu);
  return menu;
};
App.positionCallAudioContextMenu = function (menu, x, y, anchor = null) {
  if (!menu || menu.hidden) return;
  App.positionContextMenu(menu, { x, y, anchor, avoidAnchor: !!anchor });
};
App.positionCallUserContextMenu = function (x, y, anchor = null) {
  App.positionCallAudioContextMenu(App.callUserContextMenuEl, x, y, anchor);
};
App.openCallUserContextMenu = function (peerCode, x, y, anchor = null) {
  const peer = String(peerCode || "");
  const selfCode = String(App.currentUser?.code || "");
  if (!peer || peer === selfCode) return;
  const rawMember = App.callMembersCache.find(member => String(member?.code || "") === peer) || null;
  const user = App.getLiveOrStoredCallUser(rawMember || App.liveUserCache.get(peer) || {
    code: peer,
    username: "User"
  });
  const username = String(user?.username || rawMember?.username || "User");
  const menu = App.ensureCallUserContextMenu();
  (document.fullscreenElement === App.$("call-menu") ? document.fullscreenElement : document.body).appendChild(menu);
  const slider = menu.querySelector("[data-call-volume-slider]");
  const valueEl = menu.querySelector("[data-call-volume-value]");
  const usernameEl = menu.querySelector("[data-call-volume-username]");
  const value = App.callGetUserVolumePercent(peer);
  App.closeCallScreenContextMenu(true);
  App.closeMsgMenu(true);
  App.closeMsgTextMenu(true);
  App.closeEmojiCtxMenu(true);
  App.closeHtmlHubContextMenu(true);
  clearTimeout(App.callUserContextMenuCloseTimer);
  App.callUserContextMenuCloseSeq += 1;
  App.callUserContextMenuCtx = {
    peerCode: peer
  };
  if (usernameEl) usernameEl.textContent = username;
  if (slider) {
    slider.value = String(value);
    slider.setAttribute("aria-valuetext", `${value}%`);
    App.syncPreciseRangeVisual(slider);
  }
  if (valueEl) {
    valueEl.textContent = `${value}%`;
  }
  App.syncCallUserContextMenu();
  menu.hidden = false;
  menu.classList.remove("closing");
  menu.classList.add("open");
  App.callSyncRingMenu?.();
  App.positionCallUserContextMenu(x, y, anchor);
  requestAnimationFrame(() => {
    try {
      slider?.focus({
        preventScroll: true
      });
    } catch {}
  });
};
App.closeCallUserContextMenu = function (immediate = false) {
  const menu = App.callUserContextMenuEl;
  if (!menu || menu.hidden) return;
  clearTimeout(App.callUserContextMenuCloseTimer);
  const closeSeq = ++App.callUserContextMenuCloseSeq;
  const finish = () => {
    if (closeSeq !== App.callUserContextMenuCloseSeq) return;
    clearTimeout(App.callUserContextMenuCloseTimer);
    menu.hidden = true;
    menu.classList.remove("open", "closing");
    App.callUserContextMenuCtx = null;
  };
  if (immediate) {
    finish();
    return;
  }
  menu.classList.remove("open");
  menu.classList.add("closing");
  menu.addEventListener("animationend", finish, {
    once: true
  });
  App.callUserContextMenuCloseTimer = setTimeout(finish, 180);
};

App.syncCallScreenContextMenu = function () {
  const menu = App.callScreenContextMenuEl;
  const code = App.callScreenContextMenuCtx?.peerCode;
  if (!menu || !code) return;
  const own = App.callShareOwner(code) === String(App.currentUser?.code || "");
  const pause = menu.querySelector("[data-screen-pause]");
  pause.hidden = !own || App.callShareIsCamera(code);
  menu.querySelector("[data-screen-mute]").hidden = own;
  menu.querySelector(".call-user-volume-control").hidden = own;
  const paused = App.callGetScreenPauseState(code).paused;
  pause.setAttribute("aria-pressed", String(paused));
  pause.querySelector(".msg-menu-label").textContent = paused ? "Resume" : "Pause";
  pause.querySelector(".msg-menu-icon").innerHTML = paused ? App.CALL_RESUME_SVG : App.CALL_PAUSE_SVG;
  const value = App.callGetEffectiveScreenVolume(code);
  const muted = App.callIsScreenMuted(code);
  const slider = menu.querySelector("[data-screen-volume-slider]");
  slider.value = String(value);
  slider.setAttribute("aria-valuetext", `${value}%`);
  App.syncPreciseRangeVisual(slider);
  menu.querySelector("[data-screen-volume-value]").textContent = `${value}%`;
  const mute = menu.querySelector("[data-screen-mute]");
  mute.setAttribute("aria-pressed", String(muted));
  mute.querySelector(".msg-menu-label").textContent = muted ? "Unmute" : "Mute";
};
App.ensureCallScreenContextMenu = function () {
  if (App.callScreenContextMenuEl) return App.callScreenContextMenuEl;
  const menu = document.createElement("div");
  menu.id = "call-screen-context-menu";
  menu.className = "msg-menu call-user-context-menu call-screen-context-menu";
  menu.hidden = true;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Screen audio settings");
  menu.innerHTML = `
    <div class="msg-menu-user" data-screen-volume-username></div>
    <button class="msg-menu-btn" type="button" data-screen-pause aria-pressed="false" hidden>
      <span class="msg-menu-icon" aria-hidden="true"></span><span class="msg-menu-label">Pause</span>
    </button>
    <button class="msg-menu-btn" type="button" data-screen-mute aria-pressed="false">
      <span class="msg-menu-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M11 5 6 9H3v6h3l5 4V5Zm5 4 5 6m0-6-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <span class="msg-menu-label">Mute</span>
    </button>
    <div class="call-user-volume-control">
      <div class="call-user-volume-label"><span>Screen Volume</span><output data-screen-volume-value>100%</output></div>
      <input class="call-user-volume-slider" data-screen-volume-slider type="range" min="0" max="400" step="1" value="100" aria-label="Screen Volume" />
      <div class="call-user-volume-scale" aria-hidden="true"><span>0%</span><span>400%</span></div>
    </div>
  `;
  document.body.appendChild(menu);
  App.callScreenContextMenuEl = menu;
  menu.querySelector("[data-screen-pause]").addEventListener("click", () => {
    if (App.callScreenContextMenuCtx?.peerCode !== String(App.currentUser?.code || "")) return;
    void App.callSetScreenPaused(!App.callScreenPaused);
    App.syncCallScreenContextMenu();
  });
  menu.querySelector("[data-screen-mute]").addEventListener("click", event => {
    const code = App.callScreenContextMenuCtx?.peerCode;
    if (!code) return;
    App.callSetScreenMuted(code, !App.callIsScreenMuted(code), { fromGesture: !!event.isTrusted });
    App.syncCallScreenContextMenu();
  });
  menu.querySelector("[data-screen-volume-slider]").addEventListener("input", event => {
    const code = App.callScreenContextMenuCtx?.peerCode;
    if (!code) return;
    App.callSetScreenVolume(code, event.currentTarget.value, { fromGesture: !!event.isTrusted });
    App.syncCallScreenContextMenu();
  });
  document.addEventListener("pointerdown", event => {
    if (!menu.hidden && !menu.contains(event.target)) App.closeCallScreenContextMenu();
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      App.closeCallScreenContextMenu(true);
    }
  }, true);
  window.addEventListener("resize", () => App.closeCallScreenContextMenu(true));
  window.addEventListener("blur", () => App.closeCallScreenContextMenu(true));
  document.addEventListener("scroll", event => {
    if (!menu.hidden && !menu.contains(event.target)) App.closeCallScreenContextMenu(true);
  }, true);
  App.initPreciseRangeSliders(menu);
  return menu;
};
App.openCallScreenContextMenu = function (peerCode, x, y) {
  const code = String(peerCode || "");
  if (!code || !App.callMenuOpen) return;
  if (App.callShareIsCamera(code)) {
    App.openCallUserContextMenu(App.callShareOwner(code), x, y);
    return;
  }
  const member = App.callMembersCache.find(item => String(item?.code || "") === code);
  const user = App.getLiveOrStoredCallUser(member || App.liveUserCache.get(code) || { code, username: "User" });
  const menu = App.ensureCallScreenContextMenu();
  (document.fullscreenElement === App.$("call-menu") ? document.fullscreenElement : document.body).appendChild(menu);
  App.closeCallUserContextMenu(true);
  App.closeMsgMenu(true);
  App.closeMsgTextMenu(true);
  App.closeEmojiCtxMenu(true);
  App.closeHtmlHubContextMenu(true);
  App.callHideScreenViewersFloating({ immediate: true });
  clearTimeout(App.callScreenContextMenuCloseTimer);
  App.callScreenContextMenuCloseSeq += 1;
  App.callScreenContextMenuCtx = { peerCode: code };
  menu.querySelector("[data-screen-volume-username]").textContent = String(user?.username || member?.username || "User");
  App.syncCallScreenContextMenu();
  menu.hidden = false;
  menu.classList.remove("closing");
  menu.classList.add("open");
  App.positionCallAudioContextMenu(menu, x, y);
  // Focus while opening. A deferred focus can steal the user's next keyboard
  // target (especially on mobile), making a subsequent context-menu key act
  // on the previous screen instead of the screen they just selected.
  menu.querySelector(code === String(App.currentUser?.code || "") ? "[data-screen-pause]" : "[data-screen-mute]")?.focus({ preventScroll: true });
};
App.closeCallScreenContextMenu = function (immediate = false) {
  const menu = App.callScreenContextMenuEl;
  if (!menu || menu.hidden) return;
  clearTimeout(App.callScreenContextMenuCloseTimer);
  const closeSeq = ++App.callScreenContextMenuCloseSeq;
  const finish = () => {
    if (closeSeq !== App.callScreenContextMenuCloseSeq) return;
    clearTimeout(App.callScreenContextMenuCloseTimer);
    menu.hidden = true;
    menu.classList.remove("open", "closing");
    App.callScreenContextMenuCtx = null;
  };
  if (immediate) {
    finish();
    return;
  }
  menu.classList.remove("open");
  menu.classList.add("closing");
  menu.addEventListener("animationend", finish, { once: true });
  App.callScreenContextMenuCloseTimer = setTimeout(finish, 180);
};

App.register("calling/panel", function initializeFeature() {
App.$("btn-call-join")?.addEventListener("click", () => {
  if (App.callJoinPending || App.callLeavePending || App.currentCallRoomId || !App.currentRoomId) return;
  void App.joinCall(App.currentRoomId, { openMenu: true });
});
App.callBindInCallHover(App.$("call-in-call"));
App.CALL_VIEWERS_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6S2.8 12 2.8 12Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.7" stroke="currentColor" stroke-width="2"/></svg>';
window.addEventListener("resize", App.callPositionScreenViewersFloating);
window.addEventListener("scroll", App.callPositionScreenViewersFloating, true);
App.callUserContextMenuEl = null;
App.callUserContextMenuCtx = null;
App.callUserContextMenuCloseTimer = 0;
App.callUserContextMenuCloseSeq = 0;
App.callScreenContextMenuEl = null;
App.callScreenContextMenuCtx = null;
App.callScreenContextMenuCloseTimer = 0;
App.callScreenContextMenuCloseSeq = 0;
document.addEventListener("contextmenu", event => {
  const screen = event.target?.closest?.(".call-menu-card .call-screen-tile[data-share-code]");
  if (screen) {
    event.preventDefault();
    event.stopPropagation();
    App.openCallScreenContextMenu(String(screen.dataset.shareCode || ""), event.clientX, event.clientY);
    return;
  }
  const participant = event.target?.closest?.(".call-menu-card .call-participant[data-usercode]");
  if (!participant) return;
  event.preventDefault();
  event.stopPropagation();
  const peer = String(participant.dataset.usercode || "");
  if (!peer || peer === String(App.currentUser?.code || "")) {
    App.closeCallUserContextMenu(true);
    return;
  }
  App.openCallUserContextMenu(peer, event.clientX, event.clientY);
}, {
  passive: false
});
document.addEventListener("keydown", event => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  const screen = event.target?.closest?.(".call-menu-card .call-screen-tile[data-share-code]");
  if (screen) {
    event.preventDefault();
    event.stopPropagation();
    const rect = screen.getBoundingClientRect();
    App.openCallScreenContextMenu(String(screen.dataset.shareCode || ""), rect.left + Math.min(28, rect.width / 2), rect.top + Math.min(28, rect.height / 2));
    return;
  }
  const participant = event.target?.closest?.(".call-menu-card .call-participant[data-usercode]");
  const peer = String(participant?.dataset?.usercode || "");
  if (!participant || !peer || peer === String(App.currentUser?.code || "")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = participant.getBoundingClientRect();
  App.openCallUserContextMenu(peer, rect.left + Math.min(28, rect.width / 2), rect.top + Math.min(28, rect.height / 2), participant);
});

/* Chat calling: lifecycle. Classic script; see CALLING.md. */
});
})(globalThis.ChatApp);
