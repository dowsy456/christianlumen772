/* schedules/render: methods register before ordered initialization. */
(function (App) {
  "use strict";
App._timeToMinutes = function (t) {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 1 || hh > 12 || mm < 0 || mm > 59) return null;
  const ap = m[3].toUpperCase();
  if (hh === 12) hh = 0;
  if (ap === "PM") hh += 12;
  return hh * 60 + mm;
};
App._parseRangeMinutes = function (range) {
  const s = String(range || "").trim();
  const m = s.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
  if (!m) return null;
  const a = App._timeToMinutes(m[1]);
  const b = App._timeToMinutes(m[2]);
  if (a === null || b === null) return null;
  return {
    start: a,
    end: b
  };
};
App._getActiveScheduleBlockKey = function (dayType, person) {
  if (App._normalizeScheduleType(dayType) === "noschool") return null;
  const p = App.getESTParts(App.getAccurateNow());
  const weekdayIndex = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (weekdayIndex === 0 || weekdayIndex === 6) return null;
  const now = p.hour * 60 + p.minute + p.second / 60;
  for (const b of App.getScheduleRows(dayType, person, App.getESTScheduleDay())) {
    const r = App._parseRangeMinutes(b.time || "");
    if (!r) continue;
    if (now >= r.start && now < r.end) return b.key;
  }
  return null;
};
App.applySchedulesActiveHighlight = function () {
  if (!App.messagesListEl) return;
  if (App.getStoredPlace() !== "schedules") return;
  if (!App.schedulesState.previewManual) {
    const automaticDay = App.getESTScheduleDay();
    if (automaticDay !== App.schedulesState.lastAutoDay) {
      App.scheduleRenderSchedulesUI();
      return;
    }
  }
  const dayType = App.schedulesState.dayType || "full";
  const active = App.schedulesState.previewDay === App.getESTScheduleDay() ? App._getActiveScheduleBlockKey(dayType, App.schedulesState.person) : null;
  App.messagesListEl.querySelectorAll(".sched-grid-row[data-sched-block]").forEach(row => {
    const k = row.getAttribute("data-sched-block");
    row.classList.toggle("is-active", !!active && k === active);
  });
  App.messagesListEl.querySelectorAll(".sched-times-row[data-sched-block]").forEach(row => {
    const k = row.getAttribute("data-sched-block");
    row.classList.toggle("is-active", !!active && k === active);
  });
};
App.startSchedulesHighlightTimer = function () {
  if (App.schedulesHighlightTimer) return;
  App.schedulesHighlightTimer = setInterval(() => {
    if (document.visibilityState === "hidden" || App.getStoredPlace() !== "schedules") return;
    App.applySchedulesActiveHighlight();
  }, 1000);
};
App.stopSchedulesHighlightTimer = function () {
  if (App.schedulesHighlightTimer) {
    clearInterval(App.schedulesHighlightTimer);
    App.schedulesHighlightTimer = null;
  }
  App.hideScheduleClassmatesFloating({
    immediate: true
  });
};
App.scheduleRenderSchedulesUI = function () {
  if (App.queueLiveUpdate) {
    App.queueLiveUpdate("schedules", () => { if (App.getStoredPlace() === "schedules") App.renderSchedulesUI(); });
    return;
  }
  if (App.schedulesRenderRaf) return;
  App.schedulesRenderRaf = requestAnimationFrame(() => {
    App.schedulesRenderRaf = 0;
    if ((App.getStoredPlace() || "") !== "schedules") return;
    App.renderSchedulesUI();
  });
};
App._schedVal = function (v) {
  const s = String(v ?? "").trim();
  return s ? App.escapeHtml(s) : "";
};
App._renderScheduleTimesCard = function (dayType, person = null) {
  if (App._normalizeScheduleType(dayType) === "noschool") return `<div class="sched-card sched-card-times"><div class="sched-card-title">Schedule Times</div><div class="muted">N/A</div></div>`;
  const schedulePerson = App._resolveSchedulePersonKey(dayType, person);
  const t = App.SCHEDULE_TIMES[App._normalizeScheduleType(dayType)] || {};
  const activeKey = App._getActiveScheduleBlockKey(dayType, schedulePerson);
  let rows = "";
  for (const b of App.SCHEDULE_BLOCKS) {
    const rec = t[b.key] || {
      time: "",
      duration: ""
    };
    const isActive = !!activeKey && b.key === activeKey;
    rows += `
      <div class="sched-times-row${isActive ? " is-active" : ""}" data-sched-block="${App.escapeHtml(b.key)}">
        <div class="sched-times-period">${App.escapeHtml(b.label)}</div>
        <div class="sched-times-time">${App._schedVal(rec.time)}</div>
        <div class="sched-times-dur">${App._schedVal(rec.duration)}</div>
      </div>`;
  }
  return `
    <div class="sched-card sched-card-times">
      <div class="sched-card-title">Schedule Times</div>
      <div class="sched-times">
        <div class="sched-times-head">
          <div>Period</div>
          <div>Time</div>
          <div>Minutes</div>
        </div>
        ${rows}
      </div>
    </div>
  `;
};
App._renderScheduleTable = function (dayType, person) {
  const schedulePerson = App._resolveSchedulePersonKey(dayType, person);
  const previewDay = App.schedulesState.previewManual ? App._normalizeScheduleWeekday(App.schedulesState.previewDay) : App.getESTScheduleDay();
  const activeKey = previewDay === App.getESTScheduleDay() ? App._getActiveScheduleBlockKey(dayType, schedulePerson) : null;
  const hasScheduleAssigned = !!App._findConfiguredScheduleUsername(person);
  if (!hasScheduleAssigned || !App.getScheduleRows(dayType, person, previewDay).length) {
    return `
        <div class="sched-grid">
          <div class="sched-grid-head">
            <div>Period</div>
            <div>Time</div>
            <div>Minutes</div>
            <div>Class Name</div>
            <div>Teacher</div>
            <div>Room</div>
          </div>
          <div class="sched-grid-row sched-grid-empty">
            <div class="sched-cell sched-cell-empty">${dayType === "noschool" ? "N/A" : hasScheduleAssigned ? "No classes on this day" : "No schedule assigned"}</div>
          </div>
        </div>
    `;
  }
  let rows = "";
  for (const b of App.getScheduleRows(dayType, person, previewDay)) {
    const t = b, c = b;
    const isActive = !!activeKey && b.key === activeKey;
    rows += `
      <div class="sched-grid-row${isActive ? " is-active" : ""}" data-sched-block="${App.escapeHtml(b.key)}">
        <div class="sched-cell sched-cell-period" data-sched-value="${App.escapeHtml(b.label)}">${App.escapeHtml(b.label)}</div>
        <div class="sched-cell sched-cell-time" data-sched-value="${App._schedVal(t.time)}">${App._schedVal(t.time)}</div>
        <div class="sched-cell sched-cell-duration" data-sched-value="${App._schedVal(t.duration)}">${App._schedVal(t.duration)}</div>
        <div class="sched-cell sched-cell-class"><span class="sched-class-label" data-sched-value="${App._schedVal(c.className)}" data-sched-class-hover="1" data-sched-block="${App.escapeHtml(b.key)}" data-sched-class-owner="${App.escapeHtml(schedulePerson)}" data-sched-weekday="${App.escapeHtml(previewDay || "")}" data-sched-day-type="${App.escapeHtml(App._normalizeScheduleType(dayType))}">${App._schedVal(c.className)}</span></div>
        <div class="sched-cell sched-cell-teacher" data-sched-value="${App._schedVal(c.teacher)}">${App._schedVal(c.teacher)}</div>
        <div class="sched-cell sched-cell-room" data-sched-value="${App._schedVal(c.room)}">${App._schedVal(c.room)}</div>
      </div>
    `;
  }
  return `
      <div class="sched-grid">
        <div class="sched-grid-head">
          <div>Period</div>
          <div>Time</div>
          <div>Minutes</div>
          <div>Class Name</div>
          <div>Teacher</div>
          <div>Room</div>
        </div>
        ${rows}
      </div>
  `;
};
App.renderSchedulesUI = function () {
  if (!App.messagesListEl) return;

  // Schedule type is controlled by Panel (Firebase)
  App.schedulesState.dayType = App.scheduleType || App.schedulesState.dayType || "full";
  const dayType = App.schedulesState.dayType || "full";
  const person = App.schedulesState.person;
  const automaticDay = App.getESTScheduleDay();
  const previewDay = App.schedulesState.previewManual ? App._normalizeScheduleWeekday(App.schedulesState.previewDay) : automaticDay;
  App.schedulesState.previewDay = previewDay;
  App.schedulesState.lastAutoDay = automaticDay;
  const typeLabel = dayType === "noschool" ? "N/A" : App._scheduleTypeLabel(dayType);
  const dayLabel = previewDay && dayType !== "noschool" ? `Day ${previewDay} · ${App._scheduleWeekdayLabel(previewDay)}` : "Day N/A";
  const typeIcon = k => {
    const key = App._normalizeScheduleType(k);
    if (key === "half") {
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <path d="M21 12.5A8.5 8.5 0 1 1 11.5 3a6.5 6.5 0 1 0 9.5 9.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      </svg>`;
    }
    if (key === "delay2") {
      return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
        <path d="M12 7v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2"/>
    </svg>`;
  };
  const personIcon = u => {
    const code = String(u?.code || "");
    return `<div class="sched-avatar" data-usercode="${App.escapeHtml(code)}" data-sched-avatar-person="${App.escapeHtml(String(u?.username || ""))}" aria-hidden="true"></div>`;
  };
  const people = Array.isArray(App.schedulesPeopleCache) ? App.schedulesPeopleCache : [];
  const selectedPersonUser = person ? App.schedulesPeopleByUsername.get(String(person)) : null;
  const emptyLabel = App.schedulesPeopleError ? "Accounts could not be loaded. Reopen Schedules to retry." : App.schedulesPeopleLoadedOnce ? `No accounts found.` : `Loading accounts...`;
  const peopleGrid = people.length ? people.map(u => {
    const uname = String(u?.username || "User"),
      dname = String(u?.displayName || uname),
      code = String(u?.code || "");
    return `
      <button class="sched-person-card" data-sched-person="${App.escapeHtml(uname)}" type="button">
        ${personIcon(u)}
        <div class="sched-person-meta">
          <div class="sched-person-name" data-display-name-usercode="${App.escapeHtml(code)}">${App.escapeHtml(dname)}</div>
        </div>
        <div class="sched-person-go" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </button>
    `;
  }).join("") : `<div class="muted small" style="padding:6px 2px">${App.escapeHtml(emptyLabel)}</div>`;
  const previewButtons = App.SCHEDULE_WEEKDAYS.map(({
    key,
    label
  }) => `
    <button class="sched-preview-btn${previewDay === key ? " is-active" : ""}" data-sched-preview-day="${key}" type="button" data-tooltip="${App.escapeHtml(label)}" aria-label="Preview ${App.escapeHtml(label)} schedule">${key}</button>
  `).join("") + (!automaticDay ? `
    <button class="sched-preview-btn${previewDay ? "" : " is-active"}" data-sched-preview-day="" type="button">N/A</button>
  ` : "");
  const top = `
    <div class="sched-topcard">
      <div class="sched-top-left">
        <div class="sched-top-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M7 4h10a2 2 0 0 1 2 2v14l-3-2-4 2-4-2-3 2V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
            <path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
        <div>
          <div class="sched-title">Schedules</div>
          <div class="sched-sub">${App.escapeHtml(dayLabel)}</div>
        </div>
      </div>

      <div class="sched-top-right">
        <div class="sched-preview-group">
          <span class="sched-control-label">Weekday</span>
          <div class="sched-preview-days" aria-label="Preview day">
            ${previewButtons}
          </div>
        </div>
        <div class="sched-type-badge" data-tooltip="Controlled by Admin Panel">
          <span class="sched-type-ico">${typeIcon(dayType)}</span>
          <span class="sched-type-text">${App.escapeHtml(typeLabel)}</span>
        </div>
      </div>
    </div>
  `;
  let body = "";
  if (!person) {
    body = `
      <div class="sched-split">
        <div class="sched-card sched-card-people">
          <div class="sched-card-title">People</div>
          <div class="sched-people-grid">
            ${peopleGrid}
          </div>
        </div>

        ${App._renderScheduleTimesCard(dayType, null)}
      </div>
    `;
  } else {
    body = `
      <div class="sched-card sched-person-view">
      <div class="sched-view-head">
        <button class="btn tiny" data-sched-back="1" type="button" aria-label="Close schedule" data-tooltip="Close schedule">✕</button>
        ${personIcon(selectedPersonUser || { username: person })}
        <div class="sched-person-title"${selectedPersonUser?.code ? ` data-display-name-usercode="${App.escapeHtml(String(selectedPersonUser.code))}"` : ``}>${App.escapeHtml(String(selectedPersonUser?.displayName || person))}</div>
        <div class="sched-person-actions"><button class="btn tiny" type="button" data-sched-copy>Copy Schedule</button>${App.isVinny?.() ? `<button class="btn tiny primary" type="button" data-sched-edit>Edit Schedule</button>` : ""}</div>
      </div>
      ${App._renderScheduleTable(dayType, person)}
      </div>
    `;
  }
  const html = `
    <div class="sched-page${person ? " sched-selected" : ""}">
      ${top}
      ${body}
    </div>
  `;
  // Presence heartbeats never replace schedule DOM, inputs, hovered elements,
  // or scroll position. Real schedule changes patch this same view in place.
  if (App.messagesListEl.dataset.scheduleMarkup === html && App.messagesListEl.querySelector(".sched-page")) {
    App.applySchedulesActiveHighlight();
    return;
  }
  App.messagesListEl.dataset.scheduleMarkup = html;
  const existingPage = App.messagesListEl.querySelector(".sched-page");
  const sameView = existingPage && existingPage.dataset.person === (person || "") && existingPage.dataset.weekday === (previewDay || "");
  if (sameView) App.patchScheduleDOM(existingPage, html);
  else {
    App.hideScheduleClassmatesFloating({ immediate: true });
    App.messagesListEl.innerHTML = html;
  }
  const page = App.messagesListEl.querySelector(".sched-page");
  page.dataset.person = person || ""; page.dataset.weekday = previewDay || "";

  // Hydrate avatars + keep them live
  App.messagesListEl.querySelectorAll(".sched-avatar[data-usercode]").forEach(el => {
    const code = el.getAttribute("data-usercode") || "";
    const username = el.dataset.schedAvatarPerson || el.closest("[data-sched-person]")?.getAttribute("data-sched-person") || "";
    const u = App.schedulesPeopleByCode.get(code) || App.schedulesPeopleByUsername.get(username);
    if (u) App.applyAvatar(el, u);
    if (code) App.ensureLiveUserListener(code);
  });

  // Wire preview day buttons
  App.messagesListEl.querySelectorAll("[data-sched-preview-day]").forEach(btn => {
    btn.onclick = () => {
      const raw = btn.getAttribute("data-sched-preview-day");
      App.schedulesState.previewManual = !!raw;
      App.schedulesState.previewDay = App._normalizeScheduleWeekday(raw);
      App.renderSchedulesUI();
    };
  });

  // Schedule rows use a hover-only classmate tooltip for this exact day and period.
  App.messagesListEl.querySelectorAll("[data-sched-class-hover='1']").forEach(row => {
    const show = () => App.showScheduleClassmatesFloating(row, {
      ownerUsername: row.getAttribute("data-sched-class-owner") || "",
      blockKey: row.getAttribute("data-sched-block") || "",
      weekday: row.getAttribute("data-sched-weekday") || "",
      dayType: row.getAttribute("data-sched-day-type") || dayType
    });
    row.onmouseenter = () => {
      // Truncated class text gets the complete text tooltip; otherwise the
      // class name alone is the hit target for the classmates tooltip.
      if (row.scrollWidth > row.clientWidth + 1 || row.scrollHeight > row.clientHeight + 1) {
        App.showScheduleValueTooltip(row); return;
      }
      delete row.dataset.tooltip; show();
    };
    row.onmouseleave = () => App.hideScheduleClassmatesFloating();
  });
  App.messagesListEl.querySelectorAll("[data-sched-value]").forEach(cell => {
    if (cell.dataset.schedClassHover) return;
    cell.onpointerenter = () => {
      if (cell.scrollWidth > cell.clientWidth + 1 || cell.scrollHeight > cell.clientHeight + 1) App.showScheduleValueTooltip(cell);
    };
    cell.onpointerleave = () => App.hideScheduleClassmatesFloating();
  });

  // Wire name cards
  App.messagesListEl.querySelectorAll("[data-sched-person]").forEach(btn => {
    btn.onclick = () => {
      App.schedulesState.person = btn.getAttribute("data-sched-person");
      App.renderSchedulesUI();
    };
  });

  // Wire back
  const backBtn = App.messagesListEl.querySelector("[data-sched-back]");
  if (backBtn) {
    backBtn.onclick = () => {
      App.schedulesState.person = null;
      App.renderSchedulesUI();
    };
  }
  const copyButton = App.messagesListEl.querySelector("[data-sched-copy]");
  if (copyButton) copyButton.onclick = () => void App.copyPersonSchedule(person);
  const editButton = App.messagesListEl.querySelector("[data-sched-edit]");
  if (editButton) editButton.onclick = () => App.openScheduleEditor(person);

  // Keep the yellow "active period" highlight updating live
  App.startSchedulesHighlightTimer();
  App.applySchedulesActiveHighlight();
};
App.showScheduleValueTooltip = function (cell) {
  const text = cell.dataset.schedValue || cell.textContent;
  if (!text) return;
  App.clearScheduleClassmatesFloatingHide();
  const floating = App.ensureScheduleClassmatesFloating();
  const tooltip = document.createElement("div");
  tooltip.className = "call-viewers-tooltip member-classmates-tooltip schedule-value-tooltip";
  tooltip.id = "schedule-value-tooltip"; tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = text;
  floating.replaceChildren(tooltip);
  App.scheduleClassmatesFloatingAnchor = cell;
  floating.hidden = false; cell.setAttribute("aria-describedby", tooltip.id);
  App.positionScheduleClassmatesFloating(); floating.classList.add("is-visible");
};
App.patchScheduleDOM = function (page, markup) {
  const template = document.createElement("template"); template.innerHTML = markup;
  const target = template.content.firstElementChild;
  const patch = (current, next) => {
    if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; return; }
    if (current.nodeType !== 1) return;
    // Avatar children and live profile names are owned by the shared media system.
    if (current.classList.contains("sched-avatar")) return;
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name) && !["data-person", "data-weekday", "data-tooltip"].includes(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    const desired = [...next.childNodes];
    for (let index = 0; index < desired.length; index++) {
      const wanted = desired[index]; let actual = current.childNodes[index];
      const key = wanted.nodeType === 1 && (wanted.getAttribute("data-sched-block") || wanted.getAttribute("data-sched-person"));
      if (key) {
        const matched = [...current.childNodes].find(node => node.nodeType === 1 && (node.getAttribute("data-sched-block") || node.getAttribute("data-sched-person")) === key);
        if (matched && matched !== actual) { current.insertBefore(matched, actual || null); actual = matched; }
      }
      if (!actual) current.appendChild(wanted.cloneNode(true));
      else if (actual.nodeType !== wanted.nodeType || actual.nodeName !== wanted.nodeName) current.replaceChild(wanted.cloneNode(true), actual);
      else patch(actual, wanted);
    }
    while (current.childNodes.length > desired.length) current.lastChild.remove();
  };
  patch(page, target);
};
App.clearMessagesToSchedules = function () {
  App.renderSchedulesUI();
};
App.showSchedulesPage = function (personOverride = null) {
  const navigation = App.schedulesNavigation = (App.schedulesNavigation || 0) + 1;
  App.closeCallMenu();
  if (App.selectedGame?.roomActivityId) void App.closeGamesStage({
    preserve: false
  });
  // Always open to the name-picker screen (schedule type is controlled by Panel)
  App.schedulesState.dayType = App.scheduleType || "full";
  App.schedulesState.previewDay = App.getESTScheduleDay();
  App.schedulesState.previewManual = false;
  App.schedulesState.lastAutoDay = App.schedulesState.previewDay;
  const requestedPerson = personOverride ? String(personOverride).trim() || null : null;
  App.schedulesState.person = requestedPerson;
  App.stopAllChatAudio();
  App.stopRoomPresence();
  App.detachOnlineIndicator();
  App.detachMessages();
  // detachMessages prepares a future chat batch. This page owns the list now.
  App.bulkLoading = false;
  App.bulkMsgFrag = null;
  App.clearRoomLoadingState?.();
  if (App.schedulesRenderRaf) cancelAnimationFrame(App.schedulesRenderRaf);
  App.schedulesRenderRaf = 0;
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
  App.syncCallButton();
  App.abortFirebaseUploadsForPlaceChange("schedules");
  App.setStoredPlace("schedules");
  App.setComposerEnabled(false);
  App.syncSidebarNavActive();
  App.syncSidebarRoomActiveStates();
  try {
    App.syncEmojiButtonVisibility();
  } catch {}
  try {
    if (App.messagesEl) App.messagesEl.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch {}
  // Render cached/default schedules synchronously. A delayed room callback
  // cannot strand this page behind a placeholder or replace a later page.
  App.refreshSchedulesPeople();
  App.renderSchedulesUI();
  requestAnimationFrame(() => {
    if (navigation !== App.schedulesNavigation || App.getStoredPlace() !== "schedules" || App.currentRoomId) return;
    App.startScheduleTypeListener();
    App.startSchedulesPeopleListener();
    App.clearMessagesToSchedules();
  });
};

App.register("schedules/render", function initializeFeature() {
App.schedulesHighlightTimer = null;
App.schedulesState = {
  dayType: "full",
  previewDay: null,
  previewManual: false,
  lastAutoDay: null,
  person: null
};
App.schedulesRenderRaf = 0;
});
})(globalThis.ChatApp);
