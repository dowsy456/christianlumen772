/* Read receipts are message-specific. Only the latest rendered message owns a
 * visible receipt row; merely being online or opening a room is not a read. */
(function (App) {
  "use strict";
  App.pruneReadReceipts = async function (room, message) {
    const key = String(message?._key || "");
    const createdAt = Number(message?.createdAt) || App.firebasePushKeyTimestamp?.(key) || 0;
    if (!room || !key || !createdAt || message.__stub) return;
    const marker = { key, createdAt };
    // A room-level transaction orders cleanup with receipt writes. Late clients
    // cannot erase a newer message's receipts or recreate an older receipt row.
    const ref = App.db.ref(`readReceipts/${room}`);
    const nextReceipts = current => {
      const next = { _latest: marker };
      if (current?._clearedAt) next._clearedAt = current._clearedAt;
      if (current?.[key]) next[key] = current[key];
      return next;
    };
    const result = await ref.transaction(current => {
      if (createdAt <= Number(current?._clearedAt || 0)) return;
      const prior = current?._latest;
      if (prior && (Number(prior.createdAt) > createdAt || Number(prior.createdAt) === createdAt && String(prior.key).localeCompare(key) > 0)) return;
      if (prior?.key === key && Object.keys(current).every(item => item === "_latest" || item === "_clearedAt" || item === key)) return;
      return nextReceipts(current);
    }, undefined, false);
    const prior = result.snapshot?.val()?._latest;
    // Deleting the latest message legitimately makes an earlier message latest.
    // Recheck the exact previous owner, then compare-and-swap so a concurrent
    // newer message always wins over this repair.
    if (!result.committed && prior?.key && prior.key !== key) {
      const stillExists = await App.db.ref(`messages/${room}/${prior.key}`).once("value");
      if (!stillExists.exists()) return ref.transaction(current => {
        if (createdAt <= Number(current?._clearedAt || 0)) return;
        if (current?._latest?.key !== prior.key || current._latest.createdAt !== prior.createdAt) return;
        return nextReceipts(current);
      }, undefined, false);
    }
    return result;
  };
  App.saveLatestReadReceipt = async function (state, code) {
    if (state.message?.t === "system") return;
    await App.pruneReadReceipts(state.room, state.message);
    if (App.readReceiptState !== state || App.currentUser?.code !== code || !App.canSeeLatestMessage()) return;
    return App.db.ref(`readReceipts/${state.room}`).transaction(current => {
      if (App.readReceiptState !== state || !App.canSeeLatestMessage()) return;
      if (current === null) return null;
      if (current?._latest?.key !== state.key) return;
      return { ...(current._clearedAt ? { _clearedAt: current._clearedAt } : {}), _latest: current._latest, [state.key]: { ...(current[state.key] || {}), [code]: App.firebase.database.ServerValue.TIMESTAMP } };
    }, undefined, false);
  };
  App.getLatestReceiptMessage = function () {
    let latest = null;
    for (const [key, message] of App.msgDataByKey || []) {
      if (!latest || App.compareMessagesChronologically({ ...message, _key: key }, latest) > 0) latest = { ...message, _key: key };
    }
    return latest;
  };
  App.getReceiptViewerCodes = function (receipts, authorCode) {
    const author = String(authorCode || "");
    return Object.keys(receipts || {}).filter(code => code !== author &&
      !App.isGhostModeEnabledForRoom?.(App.currentRoomId, code)).sort();
  };
  App.getVisibleReceiptRect = function (element) {
    if (!element?.isConnected) return null;
    const source = element.getBoundingClientRect();
    if (source.width <= 0 || source.height <= 0) return null;
    const visual = window.visualViewport;
    const rect = {
      left: Math.max(source.left, visual?.offsetLeft || 0),
      top: Math.max(source.top, visual?.offsetTop || 0),
      right: Math.min(source.right, (visual?.offsetLeft || 0) + (visual?.width || window.innerWidth)),
      bottom: Math.min(source.bottom, (visual?.offsetTop || 0) + (visual?.height || window.innerHeight))
    };
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.inert || style.display === "none" || style.visibility !== "visible" || style.contentVisibility === "hidden" || Number(style.opacity) <= 0.05) return null;
      if (node === element) continue;
      const clip = node.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
        rect.left = Math.max(rect.left, clip.left);
        rect.right = Math.min(rect.right, clip.right);
      }
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
        rect.top = Math.max(rect.top, clip.top);
        rect.bottom = Math.min(rect.bottom, clip.bottom);
      }
    }
    // A header, one clipped pixel, or a sliver of an attachment is not a read.
    if (rect.right - rect.left < Math.min(source.width, 48) || rect.bottom - rect.top < Math.min(source.height, 20)) return null;
    return rect;
  };
  App.getReceiptPaintStack = function (element) {
    const stack = [];
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const positioned = style.position !== "static";
      const indexed = style.zIndex !== "auto";
      const parentDisplay = indexed && node.parentElement ? getComputedStyle(node.parentElement).display : "";
      const context = node === document.documentElement || style.position === "fixed" || style.position === "sticky" ||
        (indexed && (positioned || /flex|grid/.test(parentDisplay))) || Number(style.opacity) < 1 ||
        style.transform !== "none" || style.filter !== "none" || style.perspective !== "none" ||
        style.isolation === "isolate" || /paint|layout|strict|content/.test(style.contain) ||
        /transform|opacity|filter/.test(style.willChange) ||
        (style.backdropFilter && style.backdropFilter !== "none") ||
        (style.containerType && style.containerType !== "normal");
      if (context) stack.unshift({ element: node, level: Number(style.zIndex) || 0 });
    }
    return stack;
  };
  App.isReceiptOverlayAbove = function (overlay, contentStack) {
    const overlayStack = App.getReceiptPaintStack(overlay);
    let common = 0;
    while (overlayStack[common]?.element === contentStack[common]?.element && overlayStack[common] && contentStack[common]) common++;
    const layer = overlayStack[common];
    const content = contentStack[common];
    if (!layer) return false;
    if (!content) return layer.level >= 0;
    if (layer.level !== content.level) return layer.level > content.level;
    // Equal stacking levels paint in tree order. Comparing the first distinct
    // stacking context also respects an ancestor's level, unlike max(z-index).
    return !!(layer.element.compareDocumentPosition(content.element) & 2);
  };
  App.canSeeMessage = function (room, key) {
    const state = { room, key };
    if (!state?.key || state.room !== App.currentRoomId || !App.currentUser || App.bulkLoading || App.roomLoadingActive || document.hidden || !document.hasFocus() || App.desktopPresenceFocused === false ||
        App.getStoredPlace() !== `room:${state.room}` ||
        App.views.chat?.dataset.active !== "true") return false;
    const mode = document.body.dataset;
    // Require an active window as Electron may keep minimized contents alive.
    if (App.$("__shift_z_blackout__")?.classList.contains("on") ||
        (mode.activityMode === "1" && mode.activityChat !== "1") ||
        (mode.callChatMode === "1" && mode.callChat !== "1") ||
        (mode.timeChatMode === "1" && mode.timeChat !== "1") ||
        (mode.companionChat === "1" && (mode.membersSidebar === "1" || App.membersListVisible))) return false;
    if (["modal", "media-modal"].some(id => {
      if (id === "modal" && !App.timeDisplayStage && App.isTimeDisplayExpanded?.() && App.timeChatOpen) return false;
      const element = App.$(id); return element && !element.hidden && element.getAttribute("aria-hidden") !== "true";
    }) || (document.body.dataset.mobileUi === "1" && (document.body.dataset.mobileNav === "1" || App.membersListVisible))) return false;
    const row = App.msgElByKey.get(state.key);
    const clearedAt = Number(App.roomsMetaCache?.get(state.room)?.messagesClearedAt) || 0;
    const message = App.msgDataByKey?.get(state.key);
    if (clearedAt && (Number(message?.createdAt) || App.firebasePushKeyTimestamp?.(state.key) || 0) <= clearedAt) return false;
    const bubble = row?.querySelector(".bubble") || (row?.classList.contains("system-message") ? row : null);
    if (!row?.isConnected || !bubble || !App.messagesEl) return false;
    // Hit-test actual message content, not the sender/timestamp or the bubble's
    // empty area. This also catches menus, a call stage, mobile drawers and
    // arbitrary app surfaces that overlap only part of the chat.
    const content = bubble.querySelectorAll(".bubble-text,.sticker-message,.att-item,.poll-question,.poll-options,.system-message-content");
    if (!content.length || typeof document.elementFromPoint !== "function") return false;
    const contentStack = App.getReceiptPaintStack(bubble);
    const passiveOverlays = Array.from(document.querySelectorAll(
      "body > *,[role='dialog'],[role='menu'],[popover],.user-profile-popover,.games-stage-overlay,.call-menu,.mobile-drawer-scrim"
    )).filter(element => {
      if (element.contains(bubble) || bubble.contains(element) || element.hidden) return false;
      const style = getComputedStyle(element);
      return style.pointerEvents === "none" && style.display !== "none" && style.visibility === "visible" &&
        Number(style.opacity) > 0 && (style.position === "fixed" || style.position === "absolute") &&
        (style.backgroundImage !== "none" || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(style.backgroundColor)) &&
        App.isReceiptOverlayAbove(element, contentStack);
    }).map(element => element.getBoundingClientRect());
    return Array.from(content).some(element => {
      if (element.classList.contains("is-loading") || element.dataset.loading === "1") return false;
      const rect = App.getVisibleReceiptRect(element);
      if (!rect) return false;
      const width = rect.right - rect.left;
      const height = rect.bottom - rect.top;
      // Require a readable stripe of content; scrolling under a floating
      // window must never produce a receipt.
      for (const band of [0.2, 0.5, 0.8]) {
        const y = rect.top + height * band;
        const xs = [0.08, 0.3, 0.5, 0.7, 0.92].map(fraction => rect.left + width * fraction);
        if (xs.every(x => {
          if (passiveOverlays.some(overlay => x >= overlay.left && x <= overlay.right && y >= overlay.top && y <= overlay.bottom)) return false;
          const top = document.elementFromPoint(x, y);
          return top && bubble.contains(top);
        })) return true;
      }
      return false;
    });
  };
  App.canSeeLatestMessage = function () {
    const state = App.readReceiptState;
    return !!state && !App.isGhostModeEnabledForRoom?.(state.room, App.currentUser?.code) && App.canSeeMessage(state.room, state.key);
  };
  App.renderReadReceipts = function () {
    const state = App.readReceiptState;
    if (!state?.key || state.room !== App.currentRoomId) return;
    const row = App.msgElByKey.get(state.key);
    // Logs still clear unread counts, but never display readers, including
    // receipts saved by an older client.
    if (state.message?.t === "system" || row?.classList.contains("system-message")) {
      state.element?.remove(); state.element = null; return;
    }
    const time = row?.querySelector(".bubble-time");
    const header = time?.parentElement;
    if (!header) return;
    const viewers = App.getReceiptViewerCodes(state.receipts, state.author);
    if (!viewers.length) { state.element?.remove(); state.element = null; return; }
    let element = state.element;
    if (!element || !element.isConnected) {
      element = document.createElement("div");
      element.className = "message-seen";
      element.dataset.messageKey = state.key;
      const label = document.createElement("span");
      label.className = "message-seen-label";
      label.textContent = "Seen by";
      const avatars = document.createElement("div");
      avatars.className = "message-seen-avatars";
      element.append(label, avatars);
      state.element = element;
    }
    const avatars = element.querySelector(".message-seen-avatars");
    const existing = new Map(Array.from(avatars.children).map(avatar => [avatar.dataset.usercode, avatar]));
    for (const code of viewers) {
      let avatar = existing.get(code);
      if (!avatar) {
        avatar = document.createElement("button");
        avatar.type = "button";
        avatar.className = "message-seen-avatar";
        avatar.dataset.usercode = code;
        // Use the same delegated profile toggle and context menu as message
        // avatars, including clicks on the cropped image inside the button.
        avatars.appendChild(avatar);
      }
      existing.delete(code);
      const user = App.liveUserCache.get(code) || (App.currentUser?.code === code ? App.currentUser : { code, username: "User" });
      const name = user.displayName || user.username || "User";
      avatar.setAttribute("aria-label", `Seen by ${name}. Toggle profile`);
      avatar.dataset.tooltip = name;
      App.applyAvatar(avatar, user);
      App.ensureLiveUserListener(code);
    }
    for (const avatar of existing.values()) avatar.remove();
    if (element.parentElement !== header || time.nextElementSibling !== element) time.after(element);
  };
  App.stopReadReceipts = function () {
    const state = App.readReceiptState;
    if (state?.ref && state.cb) state.ref.off("value", state.cb);
    state?.element?.remove();
    clearTimeout(App.readReceiptTimer);
    App.readReceiptTimer = null;
    App.readReceiptState = null;
  };
  App.scheduleReceiptRead = function () {
    if (App.isRoomActivelyRead?.(App.currentRoomId)) App.scheduleLastSeenBump?.(App.currentRoomId);
    const state = App.readReceiptState;
    const code = App.currentUser?.code;
    // Once recorded, surface changes cannot undo a read. Avoid the geometry
    // and paint-order work for completed receipts or an invalid room/user.
    if (!state?.key || state.message?.t === "system" || state.room !== App.currentRoomId || !code || state.receipts?.[code] || state.writing) {
      clearTimeout(App.readReceiptTimer); App.readReceiptTimer = null; return;
    }
    if (!App.canSeeLatestMessage()) {
      clearTimeout(App.readReceiptTimer); App.readReceiptTimer = null; return;
    }
    if (App.readReceiptTimer) return;
    App.readReceiptTimer = setTimeout(async () => {
      App.readReceiptTimer = null;
      if (App.readReceiptState !== state || App.currentUser?.code !== code || state.receipts?.[code] || !App.canSeeLatestMessage()) return;
      state.writing = true;
      try {
        const result = await App.saveLatestReadReceipt(state, code);
        if (result?.committed && App.readReceiptState === state) {
          state.receipts[code] = Date.now();
          App.renderReadReceipts();
        }
      } catch (error) {
        console.warn("Read receipt could not be saved", error?.code || "connection unavailable");
      } finally { state.writing = false; }
    }, 450);
  };
  App.syncReadReceipts = function () {
    if (!App.currentRoomId || App.getStoredPlace() !== `room:${App.currentRoomId}` || App.bulkLoading || App.msgHasNewerHistory) {
      App.stopReadReceipts(); return;
    }
    const latest = App.getLatestReceiptMessage();
    if (!latest || latest.__stub) { App.stopReadReceipts(); return; }
    let state = App.readReceiptState;
    if (state?.room !== App.currentRoomId || state?.key !== latest._key) {
      App.stopReadReceipts();
      state = { room: App.currentRoomId, key: latest._key, message: latest, author: latest.userCode || "", receipts: {}, element: null };
      App.readReceiptState = state;
      void App.pruneReadReceipts(state.room, latest).catch(error => console.warn("Read receipt cleanup unavailable", error?.code));
      state.ref = App.db.ref(`readReceipts/${state.room}/${state.key}`);
      state.cb = snap => {
        if (App.readReceiptState !== state) return;
        state.receipts = snap.val() || {};
        App.renderReadReceipts();
        App.scheduleReceiptRead();
      };
      state.ref.on("value", state.cb, error => console.warn("Read receipts unavailable", error?.code));
    }
    App.renderReadReceipts();
    App.scheduleReceiptRead();
  };
  App.queueReadReceiptSync = function () {
    if (App.readReceiptRaf) return;
    App.readReceiptRaf = requestAnimationFrame(() => {
      App.readReceiptRaf = 0;
      App.syncReadReceipts();
    });
  };
  App.queueReceiptVisibilityCheck = function () {
    if (App.receiptVisibilityRaf) return;
    App.receiptVisibilityRaf = requestAnimationFrame(() => {
      App.receiptVisibilityRaf = 0;
      App.scheduleReceiptRead();
    });
  };
  App.register("chat/read-receipts", function () {
    App.readReceiptState = null;
    // Observe message rows only: receipt/avatar changes must never loop.
    if (App.messagesListEl) new MutationObserver(App.queueReadReceiptSync).observe(App.messagesListEl, { childList: true });
    App.messagesEl?.addEventListener("scroll", App.scheduleReceiptRead, { passive: true });
    window.addEventListener("focus", App.queueReadReceiptSync);
    window.addEventListener("blur", App.scheduleReceiptRead);
    window.addEventListener("resize", App.queueReadReceiptSync);
    document.addEventListener("visibilitychange", App.queueReadReceiptSync);
    // Observe all surface transitions, including cloak attached to <html>.
    // Receipt avatar updates are excluded so they cannot feed back into sync.
    new MutationObserver(records => {
      if (records.some(record => !App.messagesListEl?.contains(record.target))) App.queueReceiptVisibilityCheck();
    }).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "open", "class", "style", "data-active", "data-mobile-nav", "data-mobile-ui", "data-activity-mode", "data-activity-chat", "data-call-chat-mode", "data-call-chat", "data-time-chat-mode", "data-time-chat", "data-companion-mode", "data-companion-chat", "data-members-sidebar"]
    });
    document.addEventListener("transitionend", App.queueReceiptVisibilityCheck, true);
    document.addEventListener("animationend", App.queueReceiptVisibilityCheck, true);
    window.visualViewport?.addEventListener("resize", App.queueReceiptVisibilityCheck);
    window.visualViewport?.addEventListener("scroll", App.queueReceiptVisibilityCheck);
    if (typeof ResizeObserver !== "undefined" && App.messagesListEl) new ResizeObserver(App.queueReadReceiptSync).observe(App.messagesListEl);
  });
})(globalThis.ChatApp);
