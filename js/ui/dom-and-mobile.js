/* ui/dom-and-mobile: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.syncMobileUiMode = function () {
  const wasMobile = document.body.dataset.mobileUi === "1";
  const enabled = App.mobileUserAgent || App.mobileUiMedia.matches;
  document.body.dataset.mobileUi = enabled ? "1" : "0";
  document.body.dataset.mobilePlatform = /Android/i.test(navigator.userAgent || "") ? "android" : App.mobileUserAgent ? "ios" : "web";
  if (!enabled) document.body.dataset.mobileNav = "0";
  if (!wasMobile && enabled && App.membersListVisible) {
    App.membersListVisible = false;
    App.syncEmojiButtonVisibility?.();
  }
  if (wasMobile && !enabled && App.currentRoomId) {
    App.membersListVisible = true;
    if (App.companionMembersBefore !== undefined) App.companionMembersBefore = true;
  }
  // Reconcile the hidden attribute when resizing back from the mobile drawer.
  if (wasMobile !== enabled && App.COMPOSER_OPTIONAL_TOOL_IDS && App.views?.chat) App.syncEmojiButtonVisibility?.();
  const viewport = window.visualViewport;
  const viewportHeight = Math.round(viewport?.height || window.innerHeight || 0);
  const viewportWidth = Math.round(viewport?.width || window.innerWidth || 0);
  const viewportTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
  if (viewportHeight) document.documentElement.style.setProperty("--mobile-viewport-height", `${viewportHeight}px`);
  if (viewportWidth) document.documentElement.style.setProperty("--mobile-viewport-width", `${viewportWidth}px`);
  document.documentElement.style.setProperty("--mobile-viewport-top", `${viewportTop}px`);
  const editing = document.activeElement?.matches?.("input, textarea, [contenteditable='true']");
  document.body.dataset.mobileKeyboard = enabled && editing && window.innerHeight - viewportHeight > 120 ? "1" : "0";

  App.scheduleMobileChromeSync?.();
  App.syncMobileWelcome?.(enabled);
};
App.getMobileContextHoldTarget = function (e) {
  const path = typeof e?.composedPath === "function" ? e.composedPath() : [];
  const eventTarget = path.find(node => node instanceof Element) || e?.target;

  // Preserve the emoji grid button for the shared long-press Copy action.
  const insideEmojiPicker = path.some(node => node instanceof Element && node.id === "emoji-picker");
  if (insideEmojiPicker) {
    const emojiButton = path.find(node => node instanceof HTMLButtonElement);
    return emojiButton ? {
      anchor: emojiButton,
      dispatchTarget: emojiButton
    } : null;
  }
  if (!(eventTarget instanceof Element)) return null;
  const anchor = eventTarget.closest(App.MOBILE_CONTEXT_MENU_SELECTOR);
  return anchor ? {
    anchor,
    dispatchTarget: eventTarget
  } : null;
};
App.cancelMobileContextHold = function () {
  const hold = App.mobileContextHold;
  if (!hold) return;
  clearTimeout(hold.timer);
  clearTimeout(hold.feedbackTimer);
  hold.anchor?.classList?.remove("mobile-context-hold-target");
  App.mobileContextHold = null;
};
App.rafThrottle = function (fn) {
  let raf = 0;
  let lastThis = null;
  let lastArgs = null;
  return function (...args) {
    lastThis = this;
    lastArgs = args;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      fn.apply(lastThis, lastArgs);
    });
  };
};
App.syncPreciseRangeVisual = function (range) {
  if (!(range instanceof HTMLInputElement) || range.type !== "range") return;
  const min = Number(range.min || 0);
  const max = Number(range.max || 100);
  const val = Number(range.value || 0);
  const pct = Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(val) && max > min ? Math.max(0, Math.min(100, (val - min) / (max - min) * 100)) : 0;
  range.style.setProperty("--range-pct", `${pct}%`);
};
App.syncMobileWelcome = function (enabled) {
  App.mobileWelcomeOriginals ||= new Map();
  const replacements = [
    [".brand-title", "Chat App"], [".brand-subtitle", "Your people. One place."],
    ["#view-home > .h1", "Keep the conversation going."],
    ["#view-home > .muted", "Message your friends, jump into a call, and share the moments that matter."],
    ["#btn-go-create", "Create account"], ["#btn-go-login", "Log in"],
    ["#view-create .h2", "Create your account"],
    ["#view-login .h2", "Welcome back"], ["#btn-login", "Log in"],
    ["#view-create .row.split > div > .label", "Profile picture"]
  ];
  for (const [selector, label] of replacements) {
    const element = document.querySelector(selector);
    if (!element) continue;
    if (!App.mobileWelcomeOriginals.has(element)) App.mobileWelcomeOriginals.set(element, element.innerHTML);
    if (enabled) { if (element.textContent !== label) element.textContent = label; }
    else if (element.innerHTML !== App.mobileWelcomeOriginals.get(element)) element.innerHTML = App.mobileWelcomeOriginals.get(element);
  }
};

// Mobile uses the same room, call, message, and menu actions as the desktop.
// Only navigation and touch affordances are different; no second chat state.
App.setMobileDrawer = function (drawer, { focus = false } = {}) {
  if (document.body.dataset.mobileUi !== "1") return;
  const members = drawer === "members" && App.isActiveChatRoomForMembersToggle?.();
  document.body.dataset.mobileNav = drawer === "navigation" ? "1" : "0";
  App.membersListVisible = !!members;
  App.syncEmojiButtonVisibility?.();
  App.closeComposerMoreMenu?.({ immediate: true });
  App.cancelMobileContextHold();
  App.syncMobileChrome();
  if (focus) requestAnimationFrame(() => {
    const target = drawer === "navigation" ? document.querySelector(".sidebar-mobile-close") : members ? App.$("btn-mobile-members-close") : App.$("btn-mobile-nav");
    target?.focus({ preventScroll: true });
  });
};
App.syncMobileChrome = function () {
  const mobile = document.body.dataset.mobileUi === "1";
  const inRoom = !!App.currentRoomId && document.body.dataset.roomView === "1";
  const nav = document.querySelector(".sidebar:not(.members-sidebar)");
  const members = App.$("members-sidebar");
  const navOpen = mobile && document.body.dataset.mobileNav === "1";
  const membersOpen = mobile && document.body.dataset.membersSidebar === "1";
  if (nav) {
    nav.inert = mobile && !navOpen;
    if (mobile) nav.setAttribute("aria-hidden", String(!navOpen));
    else nav.removeAttribute("aria-hidden");
  }
  if (members) {
    members.inert = mobile && !membersOpen;
    if (mobile) members.setAttribute("aria-hidden", String(!membersOpen));
    else members.removeAttribute("aria-hidden");
  }
  App.$("btn-mobile-nav")?.setAttribute("aria-expanded", String(navOpen));
  App.$("btn-mobile-nav")?.setAttribute("aria-controls", nav?.id || "sidebar-nav-surface");
  const roomName = inRoom ? App.roomDisplayName?.(App.currentRoomId, App.roomsMetaCache?.get(App.currentRoomId) || null) || App.currentRoomId : "Chat App";
  const title = App.$("mobile-room-title");
  if (title && title.textContent !== roomName) title.textContent = roomName;
  const subtitle = App.$("mobile-room-subtitle");
  const copy = inRoom ? "Messages" : "Your rooms & conversations";
  if (subtitle && subtitle.textContent !== copy) subtitle.textContent = copy;
  if (!mobile) return;
  // Each message has an explicit menu button. Long-pressing its text remains
  // the operating system's ordinary text selection, including selection handles.
  for (const row of document.querySelectorAll(".msg-row[data-msgkey]")) {
    if (row.querySelector(".mobile-message-actions") || !row.querySelector(".bubble") || row.classList.contains("system-message")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mobile-message-actions";
    button.setAttribute("aria-label", "Message actions");
    button.setAttribute("aria-haspopup", "menu");
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    row.appendChild(button);
  }
};
App.bindMobileChrome = function () {
  const anchor = document.querySelector(".mobile-nav-anchor");
  if (!anchor || anchor.dataset.mobileChrome === "1") return;
  anchor.dataset.mobileChrome = "1";
  anchor.setAttribute("aria-label", "Conversation navigation");
  const copy = document.createElement("div");
  copy.className = "mobile-room-heading";
  copy.innerHTML = '<strong id="mobile-room-title">Chat App</strong><span id="mobile-room-subtitle">Your rooms &amp; conversations</span>';
  anchor.appendChild(copy);
  const button = (id, label, path) => {
    const el = document.createElement("button");
    el.id = id; el.type = "button"; el.className = "mobile-header-action";
    el.setAttribute("aria-label", label);
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${path}</svg>`;
    return el;
  };
  const memberHead = document.createElement("div");
  memberHead.className = "mobile-members-head";
  const label = document.createElement("strong"); label.textContent = "Room members";
  memberHead.appendChild(label);
  const close = button("btn-mobile-members-close", "Close room members", '<path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
  close.addEventListener("click", () => { App.setMobileDrawer(""); App.$("btn-members")?.focus({ preventScroll: true }); });
  memberHead.appendChild(close);
  App.$("members-sidebar")?.prepend(memberHead);
  App.scheduleMobileChromeSync = App.rafThrottle(App.syncMobileChrome);
  const observer = new MutationObserver(App.scheduleMobileChromeSync);
  observer.observe(document.body, { attributes: true, attributeFilter: ["data-mobile-ui", "data-mobile-nav", "data-members-sidebar", "data-room-view", "data-mode"] });
  for (const node of [App.$("messages-inner"), App.$("side-scroll"), App.$("call-menu-room")]) {
    if (node) observer.observe(node, { childList: true, subtree: true, characterData: true });
  }
  document.addEventListener("click", event => {
    const target = event.target?.closest?.(".mobile-message-actions");
    if (!target || document.body.dataset.mobileUi !== "1") return;
    event.preventDefault(); event.stopPropagation();
    const row = target.closest(".msg-row");
    const rect = target.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, clientX: rect.left, clientY: rect.bottom, button: 2 }));
  });
  App.syncMobileChrome();
};
App.bindMobileSwipes = function () {
  let gesture = null;
  const reset = () => { gesture = null; };
  const hasSelection = () => !!window.getSelection?.()?.toString();
  document.addEventListener("touchstart", event => {
    reset();
    if (document.body.dataset.mobileUi !== "1" || document.body.dataset.mode !== "chat" || event.touches.length !== 1 || hasSelection()) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".modal:not([hidden]), .msg-menu, .user-profile-popover, .emoji-popover, .sticker-popover, .voice-popover, input, textarea, select, [contenteditable], video, audio, canvas, iframe, .bubble-text, .reply-preview-snippet, .call-view-body")) return;
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, dx: 0, locked: false, started: performance.now(), drawer: document.body.dataset.mobileNav === "1" ? "navigation" : document.body.dataset.membersSidebar === "1" ? "members" : "" };
  }, { passive: true });
  document.addEventListener("touchmove", event => {
    if (!gesture || event.touches.length !== 1 || hasSelection()) { reset(); return; }
    const dx = event.touches[0].clientX - gesture.x;
    const dy = event.touches[0].clientY - gesture.y;
    if (!gesture.locked) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { reset(); return; }
      if (Math.abs(dx) < 18 || Math.abs(dx) < Math.abs(dy) * 1.7) return;
      if (!gesture.drawer && dx < 0 && !App.isActiveChatRoomForMembersToggle?.()) { reset(); return; }
      gesture.locked = true;
      App.cancelMobileContextHold();
    }
    gesture.dx = dx;
    if (event.cancelable) event.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", () => {
    const swipe = gesture; reset();
    if (!swipe?.locked || hasSelection()) return;
    const elapsed = performance.now() - swipe.started;
    if (Math.abs(swipe.dx) < 56 && !(Math.abs(swipe.dx) > 30 && elapsed < 250)) return;
    if (swipe.drawer === "navigation" && swipe.dx < 0 || swipe.drawer === "members" && swipe.dx > 0) App.setMobileDrawer("");
    else if (!swipe.drawer) App.setMobileDrawer(swipe.dx > 0 ? "navigation" : "members");
  }, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
};

// Android asks the web app first. A canceled event means this press was handled;
// an uncanceled event lets the native Activity move into the background.
App.handleMobileNativeBack = function (event) {
  if (event.defaultPrevented || document.body.dataset.mobileUi !== "1") return;
  const visible = selector => Array.from(document.querySelectorAll(selector)).some(element => {
    if (element.hidden || !element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  const consume = action => { event.preventDefault(); action?.(); };
  // Close only the top menu layer, keeping its underlying profile/modal open.
  const menus = [
    ["#profile-status-menu", () => App.closeProfileStatusMenu?.(true)],
    [".calendar-date-picker-pop", () => App.closeCalendarDatePicker?.()],
    ["#sticker-context-menu", () => App.closeStickerContextMenu?.(true, true)],
    ["#emoji-ctx-menu", () => App.closeEmojiCtxMenu?.(true)],
    [".html-hub-menu", () => App.closeHtmlHubContextMenu?.(true, true)],
    ["#call-input-settings-menu, #call-output-settings-menu", () => App.closeCallAudioSettings?.({ immediate: true, restoreFocus: true })],
    ["#call-screen-context-menu", () => App.closeCallScreenContextMenu?.(true)],
    ["#call-user-context-menu", () => App.closeCallUserContextMenu?.(true)],
    ["#msg-text-menu", () => App.closeMsgTextMenu?.(true)],
    ["#msg-menu", () => App.closeMsgMenu?.(true)]
  ];
  for (const [selector, close] of menus) {
    if (visible(selector)) { consume(close); return; }
  }
  if (App.userProfileOpen && visible("#user-profile-popover")) {
    consume(() => App.closeUserProfile?.(true)); return;
  }
  if (visible("#modal")) {
    // The existing close handler preserves its busy guard and cleanup hooks.
    consume(() => App.closeModal?.()); return;
  }
  if (visible("#emoji-popover, #sticker-popover, #voice-popover, #composer-more-menu, #poll-popover, .room-activities-menu")) {
    consume(() => App.dismissChatPopovers?.()); return;
  }
  if (document.body.dataset.mobileNav === "1" || document.body.dataset.membersSidebar === "1") {
    consume(() => App.closeMobileDrawers?.()); return;
  }
  if (App.isTimeDisplayExpanded?.()) {
    consume(() => App.collapseTimeDisplay?.()); return;
  }
  if (App.selectedGame && visible(".games-stage-overlay")) {
    consume(() => { void App.closeGamesStage?.(); }); return;
  }
  if (App.callFocusedShareCode) {
    consume(() => App.closeShareView?.()); return;
  }
  if (App.callMenuExpanded) {
    consume(() => App.setCallMenuExpanded?.(false)); return;
  }
  if (App.callMenuOpen) {
    consume(() => App.closeCallMenu?.({ dismiss: true })); return;
  }
  if (App.currentUser && (App.currentRoomId || App.getStoredPlace?.() !== "home")) {
    // Home changes the visible page only. The active call/session is retained.
    consume(() => App.showLoggedInHome?.()); return;
  }
  if (!App.currentUser && (App.views?.login?.dataset.active === "true" || App.views?.create?.dataset.active === "true")) {
    consume(() => App.showView?.("home"));
  }
};

App.register("ui/dom-and-mobile", function initializeFeature() {
App.$ = id => document.getElementById(id);
App.mobileUiMedia = window.matchMedia("(max-width: 820px)");
App.mobileUserAgent = !!globalThis.ChatAppNativeInfo || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
App.syncMobileUiMode();
if (App.mobileUiMedia.addEventListener) App.mobileUiMedia.addEventListener("change", App.syncMobileUiMode);else App.mobileUiMedia.addListener?.(App.syncMobileUiMode);
window.addEventListener("orientationchange", App.syncMobileUiMode);
window.addEventListener("resize", App.syncMobileUiMode, { passive: true });
document.addEventListener("focusin", App.syncMobileUiMode);
document.addEventListener("focusout", () => requestAnimationFrame(App.syncMobileUiMode));
window.visualViewport?.addEventListener("resize", App.syncMobileUiMode);
window.visualViewport?.addEventListener("scroll", App.syncMobileUiMode);
document.addEventListener("contextmenu", e => {
  if (!e.target?.closest?.(".msg-menu")) return;
  e.preventDefault();
  e.stopPropagation();
}, {
  capture: true,
  passive: false
});
App.MOBILE_CONTEXT_MENU_SELECTOR = [".msg-row", ".sched-avatar[data-usercode]", ".reply-preview-avatar", ".message-seen-avatar", ".calendar-author-button:not(:disabled)", ".tip-ava", ".online-ava-img", ".members-sidebar .online-ava.member-row[data-usercode]", ".call-participant[data-usercode]", ".call-screen-tile[data-share-code]", "[data-call-audio-context]", "[data-call-audio-settings]", ".html-hub-card[data-html-hub-id]", ".home-room-row[data-roomid]", ".room-row[data-room-row]", ".user-profile-avatar", ".me-pill-dock"].join(",");
App.mobileContextHold = null;
App.mobileContextClickBlock = null;
document.addEventListener("pointerdown", e => {
  if (document.body.dataset.mobileUi !== "1" || e.pointerType !== "touch" || !e.isPrimary) return;
  if (e.target?.closest?.(".msg-menu, .bubble-text, .reply-preview-snippet, .mobile-message-actions, input, textarea, select, [contenteditable='true'], [contenteditable='']") || window.getSelection?.()?.toString()) return;
  const hit = App.getMobileContextHoldTarget(e);
  if (!hit) return;
  App.cancelMobileContextHold();
  const hold = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    anchor: hit.anchor,
    dispatchTarget: hit.dispatchTarget,
    feedbackTimer: 0,
    timer: 0
  };
  hold.feedbackTimer = setTimeout(() => {
    if (App.mobileContextHold === hold) hold.anchor?.classList?.add("mobile-context-hold-target");
  }, 180);
  hold.timer = setTimeout(() => {
    if (App.mobileContextHold !== hold || !hold.dispatchTarget?.isConnected) {
      App.cancelMobileContextHold();
      return;
    }
    const contextEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: hold.x,
      clientY: hold.y,
      button: 2,
      buttons: 0
    });
    hold.dispatchTarget.dispatchEvent(contextEvent);
    const handled = contextEvent.defaultPrevented;
    App.cancelMobileContextHold();
    if (handled) {
      App.mobileContextClickBlock = {
        anchor: hold.anchor,
        until: Date.now() + 800
      };
      try {
        navigator.vibrate?.(12);
      } catch {}
    }
  }, 520);
  App.mobileContextHold = hold;
}, {
  capture: true,
  passive: true
});
document.addEventListener("pointermove", e => {
  const hold = App.mobileContextHold;
  if (!hold || e.pointerId !== hold.pointerId) return;
  if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 12) App.cancelMobileContextHold();
}, {
  capture: true,
  passive: true
});
document.addEventListener("pointerup", App.cancelMobileContextHold, {
  capture: true,
  passive: true
});
document.addEventListener("pointercancel", App.cancelMobileContextHold, {
  capture: true,
  passive: true
});
document.addEventListener("contextmenu", e => {
  if (e.isTrusted) App.cancelMobileContextHold();
  // Do not route native text-selection menus to the app's message menu.
  if (document.body.dataset.mobileUi === "1" && e.isTrusted && e.target?.closest?.(".bubble-text, .reply-preview-snippet")) e.stopImmediatePropagation();
}, {
  capture: true,
  passive: true
});
document.addEventListener("click", e => {
  const block = App.mobileContextClickBlock;
  if (!block) return;
  if (Date.now() > block.until) {
    App.mobileContextClickBlock = null;
    return;
  }
  const target = e.target;
  const sameSurface = target instanceof Node && (block.anchor === target || block.anchor?.contains?.(target) || target.contains?.(block.anchor));
  if (!sameSurface) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  App.mobileContextClickBlock = null;
}, true);
App.sleep = (ms = 0) => new Promise(resolve => {
  setTimeout(resolve, Math.max(0, Number(ms) || 0));
});
App.nextPaint = () => new Promise(resolve => {
  requestAnimationFrame(resolve);
});
App.preciseRangeDragState = null;
App.bindMobileChrome();
App.bindMobileSwipes();
window.addEventListener("chatapp:nativeback", App.handleMobileNativeBack);
});
})(globalThis.ChatApp);


