/* rooms/home: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.formatESTShortDate = function (date) {
  return App.getDateTimeFormatter("en-US", {
    timeZone: App.EST_TZ,
    year: "2-digit",
    month: "numeric",
    day: "numeric"
  }).format(date);
};
App.formatESTLongDate = function (date) {
  return App.getDateTimeFormatter("en-US", {
    timeZone: App.EST_TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(date);
};
App.formatESTTimestampTime = function (date, {
  includeSeconds = false
} = {}) {
  return App.getDateTimeFormatter("en-US", {
    timeZone: App.EST_TZ,
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? {
      second: "2-digit"
    } : {}),
    hour12: true
  }).format(date);
};
App.isSameESTDay = function (a, b) {
  const ap = App.getESTParts(a);
  const bp = App.getESTParts(b);
  return ap.year === bp.year && ap.month === bp.month && ap.day === bp.day;
};
App.formatChatTimestampParts = function (ts, {
  nowDate = App.getAccurateNow()
} = {}) {
  try {
    const d = new Date(ts ?? Date.now());
    if (!Number.isFinite(d.getTime())) return {
      short: "",
      full: ""
    };
    const timeText = App.formatESTTimestampTime(d);
    const short = App.isSameESTDay(d, nowDate) ? timeText : `${App.formatESTShortDate(d)} ${timeText}`;
    const full = `${App.formatESTLongDate(d)} ${App.formatESTTimestampTime(d, {
      includeSeconds: true
    })}`;
    return {
      short,
      full
    };
  } catch {
    return {
      short: "",
      full: ""
    };
  }
};
App.installTimestampTooltipSurface = function (doc = document, win = window) {
  if (!doc || !win) return null;
  const tip = doc.createElement("div");
  tip.id = "timestamp-tooltip";
  tip.className = "app-tooltip timestamp-tooltip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  try {
    (doc.body || doc.documentElement).appendChild(tip);
  } catch {
    return null;
  }
  let activeTarget = null;
  function position(target) {
    if (!target?.isConnected) return hide();
    const text = String(target.getAttribute?.("data-tooltip") || "").trim();
    if (!text) return hide();
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.add("visible");
    const margin = 8;
    const gap = 8;
    const vw = Math.max(doc.documentElement?.clientWidth || 0, win.innerWidth || 0);
    const vh = Math.max(doc.documentElement?.clientHeight || 0, win.innerHeight || 0);
    tip.style.maxWidth = `${Math.max(80, vw - margin * 2)}px`;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const r = target.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(margin, Math.min(left, vw - tr.width - margin));
    const above = r.top - tr.height - gap;
    const below = r.bottom + gap;
    let top = above >= margin ? above : below;
    if (top + tr.height > vh - margin && above >= margin) top = above;
    top = Math.max(margin, Math.min(top, vh - tr.height - margin));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  function show(target) {
    if (!target?.isConnected) return hide();
    activeTarget = target;
    App.activeTimestampTooltipTarget = target;
    position(target);
  }
  function hide() {
    activeTarget = null;
    App.activeTimestampTooltipTarget = null;
    tip.classList.remove("visible");
    tip.hidden = true;
  }
  // Delegated cleanup survives message rerenders and works for timestamps in
  // menus/logs as well as message rows, including moves between nested nodes.
  doc.addEventListener("pointerout", event => {
    if (activeTarget?.contains(event.target) && !activeTarget.contains(event.relatedTarget)) hide();
  }, true);
  doc.addEventListener("pointermove", event => {
    if (activeTarget && !activeTarget.contains(event.target)) hide();
  }, true);
  doc.addEventListener("focusout", event => {
    if (activeTarget?.contains(event.target) && !activeTarget.contains(event.relatedTarget)) hide();
  }, true);
  doc.documentElement?.addEventListener?.("pointerleave", hide);
  if (typeof win.MutationObserver === "function") {
    new win.MutationObserver(() => {
      if (activeTarget && (!activeTarget.isConnected || !activeTarget.getClientRects().length)) hide();
    }).observe(doc.body || doc.documentElement, { childList:true, subtree:true });
  }
  doc.addEventListener("pointerdown", hide, true);
  doc.addEventListener("pointercancel", hide, true);
  doc.addEventListener("touchstart", hide, {
    capture: true,
    passive: true
  });
  doc.addEventListener("wheel", hide, {
    capture: true,
    passive: true
  });
  win.addEventListener?.("scroll", hide, true);
  win.addEventListener?.("resize", hide);
  win.addEventListener?.("blur", hide);
  doc.addEventListener?.("visibilitychange", () => {
    if (doc.hidden) hide();
  });
  doc.addEventListener("fullscreenchange", hide);
  return {
    show,
    hide,
    position
  };
};
App.positionTimestampTooltipFor = function (target) {
  App.mainTooltipController?.position?.(target);
};
App.showTimestampTooltipFor = function (target) {
  App.mainTooltipController?.show?.(target);
};
App.hideTimestampTooltip = function () {
  App.mainTooltipController?.hide?.();
};
App.updateLiveMessageTimestamps = function () {
  if (document.visibilityState === "hidden") return;
  const now = App.getESTParts(App.getAccurateNow());
  const dateKey = now.year + "-" + now.month + "-" + now.day;
  // A timestamp's clock time and full-date tooltip are fixed. Only the date
  // prefix changes at midnight. Newly rendered/edited rows refresh themselves.
  if (App.messageTimestampDateKey !== dateKey) {
    App.messageTimestampDateKey = dateKey;
    document.querySelectorAll(".bubble-time").forEach(el => {
      try {
        el._refreshTimestamp?.();
      } catch {}
    });
  }
  if (App.activeTimestampTooltipTarget) App.positionTimestampTooltipFor(App.activeTimestampTooltipTarget);
};
App._minutesESTAt = function (ts) {
  try {
    const d = new Date(typeof ts === "number" ? ts : Date.now());
    const parts = App.getDateTimeFormatter("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(d);
    const h = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
    const m = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
    return h * 60 + m;
  } catch {
    return null;
  }
};
App._resolveSchedulePersonKey = function (dayType, username) {
  const u = String(username || "").trim().replace(/^@+/, "");
  if (!u) return "";
  return App._findConfiguredScheduleUsername(u) || u;
};
App._getActiveScheduleBlockKeyAt = function (dayType, person, minutes, weekdayOverride = App.getESTScheduleDay()) {
  const dt = App._normalizeScheduleType(dayType || "full");
  for (const b of App.getScheduleRows(dt, person, weekdayOverride)) {
    const r = App._parseRangeMinutes(b.time || "");
    if (!r) continue;
    if (minutes >= r.start && minutes < r.end) return b.key;
  }
  return null;
};
App._getESTWeekdayIndexAt = function (ts) {
  try {
    const short = App.getDateTimeFormatter("en-US", {
      timeZone: "America/New_York",
      weekday: "short"
    }).format(new Date(ts)).slice(0, 3).toLowerCase();
    return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(short);
  } catch {
    return -1;
  }
};
App._getClassForBlockAt = function (dayType, person, blockKey, weekdayOverride, ts) {
  const weekday = App._normalizeScheduleWeekday(weekdayOverride === undefined ? App.getESTScheduleDay(new Date(ts)) : weekdayOverride);
  const configuredPerson = App._findConfiguredScheduleUsername(person);
  const record = weekday && configuredPerson ? App.SCHEDULES?.[configuredPerson]?.[weekday]?.[blockKey] : null;
  if (record && typeof record === "object") {
    return {
      className: record.className ?? "",
      teacher: record.teacher ?? "",
      room: record.room ?? ""
    };
  }
  return {
    className: "",
    teacher: "",
    room: ""
  };
};
App.getClassRecordAtTimestamp = function (ts, {
  username,
  dayType,
  weekdayOverride
} = {}) {
  const minutes = App._minutesESTAt(ts);
  if (minutes === null) return null;
  const estParts = App.getESTParts(new Date(ts));
  const weekdayIndex = new Date(Date.UTC(estParts.year, estParts.month - 1, estParts.day)).getUTCDay();
  if (weekdayIndex === 0 || weekdayIndex === 6) return null;
  const dt = App._normalizeScheduleType(dayType || "full");
  const person = App._resolveSchedulePersonKey(dt, username);
  if (!person) return null;
  const key = App._getActiveScheduleBlockKeyAt(dt, person, minutes, weekdayOverride || App.getESTScheduleDay(new Date(ts)));
  if (!key) return null;
  const c = App._getClassForBlockAt(dt, person, key, weekdayOverride, ts);
  const record = {
    key,
    className: String(c?.className || "").trim(),
    teacher: String(c?.teacher || "").trim(),
    room: String(c?.room || "").trim()
  };
  return record.className ? record : null;
};
App.getClassNameAtTimestamp = function (ts, options = {}) {
  return App.getClassRecordAtTimestamp(ts, options)?.className || "";
};
App.clearMessagesToHome = function () {
  const rooms = App.getSortedRoomEntries();
  const totalRooms = rooms.length;
  const totalUnread = rooms.reduce((n, r) => n + Number(r.missedCount || 0), 0);
  const totalPinned = rooms.reduce((n, r) => n + (r.pinned ? 1 : 0), 0);
  let rowsHTML = "";
  for (const r of rooms) {
    const meta = App.roomsMetaCache.get(r.roomId) || null;
    const displayName = App.roomDisplayName(r.roomId, meta);
    const rid = App.escapeHtml(r.roomId);
    const roomNameHtml = App.escapeHtml(displayName);
    const roomNameLower = App.escapeHtml(displayName.toLowerCase());
    const rawPreview = String(r.preview || "No recent messages");
    const prevLower = App.escapeHtml(rawPreview.toLowerCase());
    const previewSeparator = rawPreview.indexOf(": ");
    const prev = previewSeparator > 0 && previewSeparator < 36 ? `<span class="home-room-preview-author">${App.escapeHtml(rawPreview.slice(0, previewSeparator))}</span><span class="home-room-preview-text">: ${App.escapeHtml(rawPreview.slice(previewSeparator + 2) || "Message")}</span>` : `<span class="home-room-preview-text">${App.escapeHtml(rawPreview)}</span>`;
    const avatarSrc = App.escapeAttr(String(meta?.photoDataURL || App.defaultStickmanDataURL()));
    const avatarStyle = App.escapeAttr(`transform:${App.formatMediaTransformRelative(meta?.photoTransform, 132)};`);
    const unreadText = App.formatNewMessagesLabel(r.missedCount);
    const lockMark = App.privateRoomMarkHTML(meta);
    const pinMark = r.pinned ? `<span class="room-pin-mark" aria-label="Pinned Room" data-tooltip="Pinned">${App.roomPinBadgeSVG()}</span>` : "";
    rowsHTML += `
      <div class="home-room-row"
          data-roomid="${rid}"
          data-roomid-lower="${roomNameLower}"
          data-preview-lower="${prevLower}"
          data-unread="${r.missedCount ? "1" : "0"}"
          data-pinned="${r.pinned ? "1" : "0"}"
          data-private="${App.isPrivateRoomMeta(meta) ? "1" : "0"}"
          tabindex="0"
          role="button"
          aria-label="Open room ${roomNameHtml}${r.missedCount ? `. ${unreadText}` : ""}">
        <div class="home-room-left">
          <div class="room-avatar" data-room-icon-id="${rid}">
            <img class="room-avatar-image" src="${avatarSrc}" alt="Room ${roomNameHtml} icon" draggable="false" style="${avatarStyle}">
          </div>

          <div class="home-room-main">
            <div class="home-room-head">
              <div class="home-room-code-row">
                <div class="home-room-code">${roomNameHtml}</div>
                <span class="room-new-messages" ${r.missedCount ? "" : "hidden"} aria-label="${unreadText}">${unreadText}</span>
                <div class="home-room-markers">${lockMark}${pinMark}</div>
              </div>
            </div>
            <div class="home-room-preview">${prev}</div>
          </div>
          <span class="home-room-open" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </div>
      </div>
    `;
  }
  const emptyRoomsHTML = `
    <div class="home-empty-block">
      <div class="empty-title">No rooms yet.</div>
      <div class="empty-sub">Create or join a room to start chatting.</div>
    </div>
  `;
  App.messagesListEl.innerHTML = `
    <div class="home-dash home-overhaul">
      <section class="home-metrics" aria-label="Room overview">
        <div class="home-stat"><span class="home-stat-value" id="home-stat-rooms">${totalRooms}</span><span class="home-stat-label">Rooms</span></div>
        <div class="home-stat"><span class="home-stat-value" id="home-stat-unread">${totalUnread}</span><span class="home-stat-label">Unread</span></div>
        <div class="home-stat"><span class="home-stat-value" id="home-stat-pinned">${totalPinned}</span><span class="home-stat-label">Pinned</span></div>
      </section>

      <section class="home-workspace">
        <div class="home-primary-panel">
          <div class="home-panel-head">
            <div>
              <div class="home-section-title">Your Rooms</div>
              <div class="home-section-sub">Recent messages, unread activity, and pinned spaces.</div>
            </div>
            <button class="home-new-room" id="home-new-room" type="button">New Room</button>
          </div>

          <div class="home-controls">
            <label class="home-search-wrap">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              <input class="input home-search" id="home-search" autocomplete="off" placeholder="Search rooms and messages" />
            </label>
            <div class="home-filters" role="group" aria-label="Filter rooms">
              <button class="btn tiny" data-home-filter="all" type="button">All</button>
              <button class="btn tiny" data-home-filter="unread" type="button">Unread</button>
              <button class="btn tiny" data-home-filter="pinned" type="button">Pinned</button>
              <button class="btn tiny" data-home-filter="public" type="button">Public</button>
              <button class="btn tiny" data-home-filter="private" type="button">Private</button>
            </div>
          </div>

          <div class="home-roomlist" id="home-roomlist">
            ${rowsHTML || emptyRoomsHTML}
            <div class="home-empty-block" id="home-empty" hidden>
              <div class="empty-title">No results.</div>
              <div class="empty-sub">Try a different search or filter.</div>
            </div>
          </div>

          <div class="home-foot">
            <div class="muted small" id="home-searchhint"></div>
          </div>
        </div>
      </section>
    </div>
  `;
  const search = App.$("home-search");
  if (search) {
    search.value = App.homeState.query || "";
    search.addEventListener("input", () => {
      App.homeState.query = search.value || "";
      App.applyHomeFilters();
    });
  }
  App.$("home-new-room")?.addEventListener("click", () => App.openRoomComposerModal("create"));
  App.messagesListEl.querySelectorAll("[data-home-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      App.homeState.filter = btn.getAttribute("data-home-filter") || "all";
      App.applyHomeFilters();
    });
  });
  App.messagesListEl.querySelectorAll(".home-room-row").forEach(row => {
    const rid = row.getAttribute("data-roomid") || "";
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      App.openRoomButtonContextMenu(e, rid, row);
    });
    row.addEventListener("click", e => {
      if (e.target.closest("button")) return;
      App.openRoom(rid);
    });
    row.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      App.openRoom(rid);
    });
  });
  App.applyHomeFilters();
};
App.showLoggedInHome = function () {
  App.clearPendingPoll?.();
  App.closeCallMenu();
  if (App.selectedGame?.roomActivityId) void App.closeGamesStage({
    preserve: false
  });
  App.stopRoomPresence();
  App.detachOnlineIndicator();
  App.detachMessages();
  App.stopSchedulesHighlightTimer();
  App.stopSchedulesPeopleListener();
  App.stopAllChatAudio();
  try {
    App.clearReplyState({
      quiet: true
    });
  } catch {}
  try {
    App.clearPendingFiles({
      quiet: true
    });
  } catch {}
  try {
    App.closePingBar({
      quiet: true
    });
  } catch {}
  try {
    App.$("msg-input").value = "";
    App.$("msg-input").blur();
  } catch {}
  App.currentRoomId = null;
  App.scheduleRoomEmptyStateSync();
  App.abortFirebaseUploadsForPlaceChange("home");
  App.setStoredPlace("home");
  App.syncSidebarNavActive();
  App.syncSidebarRoomActiveStates();
  App.syncCallButton();
  App.setComposerEnabled(false);
  try {
    App.syncEmojiButtonVisibility();
  } catch {}
  try {
    if (App.messagesEl) App.messagesEl.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch {}
  App.clearMessagesToHome();
};

App.register("rooms/home", function initializeFeature() {
App.mainTooltipController = null;
App.activeTimestampTooltipTarget = null;
App.mainTooltipController = App.installTimestampTooltipSurface(document, window);
});
})(globalThis.ChatApp);
