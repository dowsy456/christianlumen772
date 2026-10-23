/* Composer menus share a viewport portal, so narrow chats cannot clip them. */
(function (App) {
  "use strict";
  const menus = [
    ["composer-more-menu", "btn-composer-more", 260],
    ["sticker-popover", "btn-stickers", 500],
    ["voice-popover", "btn-voice", 500],
    ["room-activities-menu", "btn-activities", 500],
    ["poll-popover", "btn-poll", 500],
    ["emoji-popover", "btn-emoji", 360]
  ];
  const viewport = () => {
    const v = window.visualViewport;
    return { left: v?.offsetLeft || 0, top: v?.offsetTop || 0, width: v?.width || innerWidth, height: v?.height || innerHeight };
  };
  const setStyle = (el, key, value) => { if (el.style.getPropertyValue(key) !== value) el.style.setProperty(key, value); };
  const icon = path => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const closeIcon = icon("m6 6 12 12M18 6 6 18");
  const headerIcons = {
    "emoji-popover": icon("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 9h.01M16 9h.01M8 14c2 3 6 3 8 0"),
    "sticker-popover": icon("M14 3H7a4 4 0 0 0-4 4v10a4 4 0 0 0 4 4h6l8-8V7a4 4 0 0 0-4-4h-3Zm-1 18v-5a3 3 0 0 1 3-3h5M8 8h.01M15 8h.01M8 12c1.5 1.5 3.5 1.5 5 0"),
    "voice-popover": icon("M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6Zm-3 5a6 6 0 0 0 12 0M12 17v4M9 21h6"),
    "room-activities-menu": icon("M8 7h8a4 4 0 0 1 4 3l1 7a2 2 0 0 1-3.4 1.7L15 16H9l-2.6 2.7A2 2 0 0 1 3 17l1-7a4 4 0 0 1 4-3ZM8 10v4M6 12h4M16 11h.01M18 13h.01")
  };
  App.syncChatMenuChrome = function () {
    for (const id of ["btn-sticker-menu-close", "btn-voice-close", "room-activities-close", "activity-chat-close"]) {
      const button = App.$(id);
      if (!button || button.dataset.chatIconReady === "1") continue;
      button.classList.add("chat-icon-button");
      button.innerHTML = closeIcon;
      button.dataset.chatIconReady = "1";
    }
    for (const [id, html] of Object.entries(headerIcons)) {
      const menu = App.$(id);
      const head = menu?.querySelector(".chat-popup-heading,.voice-head,.room-activities-menu-head");
      if (!head || head.dataset.chromeReady === "1") continue;
      const badge = document.createElement("span");
      badge.className = "chat-popup-mark";
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML = html;
      head.prepend(badge);
      head.dataset.chromeReady = "1";
    }
  };
  const contextPlacements = new WeakMap();
  const contextMenus = new Set();
  let contextTrigger = null;
  const smallContextTarget = (target, x, y) => {
    if (!target?.isConnected) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.width <= 160 && rect.height <= 160 &&
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  };
  let contextLayoutFrame = 0;
  const scheduleContextMenuLayout = () => {
    if (contextLayoutFrame) return;
    contextLayoutFrame = requestAnimationFrame(() => {
      contextLayoutFrame = 0;
      for (const menu of contextMenus) {
        if (!menu.isConnected) { contextMenus.delete(menu); continue; }
        const placement = contextPlacements.get(menu);
        if (placement && !menu.hidden && getComputedStyle(menu).display !== "none") App.positionContextMenu(menu, placement.options);
      }
    });
  };
  const contextSizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleContextMenuLayout) : null;
  // All context menus use the final (untransformed) size and reserve a gap
  // around the trigger. Clamping a menu after placement can cover the trigger;
  // choosing an available side first avoids that, including at viewport edges.
  App.positionContextMenu = function (el, options = {}) {
    if (!el || el.hidden || getComputedStyle(el).display === "none") return;
    let state = contextPlacements.get(el);
    if (!state) {
      state = { base: Object.fromEntries(["max-width", "max-height", "min-width", "min-height", "overflow-y"].map(name => [name, el.style.getPropertyValue(name)])) };
      contextPlacements.set(el, state);
      contextMenus.add(el);
      contextSizeObserver?.observe(el);
    }
    const opening = state.options !== options;
    if (opening) {
      el.classList.remove("context-positioned");
      state.options = options;
      state.side = null;
      // Delegated handlers can anchor to a whole row. Preserve the small
      // control actually right-clicked (including shadow-DOM emoji buttons).
      const trigger = contextTrigger;
      state.trigger = trigger && Date.now() - trigger.time < 500 && trigger.x === options.x && trigger.y === options.y ? trigger.target : null;
      state.anchor = state.trigger || options.anchor;
      state.anchorRect = state.anchor?.getBoundingClientRect?.() || null;
    }
    for (const [name, value] of Object.entries(state.base)) {
      if (value) setStyle(el, name, value); else el.style.removeProperty(name);
    }
    const v = viewport(), margin = 10, gap = 12;
    const bounds = { left: v.left + margin, top: v.top + margin, right: v.left + v.width - margin, bottom: v.top + v.height - margin };
    const maxWidth = Math.max(1, bounds.right - bounds.left), maxHeight = Math.max(1, bounds.bottom - bounds.top);
    const style = getComputedStyle(el);
    const authoredMaxWidth = parseFloat(style.maxWidth), authoredMaxHeight = parseFloat(style.maxHeight);
    setStyle(el, "max-width", `${Math.min(maxWidth, Number.isFinite(authoredMaxWidth) ? authoredMaxWidth : maxWidth)}px`);
    setStyle(el, "max-height", `${Math.min(maxHeight, Number.isFinite(authoredMaxHeight) ? authoredMaxHeight : maxHeight)}px`);
    setStyle(el, "min-width", `${Math.min(maxWidth, parseFloat(style.minWidth) || 0)}px`);
    setStyle(el, "min-height", "0px");
    setStyle(el, "overflow-y", "auto");
    const width = el.offsetWidth;
    // Measure expanded groups at their final size. Measuring only the clipped,
    // animated panel trapped it at its previous height once ResizeObserver
    // stopped receiving changes from the scroll container.
    let naturalHeight = Math.max(el.offsetHeight, (el.scrollHeight || el.offsetHeight) + el.offsetHeight - (el.clientHeight || el.offsetHeight));
    for (const group of el.querySelectorAll(".msg-menu-group.expanded .msg-menu-group-content")) {
      const inner = group.firstElementChild;
      naturalHeight += Math.max(0, (inner?.scrollHeight || 0) - group.offsetHeight);
    }
    const height = Math.min(naturalHeight, Number.isFinite(authoredMaxHeight) ? authoredMaxHeight : maxHeight, maxHeight);
    const anchor = state.anchor?.isConnected ? state.anchor.getBoundingClientRect() : null;
    const hasPoint = Number.isFinite(options.x) && Number.isFinite(options.y);
    const movedX = anchor && state.anchorRect ? anchor.left - state.anchorRect.left : 0;
    const movedY = anchor && state.anchorRect ? anchor.top - state.anchorRect.top : 0;
    let x = hasPoint ? options.x + movedX : anchor ? anchor.left + anchor.width / 2 : bounds.left;
    let y = hasPoint ? options.y + movedY : anchor ? anchor.top + anchor.height / 2 : bounds.top;
    x = Math.max(v.left, Math.min(x, v.left + v.width));
    y = Math.max(v.top, Math.min(y, v.top + v.height));
    const avoidAnchor = anchor && (options.avoidAnchor || !hasPoint || smallContextTarget(state.anchor, x, y));
    let avoid = avoidAnchor ? { left: anchor.left, right: anchor.right, top: anchor.top, bottom: anchor.bottom } : { left: x, right: x, top: y, bottom: y };
    const spacesFor = rect => [
      { side: "below", left: bounds.left, top: Math.max(bounds.top, rect.bottom + gap), right: bounds.right, bottom: bounds.bottom },
      { side: "above", left: bounds.left, top: bounds.top, right: bounds.right, bottom: Math.min(bounds.bottom, rect.top - gap) },
      { side: "right", left: Math.max(bounds.left, rect.right + gap), top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      { side: "left", left: bounds.left, top: bounds.top, right: Math.min(bounds.right, rect.left - gap), bottom: bounds.bottom }
    ].filter(space => space.right > space.left && space.bottom > space.top);
    let spaces = spacesFor(avoid);
    // A full-screen surface cannot be avoided as a whole; its activation point
    // is the useful exclusion zone. Buttons and normal tiles keep their rect.
    if (!spaces.length) {
      avoid = { left: x, right: x, top: y, bottom: y };
      spaces = spacesFor(avoid);
    }
    // Retain a side only while the complete expanded panel fits. Otherwise let
    // it move to a larger side instead of leaving actions trapped in a sliver.
    const retainedSpace = options.preserveSide && state.side && spaces.find(item => item.side === state.side && item.right - item.left >= width && item.bottom - item.top >= height);
    let space = retainedSpace || spaces.find(item => item.right - item.left >= width && item.bottom - item.top >= height);
    if (!space) {
      space = spaces.sort((a, b) => Math.min(width, b.right - b.left) * Math.min(height, b.bottom - b.top) - Math.min(width, a.right - a.left) * Math.min(height, a.bottom - a.top))[0];
      if (!space) return;
      setStyle(el, "min-width", "0px");
      setStyle(el, "max-width", `${Math.min(width, space.right - space.left)}px`);
      setStyle(el, "max-height", `${Math.min(maxHeight, space.bottom - space.top)}px`);
    }
    if (retainedSpace) {
      setStyle(el, "min-width", "0px");
      setStyle(el, "max-width", `${Math.min(width, space.right - space.left)}px`);
      setStyle(el, "max-height", `${Math.min(space.bottom - space.top, Number.isFinite(authoredMaxHeight) ? authoredMaxHeight : maxHeight)}px`);
    }
    state.side = space.side;
    const finalWidth = el.offsetWidth, finalHeight = el.offsetHeight;
    const expandedHeight = Math.max(finalHeight, Math.min(height, space.bottom - space.top));
    let left = avoidAnchor ? avoid.left : x + gap;
    let top = y + gap;
    if (!avoidAnchor && left + finalWidth > bounds.right) left = x - gap - finalWidth;
    if (space.side === "below") top = space.top;
    if (space.side === "above") top = space.bottom - expandedHeight;
    if (space.side === "right") left = space.left;
    if (space.side === "left") left = space.right - finalWidth;
    left = Math.max(space.left, Math.min(left, space.right - finalWidth));
    top = Math.max(space.top, Math.min(top, space.bottom - finalHeight));
    // Fractional rounding must never consume the trigger gap or viewport inset.
    setStyle(el, "left", `${left}px`);
    setStyle(el, "top", `${top}px`);
    el.dataset.contextPlacement = space.side;
    if (opening) void el.offsetTop;
    if (!el.classList.contains("context-positioned")) el.classList.add("context-positioned");
  };
  App.clampFloatingMenu = App.positionContextMenu;
  App.layoutChatPopovers = function () {
    App.syncChatMenuChrome();
    const v = viewport(), margin = 8;
    const chat = document.querySelector(".chat-main")?.getBoundingClientRect();
    const companion = document.body.dataset.companionMode && document.body.dataset.companionMode !== "none";
    const inPane = companion && document.body.dataset.companionChat === "1" && chat?.width >= 230;
    const minX = inPane ? chat.left + margin : v.left + margin;
    const maxX = inPane ? chat.right - margin : v.left + v.width - margin;
    for (const [id, buttonId, desiredWidth] of menus) {
      const el = App.$(id);
      if (!el) continue;
      if (!el.classList.contains("chat-popup")) el.classList.add("chat-popup");
      if (el.parentElement !== document.body) document.body.appendChild(el);
      if (el.hidden || el.classList.contains("closing")) continue;
      if (el._chatPopupAnchor && !el._chatPopupAnchor.isConnected) {
        if (id === "poll-popover" && el.dataset.pollKey) {
          const replacement = [...document.querySelectorAll(".message-poll")].find(card => card.dataset.pollKey === el.dataset.pollKey && card.dataset.roomId === el.dataset.pollRoom)?.querySelector(".poll-view-votes");
          if (replacement) el._chatPopupAnchor = replacement;
        }
      }
      if (el._chatPopupAnchor && !el._chatPopupAnchor.isConnected) {
        if (id === "poll-popover") App.closePollPopover?.({ immediate:true });
        continue;
      }
      const composer = App.$("composer")?.getBoundingClientRect();
      const button = App.$(buttonId)?.getBoundingClientRect();
      const explicitAnchor = el._chatPopupAnchor?.isConnected ? el._chatPopupAnchor.getBoundingClientRect() : null;
      const anchor = explicitAnchor?.width ? explicitAnchor : button?.width ? button : composer;
      if (!anchor?.width || (companion && document.body.dataset.companionChat !== "1")) {
        App.dismissChatPopovers();
        continue;
      }
      if (id === "poll-popover" && explicitAnchor) {
        const scrollTop = el.scrollTop;
        const width = Math.min(360, maxX - minX);
        const above = Math.max(0, anchor.top - v.top - margin - 8);
        const below = Math.max(0, v.top + v.height - anchor.bottom - margin - 8);
        setStyle(el, "--chat-popup-width", `${width}px`);
        setStyle(el, "--chat-popup-max-height", `${v.height - margin * 2}px`);
        const naturalHeight = el.offsetHeight;
        // Prefer the space directly below the vote count when it fits; flip
        // above when needed, and scroll long lists within the available space.
        const useBelow = naturalHeight <= below || (naturalHeight > above && below >= above);
        setStyle(el, "--chat-popup-max-height", `${Math.max(48, useBelow ? below : above)}px`);
        const height = el.offsetHeight;
        const x = Math.max(minX, Math.min(anchor.left, maxX - width));
        const targetY = useBelow ? anchor.bottom + 8 : anchor.top - height - 8;
        const y = Math.max(v.top + margin, Math.min(targetY, v.top + v.height - height - margin));
        setStyle(el, "--chat-popup-left", `${Math.round(x)}px`);
        setStyle(el, "--chat-popup-top", `${Math.round(y)}px`);
        el.scrollTop = scrollTop;
        continue;
      }
      if (id === "room-activities-menu") {
        const width = Math.min(desiredWidth, maxX - minX);
        const below = Math.max(48, v.top + v.height - anchor.bottom - margin - 8);
        setStyle(el, "--chat-popup-width", `${width}px`);
        setStyle(el, "--chat-popup-max-height", `${below}px`);
        setStyle(el, "--chat-popup-left", `${Math.round(Math.max(minX, Math.min(anchor.right - width, maxX - width)))}px`);
        setStyle(el, "--chat-popup-top", `${Math.round(anchor.bottom + 8)}px`);
        continue;
      }
      const width = Math.min(desiredWidth, maxX - minX);
      const above = anchor.top - v.top - margin - 8;
      const below = v.top + v.height - anchor.bottom - margin - 8;
      const useBelow = explicitAnchor && below > above;
      const maxHeight = Math.max(48, Math.min(v.height - margin * 2, explicitAnchor ? Math.max(above, below) : (composer?.top || anchor.top) - v.top - 16));
      setStyle(el, "--chat-popup-width", `${width}px`);
      setStyle(el, "--chat-popup-max-height", `${maxHeight}px`);
      const rect = el.getBoundingClientRect();
      const leftSide = companion && document.body.dataset.sidebarPosition === "left";
      const targetX = leftSide ? chat.left + margin : anchor.right - width;
      const x = Math.max(minX, Math.min(targetX, maxX - width));
      const targetY = explicitAnchor ? useBelow ? anchor.bottom + 8 : anchor.top - rect.height - 8 : (composer?.top || anchor.top) - rect.height - 8;
      const y = Math.max(v.top + margin, Math.min(targetY, v.top + v.height - rect.height - margin));
      setStyle(el, "--chat-popup-left", `${Math.round(x)}px`);
      setStyle(el, "--chat-popup-top", `${Math.round(y)}px`);
    }
  };
  App.dismissChatPopovers = function () {
    App.closeComposerMoreMenu?.({ immediate:true });
    App.closeStickerPopover?.({ immediate:true });
    App.closeRoomActivitiesMenu?.();
    App.closeEmojiPopover?.();
    App.closeVoicePopover?.({ keepRecorder:true });
    App.closePollPopover?.({ immediate:true });
  };
  let pending = 0;
  App.scheduleChatPopoverLayout = function () {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; App.layoutChatPopovers(); });
  };
  App.register("ui/chat-popovers", function () {
    const sticker = App.$("sticker-popover");
    if (sticker && !App.$("btn-sticker-menu-close")) {
      const head = document.createElement("div");
      head.className = "chat-popup-heading";
      head.innerHTML = '<div class="chat-popup-heading-copy"><strong>Stickers</strong></div><button type="button" class="chat-popup-close" id="btn-sticker-menu-close" aria-label="Close stickers"></button>';
      sticker.prepend(head);
      App.$("btn-sticker-menu-close").onclick = () => App.closeStickerPopover({immediate:true});
    }
    App.layoutChatPopovers();
    // Opening, closing and live content changes can all change a menu's bounds.
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === "childList" || record.target === document.body || menus.some(([id]) => record.target.id === id))) App.scheduleChatPopoverLayout();
      if (records.some(record => record.target.closest?.(".msg-menu,.msg-text-menu,.html-hub-menu,.sticker-context-menu,.share-menu,.emoji-ctx-menu"))) scheduleContextMenuLayout();
    });
    observer.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:["hidden","class","data-companion-mode","data-companion-chat","data-sidebar-position"] });
    if (typeof ResizeObserver === "function") {
      const resize = new ResizeObserver(App.scheduleChatPopoverLayout);
      for (const el of [document.querySelector(".chat-main"), App.$("composer")]) if (el) resize.observe(el);
    }
    window.addEventListener("resize", App.scheduleChatPopoverLayout);
    window.visualViewport?.addEventListener("resize", App.scheduleChatPopoverLayout);
    window.visualViewport?.addEventListener("scroll", App.scheduleChatPopoverLayout);
    document.addEventListener("scroll", event => {
      // Internal scrolling never changes the menu's anchor or its bounds.
      if (event.target?.closest?.(".chat-popup")) return;
      App.scheduleChatPopoverLayout();
    }, true);
    window.addEventListener("resize", scheduleContextMenuLayout);
    window.visualViewport?.addEventListener("resize", scheduleContextMenuLayout);
    window.visualViewport?.addEventListener("scroll", scheduleContextMenuLayout);
    document.addEventListener("scroll", scheduleContextMenuLayout, true);
    document.addEventListener("contextmenu", event => {
      let target = null;
      for (const node of event.composedPath()) {
        if (node.matches?.("button,[role='button'],input,select,a[href],img,video,.msg-avatar,.message-seen-avatar,.sched-avatar,.reply-preview-avatar,.tip-ava,.call-user-avatar,.online-ava-img,.sticker-tile") && smallContextTarget(node, event.clientX, event.clientY)) target = node;
      }
      contextTrigger = { target, x: event.clientX, y: event.clientY, time: Date.now() };
    }, true);
    document.addEventListener("pointerdown", event => {
      if (event.target.closest?.("#composer-row")) {
        // A fading menu cannot intercept the next attempt to type.
        if (!event.target.closest("button")) App.dismissChatPopovers();
      }
    }, true);
    document.addEventListener("keydown", event => { if (event.key === "Escape") App.dismissChatPopovers(); });
  });
})(globalThis.ChatApp);
