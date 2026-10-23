/* Desktop notification policy follows account state and the displayed network clock. */
(function (App) {
  "use strict";
  App.getUserNotificationStatus = user => {
    if (user?.notificationStatus !== "dnd") return "online";
    const expiry = Number(user.notificationStatusExpiresAt);
    if (user === App.currentUser && App.statusSelectionAvailable?.() && expiry > 0 && statusNow() >= expiry) return "online";
    return "dnd";
  };
  App.isDoNotDisturb = () => App.getUserNotificationStatus(App.currentUser) === "dnd";
  App.statusSelectionAvailable = () => globalThis.chatDesktopOverlay?.version === 1;
  App.notificationStatusReady = false;
  App.desktopNotificationPolicyReady = () => !App.statusSelectionAvailable() || !!(App.currentUser && App.notificationStatusReady);
  App.syncDesktopNotificationPolicy = function () {
    globalThis.chatDesktopNotifications?.setPolicy?.({ doNotDisturb: App.isDoNotDisturb(),
      pushEnabled: !!App.pushNotifsEnabled, statusReady: App.desktopNotificationPolicyReady(),
      activeRoomId: App.getDesktopNotificationRoomId?.() || "" });
  };
  const statusNow = () => App.accurateNowMs?.() ?? (Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0));
  App.notificationDndDeadline = function (now = statusNow()) {
    // Use the same timezone and network-adjusted epoch as Time Display,
    // including daylight-saving transitions, regardless of the device clock.
    const parts = App.getESTParts?.(new Date(now));
    let morning = 0;
    if (parts && App.makeESTDate && App.shiftESTCalendarDate) {
      morning = App.makeESTDate({ ...parts, hour: 6, minute: 0, second: 0 }).getTime();
      if (morning <= now) morning = App.makeESTDate({ ...App.shiftESTCalendarDate(parts, 1), hour: 6, minute: 0, second: 0 }).getTime();
    }
    return Math.min(now + 6 * 60 * 60 * 1000, morning || Infinity);
  };
  let dndTimer = null, dndExpiryPending = false, dndLegacyPending = false;
  App.syncDndExpiry = function () {
    clearTimeout(dndTimer); dndTimer = null;
    if (!App.statusSelectionAvailable() || !App.notificationStatusReady || !App.currentUser?.code || App.currentUser.notificationStatus !== "dnd" || dndExpiryPending) return;
    const user = App.currentUser, deadline = Number(user.notificationStatusExpiresAt), now = statusNow();
    if (!Number.isFinite(deadline) || deadline <= 0) {
      if (dndLegacyPending) return;
      dndLegacyPending = true;
      // Existing installations get one persisted deadline, never a new six
      // hours on each restart. Multiple clients cannot extend it by logging in.
      void App.db.ref(`users/${user.code}/notificationStatusExpiresAt`).transaction(value => Number(value) > 0 ? undefined : App.notificationDndDeadline(now))
        .catch(() => {}).finally(() => { dndLegacyPending = false; });
      return;
    }
    if (now >= deadline && !dndExpiryPending) {
      dndExpiryPending = true;
      let retry = false;
      // Effective policy is already Online at the deadline even offline. Keep
      // the stored value until the guarded write succeeds, then retry quietly.
      App.notifyStatusChanged();
      App.writeCurrentUserBootstrapCache?.();
      const ref = App.db.ref(`users/${user.code}`);
      void ref.once("value").then(() => ref.transaction(record => {
        if (!record || record.notificationStatus !== "dnd" || Number(record.notificationStatusExpiresAt) !== deadline) return undefined;
        return { ...record, notificationStatus: "online", notificationStatusExpiresAt: null };
      }, undefined, false)).then(result => {
        if (App.currentUser !== user) return;
        if (user.notificationStatus === "dnd" && Number(user.notificationStatusExpiresAt) !== deadline) return;
        const record = result.snapshot.val();
        user.notificationStatus = record?.notificationStatus === "dnd" ? "dnd" : "online";
        user.notificationStatusExpiresAt = Number(record?.notificationStatusExpiresAt) || 0;
        App.notifyStatusChanged();
      }).catch(() => {
        retry = true;
      }).finally(() => {
        dndExpiryPending = false;
        if (retry && App.currentUser === user) { dndTimer = setTimeout(App.syncDndExpiry, 30000); dndTimer?.unref?.(); }
        else App.syncDndExpiry();
      });
      return;
    }
    dndTimer = setTimeout(App.syncDndExpiry, Math.max(1, Math.min(60000, deadline - now)));
    dndTimer?.unref?.();
  };
  App.userPresenceLabel = state => state === "dnd" ? "Do Not Disturb" : state === "online" ? "Online" : state === "idle" ? "Idle" : "Offline";
  App.getUserVisiblePresence = function (code) {
    const id = String(code || "");
    const self = id === String(App.currentUser?.code || "");
    const user = self ? App.currentUser : App.liveUserCache?.get(id) || App.schedulesPeopleByCode?.get(id);
    const state = App.appPresenceCache?.get(id) || (self && App.appPresenceSession?.connected && App.appPresenceSession?.ready
      ? (App.isAppIdleNow?.() ? "idle" : "online") : "offline");
    if (state === "offline") return state;
    if (App.getUserNotificationStatus(user) === "dnd") return "dnd";
    // "Online" enables notifications; it must not override measured idle state.
    return state;
  };
  App.notifyStatusChanged = function () {
    App.syncDesktopNotificationPolicy();
    App.refreshOpenUserProfilePresence?.();
    App.renderOnlineIndicator?.();
    App.syncProfileStatusControl?.();
    window.dispatchEvent(new CustomEvent("app:status-changed", { detail: { status: App.getUserNotificationStatus(App.currentUser) } }));
    App.syncDndExpiry();
  };
  App.initializeNotificationStatus = function () {
    const user = App.currentUser;
    if (!App.statusSelectionAvailable() || !user?.code || user.notificationStatus) return;
    // Transaction protects a DND selection made on another device during login.
    void App.db.ref(`users/${user.code}/notificationStatus`).transaction(value => value === "dnd" || value === "online" ? undefined : "online").then(result => {
      if (App.currentUser !== user) return;
      user.notificationStatus = result.snapshot.val() === "dnd" ? "dnd" : "online";
      App.notifyStatusChanged();
      App.writeCurrentUserBootstrapCache?.();
    }).catch(() => {});
  };
  let statusSubscription = null;
  App.stopNotificationStatusSync = function () {
    if (statusSubscription) {
      statusSubscription.ref.off("value", statusSubscription.callback);
    }
    statusSubscription = null;
    App.notificationStatusReady = false;
    clearTimeout(dndTimer); dndTimer = null;
    App.syncDesktopNotificationPolicy();
  };
  App.startNotificationStatusSync = function () {
    App.stopNotificationStatusSync();
    const code = String(App.currentUser?.code || "");
    if (!code || !App.db) return;
    // Both fields must come from one atomic snapshot. Independent leaf
    // callbacks could pair a newly enabled DND with yesterday's expiry.
    const subscription = { ref: App.db.ref(`users/${code}`), callback: null };
    statusSubscription = subscription;
    subscription.callback = snap => {
      if (statusSubscription !== subscription || String(App.currentUser?.code) !== code) return;
      const record = snap.val();
      const value = record?.notificationStatus;
      const next = value === "online" || value === "dnd" ? value : null;
      const expiry = Number(record?.notificationStatusExpiresAt) || 0;
      if (App.notificationStatusReady && App.currentUser.notificationStatus === next && App.currentUser.notificationStatusExpiresAt === expiry) return;
      App.currentUser.notificationStatus = next;
      App.currentUser.notificationStatusExpiresAt = expiry;
      App.notificationStatusReady = true;
      App.notifyStatusChanged();
      App.writeCurrentUserBootstrapCache?.();
    };
    subscription.ref.on("value", subscription.callback);
  };
  App.setNotificationStatus = async function (status) {
    if (!App.statusSelectionAvailable() || !App.currentUser?.code || !["online", "dnd"].includes(status)) return false;
    const user = App.currentUser;
    const previous = user.notificationStatus;
    const previousExpiry = user.notificationStatusExpiresAt;
    user.notificationStatus = status;
    user.notificationStatusExpiresAt = status === "dnd" ? App.notificationDndDeadline() : null;
    App.notifyStatusChanged();
    App.writeCurrentUserBootstrapCache?.();
    try {
      await App.db.ref(`users/${user.code}`).update({ notificationStatus: status, notificationStatusExpiresAt: user.notificationStatusExpiresAt });
      return true;
    } catch {
      if (App.currentUser === user && user.notificationStatus === status) {
        user.notificationStatus = previous;
        user.notificationStatusExpiresAt = previousExpiry;
        App.notifyStatusChanged();
        App.writeCurrentUserBootstrapCache?.();
      }
      App.showToast?.({ title: "Status not saved", body: "Please try changing your status again.", duration: 3500 });
      return false;
    }
  };
  let menu = null, anchor = null, closeTimer = null;
  App.closeProfileStatusMenu = function (immediate = false) {
    if (!menu || menu.hidden) return;
    clearTimeout(closeTimer);
    menu.classList.remove("open");
    menu.classList.add("closing");
    anchor?.setAttribute("aria-expanded", "false");
    const hide = () => { menu.hidden = true; menu.classList.remove("closing"); };
    if (immediate) hide(); else closeTimer = setTimeout(hide, 150);
  };
  App.openProfileStatusMenu = function (avatar, event = null) {
    if (!App.statusSelectionAvailable() || !App.currentUser || !avatar) return;
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "profile-status-menu";
      menu.className = "msg-menu profile-status-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Set your status");
      menu.hidden = true;
      menu.innerHTML = [ ["online", "Online"], ["dnd", "Do Not Disturb"] ].map(([state, label]) => `<button type="button" class="msg-menu-btn" role="menuitemradio" data-status="${state}"><span class="msg-menu-icon"><span class="profile-status-dot" data-state="${state}"></span></span><span class="msg-menu-label">${label}</span></button>`).join("");
      menu.addEventListener("click", event => {
        const button = event.target.closest("[data-status]");
        if (!button) return;
        const next = button.dataset.status;
        App.closeProfileStatusMenu();
        void App.setNotificationStatus(next);
      });
      menu.addEventListener("keydown", event => {
        const buttons = [...menu.querySelectorAll("button")];
        if (event.key === "Escape") { event.preventDefault(); App.closeProfileStatusMenu(); anchor?.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          buttons[(buttons.indexOf(document.activeElement) + direction + buttons.length) % buttons.length]?.focus();
        }
      });
      document.body.appendChild(menu);
    }
    if (!menu.hidden && !menu.classList.contains("closing") && anchor === avatar) { App.closeProfileStatusMenu(); return; }
    clearTimeout(closeTimer);
    App.closeMsgMenu?.(true);
    anchor = avatar;
    for (const button of menu.querySelectorAll("[data-status]")) button.setAttribute("aria-checked", String(button.dataset.status === App.getUserNotificationStatus(App.currentUser)));
    avatar.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    menu.classList.remove("closing");
    menu.classList.add("open");
    App.positionContextMenu(menu, { anchor: avatar, x: event?.clientX, y: event?.clientY, avoidAnchor: !event });
    menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  };
  App.syncProfileStatusControl = function () {
    if (menu && !menu.hidden) for (const button of menu.querySelectorAll("[data-status]")) button.setAttribute("aria-checked", String(button.dataset.status === App.getUserNotificationStatus(App.currentUser)));
    const avatar = App.userProfileCardEl?.querySelector(".user-profile-avatar");
    if (!avatar) return;
    const available = App.statusSelectionAvailable() && App.userProfilePinnedCode === App.currentUser?.code;
    avatar.classList.toggle("can-set-status", available);
    if (available) {
      avatar.tabIndex = 0;
      avatar.setAttribute("role", "button");
      avatar.setAttribute("aria-label", `Change status: ${App.userPresenceLabel(App.getUserNotificationStatus(App.currentUser))}`);
      avatar.setAttribute("aria-haspopup", "menu");
    }
  };
  App.register("profiles/status", function () {
    App.syncDesktopNotificationPolicy();
    document.addEventListener("visibilitychange", App.syncDndExpiry);
    window.addEventListener("focus", App.syncDndExpiry);
    const hit = target => {
      const avatar = target?.closest?.("#user-profile-card .user-profile-avatar");
      return avatar && App.statusSelectionAvailable() && App.userProfilePinnedCode === App.currentUser?.code ? avatar : null;
    };
    for (const eventName of ["click", "contextmenu"]) document.addEventListener(eventName, event => {
      const avatar = hit(event.target);
      if (!avatar) return;
      event.preventDefault(); event.stopPropagation();
      App.openProfileStatusMenu(avatar, eventName === "contextmenu" ? event : null);
    }, true);
    document.addEventListener("keydown", event => {
      const avatar = hit(event.target);
      if (!avatar || !["Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); App.openProfileStatusMenu(avatar);
    }, true);
    document.addEventListener("pointerdown", event => {
      if (menu && !menu.hidden && !menu.contains(event.target) && !anchor?.contains(event.target)) App.closeProfileStatusMenu();
    }, true);
    window.addEventListener("blur", () => App.closeProfileStatusMenu(true));
    window.addEventListener("resize", () => App.closeProfileStatusMenu(true));
  });
})(globalThis.ChatApp);
