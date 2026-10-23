/* chat/presence: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.queueMemberRosterRender = function () {
  if (App.memberRosterFrame) return;
  App.memberRosterFrame = requestAnimationFrame(() => {
    App.memberRosterFrame = 0;
    App.renderOnlineIndicator();
  });
};
App.startRoomMemberDirectory = function (roomId = App.currentRoomId) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.currentUser || !App.db || App.roomMemberDirectory?.id === id) return;
  App.stopRoomMemberDirectory();
  // A room roster only needs this room's index, never every account's joined
  // rooms. Membership creation/leave maintain this index.
  const directory = { id, ref: App.db.ref(`roomMembers/${id}`), cb: null, snapshot: null };
  App.roomMemberDirectory = directory;
  directory.cb = snap => {
    if (App.roomMemberDirectory !== directory) return;
    directory.snapshot = snap;
    App.roomMembersCb?.(snap);
  };
  directory.ref.on("value", directory.cb);
};
App.stopRoomMemberDirectory = function () {
  const directory = App.roomMemberDirectory;
  App.roomMemberDirectory = null;
  if (directory) directory.ref.off("value", directory.cb);
};
App.getRosterProfile = function (code) {
  // The already subscribed account directory supplies every initial identity in
  // one snapshot. No persistent storage or N individual network reads required.
  if (App.schedulesPeopleLoadedOnce && App.schedulesPeopleByCode) return App.schedulesPeopleByCode.get(code) || null;
  return App.liveUserCache.get(code) || (String(App.currentUser?.code || "") === code ? App.currentUser : null);
};
App.detachOnlineIndicator = function () {
  App.hideMemberActivityFloating?.({ immediate: true });
  if (App.roomOnlineRef && App.roomOnlineCb) {
    try {
      App.roomOnlineRef.off("value", App.roomOnlineCb);
    } catch {}
  }
  App.roomOnlineRef = null;
  App.roomOnlineCb = null;

  // NEW: memberships listener
  if (App.roomMembersRef && App.roomMembersCb) {
    try {
      App.roomMembersRef.off("value", App.roomMembersCb);
    } catch {}
  }
  App.roomMembersRef = null;
  App.roomMembersCb = null;
  App.roomRosterMembershipsReady = false;

  // NEW: call-members listener
  if (App.roomCallMembersRef && App.roomCallMembersCb) {
    try {
      App.roomCallMembersRef.off("value", App.roomCallMembersCb);
    } catch {}
  }
  App.roomCallMembersRef = null;
  App.roomCallMembersCb = null;
  App.onlinePresenceCache.clear();
  App.roomMembersCache.clear();
  App.roomCallMembersCache.clear();
  App.syncRoomActivitiesButton();
  if (App.onlineListEl) App.onlineListEl.innerHTML = "";
  App.onlineTiles.clear();
  App.hideMemberClassmatesFloating({
    immediate: true
  });
  if (App.onlineLabelEl) App.onlineLabelEl.textContent = "Members - 0";
  if (App.onlinePill) App.onlinePill.hidden = true;
};
App.ensureOnlinePillMount = function () {
  if (!App.onlinePill) return;
  const defaultHost = App.$("members-sidebar-mount");
  if (defaultHost && App.onlinePill.parentElement !== defaultHost) defaultHost.appendChild(App.onlinePill);
};
App.attachOnlineIndicator = function (roomId) {
  if (!App.onlinePill || !App.onlineListEl) return;
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  App.detachOnlineIndicator();
  App.startSchedulesPeopleListener();

  // Chat rooms: "Members:" label
  if (App.onlineLabelEl) App.onlineLabelEl.textContent = "Members - 0";
  App.onlinePill.hidden = !App.currentRoomId || App.currentRoomId !== id || App.views.chat.dataset.active !== "true";
  App.ensureOnlinePillMount();

  // 1) Room-open presence (online + typing)
  App.roomOnlineRef = App.db.ref(`rooms/${id}/online`);
  const onlineRef = App.roomOnlineRef;
  App.roomOnlineCb = snap => {
    if (App.roomOnlineRef !== onlineRef) return;
    App.onlinePresenceCache.clear();
    const v = snap.exists() ? snap.val() || {} : {};
    for (const [code, rec] of Object.entries(v)) {
      if (!code || !rec || typeof rec !== "object" || Array.isArray(rec)) continue;
      const username = rec && rec.username ? String(rec.username) : App.liveUserCache.get(code)?.username || "User";
      const usernameLower = rec && rec.usernameLower ? String(rec.usernameLower) : username.toLowerCase();
      const typing = !!(rec && rec.typing);
      const idle = !!(rec && rec.idle);
      const roomActivity = rec?.roomActivity && typeof rec.roomActivity === "object" ? {
        id: String(rec.roomActivity.id || ""),
        title: String(rec.roomActivity.title || "Activity"),
        startedAt: Math.max(0, Number(rec.roomActivity.startedAt || 0))
      } : null;
      App.onlinePresenceCache.set(code, {
        code,
        username,
        usernameLower,
        typing,
        idle,
        roomActivity
      });
      App.ensureLiveUserListener(code);
    }
    App.queueMemberRosterRender();
    App.syncRoomActivitiesButton();
  };
  App.roomOnlineRef.on("value", App.roomOnlineCb);

  // 2) Room memberships (ALL joined users)
  App.startRoomMemberDirectory(id);
  App.roomMembersRef = { off() {} };
  const membersRef = App.roomMembersRef;
  App.roomMembersCb = snap => {
    if (App.roomMembersRef !== membersRef) return;
    App.roomRosterMembershipsReady = true;
    App.roomMembersCache.clear();
    const all = snap.exists() ? snap.val() || {} : {};
    for (const [code, membership] of Object.entries(all)) {
      if (!code) continue;
      if (membership === true || membership && typeof membership === "object" && !Array.isArray(membership)) {
        App.roomMembersCache.set(code, true);
        App.ensureLiveUserListener(code);
      }
    }
    App.queueMemberRosterRender();
    App.refreshMentionFormattingForRenderedMessages();
  };
  if (App.roomMemberDirectory?.snapshot) App.roomMembersCb(App.roomMemberDirectory.snapshot);

  // 3) In-call members for this room (treated as online even if room is closed)
  App.roomCallMembersRef = App.db.ref(`calls/${id}/members`);
  const callMembersRef = App.roomCallMembersRef;
  App.roomCallMembersCb = snap => {
    if (App.roomCallMembersRef !== callMembersRef) return;
    App.roomCallMembersCache.clear();
    const v = snap.exists() ? snap.val() || {} : {};
    const now = Date.now();
    for (const [code, rec] of Object.entries(v)) {
      if (!code || !rec) continue;
      const connected = !!rec.connected;

      // Robust freshness: some clients may not have lastSeenAt immediately, so fall back safely.
      const lastSeenAt = Number(rec.lastSeenAt || rec.updatedAt || rec.joinedAt || 0);

      // If connected is true, consider them in-call unless their timestamp is clearly stale.
      const fresh = connected && (lastSeenAt <= 0 || now - lastSeenAt <= App.CALL_STALE_MEMBER_MS);
      if (!fresh) continue;
      App.roomCallMembersCache.set(code, true);
      App.ensureLiveUserListener(code);
    }
    App.queueMemberRosterRender();
  };
  App.roomCallMembersRef.on("value", App.roomCallMembersCb);
};
App.getMemberScheduleUser = function (code) {
  const id = String(code || "").trim();
  if (!id) return null;
  const live = App.liveUserCache.get(id) || (String(App.currentUser?.code || "") === id ? App.currentUser : null);
  const presence = App.onlinePresenceCache.get(id) || null;
  const tile = App.onlineTiles.get(id) || null;
  const username = String(live?.username || presence?.username || tile?.wrap?.dataset?.scheduleUsername || "").trim();
  if (!username) return null;
  return {
    code: id,
    username,
    displayName: String(live?.displayName || presence?.displayName || tile?.name?.textContent || username),
    photoDataURL: live?.photoDataURL || App.defaultStickmanDataURL(),
    photoTransform: live?.photoTransform || null
  };
};
App.getScheduleClassSignature = function (record) {
  const className = String(record?.className || "").trim();
  const teacher = String(record?.teacher || "").trim();
  const room = String(record?.room || "").trim();
  if (!className || !teacher || !room) return "";
  return JSON.stringify([className, teacher, room]);
};
App.getConfiguredScheduleUser = function (username) {
  const wanted = String(username || "").trim();
  if (!wanted) return null;
  const wantedLower = wanted.toLowerCase();
  const directoryUser = App.schedulesPeopleByUsername.get(wanted) || App.schedulesPeopleCache.find(user => String(user?.username || "").toLowerCase() === wantedLower) || Array.from(App.liveUserCache.values()).find(user => String(user?.username || "").toLowerCase() === wantedLower) || null;
  return {
    code: String(directoryUser?.code || ""),
    username: wanted,
    displayName: String(directoryUser?.displayName || wanted),
    photoDataURL: directoryUser?.photoDataURL || App.scheduleNameAvatarDataURL(wanted),
    photoTransform: directoryUser?.photoTransform || null
  };
};
App.getScheduleClassmatesForUsername = function (ownerUsername, timestamp = App.accurateNowMs()) {
  const username = String(ownerUsername || "").trim();
  if (!username) return [];
  const dayType = App.scheduleType || "full";
  const ownerClass = App.getClassRecordAtTimestamp(timestamp, {
    username,
    dayType
  });
  const ownerSignature = App.getScheduleClassSignature(ownerClass);
  if (!ownerSignature) return [];
  const users = [];
  const ownerUsernameLower = username.toLowerCase();
  for (const configuredUsername of Object.keys(App.SCHEDULES || {})) {
    if (!configuredUsername || configuredUsername.startsWith("__")) continue;
    if (configuredUsername.toLowerCase() === ownerUsernameLower) continue;
    const record = App.getClassRecordAtTimestamp(timestamp, {
      username: configuredUsername,
      dayType
    });
    if (App.getScheduleClassSignature(record) !== ownerSignature) continue;
    const user = App.getConfiguredScheduleUser(configuredUsername);
    if (!user) continue;
    users.push(user);
  }
  users.sort((a, b) => {
    const nameCompare = String(a.displayName || a.username).localeCompare(String(b.displayName || b.username));
    return nameCompare || String(a.code).localeCompare(String(b.code));
  });
  return users;
};
App.getScheduleClassmatesForBlock = function (ownerUsername, blockKey, weekday, dayType = App.scheduleType || "full") {
  const username = String(ownerUsername || "").trim();
  const key = String(blockKey || "").trim();
  const day = App._normalizeScheduleWeekday(weekday);
  if (!username || !key || !day) return [];
  const ownerClass = App._getClassForBlock(dayType, username, key, day);
  const ownerSignature = App.getScheduleClassSignature(ownerClass);
  if (!ownerSignature) return [];
  const ownerRow = App.getScheduleRows(dayType, username, day).find(row => row.key === key);
  const ownerRange = App._parseRangeMinutes(ownerRow?.time);
  const users = [];
  const ownerUsernameLower = username.toLowerCase();
  for (const configuredUsername of Object.keys(App.SCHEDULES || {})) {
    if (!configuredUsername || configuredUsername.startsWith("__")) continue;
    if (configuredUsername.toLowerCase() === ownerUsernameLower) continue;
    const sameClass = App.getScheduleRows(dayType, configuredUsername, day).some(row => {
      if (App.getScheduleClassSignature(row) !== ownerSignature) return false;
      const range = App._parseRangeMinutes(row.time);
      return ownerRange && range ? range.start < ownerRange.end && ownerRange.start < range.end : row.key === key;
    });
    if (!sameClass) continue;
    const user = App.getConfiguredScheduleUser(configuredUsername);
    if (user) users.push(user);
  }
  users.sort((a, b) => {
    const nameCompare = String(a.displayName || a.username).localeCompare(String(b.displayName || b.username));
    return nameCompare || String(a.code).localeCompare(String(b.code));
  });
  return users;
};
App.getMemberClassmates = function (ownerCode, timestamp = App.accurateNowMs()) {
  const owner = App.getMemberScheduleUser(ownerCode);
  return owner ? App.getScheduleClassmatesForUsername(owner.username, timestamp) : [];
};
App.buildMemberClassmatesTooltip = function (users) {
  const people = Array.isArray(users) ? users : [];
  const tooltip = document.createElement("div");
  tooltip.className = "call-viewers-tooltip member-classmates-tooltip";
  tooltip.id = `member-classmates-tooltip-${++App.memberClassmatesTooltipSeq}`;
  tooltip.dataset.viewerCount = String(people.length);
  tooltip.setAttribute("role", "tooltip");
  const label = document.createElement("div");
  label.className = "call-viewers-label";
  label.textContent = "In Class With";
  tooltip.appendChild(label);
  const row = document.createElement("div");
  row.className = "call-viewers-row";
  row.setAttribute("aria-label", `${people.length} classmate${people.length === 1 ? "" : "s"}`);
  for (const user of people) {
    const avatar = document.createElement("span");
    avatar.className = "call-viewer-avatar";
    avatar.setAttribute("aria-hidden", "true");
    App.applyAvatar(avatar, user);
    row.appendChild(avatar);
  }
  tooltip.appendChild(row);
  return tooltip;
};
App.buildScheduleClassmatesTooltip = function (users) {
  const people = Array.isArray(users) ? users : [];
  const tooltip = document.createElement("div");
  tooltip.className = "call-viewers-tooltip member-classmates-tooltip schedule-classmates-tooltip";
  tooltip.id = `schedule-classmates-tooltip-${++App.scheduleClassmatesTooltipSeq}`;
  tooltip.dataset.viewerCount = String(people.length);
  tooltip.setAttribute("role", "tooltip");
  const label = document.createElement("div");
  label.className = "call-viewers-label";
  label.textContent = "In Class With";
  tooltip.appendChild(label);
  const row = document.createElement("div");
  row.className = "call-viewers-row";
  row.setAttribute("aria-label", `${people.length} classmate${people.length === 1 ? "" : "s"}`);
  for (const user of people) {
    const avatar = document.createElement("span");
    avatar.className = "call-viewer-avatar";
    avatar.setAttribute("aria-hidden", "true");
    App.applyAvatar(avatar, user);
    row.appendChild(avatar);
  }
  tooltip.appendChild(row);
  return tooltip;
};
App.clearScheduleClassmatesFloatingHide = function () {
  if (App.scheduleClassmatesFloatingHideTimer) {
    try {
      clearTimeout(App.scheduleClassmatesFloatingHideTimer);
    } catch {}
  }
  App.scheduleClassmatesFloatingHideTimer = null;
};
App.hideScheduleClassmatesFloating = function ({
  immediate = false
} = {}) {
  App.clearScheduleClassmatesFloatingHide();
  const anchor = App.scheduleClassmatesFloatingAnchor;
  if (anchor) {
    try {
      anchor.removeAttribute("aria-describedby");
    } catch {}
  }
  App.scheduleClassmatesFloatingAnchor = null;
  if (!App.scheduleClassmatesFloating) return;
  const floating = App.scheduleClassmatesFloating;
  floating.classList.remove("is-visible");
  let reducedMotion = false;
  try {
    reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {}
  if (immediate || reducedMotion) {
    floating.hidden = true;
    return;
  }
  App.scheduleClassmatesFloatingHideTimer = setTimeout(() => {
    App.scheduleClassmatesFloatingHideTimer = null;
    if (App.scheduleClassmatesFloating === floating && !floating.classList.contains("is-visible")) floating.hidden = true;
  }, App.CALL_VIEWERS_TOOLTIP_TRANSITION_MS);
};
App.ensureScheduleClassmatesFloating = function () {
  if (App.scheduleClassmatesFloating?.isConnected) return App.scheduleClassmatesFloating;
  const floating = document.createElement("div");
  floating.className = "call-viewers-floating schedule-classmates-floating";
  floating.hidden = true;
  document.body.appendChild(floating);
  App.scheduleClassmatesFloating = floating;
  return floating;
};
App.positionScheduleClassmatesFloating = function () {
  const floating = App.scheduleClassmatesFloating;
  const row = App.scheduleClassmatesFloatingAnchor;
  if (!floating || floating.hidden || !row?.isConnected) {
    if (floating && !floating.hidden) App.hideScheduleClassmatesFloating();
    return;
  }
  const anchor = row.querySelector(".sched-cell-class") || row;
  const anchorRect = anchor.getBoundingClientRect();
  const floatingRect = floating.getBoundingClientRect();
  const margin = 8;
  const viewportWidth = Math.max(1, Number(window.innerWidth) || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, Number(window.innerHeight) || document.documentElement.clientHeight || 1);
  let left = anchorRect.left;
  let top = anchorRect.bottom + 7;
  left = Math.max(margin, Math.min(left, viewportWidth - floatingRect.width - margin));
  if (top + floatingRect.height > viewportHeight - margin) top = anchorRect.top - floatingRect.height - 7;
  top = Math.max(margin, Math.min(top, viewportHeight - floatingRect.height - margin));
  floating.style.left = `${Math.round(left)}px`;
  floating.style.top = `${Math.round(top)}px`;
};
App.showScheduleClassmatesFloating = function (row, {
  ownerUsername,
  blockKey,
  weekday,
  dayType
} = {}) {
  if (App.userProfileOpen) return App.hideScheduleClassmatesFloating({ immediate: true });
  if (!row?.isConnected) return;
  const users = App.getScheduleClassmatesForBlock(ownerUsername, blockKey, weekday, dayType);
  if (!users.length) {
    App.hideScheduleClassmatesFloating({
      immediate: true
    });
    return;
  }
  App.clearScheduleClassmatesFloatingHide();
  const floating = App.ensureScheduleClassmatesFloating();
  const tooltip = App.buildScheduleClassmatesTooltip(users);
  App.scheduleClassmatesFloatingAnchor = row;
  floating.replaceChildren(tooltip);
  const wasHidden = floating.hidden;
  if (wasHidden) floating.classList.remove("is-visible");
  floating.hidden = false;
  row.setAttribute("aria-describedby", tooltip.id);
  App.positionScheduleClassmatesFloating();
  if (wasHidden) void floating.offsetWidth;
  floating.classList.add("is-visible");
};
App.clearMemberClassmatesFloatingHide = function () {
  if (App.memberClassmatesFloatingHideTimer) {
    try {
      clearTimeout(App.memberClassmatesFloatingHideTimer);
    } catch {}
  }
  App.memberClassmatesFloatingHideTimer = null;
};
App.hideMemberClassmatesFloating = function ({
  immediate = false
} = {}) {
  App.clearMemberClassmatesFloatingHide();
  const anchor = App.memberClassmatesFloatingAnchor;
  if (anchor) {
    try {
      anchor.removeAttribute("aria-describedby");
    } catch {}
  }
  App.memberClassmatesFloatingAnchor = null;
  App.memberClassmatesFloatingOwnerCode = "";
  if (!App.memberClassmatesFloating) return;
  const floating = App.memberClassmatesFloating;
  floating.classList.remove("is-visible");
  let reducedMotion = false;
  try {
    reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  } catch {}
  if (immediate || reducedMotion) {
    floating.hidden = true;
    return;
  }
  App.memberClassmatesFloatingHideTimer = setTimeout(() => {
    App.memberClassmatesFloatingHideTimer = null;
    if (App.memberClassmatesFloating === floating && !floating.classList.contains("is-visible")) floating.hidden = true;
  }, App.CALL_VIEWERS_TOOLTIP_TRANSITION_MS);
};
App.ensureMemberClassmatesFloating = function () {
  if (App.memberClassmatesFloating?.isConnected) return App.memberClassmatesFloating;
  const floating = document.createElement("div");
  floating.className = "call-viewers-floating member-classmates-floating";
  floating.hidden = true;
  document.body.appendChild(floating);
  App.memberClassmatesFloating = floating;
  return floating;
};
App.positionMemberClassmatesFloating = function () {
  const floating = App.memberClassmatesFloating;
  const anchor = App.memberClassmatesFloatingAnchor;
  if (!floating || floating.hidden || !anchor?.isConnected) {
    if (floating && !floating.hidden) App.hideMemberClassmatesFloating();
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  const floatingRect = floating.getBoundingClientRect();
  const margin = 8;
  const viewportWidth = Math.max(1, Number(window.innerWidth) || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, Number(window.innerHeight) || document.documentElement.clientHeight || 1);
  let left = anchorRect.right - floatingRect.width;
  let top = anchorRect.bottom + 7;
  left = Math.max(margin, Math.min(left, viewportWidth - floatingRect.width - margin));
  if (top + floatingRect.height > viewportHeight - margin) top = anchorRect.top - floatingRect.height - 7;
  top = Math.max(margin, Math.min(top, viewportHeight - floatingRect.height - margin));
  floating.style.left = `${Math.round(left)}px`;
  floating.style.top = `${Math.round(top)}px`;
};
App.showMemberClassmatesFloating = function (indicator, ownerCode) {
  if (App.userProfileOpen) return App.hideMemberClassmatesFloating({ immediate: true });
  App.hideMemberActivityFloating?.({ immediate: true });
  if (!indicator?.isConnected || indicator.hidden) return;
  const users = App.getMemberClassmates(ownerCode);
  if (!users.length) {
    App.syncMemberClassmatesIndicator(App.onlineTiles.get(String(ownerCode || "")), ownerCode);
    return;
  }
  App.clearMemberClassmatesFloatingHide();
  const floating = App.ensureMemberClassmatesFloating();
  const tooltip = App.buildMemberClassmatesTooltip(users);
  const classStatus = indicator.closest(".member-sub")?.__memberStatuses?.find(item => item.kind === "class");
  if (classStatus) {
    const row = document.createElement("div");
    row.className = "member-activity-tooltip-row member-class-heading";
    row.innerHTML = App.scheduleActivityIconMarkup();
    const text = document.createElement("span");
    text.textContent = classStatus.text;
    row.appendChild(text);
    tooltip.prepend(row);
  }
  App.memberClassmatesFloatingAnchor = indicator;
  App.memberClassmatesFloatingOwnerCode = String(ownerCode || "");
  floating.replaceChildren(tooltip);
  const wasHidden = floating.hidden;
  if (wasHidden) floating.classList.remove("is-visible");
  floating.hidden = false;
  indicator.setAttribute("aria-describedby", tooltip.id);
  App.positionMemberClassmatesFloating();
  if (wasHidden) void floating.offsetWidth;
  floating.classList.add("is-visible");
};
App.refreshMemberClassmatesFloating = function (timestamp = App.accurateNowMs()) {
  const ownerCode = String(App.memberClassmatesFloatingOwnerCode || "");
  if (!ownerCode || !App.memberClassmatesFloating || App.memberClassmatesFloating.hidden) return;
  const users = App.getMemberClassmates(ownerCode, timestamp);
  if (!users.length) {
    App.hideMemberClassmatesFloating();
    return;
  }
  App.showMemberClassmatesFloating(App.memberClassmatesFloatingAnchor, ownerCode);
};
App.bindMemberClassmatesIndicator = function (indicator, ownerCode) {
  if (!indicator || indicator.dataset.classmatesBound === "1") return;
  indicator.dataset.classmatesBound = "1";
  const show = () => App.showMemberClassmatesFloating(indicator, ownerCode);
  const hide = () => App.hideMemberClassmatesFloating();
  indicator.addEventListener("mouseenter", show);
  indicator.addEventListener("mouseleave", hide);
};
App.syncMemberClassmatesIndicator = function (tile, ownerCode, timestamp = App.accurateNowMs()) {
  const indicator = tile?.classmates;
  if (!indicator) return;
  const users = App.getMemberClassmates(ownerCode, timestamp);
  const count = users.length;
  indicator.hidden = count === 0 || tile.sub?.dataset.activityKind !== "class";
  indicator.setAttribute("aria-label", count ? `In Class With, ${count} ${count === 1 ? "person" : "people"}` : "In Class With");
  if (indicator.hidden && App.memberClassmatesFloatingOwnerCode === String(ownerCode || "")) {
    App.hideMemberClassmatesFloating();
  }
};
// One detail row in priority order, with artwork for every active game.
App.getMemberActivityStatuses = function (className, user) {
  const source = App.getUserActivityItems(user);
  const games = source.filter(item => item.kind === "game" || item.kind === "html");
  const track = App.getUserSpotifyTrack?.(user);
  const statuses = [];
  if (games.length) {
    const main = games.find(item => item.activity?.experienceTitle) || games.find(item => item.kind === "game") || games[0];
    const game = main.activity || {};
    const labelFor = item => item.kind === "game" && App.getGameActivityLabel
      ? App.getGameActivityLabel(item.activity || {}, { includeCreator: false }) : item.label;
    const entries = [main, ...games.filter(item => item !== main)].map(item => ({ kind: "game", label: labelFor(item), icon: item.activity?.icon || "", platformIcon: item.activity?.platformIcon || "" }));
    const labels = entries.map(item => item.label);
    statuses.push({ kind: "game", entries, text: labels.map((label, index) => index ? String(label || "").replace(/^Playing\s+/i, "") : label).join(", "), label: labels.join("\n"), icon: game.icon || "", platformIcon: game.platformIcon || "" });
  }
  if (track) statuses.push({ kind: "spotify", text: `${track.title}${track.artist ? ` · ${track.artist}` : ""}`, label: `Listening to ${track.title}${track.artist ? ` by ${track.artist}` : ""}` });
  if (className) statuses.push({ kind: "class", text: className, label: className });
  else if (source.some(item => item.kind === "schedule")) statuses.push({ kind: "class", text: "Viewing Schedules", label: "Viewing Schedules" });
  return statuses;
};
App.memberActivityIconMarkup = function (status) {
  if (status.entries?.length) return `<span class="member-game-icons">${status.entries.map(item => App.memberActivityIconMarkup(item)).join("")}</span>`;
  if (status.icon) return `<span class="member-game-art-wrap"><img class="member-game-art" src="${App.escapeAttr(status.icon)}" alt="" referrerpolicy="no-referrer" loading="lazy">${status.platformIcon ? `<img class="member-game-platform" src="${App.escapeAttr(status.platformIcon)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ""}</span>`;
  if (status.kind === "spotify") return App.spotifyIconMarkup?.() || "";
  if (status.kind === "class") return App.scheduleActivityIconMarkup();
  return '<span class="member-game-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 6h10c2 0 3 2 3.5 5l1 6c.4 2-1.8 3-3 1l-2-3h-9l-2 3c-1.2 2-3.4 1-3-1l1-6C4 8 5 6 7 6Z" stroke="currentColor" stroke-width="1.7"/><path d="M7 9v5m-2.5-2.5h5M16 10h.01M18 12h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>';
};
App.hideMemberActivityFloating = function ({ immediate = false } = {}) {
  clearTimeout(App.memberActivityHideTimer);
  App.memberActivityAnchor?.removeAttribute("aria-describedby");
  App.memberActivityAnchor = null;
  App.memberActivityPinnedAnchor = null;
  const floating = App.memberActivityFloating;
  if (!floating) return;
  floating.classList.remove("is-visible");
  if (immediate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) floating.hidden = true;
  else App.memberActivityHideTimer = setTimeout(() => { if (!App.memberActivityAnchor) floating.hidden = true; }, App.CALL_VIEWERS_TOOLTIP_TRANSITION_MS);
};
App.positionMemberActivityFloating = function () {
  const floating = App.memberActivityFloating, anchor = App.memberActivityAnchor;
  if (!floating || floating.hidden) return;
  if (!anchor?.isConnected || anchor.hidden) return App.hideMemberActivityFloating({ immediate: true });
  const rect = anchor.getBoundingClientRect(), box = floating.getBoundingClientRect();
  const width = window.innerWidth, height = window.innerHeight, margin = 8;
  const top = rect.top - box.height - 7;
  floating.style.left = `${Math.round(Math.max(margin, Math.min(rect.right - box.width, width - box.width - margin)))}px`;
  floating.style.top = `${Math.round(Math.max(margin, Math.min(top >= margin ? top : rect.bottom + 7, height - box.height - margin)))}px`;
};
App.showMemberActivityFloating = function (anchor) {
  if (App.userProfileOpen) return App.hideMemberActivityFloating({ immediate: true });
  App.hideMemberClassmatesFloating({ immediate: true });
  const sub = anchor?.closest(".member-sub"), statuses = sub?.__memberStatuses;
  if (!anchor?.isConnected || anchor.hidden || !statuses?.length) return App.hideMemberActivityFloating();
  const items = anchor.classList.contains("member-activity-more") ? statuses.slice(1) : statuses.slice(0, 1);
  if (!items.length) return App.hideMemberActivityFloating();
  clearTimeout(App.memberActivityHideTimer);
  if (!App.memberActivityFloating?.isConnected) {
    App.memberActivityFloating = document.createElement("div");
    App.memberActivityFloating.className = "call-viewers-floating member-activities-floating";
    App.memberActivityFloating.hidden = true;
    document.body.appendChild(App.memberActivityFloating);
  }
  const floating = App.memberActivityFloating;
  App.memberActivityAnchor?.removeAttribute("aria-describedby");
  App.memberActivityAnchor = anchor;
  const tooltip = document.createElement("div");
  tooltip.className = "call-viewers-tooltip member-activities-tooltip";
  tooltip.id = "member-activities-tooltip";
  tooltip.setAttribute("role", "tooltip");
  for (const item of items) {
    const section = document.createElement("div");
    section.className = "member-activity-tooltip-section";
    for (const entry of item.entries || [item]) {
      const row = document.createElement("div");
      row.className = "member-activity-tooltip-row";
      row.innerHTML = App.memberActivityIconMarkup(entry);
      const label = document.createElement("span"); label.textContent = entry.label;
      row.appendChild(label); section.appendChild(row);
    }
    tooltip.appendChild(section);
    if (item.kind === "class") {
      const code = sub.closest("[data-usercode]")?.dataset.usercode;
      const classmates = code ? App.getMemberClassmates(code) : [];
      if (classmates.length) section.appendChild(App.buildMemberClassmatesTooltip(classmates));
    }
  }
  floating.replaceChildren(tooltip);
  const wasHidden = floating.hidden;
  if (wasHidden) floating.classList.remove("is-visible");
  floating.hidden = false;
  anchor.setAttribute("aria-describedby", tooltip.id);
  App.positionMemberActivityFloating();
  if (wasHidden) void floating.offsetWidth;
  floating.classList.add("is-visible");
};
App.renderMemberActivityStatus = function (element, className, user) {
  if (!element) return;
  const statuses = App.getMemberActivityStatuses(className, user), primary = statuses[0];
  element.__memberStatuses = statuses;
  element.hidden = !primary;
  element.dataset.activityKind = primary?.kind || "";
  element.classList.remove("has-spotify");
  element.classList.add("member-activity-status");
  element.removeAttribute("title");
  if (!element.__memberPrimary) {
    element.replaceChildren();
    const detail = document.createElement("span"), more = document.createElement("span");
    detail.className = "member-activity-primary";
    detail.setAttribute("role", "img"); detail.tabIndex = 0;
    more.className = "member-activity-more";
    more.setAttribute("role", "button"); more.tabIndex = 0;
    for (const anchor of [detail, more]) {
      anchor.addEventListener("mouseenter", () => App.showMemberActivityFloating(anchor));
      anchor.addEventListener("mouseleave", () => { if (App.memberActivityPinnedAnchor !== anchor) App.hideMemberActivityFloating(); });
      anchor.addEventListener("focus", () => App.showMemberActivityFloating(anchor));
      anchor.addEventListener("blur", () => App.hideMemberActivityFloating());
    }
    // Touch focuses a control before dispatching click; always show here so the
    // first tap cannot immediately close the tooltip just opened by focus.
    const activate = event => { event.preventDefault(); event.stopPropagation(); App.showMemberActivityFloating(more); App.memberActivityPinnedAnchor = more; };
    more.addEventListener("click", activate);
    more.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") activate(event); });
    element.append(detail, more); element.__memberPrimary = detail; element.__memberMore = more;
  }
  const detail = element.__memberPrimary, more = element.__memberMore;
  const markup = primary ? `${App.memberActivityIconMarkup(primary)}<span class="member-activity-text">${App.escapeHtml(primary.text)}</span>` : "";
  if (detail.__markup !== markup) { detail.innerHTML = markup; detail.__markup = markup; }
  detail.setAttribute("aria-label", primary?.label || "");
  more.hidden = statuses.length < 2;
  more.textContent = `+${statuses.length - 1}`;
  more.setAttribute("aria-label", statuses.length > 1 ? `${statuses.length - 1} more activities: ${statuses.slice(1).map(item => item.label).join("; ")}` : "No other activities");
  const tile = App.onlineTiles.get(String(user?.code || element.closest("[data-usercode]")?.dataset.usercode || ""));
  if (tile?.classmates && tile.classmates.parentElement !== element) element.appendChild(tile.classmates);
  if (App.memberActivityAnchor?.closest(".member-sub") === element) App.showMemberActivityFloating(App.memberActivityAnchor);
};
App.renderOnlineIndicator = function () {
  if (!App.onlinePill || !App.onlineListEl) return;
  const membersScrollHost = App.onlineListEl.closest(".members-sidebar .side-scroll");
  const membersScrollTop = membersScrollHost?.scrollTop || 0;
  const placeNow = App.getStoredPlace() || "home";
  const isRoom = placeNow.startsWith("room:") && !!App.currentRoomId;
  const typingMode = App.getSavedTypingIndicatorMode();
  const hideTypingBar = () => {
    if (App.typingBarEl) {
      clearTimeout(App.typingBarHideTimer);
      if (App.typingBarEl.hidden) {
        App.typingBarEl.classList.remove("is-visible", "is-hiding");
        if (App.typingBarUsersEl) {
          App.typingBarUsersEl.dataset.textKey = "";
          App.typingBarUsersEl.innerHTML = "";
        }
        return;
      }
      App.typingBarEl.classList.remove("is-visible");
      App.typingBarEl.classList.add("is-hiding");
      App.typingBarHideTimer = setTimeout(() => {
        App.typingBarEl.hidden = true;
        App.typingBarEl.classList.remove("is-hiding");
        if (App.typingBarUsersEl) {
          App.typingBarUsersEl.dataset.textKey = "";
          App.typingBarUsersEl.innerHTML = "";
        }
      }, 180);
    } else if (App.typingBarUsersEl) {
      App.typingBarUsersEl.dataset.textKey = "";
      App.typingBarUsersEl.innerHTML = "";
    }
  };
  App.ensureOnlinePillMount();
  const chatActive = App.views.chat?.dataset?.active === "true";
  if (!isRoom || !chatActive) {
    App.onlinePill.hidden = true;
    App.onlineListEl.innerHTML = "";
    App.onlineTiles.clear();
    App.hideMemberClassmatesFloating({
      immediate: true
    });
    hideTypingBar();
    return;
  }
  App.onlinePill.hidden = false;
  let entries = [];
  const memberCodes = Array.from(App.roomMembersCache.keys());
  for (const code of App.onlinePresenceCache.keys()) {
    if (!App.roomMembersCache.has(code) && !memberCodes.includes(code)) memberCodes.push(code);
  }
  for (const code of App.roomCallMembersCache.keys()) {
    if (!App.roomMembersCache.has(code) && !memberCodes.includes(code)) memberCodes.push(code);
  }
  // Whichever completes first wins: the shared directory or this room's
  // parallel profile reads. Never paint a partial alphabetically shuffling list.
  const profilesReady = App.schedulesPeopleLoadedOnce || memberCodes.every(code => App.liveUserCache.has(code) || code === App.currentUser?.code);
  if (!App.roomRosterMembershipsReady || !profilesReady) {
    App.onlineListEl.setAttribute("aria-busy", "true");
    if (App.onlineLabelEl) App.onlineLabelEl.textContent = "Members";
    return;
  }
  App.onlineListEl.removeAttribute("aria-busy");
  entries = memberCodes.filter(code => {
    App.ensureLiveUserListener(code);
    // Only account records establish identity. Orphaned memberships, Calendar
    // lookups, and stale room/call presence must not create a placeholder user.
    const profile = App.getRosterProfile(code);
    return typeof profile?.username === "string" && !!profile.username.trim() && profile?.adminGhostRooms?.[App.currentRoomId] !== true && !App.isGhostModeEnabledForRoom(App.currentRoomId, code);
  }).map(code => {
    const p = App.onlinePresenceCache.get(code) || null;
    const live = App.getRosterProfile(code);
    const uname = live?.username || p?.username || "User";
    const unameLower = String(live?.usernameLower || uname).toLowerCase();
    const dname = live?.displayName || p?.displayName || uname;
    const dnameLower = live?.displayNameLower || p?.displayNameLower || String(dname).toLowerCase();
    const inCall = App.roomCallMembersCache.has(code);
    const hasRoomOpen = !!p;
    let status = "offline";
    status = App.getUserVisiblePresence?.(code) || App.appPresenceCache?.get(code) || "offline";
    return {
      code,
      username: uname,
      usernameLower: unameLower,
      displayName: dname,
      displayNameLower: dnameLower,
      typing: !!(hasRoomOpen && p?.typing),
      idle: status === "idle",
      status
    };
  });
  const nameKey = x => String(x.displayNameLower || x.usernameLower || x.code).toLowerCase();
  const stableSort = arr => arr.sort((a, b) => {
    const c = nameKey(a).localeCompare(nameKey(b));
    return c !== 0 ? c : String(a.code).localeCompare(String(b.code));
  });
  const activeGroup = entries.filter(x => x.status !== "offline");
  const offlineGroup = entries.filter(x => x.status === "offline");
  stableSort(activeGroup);
  stableSort(offlineGroup);
  entries = [...activeGroup, ...offlineGroup];
  if (App.onlineLabelEl) App.onlineLabelEl.textContent = `Members - ${entries.length}`;
  const typingUsers = activeGroup.filter(x => x.typing && x.code !== App.currentUser?.code);
  if (App.typingBarEl) {
    const showTypingBar = typingMode === "bar" && typingUsers.length > 0;
    clearTimeout(App.typingBarHideTimer);
    if (showTypingBar) {
      App.typingBarEl.hidden = false;
      App.typingBarEl.classList.remove("is-hiding");
      App.typingBarEl.classList.add("is-visible");
    } else {
      hideTypingBar();
    }
    if (App.typingBarUsersEl) {
      if (showTypingBar) {
        let text = "";
        let textKey = "";
        if (typingUsers.length >= 5) {
          text = "Several people are typing";
          textKey = text;
        } else {
          const names = typingUsers.map(user => {
            const live = App.liveUserCache.get(user.code) || null;
            const uname = String(live?.displayName || user.displayName || live?.username || user.username || "User");
            return {
              html: `<strong>${App.escapeHtml(uname)}</strong>`,
              text: uname
            };
          });
          if (names.length === 1) {
            text = `${names[0].html} is typing`;
            textKey = `${names[0].text}|1`;
          } else if (names.length === 2) {
            text = `${names[0].html} and ${names[1].html} are typing`;
            textKey = `${names[0].text}|${names[1].text}|2`;
          } else {
            const last = names.pop();
            text = `${names.map(x => x.html).join(", ")}, and ${last.html} are typing`;
            textKey = `${names.map(x => x.text).join("|")}|${last.text}|${typingUsers.length}`;
          }
        }
        if (App.typingBarUsersEl.dataset.textKey !== textKey) {
          App.typingBarUsersEl.dataset.textKey = textKey;
          App.typingBarUsersEl.innerHTML = `<span class="typing-bar-users-inner">${text}...</span>`;
        }
      }
    }
  }
  const orderedNodes = [];
  const keep = new Set();
  for (const p of entries) {
    const code = p.code;
    keep.add(code);
    App.ensureLiveUserListener(code);
    let tile = App.onlineTiles.get(code);
    if (!tile) {
      const wrap = document.createElement("div");
      wrap.dataset.usercode = code;
      const ava = document.createElement("div");
      ava.className = "mini-avatar online-ava-img";
      const typing = document.createElement("div");
      typing.className = "online-typing";
      typing.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      const tip = document.createElement("div");
      tip.className = "online-tooltip";
      wrap.className = "online-ava member-row";
      wrap.setAttribute("role", "button");
      wrap.tabIndex = 0;
      const avatarWrap = document.createElement("div");
      avatarWrap.className = "member-avatar-wrap";
      const status = document.createElement("div");
      status.className = "member-status-dot";
      const meta = document.createElement("div");
      meta.className = "member-meta";
      const nameRow = document.createElement("div");
      nameRow.className = "member-name-row";
      const name = document.createElement("div");
      name.className = "member-name";
      name.dataset.displayNameUsercode = code;
      const classmates = document.createElement("span");
      classmates.className = "member-classmates-indicator";
      classmates.hidden = true;
      classmates.setAttribute("role", "img");
      classmates.setAttribute("aria-label", "In Class With");
      classmates.innerHTML = App.MEMBER_CLASSMATES_GROUP_SVG;
      App.bindMemberClassmatesIndicator(classmates, code);
      const sub = document.createElement("div");
      sub.className = "member-sub";
      avatarWrap.appendChild(ava);
      avatarWrap.appendChild(status);
      avatarWrap.appendChild(typing);
      nameRow.appendChild(name);
      meta.appendChild(nameRow);
      meta.appendChild(sub);
      wrap.appendChild(avatarWrap);
      wrap.appendChild(meta);
      wrap.appendChild(tip);
      tile = {
        wrap,
        ava,
        tip,
        typing,
        status,
        meta,
        nameRow,
        name,
        classmates,
        sub
      };
      App.onlineTiles.set(code, tile);
    }
    tile.wrap.setAttribute("role", "button");
    tile.wrap.tabIndex = 0;
    const isOffline = p.status === "offline";
    const isIdle = p.status === "idle";
    tile.wrap.classList.toggle("typing", p.status !== "offline" && !!p.typing);
    tile.wrap.classList.toggle("offline", isOffline);
    tile.wrap.classList.toggle("idle", isIdle);
    const live = App.getRosterProfile(code);
    const uname = String(live?.displayName || p.displayName || live?.username || p.username || "User");
    tile.wrap.dataset.scheduleUsername = String(live?.username || p.username || uname);
    const classNameNow = App.getClassNameAtTimestamp(App.accurateNowMs(), {
      username: live?.username || p.username || uname,
      dayType: App.scheduleType || "full"
    });
    const memberStatusText = classNameNow || "";
    const presenceText = isOffline ? "Offline" : isIdle ? "Idle" : "Online";
    const activityLabel = App.getUserActivityLabel(live || p);
    const tipParts = [uname, presenceText];
    if (memberStatusText) tipParts.push(memberStatusText);
    if (activityLabel) tipParts.push(activityLabel);
    tile.tip.textContent = tipParts.join(" · ");
    if (tile.status) tile.status.dataset.state = p.status;
    if (tile.name) tile.name.textContent = uname;
    App.renderMemberActivityStatus(tile.sub, memberStatusText, live || p);
    if (code === App.currentUser?.code) {
      App.applyAvatar(tile.ava, live || App.currentUser);
    } else if (live) {
      App.applyAvatar(tile.ava, live);
    } else {
      App.applyAvatar(tile.ava, {
        code,
        username: uname,
        photoDataURL: App.defaultStickmanDataURL(),
        photoTransform: null
      });
    }
    tile.wrap.classList.remove("can-jump", "no-jump");
    tile.wrap.onclick = null;
    tile.wrap.removeAttribute("aria-disabled");
    tile.wrap.setAttribute("aria-label", `Open ${uname}'s profile`);
    orderedNodes.push(tile.wrap);
  }
  for (const [code, tile] of App.onlineTiles) {
    if (!keep.has(code)) {
      if (App.memberClassmatesFloatingOwnerCode === String(code)) App.hideMemberClassmatesFloating();
      if (tile.wrap.contains(App.memberActivityAnchor)) App.hideMemberActivityFloating({ immediate: true });
      tile.wrap.remove();
      App.onlineTiles.delete(code);
    }
  }
  orderedNodes.forEach((node, index) => {
    const current = App.onlineListEl.childNodes[index] || null;
    if (current !== node) App.onlineListEl.insertBefore(node, current);
  });
  while (App.onlineListEl.childNodes.length > orderedNodes.length) {
    App.onlineListEl.removeChild(App.onlineListEl.lastChild);
  }
  if (membersScrollHost && membersScrollHost.scrollTop !== membersScrollTop) {
    membersScrollHost.scrollTop = membersScrollTop;
  }
  const classmatesTimestamp = App.accurateNowMs();
  for (const [code, tile] of App.onlineTiles) {
    App.syncMemberClassmatesIndicator(tile, code, classmatesTimestamp);
  }
  App.refreshMemberClassmatesFloating(classmatesTimestamp);
  App.refreshOpenUserProfileClassmates(classmatesTimestamp);
};
App.refreshOnlineIndicatorStatusTexts = function () {
  if (!App.onlineListEl) return;
  App.onlineListEl.querySelectorAll(".online-ava.member-row[data-usercode]").forEach(row => {
    const code = String(row.dataset.usercode || "");
    if (!code) return;
    const live = App.liveUserCache.get(code) || (String(App.currentUser?.code || "") === code ? App.currentUser : null);
    if (!live) return;
    const nameEl = row.querySelector(".member-name");
    const subEl = row.querySelector(".member-sub");
    const tipEl = row.querySelector(".online-tooltip");
    const isOffline = row.classList.contains("offline");
    const isIdle = row.classList.contains("idle");
    const uname = String(live.displayName || live.username || "User");
    const classNameNow = App.getClassNameAtTimestamp(App.accurateNowMs(), {
      username: live.username || uname,
      dayType: App.scheduleType || "full"
    });
    const memberStatusText = classNameNow || "";
    const presenceText = isOffline ? "Offline" : isIdle ? "Idle" : "Online";
    const activityLabel = App.getUserActivityLabel(live);
    const tipParts = [uname, presenceText];
    if (memberStatusText) tipParts.push(memberStatusText);
    if (activityLabel) tipParts.push(activityLabel);
    const tipText = tipParts.join(" · ");
    if (nameEl && nameEl.textContent !== uname) nameEl.textContent = uname;
    App.renderMemberActivityStatus(subEl, memberStatusText, live);
    if (tipEl && tipEl.textContent !== tipText) tipEl.textContent = tipText;
  });
  const classmatesTimestamp = App.accurateNowMs();
  for (const [code, tile] of App.onlineTiles) {
    App.syncMemberClassmatesIndicator(tile, code, classmatesTimestamp);
  }
  App.refreshMemberClassmatesFloating(classmatesTimestamp);
  App.refreshOpenUserProfileClassmates(classmatesTimestamp);
};
App.startRoomPresence = function (roomId) {
  if (!App.currentUser) return;
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  App.stopRoomPresence();
  App.myPresenceRef = App.db.ref(`rooms/${id}/online/${App.currentUser.code}`);
  const ref = App.myPresenceRef;
  const session = { ref, id: globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, code: App.currentUser.code, connected: false, ready: false, generation: 0 };
  App.roomPresenceSession = session;
  const writePresence = async () => {
    const generation = session.generation;
    const isCurrent = () => App.roomPresenceSession === session && App.currentUser?.code === session.code && session.connected && session.generation === generation;
    if (!isCurrent()) return;
    if (App.isGhostModeEnabledForRoom(id, session.code)) {
      try { await ref.remove(); } catch {}
      return;
    }
    const uname = App.currentUser.username || "User";
    const dname = App.currentUser.displayName || uname;
    const payload = {
      code: App.currentUser.code,
      sessionId: session.id,
      username: uname,
      usernameLower: uname.toLowerCase(),
      displayName: dname,
      displayNameLower: dname.toLowerCase(),
      typing: false,
      idle: !!document.hidden || !!App.myRoomIdle,
      roomActivity: App.getCurrentRoomActivityPayload(id),
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    };
    try {
      await ref.onDisconnect().remove();
      if (!isCurrent()) return;
      await ref.set(payload);
      if (!isCurrent()) {
        if (App.myPresenceRef !== ref) await ref.transaction(value => !value || value.sessionId === session.id ? null : undefined, undefined, false);
        return;
      }
      session.ready = true;
    } catch {}
  };
  App.startAppPresence();
  App.syncAppIdle();
  App.presenceConnRef = App.db.ref(".info/connected");
  App.presenceConnCb = snap => {
    if (App.roomPresenceSession !== session) return;
    ++session.generation;
    session.connected = snap.val() === true;
    session.ready = false;
    if (session.connected) {
      void writePresence();
      App.scheduleRoomIdleCheck();
    }
  };
  App.presenceConnRef.on("value", App.presenceConnCb);
};
App.stopRoomPresence = function () {
  const session = App.roomPresenceSession;
  App.roomPresenceSession = null;
  // Room navigation does not stop app-wide presence or its idle timer.
  try {
    if (App.typingIdleTimer) clearTimeout(App.typingIdleTimer);
  } catch {}
  App.typingIdleTimer = null;
  App.myTyping = false;
  if (App.presenceConnRef && App.presenceConnCb) {
    try {
      App.presenceConnRef.off("value", App.presenceConnCb);
    } catch {}
  }
  App.presenceConnRef = null;
  App.presenceConnCb = null;
  if (App.myPresenceRef) {
    const ref = App.myPresenceRef;
    // Only clear this visit. A delayed leave must preserve a newer visit to
    // the same room. Keep server cleanup armed while the socket is offline.
    try {
      const removal = session?.id ? ref.transaction(value => !value || value.sessionId === session.id ? null : undefined, undefined, false) : ref.remove();
      void removal.catch(() => {});
    } catch {}
  }
  App.myPresenceRef = null;
};
App.setMyTyping = function (val) {
  const next = !!val;
  if (next === App.myTyping) return;
  App.myTyping = next;
  if (!App.myPresenceRef || (App.roomPresenceSession && !App.roomPresenceSession.connected)) return;
  try {
    App.myPresenceRef.update({
      typing: next,
      updatedAt: App.firebase.database.ServerValue.TIMESTAMP
    }).catch(() => {});
  } catch {}
};
App.bumpMyTyping = function () {
  if (!App.myPresenceRef) return;
  App.setMyTyping(true);
  if (App.typingIdleTimer) clearTimeout(App.typingIdleTimer);
  App.typingIdleTimer = setTimeout(() => App.setMyTyping(false), 900);
};
App.isChatRoomPresenceActive = function () {
  const placeNow = App.getStoredPlace() || "home";
  return !!(App.currentUser && App.myPresenceRef && App.currentRoomId && placeNow.startsWith("room:") && App.views.chat?.dataset?.active === "true");
};
// Compatibility hooks for existing room/activity callers; idle belongs to the app.
App.isRoomIdleNow = function () { return App.isAppIdleNow(); };
App.scheduleRoomIdleCheck = function () { App.syncAppIdle(); };
App.markRoomInputActive = function () { App.markAppInputActive(); };
App.startRoomIdleTracking = function () { App.startAppPresence(); };
App.stopRoomIdleTracking = function () {};

App.register("chat/presence", function initializeFeature() {
window.addEventListener("resize", App.positionMemberActivityFloating);
window.addEventListener("scroll", App.positionMemberActivityFloating, true);
document.addEventListener("pointerdown", event => {
  if (!event.target.closest?.(".member-activity-more")) App.hideMemberActivityFloating();
}, true);
document.addEventListener("keydown", event => { if (event.key === "Escape") App.hideMemberActivityFloating(); });
document.addEventListener("error", event => {
  if (event.target?.tagName !== "IMG" || !event.target.classList.contains("member-game-art")) return;
  const fallback = document.createElement("span"); fallback.innerHTML = App.memberActivityIconMarkup({ kind: "game" });
  event.target.replaceWith(fallback.firstElementChild);
}, true);
window.addEventListener("resize", App.positionMemberClassmatesFloating);
window.addEventListener("scroll", App.positionMemberClassmatesFloating, true);
window.addEventListener("resize", App.positionScheduleClassmatesFloating);
window.addEventListener("scroll", App.positionScheduleClassmatesFloating, true);
document.addEventListener("pointerdown", () => App.hideScheduleClassmatesFloating({
  immediate: true
}), true);
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target?.closest?.(".member-activity-more")) return;
  const row = e.target?.closest?.(".members-sidebar .online-ava.member-row[data-usercode]");
  if (!row) return;
  const code = String(row.dataset.usercode || "").trim();
  if (!code) return;
  e.preventDefault();
  App.openUserProfileAt(row, code);
});
});
})(globalThis.ChatApp);
