/* profiles/avatars: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.getAvatarFallbackSize = function (el) {
  if (!el) return 40;
  if (el.classList.contains("call-user-avatar")) return 96;
  if (el.classList.contains("call-share-avatar")) return 76;
  if (el.classList.contains("user-profile-avatar")) return 92;
  if (el.classList.contains("user-profile-classmate-avatar")) return 34;
  if (el.classList.contains("call-viewer-avatar")) return 28;
  if (el.classList.contains("room-avatar-image") || el.classList.contains("room-avatar")) return 42;
  if (el.classList.contains("sched-avatar")) return 42;
  if (el.classList.contains("msg-avatar")) return 34;
  if (el.classList.contains("reply-preview-avatar")) return 18;
  if (el.classList.contains("tip-ava")) return 22;
  if (el.classList.contains("online-ava-img")) return 28;
  if (el.classList.contains("mini-avatar") && el.closest?.(".me-pill-dock")) return 24;
  if (el.classList.contains("mini-avatar")) return 32;
  return 40;
};
App.getMediaFrameSize = function (el, fallback = 40) {
  if (!el) return Math.max(1, Number(fallback) || 40);
  const rect = el.getBoundingClientRect?.();
  let size = Math.round(rect?.width || 0);
  if (!size || size < 2) {
    try {
      const computed = getComputedStyle(el);
      size = Math.round(parseFloat(computed.width) || parseFloat(computed.height) || 0);
    } catch {}
  }
  if (!size || size < 2) size = App.getAvatarFallbackSize(el) || fallback;
  return Math.max(1, size);
};
App.formatMediaTransform = function (t, sizePx, legacySizePx = 84) {
  const size = Math.max(1, Number(sizePx) || 1);
  const tpx = App.transformToPixels(t, size, legacySizePx);
  const x = Math.round((Number(tpx.x) || 0) * 1000) / 1000;
  const y = Math.round((Number(tpx.y) || 0) * 1000) / 1000;
  const scale = Math.max(0.2, Number(tpx.scale) || 1);
  return `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;
};
App.formatMediaTransformRelative = function (t, legacySizePx = 84) {
  const tr = App.normalizeTransformToRel(t, legacySizePx);
  const xPct = Math.round((-50 + (Number(tr.x) || 0) * 100) * 10000) / 10000;
  const yPct = Math.round((-50 + (Number(tr.y) || 0) * 100) * 10000) / 10000;
  const scale = Math.max(0.2, Number(tr.scale) || 1);
  return `translate(${xPct}%, ${yPct}%) scale(${scale})`;
};
App.formatMediaTransformCss = function (t, sizeCss, legacySizePx = 84) {
  const tr = App.normalizeTransformToRel(t, legacySizePx);
  const x = Math.round((Number(tr.x) || 0) * 100000) / 100000;
  const y = Math.round((Number(tr.y) || 0) * 100000) / 100000;
  const scale = Math.max(0.2, Number(tr.scale) || 1);
  const size = String(sizeCss || "1px");
  return `translate(calc(-50% + (${x} * ${size})), calc(-50% + (${y} * ${size}))) scale(${scale})`;
};
App.applyCroppedImage = function (img, src, transform, sizePx, legacySizePx = 84) {
  if (!img) return;
  const nextSrc = String(src || App.defaultStickmanDataURL());
  const tr = App.normalizeTransformToRel(transform, legacySizePx);
  // Both stored offsets use FRAME WIDTH, including banners. CSS percentage
  // margins use the containing block's width, so this needs no layout read or
  // resize observer and preserves exactly the editor's crop at every size.
  const left = `${50 + (Number(tr.x) || 0) * 100}%`;
  const marginTop = `${(Number(tr.y) || 0) * 100}%`;
  const nextTransform = `translate(-50%, -50%) scale(${Math.max(0.2, Number(tr.scale) || 1)})`;
  img.classList.add("app-cropped-image");
  img.parentElement?.classList.add("app-media-frame");
  img.decoding = "async";
  img.draggable = false;
  if (img.getAttribute("src") !== nextSrc) img.src = nextSrc;
  if (img.style.left !== left) img.style.left = left;
  if (img.style.marginTop !== marginTop) img.style.marginTop = marginTop;
  if (img.style.transform !== nextTransform) img.style.transform = nextTransform;
};
App.applyAvatar = function (el, user, { live = true } = {}) {
  if (!el) return;
  const isDirectImg = String(el.tagName || "").toLowerCase() === "img";
  let img = isDirectImg ? el : el.querySelector("img");
  if (!img) {
    el.innerHTML = "";
    img = document.createElement("img");
    img.draggable = false;
    el.appendChild(img);
  }
  const frameEl = isDirectImg ? el.parentElement || el : el;
  const userCode = String(user?.code || user?.userCode || el.dataset?.usercode || frameEl.dataset?.usercode || "").trim();
  frameEl.classList.add("app-avatar-frame");
  const preview = !live || !!frameEl.closest?.("[data-media-preview]");
  if (userCode) {
    try {
      el.dataset.avatarUsercode = userCode;
    } catch {}
    if (!preview && App.db && App.liveUserListeners) App.ensureLiveUserListener(userCode);
  }
  // Crops use percentages, so updating an avatar never needs a synchronous
  // layout measurement (especially costly for a full room roster).
  App.applyCroppedImage(img, String(user?.photoDataURL || App.defaultStickmanDataURL()), user?.photoTransform, App.getAvatarFallbackSize(frameEl));
};
App.applyBanner = function (el, user, { live = true } = {}) {
  if (!el) return;
  const code = String(user?.code || user?.userCode || "").trim();
  el.classList.add("app-media-frame", "app-banner-frame");
  if (code) el.dataset.bannerUsercode = code;
  let img = el.querySelector(".app-cropped-image, .user-profile-banner-img, img");
  if (!img) {
    img = document.createElement("img");
    img.alt = "";
    img.className = "user-profile-banner-img";
    el.prepend(img);
  }
  const src = String(user?.bannerDataURL || "");
  img.hidden = !src;
  const fallback = el.querySelector(".user-profile-banner-fallback");
  if (fallback) fallback.hidden = !!src;
  if (src) App.applyCroppedImage(img, src, user?.bannerTransform, 340, 340);
  if (live && code && !el.closest?.("[data-media-preview]") && App.db && App.liveUserListeners) App.ensureLiveUserListener(code);
};
App.applyRoomIcon = function (el, roomId, meta = App.roomsMetaCache?.get(roomId)) {
  if (!el) return;
  const direct = String(el.tagName || "").toLowerCase() === "img";
  const frame = direct ? el.parentElement : el;
  if (!frame) return;
  let img = direct ? el : el.querySelector("img");
  if (!img) { img = document.createElement("img"); frame.appendChild(img); }
  frame.classList.add("app-avatar-frame");
  el.dataset.roomIconId = String(roomId || "");
  App.applyCroppedImage(img, meta?.photoDataURL, meta?.photoTransform, 42, 132);
};
App.refreshRenderedRoomIcon = function (roomId) {
  const id = String(roomId || "");
  const meta = App.roomsMetaCache?.get(id);
  document.querySelectorAll("[data-room-icon-id]").forEach(el => {
    if (el.dataset.roomIconId === id) App.applyRoomIcon(el, id, meta);
  });
};
App.hydrateMediaSurfaces = function (root = document) {
  const selector = "[data-avatar-usercode], [data-banner-usercode], [data-room-icon-id]";
  const nodes = [...(root.querySelectorAll?.(selector) || [])];
  if (root.matches?.(selector)) nodes.unshift(root);
  for (const el of nodes) {
    if (el.closest?.("[data-media-preview]")) continue;
    const code = el.dataset.avatarUsercode || el.dataset.bannerUsercode;
    const user = App.liveUserCache?.get(code) || (String(App.currentUser?.code || "") === code ? App.currentUser : null);
    if (el.hasAttribute("data-room-icon-id")) App.applyRoomIcon(el, el.dataset.roomIconId);
    else if (user && el.hasAttribute("data-banner-usercode")) App.applyBanner(el, user);
    else if (user) App.applyAvatar(el, user);
    else if (code && App.db && App.liveUserListeners) App.ensureLiveUserListener(code);
  }
};
App.refreshRenderedAvatarForUser = function (user) {
  const code = String(user?.code || "").trim();
  if (!code) return;
  const safeCode = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(code) : code.replace(/"/g, '\\"');
  const frames = new Set(document.querySelectorAll(`[data-avatar-usercode="${safeCode}"]`));
  document.querySelectorAll(`[data-banner-usercode="${safeCode}"]`).forEach(el => {
    if (!el.closest?.("[data-media-preview]")) App.applyBanner(el, user);
  });
  document.querySelectorAll(`.msg-avatar[data-usercode="${safeCode}"], ` + `.reply-preview-avatar[data-usercode="${safeCode}"], ` + `.reply-target-avatar[data-usercode="${safeCode}"], ` + `.sched-avatar[data-usercode="${safeCode}"], ` + `.tip-ava[data-usercode="${safeCode}"], ` + `.call-user-avatar[data-usercode="${safeCode}"], ` + `.ping-item-avatar[data-usercode="${safeCode}"]`).forEach(el => frames.add(el));
  document.querySelectorAll(`.online-ava[data-usercode="${safeCode}"] .online-ava-img`).forEach(el => frames.add(el));
  if (String(App.currentUser?.code || "") === code) {
    const self = App.$("me-avatar");
    if (self) frames.add(self);
  }
  frames.forEach(el => { if (!el.closest?.("[data-media-preview]")) App.applyAvatar(el, user); });
  if (App.callMembersCache?.some(member => String(member.code) === code)) App.callPublishDesktopOverlay?.();
};
// Subscribe only to public profile leaves. Settings (custom audio/backgrounds),
// private libraries and personal preferences never ride on an avatar lookup.
App.PUBLIC_PROFILE_FIELDS = ["username", "usernameLower", "displayName", "displayNameLower", "bio", "photoDataURL", "photoTransform", "bannerDataURL", "bannerTransform", "htmlActivity", "htmlActivities", "htmlActivitiesVersion", "gameActivitySessions", "spotifySessions", "notificationStatus", "adminGhostRooms"];
App.fieldGroupRef = function (path, fields) {
  const subscriptions = new Map();
  return {
    on(event, callback, canceled) {
      subscriptions.get(callback)?.();
      const record = {}, pending = new Set(fields), bindings = [];
      let active = true, queued = false;
      const publish = () => {
        if (!active || pending.size || queued) return;
        queued = true;
        Promise.resolve().then(() => {
          queued = false;
          if (active) callback({ val: () => ({ ...record }), exists: () => Object.keys(record).length > 0 });
        });
      };
      subscriptions.set(callback, () => { active = false; for (const item of bindings) item.ref.off("value", item.callback); });
      for (const field of fields) {
        const ref = App.db.ref(`${path}/${field}`);
        const childCallback = snap => {
          const value = snap.val();
          if (value === null || value === undefined) delete record[field]; else record[field] = value;
          pending.delete(field); publish();
        };
        bindings.push({ ref, callback: childCallback });
        ref.on("value", childCallback, canceled);
      }
      return callback;
    },
    off(event, callback) {
      if (callback) { subscriptions.get(callback)?.(); subscriptions.delete(callback); }
      else { for (const stop of subscriptions.values()) stop(); subscriptions.clear(); }
    }
  };
};
App.readUserProfile = async function (code) {
  if (!code) return null;
  const values = await Promise.all(App.PUBLIC_PROFILE_FIELDS.map(async field => [field, (await App.db.ref(`users/${code}/${field}`).once("value")).val()]));
  const rec = Object.fromEntries(values.filter(([, value]) => value !== null && value !== undefined));
  return typeof rec.username === "string" && rec.username.trim() ? rec : null;
};
// All saved references use an immutable account ID. Resolve names from the
// current profile first; snapshot labels are only an offline/deleted fallback.
App.getUserIdentity = function (code, fallback = {}) {
  const id = String(code || "").trim();
  const current = id && String(App.currentUser?.code || "") === id ? App.currentUser : null;
  const live = id ? App.liveUserCache?.get(id) : null;
  const profile = live || current;
  const username = profile?.username || fallback.username || fallback.fromUsername || "User";
  return { ...fallback, ...(profile || {}), code: id, username,
    displayName: profile?.displayName || profile?.username || fallback.displayName || username };
};
App.getUserDisplayName = function (code, fallback = {}) {
  return App.getUserIdentity(code, fallback).displayName;
};
App.refreshUserIdentityReferences = function (code) {
  for (const [roomId, meta] of App.roomsMetaCache || []) {
    if (meta?.lastMessageAuthorCode === code || [...(App.notificationRoomTails?.get(roomId)?.values() || [])].some(message => message?.userCode === code || message?.system?.userCode === code)) App.updateRoomListItem?.(roomId);
  }
};
App.stopLiveUserListeners = function () {
  for (const [code, v] of App.liveUserListeners) {
    App.cancelLiveUpdate?.(`profile-media:${code}`);
    try {
      v.ref.off("value", v.cb);
    } catch {}
  }
  App.liveUserListeners.clear();
  App.liveUserCache.clear();
};
App.ensureLiveUserListener = function (userCode) {
  const code = (userCode || "").trim();
  if (!code) return;
  if (App.liveUserListeners.has(code)) return;
  const ref = App.fieldGroupRef(`users/${code}`, App.PUBLIC_PROFILE_FIELDS);
  const listener = { ref, cb: null, revision: 0, identityKey: null, ownership: null, activityKey: null };
  const cb = async snap => {
    if (App.liveUserListeners.get(code) !== listener) return;
    const revision = ++listener.revision;
    const rec = snap.val() || {};
    // Memberships and old presence can outlive an account. An absent or partial
    // profile is not a person called "User". Remember the missing profile so a
    // cached Calendar author cannot put it back while its listener is active.
    if (!snap.exists() || typeof rec.username !== "string" || !rec.username.trim()) {
      listener.identityKey = listener.ownership = listener.activityKey = null;
      App.liveUserCache.set(code, null);
      if (String(App.currentUser?.code || "") === code && !App.passwordChangeInFlight) {
        if (App.invalidateAccountSession) await App.invalidateAccountSession(code);
        else await App.logoutToLanding?.();
        return;
      }
      if (App.userProfileOpen && App.userProfilePinnedCode === code) App.closeUserProfile?.(true);
      App.renderOnlineIndicator?.();
      return;
    }
    // Login and profile editing claim names. Reading another person's profile
    // must never wait for (or write) a name-ownership transaction.
    if (App.liveUserListeners.get(code) !== listener || revision !== listener.revision) return;
    const username = rec.username || "User";
    const displayName = rec.displayName || username;
    const displayNameLower = displayName.toLowerCase();
    const user = {
      code,
      username,
      usernameLower: rec.usernameLower || username.toLowerCase(),
      displayName,
      displayNameLower,
      bio: String(rec.bio || "").slice(0, 400),
      photoDataURL: rec.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.normalizeTransformToRel(rec.photoTransform, 84),
      bannerDataURL: String(rec.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(rec.bannerTransform, 340),
      htmlActivity: App.getUserHtmlActivity(rec),
      htmlActivities: rec.htmlActivities || null,
      htmlActivitiesVersion: rec.htmlActivitiesVersion === 1 ? 1 : 0,
      gameActivitySessions: rec.gameActivitySessions || null,
      spotifySessions: rec.spotifySessions || null,
      notificationStatus: rec.notificationStatus === "dnd" ? "dnd" : rec.notificationStatus === "online" ? "online" : null,
      adminGhostRooms: App.normalizeAdminGhostRooms(rec.adminGhostRooms)
    };
    const previous = App.liveUserCache.get(code);
    const identityChanged = !previous || ["username", "usernameLower", "displayName", "displayNameLower", "bio"].some(key => previous[key] !== user[key]) ||
      JSON.stringify(previous.adminGhostRooms) !== JSON.stringify(user.adminGhostRooms);
    const profileChanged = !previous || ["username", "usernameLower", "displayName", "displayNameLower", "bio", "photoDataURL", "bannerDataURL"].some(key => previous[key] !== user[key]) ||
      ["photoTransform", "bannerTransform", "adminGhostRooms"].some(key => JSON.stringify(previous[key]) !== JSON.stringify(user[key]));
    const statusChanged = previous?.notificationStatus !== user.notificationStatus;
    const activityKey = App.getActivityPresenceRenderKey?.(user) ?? JSON.stringify(App.getUserActivityItems?.(user) || []);
    // An expiry timer can hide an activity without another profile snapshot.
    // Compare the old lease at today's time as well as the last snapshot key:
    // renewing the same game/title must bring the hidden indicator back.
    const previousActivityKey = App.getActivityPresenceRenderKey?.(previous) ?? listener.activityKey;
    const activityChanged = listener.activityKey !== activityKey || previousActivityKey !== activityKey;
    listener.activityKey = activityKey;
    if (String(App.currentUser?.code || "") === code) {
      App.currentUser.username = user.username;
      App.currentUser.usernameLower = user.usernameLower;
      App.currentUser.displayName = user.displayName;
      App.currentUser.displayNameLower = user.displayNameLower;
      App.currentUser.bio = user.bio;
      App.currentUser.photoDataURL = user.photoDataURL;
      App.currentUser.photoTransform = user.photoTransform;
      App.currentUser.bannerDataURL = user.bannerDataURL;
      App.currentUser.bannerTransform = user.bannerTransform;
      App.currentUser.htmlActivity = user.htmlActivity;
      App.currentUser.htmlActivities = user.htmlActivities;
      App.currentUser.htmlActivitiesVersion = user.htmlActivitiesVersion;
      App.currentUser.gameActivitySessions = user.gameActivitySessions;
      App.currentUser.spotifySessions = user.spotifySessions;
      const statusChanged = App.currentUser.notificationStatus !== user.notificationStatus;
      App.currentUser.notificationStatus = user.notificationStatus;
      if (statusChanged) App.notifyStatusChanged?.();
      App.currentUser.adminGhostRooms = user.adminGhostRooms;
    }
    App.liveUserCache.set(code, user);
    App.observeActivityPresenceUser?.(user);
    // Timestamp-only changes keep leases fresh without rebuilding avatars,
    // messages, the call panel, or the bootstrap cache.
    if (!profileChanged) {
      if (activityChanged || statusChanged) {
        App.renderOnlineIndicator?.();
        if (App.userProfileOpen && App.userProfilePinnedCode === code) App.refreshOpenUserProfileCard?.();
      }
      return;
    }
    const sessionCode = App.currentUser?.code;
    const refreshMedia = () => {
      if (sessionCode === App.currentUser?.code) App.refreshRenderedAvatarForUser(App.liveUserCache.get(code) || user);
    };
    if (App.queueLiveUpdate) App.queueLiveUpdate(`profile-media:${code}`, refreshMedia); else refreshMedia();
    // A crop or picture edit only patches existing media. Do not disturb
    // scroll position, open menus, active calls, or a settings draft.
    if (!identityChanged) {
      if (activityChanged || statusChanged) App.renderOnlineIndicator?.();
      if (App.userProfileOpen && App.userProfilePinnedCode === code) App.patchUserProfileCard(App.userProfileCardEl, user);
      if (String(App.currentUser?.code || "") === code) App.writeCurrentUserBootstrapCache?.();
      return;
    }
    document.querySelectorAll(`[data-display-name-usercode="${code}"]`).forEach(el => {
      el.textContent = user.displayName;
    });
    document.querySelectorAll(`[data-username-usercode="${code}"]`).forEach(el => {
      el.textContent = user.username;
    });
    document.querySelectorAll(`.reply-preview-author[data-reply-usercode="${code}"]`).forEach(el => {
      el.textContent = App.normalizeReplyDisplayName(user.displayName || user.username || "User");
    });
    document.querySelectorAll(`.online-ava[data-usercode="${code}"] .online-tooltip`).forEach(el => {
      el.textContent = user.displayName;
    });
    App.refreshUserIdentityReferences(code);
    App.scheduleRoomSearchRender?.();
    if (App.readReceiptState?.receipts?.[code]) App.renderReadReceipts?.();
    if (App.replyState && String(App.replyState.userCode || "") === code) {
      App.replyState.username = user.username;
      App.replyState.displayName = user.displayName;
      App.updateReplyBarPreview();
    }
    if (App.userProfileOpen && App.userProfilePinnedCode === code) {
      App.refreshOpenUserProfileCard();
    }
    try {
      App.renderOnlineIndicator();
    } catch {}
    try {
      App.renderCallMenu();
    } catch {}
    if (String(App.currentUser?.code || "") === code) {
      App.setMeHeader();
      App.writeCurrentUserBootstrapCache();
    }
    if (App.pingBarEl && !App.pingBarEl.hidden) App.renderPingList();
    App.refreshMentionFormattingForRenderedMessages();
  };
  listener.cb = cb;
  App.liveUserListeners.set(code, listener);
  ref.on("value", cb);
};
App.setMeHeader = function () {
  const displayName = App.currentUser?.displayName || App.currentUser?.username || "—";
  const username = App.currentUser?.username || "—";
  App.$("me-name").textContent = displayName;
  App.$("me-code").textContent = username;
  App.applyAvatar(App.$("me-avatar"), App.currentUser);
};

App.register("profiles/avatars", function initializeFeature() {
  // Only added subtrees are scanned. Attribute updates never feed back into
  // this observer, and normal image refreshes preserve focus and scroll.
  const pending = new Set();
  let queued = false;
  App.mediaSurfaceObserver = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1 && node.tagName !== "IMG") pending.add(node);
    }
    if (!pending.size || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const roots = [...pending];
      pending.clear();
      for (const root of roots) if (root.isConnected) App.hydrateMediaSurfaces(root);
    });
  });
  App.mediaSurfaceObserver.observe(document.body, { childList: true, subtree: true });
});
})(globalThis.ChatApp);
