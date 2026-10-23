/* ui/clock: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.accurateNowMs = function () {
  if (App.atomicSync.ok && Number.isFinite(App.atomicSync.baseMs) && App.atomicSync.baseMs > 0) {
    const perfNow = typeof performance !== "undefined" && performance.now ? performance.now() : App.atomicSync.perfMs;
    return App.atomicSync.baseMs + Math.max(0, perfNow - App.atomicSync.perfMs);
  }
  return Date.now() + App.firebaseServerTimeOffsetMs;
};
App.getAccurateNow = function () {
  return new Date(App.accurateNowMs());
};
App.syncAtomicClock = async function ({
  force = false
} = {}) {
  const wallNow = Date.now();
  if (!force && App.atomicSync.lastSyncAt && wallNow - App.atomicSync.lastSyncAt < 30000) return; // 30s throttle
  App.atomicSync.lastSyncAt = wallNow;
  const t0 = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
  try {
    // Try multiple time sources (failover). If one is blocked/reset, move on.
    for (const base of App.ATOMIC_TIME_ENDPOINTS) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), App.ATOMIC_SYNC_TIMEOUT_MS);

      // Per-attempt timestamps (NTP-style midpoint uses the attempt window)
      const t0a = typeof performance !== "undefined" && performance.now ? performance.now() : t0;
      const r0a = Date.now();
      try {
        const sep = base.includes("?") ? "&" : "?";
        const url = `${base}${sep}_=${Math.random().toString(36).slice(2)}`;
        const res = await fetch(url, {
          cache: "no-store",
          signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`atomic time HTTP ${res.status}`);
        const data = await res.json();
        const t1 = typeof performance !== "undefined" && performance.now ? performance.now() : t0a;
        const r1 = Date.now();
        const rtt = t1 - t0a;

        // Accept several common payload shapes:
        // - worldtimeapi: { unixtime: <seconds> }
        // - timeapi.io:   { dateTime: "YYYY-MM-DDTHH:mm:ss.fffffff" ... } (interpretable as UTC when requesting UTC)
        // - other APIs:   { unixTime / epoch / timestamp }
        let serverMs = NaN;

        // Prefer timestamp strings because second-only Unix payloads can be up
        // to a full second behind by the time the response reaches the client.
        if (data && typeof data.dateTime === "string") {
          let s = String(data.dateTime || "").trim();
          // If the timestamp has no timezone, treat it as UTC (TimeAPI UTC endpoint often omits "Z")
          if (s && !/[zZ]$/.test(s) && !/[+-]\d{2}:\d{2}$/.test(s)) s += "Z";
          const ms = Date.parse(s);
          if (Number.isFinite(ms)) serverMs = ms;
        } else if (data && typeof data.datetime === "string") {
          let s = String(data.datetime || "").trim();
          if (s && !/[zZ]$/.test(s) && !/[+-]\d{2}:\d{2}$/.test(s)) s += "Z";
          const ms = Date.parse(s);
          if (Number.isFinite(ms)) serverMs = ms;
        }
        if (!Number.isFinite(serverMs) && data && Number.isFinite(Number(data.unixtime))) serverMs = Number(data.unixtime) * 1000;else if (!Number.isFinite(serverMs) && data && Number.isFinite(Number(data.unixTime))) serverMs = Number(data.unixTime) * 1000;else if (!Number.isFinite(serverMs) && data && Number.isFinite(Number(data.epoch))) serverMs = Number(data.epoch) * 1000;else if (!Number.isFinite(serverMs) && data && Number.isFinite(Number(data.timestamp))) serverMs = Number(data.timestamp) * 1000;
        if (!Number.isFinite(serverMs)) throw new Error("atomic time payload missing usable timestamp");

        // Midpoint estimate (NTP-style)
        const clientMidMs = r0a + (r1 - r0a) / 2;
        const offsetMs = serverMs - clientMidMs;
        App.atomicSync.ok = true;
        App.atomicSync.source = "network";
        App.atomicSync.offsetMs = offsetMs;
        App.atomicSync.perfMs = t1;
        App.atomicSync.baseMs = r1 + offsetMs;
        App.atomicSync.rttMs = rtt;
        clearTimeout(to);
        return; // success: stop trying endpoints
      } catch {
        // try next endpoint
      } finally {
        clearTimeout(to);
      }
    }
  } catch {
    // Keep the last known good sync if we have one; otherwise fall back to device time.
  }
};
App.startAtomicClockSync = function () {
  if (App.atomicSyncBound) return;
  App.atomicSyncBound = true;
  try {
    App.firebaseServerTimeOffsetRef = App.db.ref(".info/serverTimeOffset");
    App.firebaseServerTimeOffsetRef.on("value", snap => {
      const offset = Number(snap.val());
      // Reject corrupted values while allowing real device-clock correction.
      if (!Number.isFinite(offset) || Math.abs(offset) > 7 * 24 * 60 * 60 * 1000) return;
      App.firebaseServerTimeOffsetMs = offset;
      const perfNow = typeof performance !== "undefined" && performance.now ? performance.now() : App.atomicSync.perfMs;
      const networkAgeMs = perfNow - Number(App.atomicSync.perfMs || 0);
      const hasFreshNetworkBaseline = App.atomicSync.source === "network" && networkAgeMs >= 0 && networkAgeMs < 10 * 60 * 1000;
      if (hasFreshNetworkBaseline) return;
      App.atomicSync.ok = true;
      App.atomicSync.source = "firebase";
      App.atomicSync.offsetMs = offset;
      App.atomicSync.baseMs = Date.now() + offset;
      App.atomicSync.perfMs = typeof performance !== "undefined" && performance.now ? performance.now() : 0;
      App.atomicSync.lastSyncAt = Date.now();
    });
  } catch {
    App.firebaseServerTimeOffsetMs = 0;
  }
  void App.syncAtomicClock({
    force: true
  });
  App.atomicSyncInterval = setInterval(() => {
    void App.syncAtomicClock({
      force: true
    });
  }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void App.syncAtomicClock({
      force: true
    }).finally(() => App.startSidebarClock());
  });
};
App.formatESTClock = function (date = new Date()) {
  try {
    return App.getDateTimeFormatter("en-US", {
      timeZone: App.EST_TZ,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    }).format(date);
  } catch {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
  }
};
App.getESTParts = function (date = new Date()) {
  const parts = App.getDateTimeFormatter("en-US", {
    timeZone: App.EST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second)
  };
};
App.makeESTDate = function (parts) {
  // parts: {year,month,day,hour,minute,second}
  let d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0));
  for (let i = 0; i < 2; i++) {
    const got = App.getESTParts(d);
    const gotUTC = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second || 0);
    const wantUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
    const diff = gotUTC - wantUTC;
    if (!diff) break;
    d = new Date(d.getTime() - diff);
  }
  return d;
};
App.shiftESTCalendarDate = function (parts, days = 1) {
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: calendar.getUTCFullYear(),
    month: calendar.getUTCMonth() + 1,
    day: calendar.getUTCDate()
  };
};
App.getESTWallTimeCandidates = function (parts) {
  const seedMs = App.makeESTDate(parts).getTime();
  const matches = [];
  const seen = new Set();
  for (let hourOffset = -3; hourOffset <= 3; hourOffset += 1) {
    const candidate = new Date(seedMs + hourOffset * 60 * 60 * 1000);
    const got = App.getESTParts(candidate);
    const same = got.year === parts.year && got.month === parts.month && got.day === parts.day && got.hour === parts.hour && got.minute === parts.minute && got.second === (parts.second || 0);
    if (!same || seen.has(candidate.getTime())) continue;
    seen.add(candidate.getTime());
    matches.push(candidate);
  }
  return matches.sort((a, b) => a.getTime() - b.getTime());
};
App.stopSidebarClock = function () {
  try {
    if (App.clockInterval) clearInterval(App.clockInterval);
  } catch {}
  try {
    if (App.clockTimeout) clearTimeout(App.clockTimeout);
  } catch {}
  try {
    if (App.clockClassInterval) clearInterval(App.clockClassInterval);
  } catch {}
  App.clockInterval = null;
  App.clockTimeout = null;
  App.clockClassInterval = null;
};
App.startSidebarClock = function () {
  App.stopSidebarClock();
  App.startAtomicClockSync();
  const tick = () => {
    const nowMs = App.accurateNowMs();
    const timeText = App.formatESTClock(new Date(nowMs));
    if (App.clockTimeEl) App.clockTimeEl.textContent = timeText;
    if (App.btnTimeDisplay) {
      App.btnTimeDisplay.setAttribute("aria-label", timeText);
      App.btnTimeDisplay.dataset.tooltip = timeText;
      const tooltip = App.$("sidebar-tooltip");
      if (tooltip && (App.btnTimeDisplay.getAttribute("aria-describedby") || "").split(/\s+/).includes(tooltip.id)) {
        if (tooltip.textContent !== timeText) tooltip.textContent = timeText;
      }
    }
    const modalTimeEl = App.$("time-display-modal-time");
    if (modalTimeEl) modalTimeEl.textContent = timeText;
    App.updateTimerUI(nowMs);
    App.updateClockClassUI();
    App.refreshOnlineIndicatorStatusTexts();
    App.updateLiveMessageTimestamps();
    const phase = (App.accurateNowMs() % 1000 + 1000) % 1000;
    App.clockTimeout = setTimeout(tick, Math.max(40, 1000 - phase + 4));
  };
  tick();
  App.renderOnlineIndicator();
};
App._findConfiguredScheduleUsername = function (username) {
  const uname = String(username || "").trim();
  if (!uname) return null;
  if (Object.prototype.hasOwnProperty.call(App.SCHEDULES || {}, uname) && !uname.startsWith("__")) return uname;
  const want = uname.toLowerCase();
  for (const k of Object.keys(App.SCHEDULES || {})) {
    if (String(k).startsWith("__")) continue;
    if (String(k).toLowerCase() === want) return k;
  }
  return null;
};
App._assignedSchedulePersonForUser = function (dayType, username) {
  return App._findConfiguredScheduleUsername(username);
};
App.getClockClassText = function () {
  if (!App.currentUser || !App.schedulesModuleReady) return "";
  const dayType = App.scheduleType || "full";
  const person = App._assignedSchedulePersonForUser(dayType, App.currentUser.username);
  if (!person) return "";
  const activeKey = App._getActiveScheduleBlockKey(dayType, person);
  if (!activeKey) return "";
  const c = App._getClassForBlock(dayType, person, activeKey);
  const name = String(c?.className || "").trim();
  if (!name || name.toLowerCase() === "none") return "";
  return `Class: ${name}`;
};
App.updateClockClassUI = function () {
  const classText = App.getClockClassText();
  const modalClassEl = App.$("time-display-modal-class");
  if (modalClassEl) {
    modalClassEl.textContent = classText;
    modalClassEl.hidden = !classText;
  }
  if (App.clockClassEl) {
    App.clockClassEl.textContent = classText;
    App.clockClassEl.hidden = !classText;
  }
};
App.pad2 = function (n) {
  return String(n).padStart(2, "0");
};
App.formatDuration = function (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  return `${App.pad2(h)}:${App.pad2(m)}:${App.pad2(s)}`;
};
App.formatTimerPercent = function (value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  const fixed = n.toFixed(2);
  return n < 10 ? `0${fixed}%` : `${fixed}%`;
};
App.getTimerDisplayState = function (nowMs = App.accurateNowMs()) {
  if (!App.timerTargetMs) {
    return {
      active: false,
      remaining: "",
      detail: "",
      progress: 0,
      progressText: "",
      showProgress: false,
      showTimer: false
    };
  }
  const now = nowMs;
  const diff = App.timerTargetMs - now;
  if (diff <= 0) {
    return {
      active: false,
      remaining: "00:00:00",
      detail: `Reached ${App.timerTargetLabel}.`,
      progress: 100,
      progressText: "100.00%",
      showProgress: true,
      showTimer: true
    };
  }
  const started = Number(App.timerStartedAtMs || now);
  const total = Math.max(1, App.timerTargetMs - started);
  const elapsed = Math.min(total, Math.max(0, now - started));
  const progress = Math.max(0, Math.min(100, elapsed / total * 100));
  return {
    active: true,
    remaining: App.formatDuration(diff),
    detail: `Target: ${App.timerTargetLabel}`,
    progress,
    progressText: App.formatTimerPercent(progress),
    showProgress: true,
    showTimer: true
  };
};
App.renderTimeDisplayModal = function (nowMs = App.accurateNowMs()) {
  const timeEl = App.$("time-display-modal-time");
  const classEl = App.$("time-display-modal-class");
  const remainEl = App.$("time-display-modal-timer-remaining");
  const percentEl = App.$("time-display-modal-timer-percent");
  const detailEl = App.$("time-display-modal-timer-detail");
  const barEl = App.$("time-display-modal-timer-bar");
  const progressEl = barEl?.closest(".time-display-modal-progress");
  const timerBoxEl = App.$("time-display-modal-timer-box");
  if (timeEl) timeEl.textContent = App.formatESTClock(new Date(nowMs));
  if (classEl) {
    const classText = App.getClockClassText();
    classEl.textContent = classText;
    classEl.hidden = !classText;
  }
  const timer = App.getTimerDisplayState(nowMs);
  if (timerBoxEl) timerBoxEl.hidden = !timer.showTimer;
  if (remainEl) {
    remainEl.textContent = timer.remaining;
    remainEl.hidden = !timer.remaining;
  }
  if (percentEl) {
    percentEl.textContent = timer.progressText;
    percentEl.hidden = !timer.progressText;
  }
  if (detailEl) {
    detailEl.textContent = timer.detail;
    detailEl.hidden = !timer.detail;
  }
  if (barEl) barEl.style.width = `${timer.progress}%`;
  if (progressEl) progressEl.hidden = !timer.showProgress;
};
App.updateTimerUI = function (nowMs = App.accurateNowMs()) {
  const timer = App.getTimerDisplayState(nowMs);
  if (App.clockTimerEl) {
    App.clockTimerEl.textContent = App.timerTargetMs ? timer.active ? `Timer: ${timer.remaining} left.` : `Timer reached ${App.timerTargetLabel}.` : "";
    App.clockTimerEl.hidden = !App.timerTargetMs;
  }
  App.renderTimeDisplayModal(nowMs);
  if (App.timerTargetMs && !timer.active) {
    App.showToast({
      title: "Timer",
      body: `Reached ${App.timerTargetLabel} (ET).`,
      duration: 4000
    });
    App.clearClockTimer();
  }
};
App.startTimerCountdown = function () {
  try {
    if (App.timerInterval) clearInterval(App.timerInterval);
  } catch {}
  App.timerInterval = null;
  App.updateTimerUI(App.accurateNowMs());
};
App.clearClockTimer = function () {
  App.timerTargetMs = null;
  App.timerTargetLabel = "";
  App.timerStartedAtMs = null;
  try {
    if (App.timerInterval) clearInterval(App.timerInterval);
  } catch {}
  App.timerInterval = null;
  App.updateTimerUI();
};
App.isTimeDisplayExpanded = () => !!(App.timeDisplayStage?.isConnected || (App.modalEl && !App.modalEl.hidden && App.modalEl.dataset.size === "time-display" && App.modalEl.dataset.timeDisplayExpanded === "1"));
App.parkTimeDisplay = function () {
  if (App.timeDisplayStage?.isConnected || !App.isTimeDisplayExpanded()) return;
  // Preserve the clock as a peer surface while the shared dialog shell shows
  // chat viewers/settings. The live clock nodes keep their identity and IDs.
  const content = App.$("time-display-modal-time")?.closest(".time-display-modal-ui");
  if (!content) return;
  const stage = document.createElement("section");
  stage.id = "time-display-stage";
  stage.className = "modal is-open";
  stage.dataset.size = "time-display";
  stage.dataset.timeDisplayExpanded = "1";
  stage.setAttribute("aria-label", "Time Display");
  stage.innerHTML = '<div class="modal-card"><div class="modal-main"><header class="modal-head"><div class="modal-head-actions"></div></header><div class="modal-body"></div></div></div>';
  const actions = stage.querySelector(".modal-head-actions");
  for (const [sourceId, id, label, handler] of [
    ["btn-time-display-chat", "btn-time-stage-chat", "Open Chat", App.toggleTimeDisplayChat],
    ["btn-time-display-expand", "btn-time-stage-expand", "Collapse Time Display", () => App.collapseTimeDisplay()],
    ["btn-modal-close", "btn-time-stage-close", "Close Time Display", () => App.collapseTimeDisplay({ silent:true })]
  ]) {
    const button = App.$(sourceId).cloneNode(true);
    button.id = id;
    button.hidden = false;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.onclick = handler;
    actions.appendChild(button);
  }
  stage.querySelector(".modal-body").appendChild(content);
  App.timeDisplayStage = stage;
  document.body.appendChild(stage);
  App.modalBeforeClose = null;
  delete App.modalEl.dataset.timeDisplayExpanded;
  App.syncTimeDisplayChatAction();
};
App.canOpenTimeDisplayChat = () => !!(App.currentUser && App.currentRoomId && App.getStoredPlace() === `room:${App.currentRoomId}` && App.views?.chat?.dataset.active === "true");
App.syncTimeDisplayChatAction = function () {
  if (!App.modalEl) return;
  const button = App.$("btn-time-display-chat");
  const visible = !App.modalEl.hidden && App.modalEl.dataset.size === "time-display" && App.canOpenTimeDisplayChat();
  if (!App.canOpenTimeDisplayChat() || !App.isTimeDisplayExpanded()) App.timeChatOpen = false;
  if (button) {
    button.hidden = !visible;
    button.setAttribute("aria-pressed", App.timeChatOpen ? "true" : "false");
    button.setAttribute("aria-expanded", App.timeChatOpen ? "true" : "false");
    button.setAttribute("aria-label", App.timeChatOpen ? "Close Chat" : "Open Chat");
    button.dataset.tooltip = App.timeChatOpen ? "Close Chat" : "Open Chat";
  }
  const stageButton = App.$("btn-time-stage-chat");
  if (stageButton) {
    stageButton.hidden = !App.canOpenTimeDisplayChat();
    stageButton.setAttribute("aria-pressed", App.timeChatOpen ? "true" : "false");
    stageButton.setAttribute("aria-expanded", App.timeChatOpen ? "true" : "false");
    stageButton.setAttribute("aria-label", App.timeChatOpen ? "Close Chat" : "Open Chat");
    stageButton.dataset.tooltip = App.timeChatOpen ? "Close Chat" : "Open Chat";
  }
  const card = App.modalCard;
  if (card) card.setAttribute("aria-modal", !App.timeDisplayStage && App.isTimeDisplayExpanded() && App.timeChatOpen ? "false" : "true");
  App.syncActivityChatLayout?.();
};
App.toggleTimeDisplayChat = function () {
  if (!App.canOpenTimeDisplayChat() || (!App.timeDisplayStage && (App.modalEl.hidden || App.modalEl.dataset.size !== "time-display"))) return;
  const open = !(App.isTimeDisplayExpanded() && App.timeChatOpen);
  if (!App.isTimeDisplayExpanded()) App.enlargeTimeDisplay();
  App.timeChatOpen = open;
  if (!open) App.membersListVisible = false;
  App.syncEmojiButtonVisibility?.();
  App.syncTimeDisplayChatAction();
};
App.syncTimeDisplayExpandAction = function () {
  const button = App.$("btn-time-display-expand");
  if (!button) return;
  const expanded = App.modalEl.dataset.timeDisplayExpanded === "1";
  const label = expanded ? "Collapse Time Display" : "Expand Time Display";
  button.setAttribute("aria-pressed", expanded ? "true" : "false");
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
};
App.configureTimeDisplayExpandAction = function () {
  const chat = App.$("btn-time-display-chat");
  if (chat) chat.onclick = App.toggleTimeDisplayChat;
  App.syncTimeDisplayChatAction();
  const button = App.$("btn-time-display-expand");
  if (!button) return;
  button.hidden = false;
  button.onclick = () => {
    if (App.modalEl.dataset.timeDisplayExpanded === "1") App.collapseTimeDisplay();else App.enlargeTimeDisplay();
  };
  App.syncTimeDisplayExpandAction();
};
App.enlargeTimeDisplay = function () {
  if (App.modalEl.hidden || App.modalEl.dataset.size !== "time-display") return;
  App.modalEl.dataset.timeDisplayExpanded = "1";
  App.syncTimeDisplayChatAction();
  App.syncTimeDisplayExpandAction();
  App.renderTimeDisplayModal();
};
App.collapseTimeDisplay = function ({
  silent = false
} = {}) {
  if (App.timeDisplayStage) {
    App.timeDisplayStage.remove();
    App.timeDisplayStage = null;
    App.timeChatOpen = false;
    App.syncTimeDisplayChatAction();
    if (!silent) App.openTimeDisplayModal();
    return;
  }
  const wasExpanded = App.modalEl.dataset.timeDisplayExpanded === "1";
  delete App.modalEl.dataset.timeDisplayExpanded;
  App.timeChatOpen = false;
  App.syncTimeDisplayChatAction();
  App.syncTimeDisplayExpandAction();
  if (!silent && wasExpanded) {
    try {
      App.$("btn-time-display-expand")?.focus?.({
        preventScroll: true
      });
    } catch {}
  }
};
App.openTimeDisplayModal = function () {
  if (App.timeDisplayStage) App.collapseTimeDisplay({ silent:true });
  App.openModal({
    title: "Time Display",
    size: "time-display",
    bodyHTML: `
      <div class="time-display-modal-ui">
        <div class="time-display-modal-clock">
          <div class="time-display-modal-time" id="time-display-modal-time">—</div>
          <div class="time-display-modal-class" id="time-display-modal-class" hidden></div>
        </div>

        <div class="time-display-modal-timer" id="time-display-modal-timer-box"${App.timerTargetMs ? "" : " hidden"}>
          <div class="time-display-modal-timer-head">
            <div class="time-display-modal-timer-title">Timer</div>
            <div class="time-display-modal-timer-detail" id="time-display-modal-timer-detail" hidden></div>
          </div>
          <div class="time-display-modal-timer-metrics">
            <div class="time-display-modal-timer-remaining" id="time-display-modal-timer-remaining"></div>
            <div class="time-display-modal-timer-percent" id="time-display-modal-timer-percent" hidden></div>
          </div>
          <div class="time-display-modal-progress">
            <div class="time-display-modal-progress-bar" id="time-display-modal-timer-bar"></div>
          </div>
        </div>
      </div>
    `,
    actionsHTML: `
      ${App.timerTargetMs ? `<button class="btn" id="time-display-modal-clear" type="button">Clear Timer</button>` : ``}
      <button class="btn primary" id="time-display-modal-set" type="button">Set Timer</button>
    `,
    onBeforeClose: () => App.collapseTimeDisplay({
      silent: true
    })
  });
  App.configureTimeDisplayExpandAction();
  App.renderTimeDisplayModal();
  App.$("time-display-modal-set")?.addEventListener("click", App.openClockTimerModal);
  App.$("time-display-modal-clear")?.addEventListener("click", () => {
    App.clearClockTimer();
    App.renderTimeDisplayModal();
  });
};
App.openClockTimerModal = function () {
  App.openModal({
    title: "Set Timer",
    size: "timer",
    bodyHTML: `
      <div class="muted small">Choose a target time in Eastern Time.</div>

      <div class="timer-grid">
        <div class="timer-field">
          <div class="timer-label">Hour</div>
          <input class="input" id="timer-hour" inputmode="numeric" autocomplete="off" placeholder="1-12" maxlength="2" />
        </div>
        <div class="timer-field">
          <div class="timer-label">Minute</div>
          <input class="input" id="timer-minute" inputmode="numeric" autocomplete="off" placeholder="0-59" maxlength="2" />
        </div>
        <div class="timer-field">
          <div class="timer-label">Second</div>
          <input class="input" id="timer-second" inputmode="numeric" autocomplete="off" placeholder="0-59" maxlength="2" />
        </div>
      </div>

      <div class="timer-ampm">
        <button class="btn tiny" id="timer-am" type="button">AM</button>
        <button class="btn tiny" id="timer-pm" type="button">PM</button>
      </div>

      <div class="timer-hint muted small" id="timer-preview">—</div>
    `,
    actionsHTML: `
      ${App.timerTargetMs ? `<button class="btn" id="timer-clear" type="button">Clear Timer</button>` : ``}
      <button class="btn primary" id="timer-start" type="button">Start</button>
    `
  });
  const defaultNowMs = App.accurateNowMs() + 60 * 1000;
  const defaultParts = App.getESTParts(new Date(defaultNowMs));
  const defaultHour12 = defaultParts.hour % 12 || 12;
  let ampm = defaultParts.hour >= 12 ? "PM" : "AM";
  function syncPreview() {
    const hRaw = App.$("timer-hour")?.value || "";
    const mRaw = App.$("timer-minute")?.value || "";
    const sRaw = App.$("timer-second")?.value || "";
    const h = Number(hRaw);
    const m = Number(mRaw);
    const s = Number(sRaw);
    const prev = App.$("timer-preview");
    if (!prev) return;
    if (!hRaw || Number.isNaN(h) || h < 1 || h > 12) {
      prev.textContent = "Enter an hour (1–12).";
      return;
    }
    if (mRaw && (Number.isNaN(m) || m < 0 || m > 59)) {
      prev.textContent = "Minute must be 00–59.";
      return;
    }
    if (sRaw && (Number.isNaN(s) || s < 0 || s > 59)) {
      prev.textContent = "Second must be 00–59.";
      return;
    }
    prev.textContent = `Target: ${h}:${App.pad2(mRaw ? m : 0)}:${App.pad2(sRaw ? s : 0)} ${ampm}`;
  }
  function setAMPM(next) {
    ampm = next;
    App.$("timer-am")?.classList.toggle("primary", ampm === "AM");
    App.$("timer-pm")?.classList.toggle("primary", ampm === "PM");
    syncPreview();
  }
  App.$("timer-am")?.addEventListener("click", () => setAMPM("AM"));
  App.$("timer-pm")?.addEventListener("click", () => setAMPM("PM"));
  function sanitizeTimerInput(id, min, max) {
    const el = App.$(id);
    if (!el) return;
    el.addEventListener("input", () => {
      let v = el.value.replace(/\D/g, "").slice(0, 2);
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n)) v = String(Math.min(max, Math.max(min, n)));
      }
      el.value = v;
      syncPreview();
    });
  }
  sanitizeTimerInput("timer-hour", 1, 12);
  sanitizeTimerInput("timer-minute", 0, 59);
  sanitizeTimerInput("timer-second", 0, 59);
  if (App.$("timer-hour")) App.$("timer-hour").value = String(defaultHour12);
  if (App.$("timer-minute")) App.$("timer-minute").value = App.pad2(defaultParts.minute);
  if (App.$("timer-second")) App.$("timer-second").value = "00";
  setAMPM(ampm);
  syncPreview();
  App.$("timer-clear")?.addEventListener("click", () => {
    App.clearClockTimer();
    App.closeModal();
  });
  App.$("timer-start")?.addEventListener("click", () => {
    const h = Number(App.$("timer-hour")?.value || "");
    const m = Number(App.$("timer-minute")?.value || "0");
    const s = Number(App.$("timer-second")?.value || "0");
    if (!Number.isFinite(h) || h < 1 || h > 12) {
      App.showToast({
        title: "Invalid Time",
        body: "Hour must be 1–12.",
        duration: 2400
      });
      return;
    }
    if (!Number.isFinite(m) || m < 0 || m > 59) {
      App.showToast({
        title: "Invalid Time",
        body: "Minute must be 00–59.",
        duration: 2400
      });
      return;
    }
    if (!Number.isFinite(s) || s < 0 || s > 59) {
      App.showToast({
        title: "Invalid Time",
        body: "Second must be 00–59.",
        duration: 2400
      });
      return;
    }
    let h24 = h % 12;
    if (ampm === "PM") h24 += 12;
    const nowMs = App.accurateNowMs();
    const now = new Date(nowMs);
    const nowParts = App.getESTParts(now);
    const requestedWallTime = {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: h24,
      minute: m,
      second: s
    };
    const todayCandidates = App.getESTWallTimeCandidates(requestedWallTime);
    if (!todayCandidates.length) {
      App.showToast({
        title: "Invalid Time",
        body: "That Eastern Time does not exist today because of the daylight saving time change.",
        duration: 3600
      });
      return;
    }
    let target = todayCandidates.find(candidate => candidate.getTime() > nowMs) || null;
    if (!target) {
      const nextDay = App.shiftESTCalendarDate(nowParts, 1);
      const nextCandidates = App.getESTWallTimeCandidates({
        ...nextDay,
        hour: h24,
        minute: m,
        second: s
      });
      target = nextCandidates[0] || null;
    }
    if (!target) {
      App.showToast({
        title: "Invalid Time",
        body: "Could not resolve that Eastern Time.",
        duration: 3000
      });
      return;
    }
    App.timerTargetMs = target.getTime();
    App.timerTargetLabel = `${h}:${App.pad2(m)}:${App.pad2(s)} ${ampm}`;
    App.timerStartedAtMs = nowMs;
    App.startTimerCountdown();
    App.closeModal();
  });
};

App.register("ui/clock", function initializeFeature() {
App.clockTimeEl = App.$("clock-time");
App.clockClassEl = App.$("clock-class");
App.clockTimerEl = App.$("clock-timer");
App.btnTimeDisplay = App.$("btn-time-display");
if (App.btnTimeDisplay) {
  App.btnTimeDisplay.setAttribute("aria-haspopup", "dialog");
}
App.EST_TZ = "America/New_York";
App.ATOMIC_TIME_ENDPOINTS = [
// Primary: timeapi.io (typically CORS-friendly and reliable)
"https://timeapi.io/api/Time/current/zone?timeZone=UTC",
// Secondary: worldtimeapi (kept as fallback only)
"https://worldtimeapi.org/api/timezone/Etc/UTC"];
App.ATOMIC_SYNC_TIMEOUT_MS = 3500;
App.atomicSync = {
  ok: false,
  source: "device",
  offsetMs: 0,
  baseMs: 0,
  perfMs: 0,
  rttMs: 0,
  lastSyncAt: 0
};
App.firebaseServerTimeOffsetMs = 0;
App.firebaseServerTimeOffsetRef = null;
App.atomicSyncInterval = null;
App.atomicSyncBound = false;
App.clockInterval = null;
App.clockTimeout = null;
App.clockClassInterval = null;
App.schedulesModuleReady = false;
App.timerInterval = null;
App.timerTargetMs = null;
App.timerTargetLabel = "";
App.timerStartedAtMs = null;
App.btnTimeDisplay?.addEventListener("click", App.openTimeDisplayModal);
App.startSidebarClock();
App.updateTimerUI();
});
})(globalThis.ChatApp);
