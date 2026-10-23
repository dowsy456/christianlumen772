/* schedules/admin: methods register before ordered initialization. */
(function (App) {
  "use strict";
App._normalizeScheduleWeekday = function (v) {
  const key = String(v ?? "").trim().toUpperCase();
  return App.SCHEDULE_WEEKDAYS.some(day => day.key === key) ? key : null;
};
App.getESTScheduleDay = function (date = App.getAccurateNow()) {
  const timestamp = date instanceof Date ? date.getTime() : Number(date);
  const index = App._getESTWeekdayIndexAt(Number.isFinite(timestamp) ? timestamp : Date.now());
  return App.SCHEDULE_WEEKDAYS.find(day => day.index === index)?.key || null;
};
App._scheduleWeekdayLabel = function (key) {
  const normalized = App._normalizeScheduleWeekday(key);
  return App.SCHEDULE_WEEKDAYS.find(day => day.key === normalized)?.label || "N/A";
};
App._normalizeScheduleType = function (v) {
  const s = String(v ?? "").trim();
  return s === "full" || s === "half" || s === "delay2" || s === "noschool" ? s : "full";
};
App._normalizeAccountCreationEnabled = function (v) {
  // A fresh database has no admin settings. Only an explicit false disables it.
  return v !== false;
};
App._scheduleTypeLabel = function (key) {
  const k = App._normalizeScheduleType(key);
  return App.SCHEDULE_DAY_TYPES.find(x => x.key === k)?.label || "Full Day";
};
App.startScheduleTypeListener = function () {
  App.startScheduleDataListener();
  if (App.scheduleTypeListener) return;
  const ref = App.db.ref(App.ADMIN_SCHEDULETYPE_PATH);
  const cb = snap => {
    App.scheduleType = App._normalizeScheduleType(snap.val());
    const wrap = App.$("panel-schedtypes");
    if (wrap) {
      wrap.querySelectorAll("[data-panel-schedtype]").forEach(btn => {
        const k = btn.getAttribute("data-panel-schedtype") || "full";
        btn.classList.toggle("primary", App._normalizeScheduleType(k) === App.scheduleType);
      });
    }
    if (App.getStoredPlace() === "schedules") {
      App.schedulesState.dayType = App.scheduleType;
      try {
        App.scheduleRenderSchedulesUI();
      } catch {}
    }
  };
  ref.on("value", cb);
  App.scheduleTypeListener = {
    ref,
    cb
  };
};
App.stopScheduleTypeListener = function () {
  App.stopScheduleDataListener();
  if (!App.scheduleTypeListener) return;
  try {
    App.scheduleTypeListener.ref.off("value", App.scheduleTypeListener.cb);
  } catch {}
  App.scheduleTypeListener = null;
  App.scheduleType = "full";
};
App.setScheduleType = async function (key) {
  if (!App.isVinny?.()) throw new Error("Only Vinny can change the schedule type.");
  const k = App._normalizeScheduleType(key);
  await App.db.ref(App.ADMIN_SCHEDULETYPE_PATH).set(k);
};
App.startAccountCreationListener = function () {
  if (App.accountCreationListener) return;
  const ref = App.db.ref(App.ADMIN_ACCOUNTCREATION_PATH);
  const cb = snap => {
    App.accountCreationEnabled = App._normalizeAccountCreationEnabled(snap.val());
    App.bindCreateAccountButton();
    const wrap = App.$("panel-account-creation");
    if (wrap) {
      wrap.querySelectorAll("[data-panel-account-creation]").forEach(btn => {
        const k = btn.getAttribute("data-panel-account-creation") || "disabled";
        btn.classList.toggle("primary", k === "enabled" === App.accountCreationEnabled);
      });
    }
  };
  ref.on("value", cb);
  App.accountCreationListener = {
    ref,
    cb
  };
};
App.setAccountCreationEnabled = async function (enabled) {
  if (!App.isVinny?.()) throw new Error("Only Vinny can change account creation.");
  await App.db.ref(App.ADMIN_ACCOUNTCREATION_PATH).set(!!enabled);
};
App._getClassForBlock = function (dayType, person, blockKey, weekdayOverride = App.getESTScheduleDay()) {
  const weekday = App._normalizeScheduleWeekday(weekdayOverride);
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

// The existing account model uses account codes, not Firebase Authentication.
// This editor follows the existing Vinny admin UI boundary. Deployments must
// enforce equivalent authorization with authenticated database rules before
// treating any client-side admin check as a security boundary.
App.scheduleStorageKey = function (person) {
  return encodeURIComponent(String(person || "").trim().toLowerCase()).replace(/\./g, "%2E");
};
App.getScheduleOverride = function (person) {
  return App.scheduleOverrides?.[App.scheduleStorageKey(person)] || null;
};
App.getScheduleRows = function (dayType, person, weekday = App.getESTScheduleDay()) {
  const day = App._normalizeScheduleWeekday(weekday);
  if (!day || App._normalizeScheduleType(dayType) === "noschool") return [];
  const override = App.getScheduleOverride(person);
  if (override?.removed) return [];
  if (override?.days && Object.prototype.hasOwnProperty.call(override.days, day)) {
    return Array.isArray(override.days[day]) ? override.days[day] : Object.values(override.days[day] || {});
  }
  const configured = App._findConfiguredScheduleUsername(person);
  if (person && !configured) return [];
  const times = App.SCHEDULE_TIMES?.[App._normalizeScheduleType(dayType)] || {};
  return App.SCHEDULE_BLOCKS.map(block => ({
    key: block.key, label: block.label,
    time: times[block.key]?.time || "", duration: times[block.key]?.duration || "",
    className: App.SCHEDULES?.[configured]?.[day]?.[block.key]?.className || "",
    teacher: App.SCHEDULES?.[configured]?.[day]?.[block.key]?.teacher || "",
    room: App.SCHEDULES?.[configured]?.[day]?.[block.key]?.room || ""
  }));
};
App.normalizeScheduleDays = function (days) {
  const clean = {};
  for (const { key: day } of App.SCHEDULE_WEEKDAYS) {
    const rows = Array.isArray(days?.[day]) ? days[day] : Object.values(days?.[day] || {});
    if (rows.length > 24) throw new Error("Each day can contain at most 24 periods.");
    const seen = new Set();
    clean[day] = rows.map((row, index) => {
      const value = {};
      for (const field of ["key", "label", "time", "duration", "className", "teacher", "room"]) {
        value[field] = String(row?.[field] || "").trim().slice(0, field === "key" ? 64 : 180);
      }
      if (!value.key || /[.#$\[\]/]/.test(value.key) || seen.has(value.key)) value.key = `period_${index + 1}`;
      while (seen.has(value.key)) value.key += "_";
      seen.add(value.key);
      if (!value.label) value.label = `Period ${index + 1}`;
      if (value.time) {
        const range = App._parseRangeMinutes(value.time);
        if (!range || range.start >= range.end) throw new Error(`${day}: enter a valid start and end time for ${value.label}.`);
        value.duration = `${range.end - range.start} minutes`;
      } else value.duration = "";
      return value;
    });
  }
  return clean;
};
App.applyScheduleOverrides = function (raw) {
  if (!App.scheduleDefaults) App.scheduleDefaults = JSON.parse(JSON.stringify(App.SCHEDULES || {}));
  const overrides = {};
  const schedules = JSON.parse(JSON.stringify(App.scheduleDefaults));
  for (const [key, record] of Object.entries(raw || {})) {
    if (!record || typeof record !== "object" || !record.username || key !== App.scheduleStorageKey(record.username)) continue;
    const username = Object.keys(schedules).find(name => name.toLowerCase() === String(record.username).toLowerCase()) || String(record.username);
    if (record.removed === true) { overrides[key] = { ...record, removed: true }; delete schedules[username]; continue; }
    try {
      const days = App.normalizeScheduleDays(record.days);
      overrides[key] = { ...record, days };
      schedules[username] = Object.fromEntries(App.SCHEDULE_WEEKDAYS.map(day => [day.key,
        Object.fromEntries(days[day.key].map(row => [row.key, { className: row.className, teacher: row.teacher, room: row.room }]))]));
    } catch (error) { console.warn("Skipped invalid schedule record", error.message); }
  }
  const signature = JSON.stringify(overrides);
  if (signature === App.scheduleOverridesSignature) return;
  App.scheduleOverridesSignature = signature;
  App.scheduleOverrides = overrides;
  App.SCHEDULES = schedules;
  App.refreshSchedulesPeople?.();
  App.scheduleRenderSchedulesUI?.();
  App.updateClockClassUI?.();
  App.refreshOnlineIndicatorStatusTexts?.();
  const hovered = App.scheduleClassmatesFloatingAnchor;
  if (hovered?.isConnected && hovered.dataset.schedClassOwner) {
    App.showScheduleClassmatesFloating?.(hovered, { ownerUsername: hovered.dataset.schedClassOwner,
      blockKey: hovered.dataset.schedBlock, weekday: hovered.dataset.schedWeekday, dayType: hovered.dataset.schedDayType });
  }
  // An editor keeps its local draft. A changed remote revision is reported and
  // rejected on save instead of replacing an active field or its selection.
  if (App.scheduleEditor && App.scheduleEditor.revision !== Number(App.getScheduleOverride(App.scheduleEditor.person)?.revision || 0)) {
    const status = document.querySelector("[data-sched-editor-status]");
    if (status) status.textContent = "This schedule changed elsewhere. Reopen the editor before saving your changes.";
  }
};
App.startScheduleDataListener = function () {
  if (App.scheduleDataListener || !App.db) return;
  const ref = App.db.ref("admin/schedules");
  const cb = snap => { App.scheduleDataLoaded = true; App.scheduleDataError = ""; App.applyScheduleOverrides(snap.val()); };
  ref.on("value", cb, error => {
    App.scheduleDataError = error.message;
    App.scheduleDataListener = null;
    App.scheduleRenderSchedulesUI?.();
  });
  App.scheduleDataListener = { ref, cb };
};
App.stopScheduleDataListener = function () {
  const listener = App.scheduleDataListener;
  if (listener) listener.ref.off("value", listener.cb);
  App.scheduleDataListener = null;
  App.scheduleDataLoaded = false;
  App.scheduleEditor = null;
};
App.savePersonSchedule = async function (person, days, { removed = false, expectedRevision = 0 } = {}) {
  if (!App.isVinny?.()) throw new Error("Only Vinny can edit schedules.");
  const username = String(person || "").trim();
  if (!username || username.length > 120) throw new Error("Choose a valid user.");
  if (!App.scheduleDataLoaded) throw new Error("Schedules are still loading. Please try again.");
  const normalized = removed ? {} : App.normalizeScheduleDays(days);
  const owner = String(App.currentUser?.code || "");
  let conflict = false;
  const result = await App.db.ref(`admin/schedules/${App.scheduleStorageKey(username)}`).transaction(current => {
    if (!App.isVinny?.() || String(App.currentUser?.code || "") !== owner) return;
    if (Number(current?.revision || 0) !== Number(expectedRevision)) { conflict = true; return; }
    conflict = false;
    return { username, days: normalized, removed: !!removed, revision: Number(expectedRevision) + 1,
      updatedAt: App.firebase?.database?.ServerValue?.TIMESTAMP || Date.now() };
  }, undefined, false);
  if (!result.committed) throw new Error(conflict ? "This schedule changed elsewhere. Reopen the editor to use its latest version." : "The schedule was not saved. Check your connection and try again.");
};
App.scheduleAsText = function (person, days = null) {
  const lines = [`Schedule — ${person}`];
  for (const day of App.SCHEDULE_WEEKDAYS) {
    lines.push("", `${day.label} (Day ${day.key})`);
    const rows = days?.[day.key] || App.getScheduleRows(App.scheduleType === "noschool" ? "full" : App.scheduleType || "full", person, day.key);
    if (!rows.length) lines.push("No classes");
    for (const row of rows) lines.push(`${row.label} | ${row.time || "Time not set"} | ${row.className || "No class"} | Teacher: ${row.teacher || "—"} | Room: ${row.room || "—"}`);
  }
  return lines.join("\n");
};
App.copyPersonSchedule = async function (person, days = null) {
  const text = App.scheduleAsText(person, days);
  try {
    if (App.copyTextToClipboard) await App.copyTextToClipboard(text);
    else await navigator.clipboard.writeText(text);
    App.showToast?.({ title: "Schedule Copied", body: "The full week is on your clipboard.", duration: 1800 });
  }
  catch {
    App.openModal({ title: "Copy Schedule", bodyHTML: `<textarea class="sched-copy-text" readonly aria-label="Schedule text">${App.escapeHtml(text)}</textarea>` });
    const area = document.querySelector(".sched-copy-text");
    area?.select();
  }
};
App.openScheduleEditor = function (person) {
  if (!App.isVinny?.()) return;
  const days = Object.fromEntries(App.SCHEDULE_WEEKDAYS.map(day => [day.key,
    App.getScheduleRows(App.scheduleType === "noschool" ? "full" : App.scheduleType || "full", person, day.key).map(row => ({ ...row }))]));
  const editor = { person, days, day: App._normalizeScheduleWeekday(App.schedulesState.previewDay) || "M",
    revision: Number(App.getScheduleOverride(person)?.revision || 0), saving: false };
  App.scheduleEditor = editor;
  const dayOptions = App.SCHEDULE_WEEKDAYS.map(day => `<option value="${day.key}">${day.label}</option>`).join("");
  App.openModal({
    title: "Edit Schedule", size: "schedule-editor",
    bodyHTML: `<div class="sched-editor">
      <div class="sched-editor-days">${App.SCHEDULE_WEEKDAYS.map(day => `<button type="button" class="btn tiny" data-sched-edit-day="${day.key}">${day.label}</button>`).join("")}</div>
      <div class="sched-editor-copy"><label>Copy From <select data-sched-copy-source>${dayOptions}</select></label><button class="btn tiny" type="button" data-sched-copy-day>Replace This Day</button></div>
      <div data-sched-editor-rows></div>
      <div class="sched-editor-tools"><button class="btn tiny" type="button" data-sched-add-row>Add Period</button><button class="btn tiny" type="button" data-sched-copy-week>Copy Week as Text</button><button class="btn tiny danger" type="button" data-sched-remove-week>Remove Entire Schedule</button></div>
      <div class="sched-editor-status" role="status" data-sched-editor-status></div>
    </div>`,
    actionsHTML: `<button class="btn primary" type="button" data-sched-edit-save>Save Schedule</button>`,
    onBeforeClose: () => { if (App.scheduleEditor === editor) App.scheduleEditor = null; }
  });
  const body = App.$("modal-body");
  const status = message => { const el = body.querySelector("[data-sched-editor-status]"); if (el) el.textContent = message; };
  body.querySelectorAll("[data-sched-edit-day]").forEach(button => button.addEventListener("click", () => {
    editor.day = button.dataset.schedEditDay; App.renderScheduleEditorRows();
  }));
  body.querySelector("[data-sched-copy-day]").onclick = () => {
    const source = body.querySelector("[data-sched-copy-source]").value;
    if (source === editor.day) { status("Choose another day to copy from."); return; }
    editor.days[editor.day] = editor.days[source].map(row => ({ ...row }));
    App.renderScheduleEditorRows(); status(`${App._scheduleWeekdayLabel(source)} copied to ${App._scheduleWeekdayLabel(editor.day)}. Save to apply.`);
  };
  body.querySelector("[data-sched-add-row]").onclick = () => {
    if (editor.days[editor.day].length >= 24) { status("Each day can contain at most 24 periods."); return; }
    editor.days[editor.day].push({ key: `period_${Date.now().toString(36)}`, label: `Period ${editor.days[editor.day].length + 1}`, time: "", duration: "", className: "", teacher: "", room: "" });
    App.renderScheduleEditorRows();
  };
  body.querySelector("[data-sched-copy-week]").onclick = () => void App.copyPersonSchedule(person, editor.days);
  const save = async removed => {
    if (editor.saving) return;
    editor.saving = true;
    body.querySelectorAll("button, input, select").forEach(el => el.disabled = true);
    status("Saving schedule…");
    try {
      await App.savePersonSchedule(person, editor.days, { removed, expectedRevision: editor.revision });
      if (App.scheduleEditor === editor) App.closeModal();
      App.scheduleRenderSchedulesUI();
    } catch (error) { status(error.message || "The schedule could not be saved."); }
    finally { editor.saving = false; body.querySelectorAll("button, input, select").forEach(el => el.disabled = false); }
  };
  body.querySelector("[data-sched-edit-save]").onclick = () => void save(false);
  body.querySelector("[data-sched-remove-week]").onclick = event => {
    if (!editor.confirmRemove) { editor.confirmRemove = true; event.currentTarget.textContent = "Confirm Remove Entire Schedule"; status("This removes every day for this user. Click again to apply."); return; }
    void save(true);
  };
  App.renderScheduleEditorRows();
};
App.renderScheduleEditorRows = function () {
  const editor = App.scheduleEditor;
  const body = App.$("modal-body");
  const container = body?.querySelector("[data-sched-editor-rows]");
  if (!editor || !container) return;
  body.querySelectorAll("[data-sched-edit-day]").forEach(button => {
    button.classList.toggle("primary", button.dataset.schedEditDay === editor.day);
    button.setAttribute("aria-pressed", String(button.dataset.schedEditDay === editor.day));
  });
  const fields = [["label", "Period"], ["time", "Time (e.g. 7:45 AM - 8:30 AM)"], ["className", "Class Name"], ["teacher", "Teacher"], ["room", "Room"]];
  container.innerHTML = editor.days[editor.day].map((row, index) => `<fieldset class="sched-editor-row" data-sched-edit-row="${index}"><legend>${App.escapeHtml(row.label || `Period ${index + 1}`)}</legend>
    <div class="sched-editor-fields">${fields.map(([key, label]) => `<label>${label}<input type="text" maxlength="180" data-sched-edit-field="${key}" value="${App.escapeHtml(row[key] || "")}"></label>`).join("")}</div>
    <div class="sched-editor-row-actions"><button type="button" class="btn tiny" data-sched-move="-1" aria-label="Move Period Up" ${index === 0 ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button><button type="button" class="btn tiny" data-sched-move="1" aria-label="Move Period Down" ${index === editor.days[editor.day].length - 1 ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg></button>
      <label>Copy To <select data-sched-row-destination>${App.SCHEDULE_WEEKDAYS.filter(day => day.key !== editor.day).map(day => `<option value="${day.key}">${day.label}</option>`).join("")}</select></label><button class="btn tiny" type="button" data-sched-copy-row>Copy Class</button><button class="btn tiny" type="button" data-sched-delete-row>Remove Period</button></div>
  </fieldset>`).join("") || `<p class="muted">No periods for ${App._scheduleWeekdayLabel(editor.day)}. Add a period or copy another day.</p>`;
  container.oninput = event => {
    const input = event.target.closest("[data-sched-edit-field]");
    if (!input || editor.saving) return;
    const fieldset = input.closest("[data-sched-edit-row]");
    const row = editor.days[editor.day][Number(fieldset.dataset.schedEditRow)];
    row[input.dataset.schedEditField] = input.value;
    if (input.dataset.schedEditField === "label") fieldset.querySelector("legend").textContent = input.value || "Period";
  };
  container.onclick = event => {
    const button = event.target.closest("button"), fieldset = button?.closest("[data-sched-edit-row]");
    if (!fieldset || button.disabled || editor.saving) return;
    const index = Number(fieldset.dataset.schedEditRow);
    if (button.hasAttribute("data-sched-delete-row")) { editor.days[editor.day].splice(index, 1); App.renderScheduleEditorRows(); return; }
    if (button.hasAttribute("data-sched-move")) {
      const rows = editor.days[editor.day], target = index + Number(button.dataset.schedMove);
      if (target < 0 || target >= rows.length) return;
      [rows[index], rows[target]] = [rows[target], rows[index]];
      const sibling = container.children[target];
      if (target < index) container.insertBefore(fieldset, sibling);
      else container.insertBefore(sibling, fieldset);
      Array.from(container.children).forEach((node, position) => {
        node.dataset.schedEditRow = String(position);
        node.querySelector('[data-sched-move="-1"]').disabled = position === 0;
        node.querySelector('[data-sched-move="1"]').disabled = position === rows.length - 1;
      });
      button.focus({ preventScroll: true });
      return;
    }
    if (button.hasAttribute("data-sched-copy-row")) {
      const destination = fieldset.querySelector("[data-sched-row-destination]").value;
      const target = editor.days[destination], row = { ...editor.days[editor.day][index] };
      const existing = target.findIndex(item => item.key === row.key);
      if (existing >= 0) target[existing] = row;
      else if (target.length < 24) target.push(row);
      else return;
      body.querySelector("[data-sched-editor-status]").textContent = `${row.label} copied to ${App._scheduleWeekdayLabel(destination)}. Save to apply.`;
    }
  };
};

App.register("schedules/admin", function initializeFeature() {
App.ADMIN_SCHEDULETYPE_PATH = "admin/scheduleType";
App.ADMIN_ACCOUNTCREATION_PATH = "admin/accountCreationEnabled";
App.SCHEDULE_WEEKDAYS = [{
  key: "M",
  label: "Monday",
  index: 1
}, {
  key: "T",
  label: "Tuesday",
  index: 2
}, {
  key: "W",
  label: "Wednesday",
  index: 3
}, {
  key: "R",
  label: "Thursday",
  index: 4
}, {
  key: "F",
  label: "Friday",
  index: 5
}];
App.scheduleType = "full";
App.scheduleTypeListener = null;
App.accountCreationListener = null;
App.scheduleOverrides = {};
App.scheduleOverridesSignature = null;
App.scheduleDataLoaded = false;
App.scheduleDataListener = null;
App.scheduleEditor = null;
App.schedulesModuleReady = true;
});
})(globalThis.ChatApp);
