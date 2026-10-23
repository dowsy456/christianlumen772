/* profiles/popover: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.openAvatarContextMenuFor = function (targetEl, userCode, event = null) {
  const code = String(userCode || "").trim();
  if (!code || !targetEl) return;
  const live = App.liveUserCache.get(code) || null;
  const fallbackSelf = App.currentUser && String(App.currentUser.code || "") === code ? App.currentUser : null;
  const user = live || fallbackSelf || {
    code,
    username: "User",
    photoDataURL: App.defaultStickmanDataURL(),
    photoTransform: null
  };
  const uname = String(user?.username || "User");
  const photoDataURL = String(user?.photoDataURL || App.defaultStickmanDataURL());
  const bannerDataURL = String(user?.bannerDataURL || "");
  const ext = App.inferImageExt(photoDataURL);
  const bannerExt = bannerDataURL ? App.inferImageExt(bannerDataURL) : "png";
  const fn = `${App.safeFileBaseName(uname)}.${ext}`;
  const bannerFn = `${App.safeFileBaseName(uname)}-banner.${bannerExt}`;
  App.openMsgMenuFor(targetEl, {
    menu: "avatar",
    userCode: code,
    username: uname,
    displayName: String(user?.displayName || uname),
    imageDataURL: photoDataURL,
    imageFileName: fn,
    bannerDataURL,
    bannerFileName: bannerFn,
    pointerX: event?.clientX,
    pointerY: event?.clientY
  });
};
App.resolveUserProfileAvatarTarget = function (target) {
  const avatarEl = target?.closest?.(".msg-avatar, .message-seen-avatar, .sched-avatar, .reply-preview-avatar, .tip-ava, .call-user-avatar, .online-ava-img, .members-sidebar .online-ava.member-row[data-usercode], .calendar-author-button:not(:disabled)");
  if (!avatarEl) return null;
  if (avatarEl.classList.contains("call-user-avatar") && avatarEl.closest(".call-menu-card")) {
    return null;
  }
  const host = avatarEl.closest?.("[data-usercode]") || avatarEl;
  const code = String(host?.dataset?.usercode || "").trim();
  if (!code) return null;
  return {
    avatarEl,
    host,
    code,
    anchorEl: avatarEl.closest?.(".online-ava") || host
  };
};
App.ensureGlobalAvatarContextMenuDelegation = function () {
  if (App.globalAvatarContextMenuBound) return;
  App.globalAvatarContextMenuBound = true;
  document.addEventListener("contextmenu", e => {
    const hit = App.resolveUserProfileAvatarTarget(e.target);
    if (!hit || hit.avatarEl.classList.contains("msg-avatar")) return;
    e.preventDefault();
    e.stopPropagation();
    App.openAvatarContextMenuFor(hit.anchorEl, hit.code, e);
  }, {
    passive: false
  });
};
App.getUserProfileRecord = function (userCode) {
  const code = String(userCode || "").trim();
  if (!code) return null;
  if (App.currentUser && String(App.currentUser.code || "") === code) return App.currentUser;
  return App.liveUserCache.get(code) || null;
};
App.getUserHtmlActivity = function (user) {
  const raw = user?.htmlActivity;
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").toLowerCase() === "upload" ? "upload" : "hub";
  const title = String(raw.title || raw.fileName || "").trim();
  if (!title) return null;
  const now = App.appPresenceNow?.() || Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0);
  return {
    type,
    title,
    // Keep pre-Hub activity records readable while every updated client writes hubId.
    hubId: String(raw.hubId || raw.libraryId || ""),
    fileName: String(raw.fileName || "").trim(),
    updatedAt: Number(raw.updatedAt || 0),
    startedAt: Number.isFinite(Number(raw.startedAt)) && Number(raw.startedAt) > 0 && Number(raw.startedAt) <= now + 90000 ? Number(raw.startedAt) : 0
  };
};
App.getUserActivityItems = function (user) {
  const items = [];
  if (App.isUserViewingSchedules(user)) {
    items.push({
      kind: "schedule",
      label: "Viewing Schedules"
    });
  }
  const htmlActivity = App.getUserHtmlActivity(user);
  if (htmlActivity) {
    items.push({
      kind: "html",
      label: `Playing ${htmlActivity.title}`,
      activity: htmlActivity
    });
  }
  return items;
};
App.getUserActivityLabel = function (user) {
  return App.getUserActivityItems(user).map(item => item.label).join(" · ");
};
App.htmlActivityIconMarkup = function (className = "") {
  return `<span class="html-activity-icon${className ? ` ${App.escapeAttr(className)}` : ``}" aria-hidden="true">${App.htmlHubButtonIconSVG()}</span>`;
};
App.scheduleActivityIconMarkup = function (className = "") {
  return `<span class="schedule-activity-icon${className ? ` ${className}` : ``}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 10.5 12 5l9 5.5-9 5.5-9-5.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M6.5 13v4.2c1.6 1.2 3.4 1.8 5.5 1.8s3.9-.6 5.5-1.8V13" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M21 10.5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>`;
};
App.userActivityIconsMarkup = function (items, className = "") {
  const kinds = new Set((Array.isArray(items) ? items : []).filter(item => item && item.kind !== "spotify").map(item => item.kind === "schedule" ? "schedule" : "playing"));
  return [...kinds].map(kind => kind === "schedule" ? App.scheduleActivityIconMarkup(className) : App.htmlActivityIconMarkup(className)).join("");
};
App.userProfileActivitiesMarkup = function (items) {
  const source = (Array.isArray(items) ? items : []).filter(Boolean);
  const rows = source.filter(item => item.kind !== "spotify").map(item => {
    const activity = item.activity || {};
    const playing = item.kind === "html" || item.kind === "game";
    const label = item.kind === "game" && App.getGameActivityLabel
      ? App.getGameActivityLabel(activity, { includeCreator: false })
      : playing ? `Playing ${activity.experienceTitle || activity.title || item.label?.replace(/^Playing\s+/i, "") || "Game"}` : item.label;
    const icon = item.kind === "game" && activity.icon
      ? `<span class="user-profile-game-art"><img src="${App.escapeAttr(activity.icon)}" alt="" referrerpolicy="no-referrer">${activity.platformIcon ? `<img class="user-profile-game-platform" src="${App.escapeAttr(activity.platformIcon)}" alt="${App.escapeAttr(activity.title || "Platform")}" referrerpolicy="no-referrer">` : ""}</span>`
      : item.kind === "schedule" ? App.scheduleActivityIconMarkup() : App.htmlActivityIconMarkup();
    const startedAt = Number(activity.startedAt);
    const timer = (stamp, label = "") => Number.isFinite(stamp) && stamp > 0 ? `<span class="user-profile-activity-elapsed" data-activity-started-at="${stamp}" data-activity-timer-label="${App.escapeAttr(label)}">${App.escapeHtml((label ? label + ': ' : '') + (App.getActivityElapsedLabel?.(stamp) || ""))}</span>` : "";
    const experienceStartedAt = Number(activity.experienceStartedAt);
    const elapsed = playing ? timer(startedAt, activity.experienceTitle ? activity.title : "") + (activity.experienceTitle ? timer(experienceStartedAt, App.getGameActivityTitle?.(activity) || activity.experienceTitle) : "") : "";
    return `<div class="user-profile-activity" data-activity-kind="${App.escapeAttr(item.kind || "")}">${icon}<span class="user-profile-activity-copy"><span class="user-profile-activity-text">${App.escapeHtml(String(label || ""))}</span>${playing && activity.creator ? `<span class="user-profile-game-author">By ${App.escapeHtml(activity.creator)}</span>` : ""}${elapsed}</span></div>`;
  }).join("");
  const spotify = source.find(item => item.kind === "spotify");
  return (rows ? `<div class="user-profile-activities">${rows}</div>` : "") + (App.spotifyProfileMarkup?.(spotify?.activity) || "");
};
App.refreshUserProfileActivityElapsed = function () {
  if (!App.userProfileOpen || !App.userProfileCardEl) return;
  App.userProfileCardEl.querySelectorAll("[data-activity-started-at]").forEach(element => {
    const label = element.dataset.activityTimerLabel;
    const text = (label ? label + ": " : "") + (App.getActivityElapsedLabel?.(Number(element.dataset.activityStartedAt)) || "");
    if (element.textContent !== text) element.textContent = text;
  });
};
App.buildUserProfileClassmatesHTML = function (user, {
  preview = false,
  timestamp = null
} = {}) {
  if (preview) return "";
  const username = String(user?.username || "").trim();
  if (!username) return "";
  const hasTimestamp = timestamp !== null && timestamp !== undefined && Number.isFinite(Number(timestamp));
  const at = hasTimestamp ? Number(timestamp) : App.accurateNowMs();
  const classmates = App.getScheduleClassmatesForUsername(username, at);
  if (!classmates.length) return "";
  const classmatesKey = classmates.map(classmate => String(classmate.username || "").toLowerCase()).join("|");
  const avatars = classmates.map(classmate => {
    const classmateUsername = String(classmate.username || "User");
    const classmateCode = String(classmate.code || "");
    return `
      <span class="user-profile-classmate" data-profile-classmate-username="${App.escapeAttr(classmateUsername)}" role="img" aria-label="${App.escapeAttr(classmateUsername)}">
        <span class="user-profile-classmate-avatar" data-avatar-usercode="${App.escapeAttr(classmateCode)}"></span>
        <span class="user-profile-classmate-username" aria-hidden="true">${App.escapeHtml(classmateUsername)}</span>
      </span>`;
  }).join("");
  return `
    <div class="user-profile-classmates" data-profile-classmates data-classmates-key="${App.escapeAttr(classmatesKey)}">
      <div class="user-profile-classmates-label">In Class With</div>
      <div class="user-profile-classmates-row">${avatars}</div>
    </div>`;
};
App.hydrateUserProfileClassmates = function (root = App.userProfileCardEl) {
  if (!root) return;
  root.querySelectorAll(".user-profile-classmate[data-profile-classmate-username]").forEach(item => {
    const username = item.getAttribute("data-profile-classmate-username") || "";
    const avatar = item.querySelector(".user-profile-classmate-avatar");
    const classmate = App.getConfiguredScheduleUser(username);
    if (avatar && classmate) {
      const code = String(classmate.code || "");
      if (code) avatar.dataset.avatarUsercode = code;else avatar.removeAttribute("data-avatar-usercode");
      App.applyAvatar(avatar, classmate);
    }
  });
};
App.hydrateUserProfileAvatars = function (root, user) {
  if (!root) return;
  const profileAvatar = root.querySelector(".user-profile-avatar");
  if (profileAvatar && user) App.applyAvatar(profileAvatar, user);
  const banner = root.querySelector(".user-profile-banner");
  if (banner && user) App.applyBanner(banner, user);
  App.syncProfileStatusControl?.();
  App.hydrateUserProfileClassmates(root);
};
App.refreshOpenUserProfileClassmates = function (timestamp = App.accurateNowMs()) {
  if (!App.userProfileOpen || !App.userProfileCardEl || !App.userProfilePinnedCode) return;
  const user = App.getUserProfileRecord(App.userProfilePinnedCode);
  if (!user) return;
  const body = App.userProfileCardEl.querySelector(".user-profile-body");
  if (!body) return;
  const current = body.querySelector("[data-profile-classmates]");
  const markup = App.buildUserProfileClassmatesHTML(user, {
    timestamp
  });
  if (!markup) {
    if (current) {
      current.remove();
      if (App.userProfileAnchorEl?.isConnected) App.positionUserProfile(App.userProfileAnchorEl);
    }
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  if (current?.dataset?.classmatesKey === next.dataset.classmatesKey) {
    App.hydrateUserProfileClassmates(current);
    return;
  }
  if (current) {
    current.replaceWith(next);
  } else {
    const bio = body.querySelector(".user-profile-bio");
    if (bio) body.insertBefore(next, bio);else body.appendChild(next);
  }
  App.hydrateUserProfileClassmates(next);
  if (App.userProfileAnchorEl?.isConnected) App.positionUserProfile(App.userProfileAnchorEl);
};
App.refreshOpenUserProfileCard = function () {
  if (!App.userProfileOpen || !App.userProfileCardEl || !App.userProfilePinnedCode) return;
  const user = App.getUserProfileRecord(App.userProfilePinnedCode);
  if (!user) {
    App.closeUserProfile(true);
    return;
  }
  App.patchUserProfileCard(App.userProfileCardEl, user);
  if (App.userProfileAnchorEl?.isConnected) App.positionUserProfile(App.userProfileAnchorEl);
};
App.patchUserProfileCard = function (root, user, { preview = false } = {}) {
  if (!root || !user) return;
  if (preview) root.dataset.mediaPreview = "true";
  if (!root.querySelector(".user-profile-shell")) {
    root.innerHTML = App.buildUserProfileCardHTML(user, { preview });
  }
  const text = (selector, value) => {
    const el = root.querySelector(selector);
    if (el && el.textContent !== value) el.textContent = value;
  };
  text(".user-profile-display", String(user.displayName || user.username || "User"));
  text(".user-profile-username", String(user.username || "user").replace(/^@/, ""));
  const body = root.querySelector(".user-profile-body");
  let bio = body.querySelector(".user-profile-bio");
  const bioText = String(user.bio || "").slice(0, 400);
  if (bioText && !bio) { bio = document.createElement("div"); bio.className = "user-profile-bio"; body.appendChild(bio); }
  if (bio && bio.textContent !== bioText) bio.textContent = bioText;
  if (bio) bio.hidden = !bioText;
  const activities = root.querySelector("[data-profile-activities]");
  if (activities) {
    const markup = App.userProfileActivitiesMarkup(App.getUserActivityItems(user));
    if (activities._markup !== markup) { activities.innerHTML = markup; activities._markup = markup; }
  }
  App.hydrateUserProfileAvatars(root, user);
  if (!preview) {
    App.refreshOpenUserProfilePresence();
    App.refreshOpenUserProfileClassmates();
  }
};
App.getProfilePresenceState = function (code) {
  if (App.getUserVisiblePresence) return App.getUserVisiblePresence(code);
  const state = App.appPresenceCache?.get(String(code || ""));
  if (state === "online" || state === "idle") return state;
  if (String(code || "") === String(App.currentUser?.code || "")) return document.hidden || App.myRoomIdle ? "idle" : "online";
  return "offline";
};
App.refreshOpenUserProfilePresence = function () {
  if (!App.userProfileOpen || !App.userProfileCardEl) return;
  const badge = App.userProfileCardEl.querySelector(".user-profile-presence");
  if (!badge) return;
  const state = App.getProfilePresenceState(App.userProfilePinnedCode);
  badge.dataset.state = state;
  badge.textContent = App.userPresenceLabel?.(state) || (state === "idle" ? "Idle" : state === "online" ? "Online" : "Offline");
};
App.buildUserProfileCardHTML = function (user, {
  preview = false
} = {}) {
  const displayName = String(user?.displayName || user?.username || "User");
  const username = String(user?.username || "user");
  const bio = String(user?.bio || "").slice(0, 400);
  const photoDataURL = String(user?.photoDataURL || App.defaultStickmanDataURL());
  const bannerDataURL = String(user?.bannerDataURL || "");
  const pfpTransform = App.formatMediaTransformRelative(user?.photoTransform, 84);
  const bannerTransform = App.formatMediaTransformCss(user?.bannerTransform, "var(--profile-banner-width, min(340px, calc(100vw - 24px)))", 340);
  const bannerMarkup = bannerDataURL ? `<img class="user-profile-banner-img" src="${App.escapeHtml(bannerDataURL)}" alt="" style="transform:${App.escapeAttr(bannerTransform)}" />` : `<div class="user-profile-banner-fallback"></div>`;
  const activityItems = App.getUserActivityItems(user);
  const activitiesMarkup = App.userProfileActivitiesMarkup(activityItems);
  const classmatesMarkup = App.buildUserProfileClassmatesHTML(user, {
    preview
  });
  const presence = App.getProfilePresenceState(user?.code);
  return `
    <div class="user-profile-shell${preview ? ` is-preview` : ``}" data-usercode="${App.escapeHtml(String(user?.code || ""))}">
      <div class="user-profile-banner" data-banner-usercode="${App.escapeAttr(String(user?.code || ""))}">
        ${bannerMarkup}
        <button class="user-profile-close" type="button" ${preview ? `hidden` : ``} aria-label="Close profile"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        <button class="user-profile-more" type="button" ${preview ? `hidden` : ``} aria-label="Profile actions">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" fill="currentColor"></circle>
            <circle cx="12" cy="12" r="1.8" fill="currentColor"></circle>
            <circle cx="19" cy="12" r="1.8" fill="currentColor"></circle>
          </svg>
        </button>
      </div>
      <div class="user-profile-body">
        <div class="user-profile-avatar-wrap">
          <div class="user-profile-avatar" data-avatar-usercode="${App.escapeHtml(String(user?.code || ""))}">
            <img src="${App.escapeHtml(photoDataURL)}" alt="${App.escapeHtml(displayName)}" draggable="false" style="transform:${App.escapeAttr(pfpTransform)}" />
          </div>
        </div>
        <div class="user-profile-names">
          <div class="user-profile-display">${App.escapeHtml(displayName)}</div>
          <div class="user-profile-identity-line"><div class="user-profile-username">${App.escapeHtml(username.replace(/^@/, ""))}</div><span class="user-profile-presence" data-state="${presence}">${App.userPresenceLabel?.(presence) || (presence === "idle" ? "Idle" : presence === "online" ? "Online" : "Offline")}</span></div>
          <div data-profile-activities>${activitiesMarkup}</div>
        </div>
        ${classmatesMarkup}
        ${bio ? `<div class="user-profile-bio">${App.escapeHtml(bio)}</div>` : ``}
      </div>
    </div>
  `;
};
App.closeUserProfile = function (immediate = false) {
  App.closeProfileStatusMenu?.(immediate);
  clearInterval(App.userProfileActivityTimer);
  App.userProfileActivityTimer = null;
  if (!App.userProfileEl) return;
  App.userProfileAnchorEl?.removeAttribute?.("data-profile-open");
  const seq = ++App.userProfileRenderSeq;
  clearTimeout(App.userProfileCloseTimer);
  if (immediate || App.userProfileEl.hidden) {
    App.userProfileEl.hidden = true;
    App.userProfileEl.classList.remove("is-open", "is-closing");
    App.userProfileCardEl.innerHTML = "";
    App.userProfileOpen = false;
    App.userProfilePinnedCode = "";
    App.userProfileAnchorEl = null;
    return;
  }
  App.userProfileEl.classList.remove("is-open");
  void App.userProfileEl.offsetHeight;
  App.userProfileEl.classList.add("is-closing");
  App.userProfileCloseTimer = window.setTimeout(() => {
    if (seq !== App.userProfileRenderSeq) return;
    App.userProfileEl.hidden = true;
    App.userProfileEl.classList.remove("is-closing");
    App.userProfileCardEl.innerHTML = "";
    App.userProfileOpen = false;
    App.userProfilePinnedCode = "";
    App.userProfileAnchorEl = null;
  }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
};
App.positionUserProfile = function (anchorEl) {
  if (!App.userProfileEl || !anchorEl) return;
  const anchorRect = anchorEl.getBoundingClientRect();
  // offset dimensions do not include the entrance scale animation.
  const cardRect = { width: App.userProfileEl.offsetWidth, height: App.userProfileEl.offsetHeight };
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchorRect.right + gap;
  let top = anchorRect.top;
  if (left + cardRect.width > vw - 12) {
    left = anchorRect.left - cardRect.width - gap;
  }
  if (left < 12) {
    left = Math.max(12, Math.min(vw - cardRect.width - 12, anchorRect.left + anchorRect.width / 2 - cardRect.width / 2));
  }
  if (top + cardRect.height > vh - 12) {
    top = Math.max(12, vh - cardRect.height - 12);
  }
  if (top < 12) top = 12;
  App.userProfileEl.style.left = `${Math.round(left)}px`;
  App.userProfileEl.style.top = `${Math.round(top)}px`;
  App.userProfileEl.style.transformOrigin = left < anchorRect.left ? "top right" : "top left";
};
App.openUserProfileAt = function (anchorEl, userCode, {
  sourceMenu = false
} = {}) {
  if (!App.userProfileEl || !App.userProfileCardEl || !anchorEl) return;
  const code = String(userCode || "").trim();
  const user = App.getUserProfileRecord(code);
  if (!user) return;
  App.hideMemberActivityFloating?.({ immediate: true });
  App.hideMemberClassmatesFloating?.({ immediate: true });
  App.hideScheduleClassmatesFloating?.({ immediate: true });
  App.hideAppTooltip?.();
  const seq = ++App.userProfileRenderSeq;
  clearTimeout(App.userProfileCloseTimer);
  App.userProfileEl.hidden = false;
  App.userProfileEl.classList.remove("is-open", "is-closing");
  App.userProfileAnchorEl = anchorEl;
  document.querySelectorAll("[data-profile-open]").forEach(node => node.removeAttribute("data-profile-open"));
  anchorEl.setAttribute("data-profile-open", "true");
  App.userProfilePinnedCode = code;
  App.userProfileCardEl.innerHTML = App.buildUserProfileCardHTML(user);
  App.hydrateUserProfileAvatars(App.userProfileCardEl, user);
  App.userProfileCardEl.scrollTop = 0;
  App.positionUserProfile(anchorEl);
  requestAnimationFrame(() => {
    if (seq !== App.userProfileRenderSeq) return;
    if (!App.userProfileEl.hidden && App.userProfilePinnedCode === code) {
      App.userProfileEl.classList.add("is-open");
    }
  });
  App.userProfileOpen = true;
  clearInterval(App.userProfileActivityTimer);
  App.userProfileActivityTimer = setInterval(App.refreshUserProfileActivityElapsed, 1000);
  App.userProfileEl.setAttribute("role", "dialog");
  App.userProfileEl.setAttribute("aria-label", `${user.displayName || user.username || "User"}'s profile`);
  if (!sourceMenu) App.closeMsgMenu(true);
};
App.toggleUserProfileAt = function (anchorEl, userCode) {
  const code = String(userCode || "").trim();
  if (!anchorEl || !code) return;
  if (App.userProfileOpen && App.userProfilePinnedCode === code) {
    App.closeUserProfile(true);
    return;
  }
  App.openUserProfileAt(anchorEl, code);
};

App.register("profiles/popover", function initializeFeature() {
App.globalAvatarContextMenuBound = false;
App.ensureGlobalAvatarContextMenuDelegation();
App.userProfileOpen = false;
App.userProfileCloseTimer = 0;
App.userProfilePinnedCode = "";
App.userProfileAnchorEl = null;
App.userProfileEl = App.$("user-profile-popover");
App.userProfileCardEl = App.$("user-profile-card");
App.userProfileRenderSeq = 0;
App.userProfileCardEl?.addEventListener("contextmenu", event => {
  const more = event.target.closest?.(".user-profile-more, .user-profile-avatar");
  if (!more) return;
  event.preventDefault();
  event.stopPropagation();
  App.openAvatarContextMenuFor(more, App.userProfilePinnedCode, event);
});
App.userProfileCardEl?.addEventListener("click", event => {
  const more = event.target.closest?.(".user-profile-more");
  if (more) {
    event.preventDefault();
    event.stopPropagation();
    const code = App.userProfilePinnedCode;
    if (App.msgMenuEl && !App.msgMenuEl.hidden && App.msgMenuCtx?.menu === "avatar" && String(App.msgMenuCtx.userCode || "") === code && App.msgMenuAnchorEl === more) {
      App.closeMsgMenu();
    } else {
      App.openAvatarContextMenuFor(more, code);
    }
    return;
  }
  if (!event.target.closest?.(".user-profile-close")) return;
  const anchor = App.userProfileAnchorEl;
  App.closeUserProfile();
  anchor?.focus?.({ preventScroll: true });
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !App.userProfileOpen || (App.msgMenuEl && !App.msgMenuEl.hidden)) return;
  event.preventDefault();
  const anchor = App.userProfileAnchorEl;
  App.closeUserProfile();
  anchor?.focus?.({ preventScroll: true });
});
document.addEventListener("click", e => {
  if (e.target?.closest?.(".member-activity-more")) return;
  if (e.target?.closest?.(".profile-status-menu")) return;
  // Profile actions are portaled to the body. They still belong to this
  // profile; expanding Assets must not dismiss and detach their own anchor.
  if (App.msgMenuEl?.contains(e.target) && App.userProfileEl?.contains(App.msgMenuAnchorEl)) return;
  // The dock handles click and keyboard activation itself. Do not close its
  // current profile in capture phase before that handler can toggle it.
  if (e.target?.closest?.(".me-pill-dock")) return;
  const mention = e.target?.closest?.(".mention-link[data-usercode]");
  if (mention) {
    const code = String(mention.dataset.usercode || "").trim();
    if (!code) return;
    e.preventDefault();
    e.stopPropagation();
    App.toggleUserProfileAt(mention, code);
    return;
  }
  if (e.target?.closest?.(".member-classmates-indicator")) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const memberRow = e.target?.closest?.(".members-sidebar .online-ava.member-row[data-usercode]");
  const memberCode = String(memberRow?.dataset?.usercode || "").trim();
  const avatarHit = memberRow && memberCode ? {
    anchorEl: memberRow,
    code: memberCode
  } : App.resolveUserProfileAvatarTarget(e.target);
  if (avatarHit) {
    e.preventDefault();
    e.stopPropagation();
    App.toggleUserProfileAt(avatarHit.anchorEl, avatarHit.code);
    return;
  }
  if (App.userProfileOpen) {
    if (App.userProfileEl?.contains?.(e.target)) return;
    App.closeUserProfile();
  }
}, true);
window.addEventListener("resize", () => {
  if (!App.userProfileOpen) return;
  if (!App.userProfileAnchorEl?.isConnected) {
    App.closeUserProfile(true);
    return;
  }
  App.positionUserProfile(App.userProfileAnchorEl);
});
window.addEventListener("blur", () => App.closeUserProfile(true));
document.addEventListener("scroll", () => {
  if (!App.userProfileOpen) return;
  if (!App.userProfileAnchorEl?.isConnected) {
    App.closeUserProfile(true);
    return;
  }
  App.positionUserProfile(App.userProfileAnchorEl);
}, true);
App.roomsListEl = App.$("rooms-list");
App.onlinePill = App.$("online-pill");
App.onlineLabelEl = App.$("online-label");
App.onlineListEl = App.$("online-list");
App.typingBarEl = App.$("typing-bar");
App.typingBarUsersEl = App.$("typing-bar-users");
App.typingBarHideTimer = 0;
});
})(globalThis.ChatApp);
