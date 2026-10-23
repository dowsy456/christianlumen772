/* App navigation and its independent, always-visible account/call dock. */
(function (App) {
  "use strict";
  App.syncSidebarNavActive = function () {
    const place = App.getStoredPlace() || "home";
    const selectedIds = new Set();
    if (place === "home") selectedIds.add("btn-side-home");
    if (place === "schedules") selectedIds.add("btn-side-schedules");
    if (place === "calendar" || place.startsWith("calendar:")) selectedIds.add("btn-side-calendar");
    ["btn-side-home", "btn-side-settings", "btn-side-call", "btn-room-plus", "btn-side-calendar", "btn-side-schedules", "btn-side-html-hub", "btn-side-notepad", "btn-side-panel"].forEach(id => {
      const el = App.$(id);
      if (!el) return;
      const selected = selectedIds.has(id);
      el.classList.toggle("is-selected", selected);
      if (selected) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    });
  };

  App.formatSidebarCallDuration = function (startedAt, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const rest = String(seconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
  };

  App.syncSidebarCallDock = function () {
    const dock = App.$("sidebar-call");
    if (!dock) return;
    const roomId = App.currentUser ? App.currentCallRoomId : null;
    dock.hidden = !roomId;
    if (!roomId) {
      App.closeSidebarMediaMenu?.();
      clearInterval(App.sidebarCallTimer);
      App.sidebarCallTimer = 0;
      App.sidebarCallSession = "";
      return;
    }
    const session = `${roomId}:${App.callSessionId || ""}`;
    if (App.sidebarCallSession !== session) {
      App.sidebarCallSession = session;
      const member = App.callMembersCache?.find(user => String(user.code) === String(App.currentUser.code));
      App.sidebarCallStartedAt = Number(member?.joinedAt) > 0 ? Number(member.joinedAt) : Date.now();
    }
    const roomName = App.roomDisplayName?.(roomId, App.roomsMetaCache?.get(roomId) || null) || roomId;
    const connection = App.callGetConnectionPresentation?.() || { text: "Connecting", level: "connecting", detail: "Waiting for call transport" };
    const reconnecting = connection.level === "reconnecting";
    App.$("sidebar-call-room").textContent = roomName;
    App.$("sidebar-call-status").textContent = connection.text;
    dock.dataset.quality = connection.level;
    App.$("sidebar-call-status").setAttribute("aria-label", connection.detail);
    dock.classList.toggle("is-reconnecting", reconnecting);
    const timer = App.$("sidebar-call-time");
    const tick = () => {
      timer.textContent = App.formatSidebarCallDuration(App.sidebarCallStartedAt);
      timer.dateTime = `PT${Math.max(0, Math.floor((Date.now() - App.sidebarCallStartedAt) / 1000))}S`;
    };
    tick();
    if (!App.sidebarCallTimer) App.sidebarCallTimer = setInterval(tick, 1000);
    const open = App.$("btn-sidebar-call-open");
    open.setAttribute("aria-label", `${App.callMenuOpen ? "Close" : "Open"} call in ${roomName}`);
    open.setAttribute("aria-expanded", String(!!App.callMenuOpen));
    open.setAttribute("aria-controls", "call-menu");
    open.dataset.tooltip = `${connection.text} · ${connection.detail}`;
    const pending = !!(App.callJoinPending || App.callLeavePending);
    const controls = [
      ["mute", App.callListenOnly ? "Microphone unavailable" : App.callMuted ? "Unmute" : "Mute", App.callMuted, pending || App.callListenOnly],
      ["deafen", App.callDeafened ? "Undeafen" : "Deafen", App.callDeafened, pending],
      ["share", "Screen and Camera", App.callSharing || App.callCameraSharing, pending],
      ["leave", "Leave Call", false, pending]
    ];
    controls.forEach(([name, label, active, disabled]) => {
      const button = App.$(`btn-sidebar-call-${name}`);
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = label;
      button.classList.toggle("is-active", !!active);
      if (name !== "leave") button.setAttribute("aria-pressed", active ? "true" : "false");
      button.disabled = !!disabled;
    });
    App.syncSidebarMediaMenu?.();
  };

  App.closeSidebarMediaMenu = function () {
    const menu = App.$("sidebar-media-menu");
    clearTimeout(App.sidebarMediaCloseTimer);
    if (menu) {
      menu.classList.remove("open"); menu.classList.add('closing'); menu.style.opacity = '0';
      App.sidebarMediaCloseTimer = setTimeout(() => { menu.hidden = true; menu.classList.remove('closing'); }, 140);
    }
    App.$("btn-sidebar-call-share")?.setAttribute("aria-expanded", "false");
  };
  App.syncSidebarMediaMenu = function () {
    const menu = App.$("sidebar-media-menu");
    if (!menu || menu.hidden) return;
    for (const name of ["share", "camera"]) {
      const source = App.$(`btn-call-${name}`), button = menu.querySelector(`[data-call-media="${name}"]`);
      const active = name === "share" ? !!App.callSharing : !!App.callCameraSharing;
      const pending = name === "share" ? App.callScreenCapturePending : App.callCameraCapturePending;
      const label = name === "share" ? "Screen Share" : "Camera";
      button.querySelector(".media-label").textContent = label;
      button.querySelector(".media-status").textContent = active ? "On" : pending ? "Opening…" : "Off";
      button.setAttribute("aria-checked", String(active));
      button.classList.toggle("is-active", active);
      button.disabled = !!source?.disabled || !!App.callJoinPending || !!App.callLeavePending;
    }
  };
  App.toggleSidebarMediaMenu = function () {
    let menu = App.$("sidebar-media-menu");
    if (menu && !menu.hidden && menu.classList.contains('open')) { App.closeSidebarMediaMenu(); return; }
    clearTimeout(App.sidebarMediaCloseTimer);
    App.dismissChatPopovers?.();
    const anchor = App.$("btn-sidebar-call-share");
    if (!menu) {
      menu = document.createElement("div"); menu.id = "sidebar-media-menu";
      menu.className = "composer-more-menu chat-popup sidebar-media-menu";
      menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Screen and Camera");
      const actions = document.createElement("div"); actions.className = "composer-more-actions"; menu.append(actions);
      for (const name of ["share", "camera"]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "icon-btn composer-tool-btn";
        button.dataset.callMedia = name; button.setAttribute("role", "menuitemcheckbox");
        button.innerHTML = (App.$(`btn-call-${name}`)?.querySelector("svg")?.outerHTML || "") + '<span class="media-label"></span><span class="media-status"></span>';
        button.addEventListener("click", async () => {
          if (button.disabled) return;
          button.disabled = true;
          App.callCaptureAnchor = anchor;
          App.closeSidebarMediaMenu();
          try { await (name === "share" ? App.callToggleShareScreen() : App.callToggleCamera()); }
          finally { App.callCaptureAnchor = null; App.syncSidebarMediaMenu(); }
        });
        actions.append(button);
      }
      document.body.append(menu);
    }
    menu.hidden = false; menu.classList.remove('open', 'closing'); menu.style.opacity = '0';
    anchor.setAttribute("aria-expanded", "true"); anchor.setAttribute("aria-haspopup", "menu"); anchor.setAttribute("aria-controls", menu.id);
    App.syncSidebarMediaMenu();
    App.layoutSidebarMediaMenu();
    void menu.offsetHeight;
    menu.classList.add('open'); menu.style.opacity = '1';
    menu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  };

  App.layoutSidebarMediaMenu = function () {
    const menu = App.$('sidebar-media-menu'), anchor = App.$('btn-sidebar-call-share');
    if (!menu || menu.hidden || !anchor) return;
    const v = window.visualViewport;
    const x = v?.offsetLeft || 0, y = v?.offsetTop || 0, width = v?.width || innerWidth, height = v?.height || innerHeight;
    const rect = anchor.getBoundingClientRect(), menuWidth = Math.min(260, width - 20);
    menu.style.setProperty('--chat-popup-width', `${menuWidth}px`);
    menu.style.setProperty('--chat-popup-max-height', `${height - 20}px`);
    const menuHeight = Math.min(menu.scrollHeight + 2, height - 20);
    menu.style.setProperty('--chat-popup-left', `${Math.max(x + 10, Math.min(rect.right - menuWidth, x + width - menuWidth - 10))}px`);
    menu.style.setProperty('--chat-popup-top', `${Math.max(y + 10, Math.min(rect.top - menuHeight - 12, y + height - menuHeight - 10))}px`);
  };

  App.register("ui/sidebar", function initializeFeature() {
    window.addEventListener('resize', App.layoutSidebarMediaMenu);
    window.visualViewport?.addEventListener('resize', App.layoutSidebarMediaMenu);
    window.visualViewport?.addEventListener('scroll', App.layoutSidebarMediaMenu);
    const side = document.querySelector(".sidebar:not(.members-sidebar)");
    const scroll = App.$("side-scroll");
    if (!side || !scroll) return;
    side.id = "sidebar-nav-surface";
    side.classList.add("sidebar-refresh");
    const head = side.querySelector(".sidebar-workspace-head");
    if (head) side.prepend(head);

    // The mobile drawer keeps its close action at the top; density belongs in the account dock.
    if (head) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "sidebar-mobile-close sidebar-dock-button";
      close.setAttribute("aria-label", "Close Navigation");
      close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
      close.addEventListener("click", () => App.closeMobileDrawers?.());
      head.prepend(close);
    }
    const dock = document.createElement("footer");
    dock.className = "sidebar-dock";
    dock.setAttribute("aria-label", "Account and call controls");
    dock.innerHTML = `<section class="sidebar-call" id="sidebar-call" aria-label="Current call" hidden>
      <button class="sidebar-call-summary" id="btn-sidebar-call-open" type="button" aria-label="Open current call">
        <span class="sidebar-call-orb" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6.3 3.5h2.2l2 4-2 2a14.5 14.5 0 0 0 6 6l2-2 4 2v2.2a3 3 0 0 1-3.4 3C10 19.8 4.2 14 3.3 6.9a3 3 0 0 1 3-3.4Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="sidebar-call-copy"><span id="sidebar-call-room"></span><span id="sidebar-call-status">In call</span></span>
        <time id="sidebar-call-time" aria-label="Time in call">0:00</time>
      </button>
      <div class="sidebar-call-actions" role="group" aria-label="Quick call controls"></div>
    </section><div class="sidebar-account"></div>`;
    const actions = dock.querySelector(".sidebar-call-actions");
    // A centered, full-size receiver keeps Leave recognizable in both controls.
    const leaveIcon = App.$("btn-call-leave")?.querySelector(".call-control-icon");
    if (leaveIcon) leaveIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 7.5c-4.4 0-8.5 1.6-11.4 4.3a1.2 1.2 0 0 0 0 1.7l2.1 2.1c.5.5 1.2.5 1.7.1.8-.8 1.7-1.4 2.7-1.9.4-.2.7-.6.7-1.1v-2.3a15.8 15.8 0 0 1 8.4 0v2.3c0 .5.3.9.7 1.1 1 .5 1.9 1.1 2.7 1.9.5.4 1.2.4 1.7-.1l2.1-2.1a1.2 1.2 0 0 0 0-1.7C20.5 9.1 16.4 7.5 12 7.5Z" fill="currentColor"/></svg>';
    // Reuse the same icons and handlers as the full call menu.
    ["mute", "deafen", "share", "leave"].forEach(name => {
      const source = App.$(`btn-call-${name}`);
      const button = document.createElement("button");
      button.type = "button";
      button.id = `btn-sidebar-call-${name}`;
      button.className = `sidebar-dock-button sidebar-call-${name}`;
      button.innerHTML = source?.querySelector("svg")?.outerHTML || "";
      button.setAttribute("aria-label", source?.getAttribute("aria-label") || name);
      button.addEventListener("click", () => {
        if (button.disabled || !App.currentCallRoomId) return;
        if (name === "mute") App.callToggleMute();
        if (name === "deafen") App.callToggleDeafen();
        if (name === "share") App.toggleSidebarMediaMenu();
        if (name === "leave") void App.leaveCall({ roomId: App.currentCallRoomId, quiet: true });
      });
      if (name === "mute" || name === "deafen") {
        const kind = name === "mute" ? "input" : "output";
        const title = name === "mute" ? "Input Settings" : "Output Settings";
        const split = document.createElement("div");
        split.className = "call-control-split sidebar-call-split";
        split.setAttribute("role", "group");
        split.setAttribute("aria-label", title);
        button.dataset.callAudioContext = kind;
        const arrow = document.createElement("button");
        arrow.type = "button";
        arrow.id = `btn-sidebar-call-${kind}-settings`;
        arrow.className = "sidebar-dock-button call-settings-toggle";
        arrow.dataset.callAudioSettings = kind;
        arrow.dataset.tooltip = title;
        arrow.setAttribute("aria-label", title);
        arrow.setAttribute("aria-haspopup", "dialog");
        arrow.setAttribute("aria-expanded", "false");
        arrow.setAttribute("aria-controls", `call-${kind}-settings-menu`);
        arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 9.5 5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        split.append(button, arrow);
        actions.appendChild(split);
      } else {
        actions.appendChild(button);
      }
    });
    dock.querySelector("#btn-sidebar-call-open").addEventListener("click", () => {
      if (App.callMenuOpen) App.closeCallMenu(); else App.openCallMenu();
      App.syncSidebarCallDock();
      if (document.body.dataset.mobileUi === "1") App.closeMobileDrawers?.();
    });
    const account = dock.querySelector(".sidebar-account");
    const me = side.querySelector(".me-pill-dock");
    if (me) {
      me.setAttribute("role", "button");
      me.setAttribute("tabindex", "0");
      me.setAttribute("aria-label", "Your profile");
      me.dataset.tooltip = "Your profile";
      const openProfile = () => {
        if (App.currentUser) App.toggleUserProfileAt?.(me, App.currentUser.code);
      };
      me.addEventListener("click", openProfile);
      me.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openProfile();
      });
      account.appendChild(me);
    }
    const accountActions = document.createElement("div");
    accountActions.className = "sidebar-account-actions";
    accountActions.setAttribute("role", "group");
    accountActions.setAttribute("aria-label", "Navigation settings");
    const settings = App.$("btn-side-settings");
    if (settings) {
      settings.className = "sidebar-dock-button sidebar-settings";
      settings.querySelector(".side-label")?.remove();
      settings.dataset.tooltip = "Settings";
      settings.removeAttribute("title");
      accountActions.appendChild(settings);
    }

    account.appendChild(accountActions);
    side.appendChild(dock);
    document.addEventListener("pointerdown", event => {
      if (!event.target.closest?.("#sidebar-media-menu, #btn-sidebar-call-share")) App.closeSidebarMediaMenu();
    });
    document.addEventListener("keydown", event => {
      const menu = App.$("sidebar-media-menu");
      if (!menu || menu.hidden) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); App.closeSidebarMediaMenu(); App.$("btn-sidebar-call-share")?.focus({ preventScroll:true }); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    }, true);
    const rail = document.createElement("nav");
    rail.className = "sidebar-icon-rail";
    rail.setAttribute("aria-label", "App navigation");
    const plus = App.$("btn-room-plus");
    plus.querySelector(".side-label")?.remove();
    plus.dataset.tooltip = "Create or Join Room";
    plus.setAttribute("aria-label", "Create or Join Room");
    App.$("rooms-head").querySelector(".rooms-head-actions").prepend(plus);
    for (const nav of scroll.querySelectorAll(".sidebar-nav")) {
      for (const button of [...nav.children]) {
        button.querySelectorAll(".side-label").forEach(label => label.remove());
        button.dataset.tooltip = button.getAttribute("aria-label") || "";
        rail.append(button);
      }
      nav.remove();
    }
    scroll.prepend(rail);

    App.syncSidebarCallDock();
    App.callSyncAudioSettingsUI?.();
    side.addEventListener("click", () => requestAnimationFrame(App.syncSidebarNavActive), true);

    // Icon navigation uses the same animated tooltip as the account dock.
    const tip = document.createElement("div");
    tip.id = "sidebar-tooltip";
    tip.className = "sidebar-tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
    let anchor = null;
    const hideTip = () => {
      if (anchor) {
        const ids = (anchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== tip.id);
        if (ids.length) anchor.setAttribute("aria-describedby", ids.join(" ")); else anchor.removeAttribute("aria-describedby");
      }
      anchor = null;
      tip.classList.remove("is-visible");
    };
    App.hideAppTooltip = hideTip;
    const showTip = target => {
      const hit = target?.closest?.("button, .room-row, .me-pill-dock");
      if (!hit || hit.disabled || App.userProfileOpen) return hideTip();
      const sidebarControl = side.contains(hit) && hit.matches(".sidebar-dock-button, .sidebar-call-summary, .side-btn, #btn-time-display, .rooms-mode-toggle, .spotify-player-button");
      const chatControl = hit.hasAttribute("data-tooltip") && !!hit.closest(".room-toolbar, .call-menu, .composer-row");
      if (!sidebarControl && !chatControl) return hideTip();
      const label = hit.getAttribute("data-tooltip") || hit.getAttribute("aria-label");
      if (!label) return hideTip();
      if (anchor !== hit) hideTip();
      anchor = hit;
      tip.textContent = label;
      const ids = new Set((hit.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
      ids.add(tip.id);
      hit.setAttribute("aria-describedby", [...ids].join(" "));
      const rect = hit.getBoundingClientRect();
      const bounds = tip.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0;
      const topEdge = viewport?.offsetTop || 0;
      const vw = viewport?.width || window.innerWidth;
      const vh = viewport?.height || window.innerHeight;
      let left = rect.left + (rect.width - bounds.width) / 2;
      let top = rect.top - bounds.height - 9;
      if (top < topEdge + 8) top = rect.bottom + 9;
      left = Math.max(leftEdge + 8, Math.min(left, leftEdge + vw - bounds.width - 8));
      top = Math.max(topEdge + 8, Math.min(top, topEdge + vh - bounds.height - 8));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      tip.classList.add("is-visible");
    };
    document.addEventListener("pointerover", event => { if (event.pointerType !== "touch") showTip(event.target); });
    document.addEventListener("pointerout", event => { if (anchor && !anchor.contains(event.relatedTarget)) hideTip(); });
    document.addEventListener("focusin", event => showTip(event.target));
    document.addEventListener("focusout", hideTip);
    document.addEventListener("pointerdown", hideTip);
    document.addEventListener("keydown", event => { if (event.key === "Escape") hideTip(); });
    // Remove native title popups while retaining screen-reader labels, including
    // titles added by later avatar or room updates.
    const removeNativeTitles = () => {
      side.querySelectorAll("[title]").forEach(element => {
        if (!element.hasAttribute("aria-label") && element.title) element.setAttribute("aria-label", element.title);
        element.removeAttribute("title");
      });
    };
    removeNativeTitles();
    new MutationObserver(removeNativeTitles).observe(side, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
    scroll.addEventListener("scroll", hideTip, { passive: true });
    window.addEventListener("resize", hideTip, { passive: true });
    document.addEventListener("visibilitychange", hideTip);
  });
})(globalThis.ChatApp);
