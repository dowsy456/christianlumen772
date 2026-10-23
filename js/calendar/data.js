/* Calendar uses the accurate Time Display clock with device-local date parts.
 * Public notes: calendar/years/YYYY/YYYY-MM-DD/pushId
 * Personal note reminder tags: calendarReminders/accountCode/YYYY-MM-DD/noteId
 * Account codes follow the existing application's session model. Actual access
 * control requires Firebase Authentication and corresponding database rules.
 */
(function (App) {
  "use strict";

  let session = null;
  let generation = 0;
  const validEntryId = value => typeof value === "string" && !!value && !/[.#$\[\]/\u0000-\u001f\u007f]/.test(value);

  function now() {
    try {
      const value = App.getAccurateNow?.();
      if (value && Number.isFinite(value.getTime())) return value;
    } catch {}
    return new Date();
  }

  App.calendarDateKey = function (date = now()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  function parseDate(key) {
    if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const parts = key.split("-").map(Number);
    const value = new Date(parts[0], parts[1] - 1, parts[2], 12);
    return App.calendarDateKey(value) === key ? value : null;
  }

  function initialState() {
    const date = now();
    const today = App.calendarDateKey(date);
    return {
      year: date.getFullYear(), month: date.getMonth(), today,
      selectedDate: today, notes: {}, reminders: {}, ready: false,
      remindersReady: false, error: "", remindersError: "", cleanupError: "",
      connected: false, serverYear: null
    };
  }

  function render() {
    App.renderCalendar?.();
  }

  function active(owner) {
    return !!owner && session === owner && owner.generation === generation &&
      String(App.currentUser?.code || "") === owner.code;
  }

  function error(code, message) {
    return Object.assign(new Error(message), { code: `calendar/${code}` });
  }

  function unsubscribe(listener) {
    if (!listener) return;
    try { listener.ref.off(listener.event, listener.callback); } catch {}
  }

  function listen(ref, event, callback, failure) {
    const listener = { ref, event, callback, failed: false };
    ref.on(event, callback, reason => {
      listener.failed = true;
      failure(reason);
    });
    return listener;
  }

  function usableRecords(raw, year, earliestDate) {
    const days = {};
    if (!raw || typeof raw !== "object") return days;
    for (const [date, entries] of Object.entries(raw)) {
      if (!parseDate(date) || (year && Number(date.slice(0, 4)) !== year) ||
          (earliestDate && date < earliestDate) || !entries || typeof entries !== "object") continue;
      const valid = {};
      for (const [id, record] of Object.entries(entries)) {
        if (!record || typeof record !== "object" || typeof record.text !== "string" || !record.text.trim()) continue;
        valid[id] = record;
      }
      if (Object.keys(valid).length) days[date] = valid;
    }
    return days;
  }

  // The day list and month previews share one order. Legacy notes retain their
  // chronological order; new unranked notes follow notes someone has arranged.
  App.getCalendarNoteEntries = function (records) {
    const rank = record => Number.isSafeInteger(record?.order) && record.order >= 0 ? record.order : Infinity;
    return Object.entries(records || {}).filter(([, record]) =>
      record && typeof record.text === "string" && !!record.text.trim()
    ).sort((a, b) => {
      const aRank = rank(a[1]), bRank = rank(b[1]);
      return (aRank === bRank ? 0 : aRank < bRank ? -1 : 1) ||
        (Number(a[1].createdAt) || 0) - (Number(b[1].createdAt) || 0) || a[0].localeCompare(b[0]);
    });
  };

  function usableReminders(raw, today) {
    const days = {};
    for (const [date, entries] of Object.entries(raw || {})) {
      if (!parseDate(date) || date < today || !entries || typeof entries !== "object") continue;
      const valid = {};
      for (const [id, record] of Object.entries(entries)) {
        if (!validEntryId(id) || !record || typeof record !== "object") continue;
        const tag = validEntryId(record.noteId) && record.noteId === id;
        const legacy = !record.noteId && typeof record.text === "string" && record.text.trim();
        if (tag || legacy) valid[id] = record;
      }
      if (Object.keys(valid).length) days[date] = valid;
    }
    return days;
  }

  function clearToasts(owner) {
    if (!owner) return;
    for (const handle of owner.toastHandles.values()) handle?.cancel?.();
    owner.toastHandles.clear();
  }

  function showDueReminders(owner) {
    if (!active(owner) || typeof App.showToast !== "function") return;
    const state = App.calendarState;
    if (!state.remindersReady) return;
    const due = state.reminders[state.today] || {};
    function reminderText(id, date) {
      if (!active(owner) || App.calendarDateKey(now()) !== date || App.calendarState.today !== date) return null;
      const current = App.calendarState.reminders[date]?.[id];
      if (!current) return null;
      if (current.noteId) {
        if (!App.calendarState.ready || App.calendarState.serverYear > App.calendarState.year) return null;
        return App.calendarState.notes[date]?.[current.noteId]?.text || null;
      }
      // Keep reminders made by earlier versions private until they expire.
      return current.text || null;
    }
    for (const [key, handle] of owner.toastHandles) {
      const id = key.slice(key.indexOf("/") + 1);
      if (!key.startsWith(`${state.today}/`) || !due[id] || (state.ready && !reminderText(id, state.today))) {
        handle?.cancel?.();
        owner.toastHandles.delete(key);
      } else {
        handle?.refresh?.();
      }
    }
    for (const id of Object.keys(due)) {
      const date = state.today, key = `${date}/${id}`;
      if (owner.shownReminders.has(key) || owner.toastHandles.has(key) || !reminderText(id, date)) continue;
      // Reserve the key before showToast, whose onShow can run synchronously.
      owner.toastHandles.set(key, null);
      const handle = App.showToast({
        queue: true,
        title: "Reminder for today",
        body: reminderText(id, date),
        duration: 10000,
        isValid: () => active(owner) && !!reminderText(id, date),
        getContent: () => {
          const text = reminderText(id, date);
          return text ? { body: text } : null;
        },
        onShow: () => { if (active(owner)) owner.shownReminders.add(key); },
        onClose: () => owner.toastHandles.delete(key)
      });
      if (owner.toastHandles.has(key)) owner.toastHandles.set(key, handle);
    }
  }

  function purgeExpiredReminders(owner) {
    if (!active(owner) || owner.reminderCleanupRunning) return;
    const today = App.calendarState.today;
    const updates = {};
    for (const date of Object.keys(owner.rawReminders || {})) {
      if (parseDate(date) && date < today) updates[date] = null;
    }
    if (!Object.keys(updates).length) {
      owner.reminderCleanupFailed = false;
      return;
    }
    owner.reminderCleanupRunning = true;
    owner.remindersRef.update(updates).then(() => {
      if (!active(owner)) return;
      owner.reminderCleanupFailed = false;
      if (App.calendarState.remindersError.startsWith("Reminder cleanup")) App.calendarState.remindersError = "";
    }).catch(() => {
      if (!active(owner)) return;
      owner.reminderCleanupFailed = true;
      App.calendarState.remindersError = "Reminder cleanup could not finish. Reconnect to retry.";
      render();
    }).finally(() => {
      owner.reminderCleanupRunning = false;
    });
  }

  function purgeYear(owner, year) {
    if (!active(owner) || !/^\d{4}$/.test(year) || Number(year) >= now().getFullYear() || owner.purgingYears.has(year)) return;
    owner.purgingYears.add(year);
    App.db.ref(`calendar/years/${year}`).remove().then(() => {
      if (!active(owner)) return;
      owner.failedYears.delete(year);
      if (!owner.failedYears.size) App.calendarState.cleanupError = "";
    }).catch(() => {
      if (!active(owner)) return;
      owner.failedYears.add(year);
      App.calendarState.cleanupError = "Previous-year notes could not be cleared. Reconnect to retry.";
      render();
    }).finally(() => owner.purgingYears.delete(year));
  }

  function publishYearMetadata(owner) {
    if (!active(owner) || !App.calendarState.connected || owner.publishingYear) return;
    const year = now().getFullYear();
    if (owner.publishedYear === year) return;
    owner.publishingYear = true;
    const expiry = new Date(year + 1, 0, 1).getTime();
    // Advance the watermark and remove obsolete years atomically, so a save
    // racing the first New Year's connection cannot restore the old branch.
    App.db.ref("calendar").transaction(current => {
      if (!active(owner)) return;
      const calendar = { ...(current || {}) };
      calendar.activeYear = Math.max(Number(calendar.activeYear) || 0, year);
      const years = { ...(calendar.years || {}) };
      for (const key of Object.keys(years)) {
        if (/^\d{4}$/.test(key) && Number(key) < calendar.activeYear) delete years[key];
      }
      calendar.years = years;
      if (calendar.activeYear <= year) {
        const expiries = { ...(calendar.yearExpiry || {}) };
        const existing = Number(expiries[year]);
        expiries[year] = Number.isFinite(existing) && existing > 0 ? Math.min(existing, expiry) : expiry;
        calendar.yearExpiry = expiries;
      }
      return calendar;
    }, undefined, false).then(result => {
      if (!active(owner) || !result.committed) return;
      App.calendarState.serverYear = Number(result.snapshot.val()?.activeYear) || null;
      owner.publishedYear = year;
    }).catch(() => {
      if (!active(owner)) return;
      App.calendarState.cleanupError = "Calendar rollover could not be synchronized. Reconnect to retry.";
      render();
    }).finally(() => {
      owner.publishingYear = false;
      if (active(owner)) render();
    });
  }

  function attachActiveYear(owner) {
    if (!active(owner)) return;
    unsubscribe(owner.activeYearListener);
    owner.activeYearListener = listen(App.db.ref("calendar/activeYear"), "value", snapshot => {
      if (!active(owner)) return;
      const year = Number(snapshot.val());
      App.calendarState.serverYear = Number.isInteger(year) && year >= 1000 ? year : null;
      if (year > App.calendarState.year) {
        App.calendarState.notes = {};
        App.calendarState.error = "The shared calendar has started a new year. It will reopen when your local new year begins.";
      } else if (App.calendarState.error.startsWith("Calendar rollover status")) {
        App.calendarState.error = "";
      }
      render();
    }, () => {
      if (!active(owner)) return;
      App.calendarState.serverYear = null;
      App.calendarState.error = "Calendar rollover status could not be loaded. Check database access.";
      render();
    });
  }

  function attachYear(owner) {
    if (!active(owner)) return;
    unsubscribe(owner.notesListener);
    unsubscribe(owner.yearCleanupListener);
    const year = App.calendarState.year;
    owner.notesYear = year;
    App.calendarState.ready = false;
    App.calendarState.error = "";
    const ref = App.db.ref(`calendar/years/${year}`);
    owner.notesListener = listen(ref, "value", snapshot => {
      if (!active(owner) || App.calendarState.year !== year) return;
      App.calendarState.notes = App.calendarState.serverYear > year ? {} : usableRecords(snapshot.val(), year);
      App.calendarState.ready = true;
      App.calendarState.error = App.calendarState.serverYear > year ? "The shared calendar has started a new year. It will reopen when your local new year begins." : "";
      purgeExpiredReminders(owner);
      showDueReminders(owner);
      render();
    }, () => {
      if (!active(owner) || App.calendarState.year !== year) return;
      App.calendarState.ready = false;
      App.calendarState.error = "Shared notes could not be loaded. Check your connection and database access.";
      render();
    });
    // A listener also catches an old offline client's late write after rollover.
    const previousYears = App.db.ref("calendar/years").orderByKey().endAt(String(year - 1));
    owner.yearCleanupListener = listen(previousYears, "child_added", snapshot => {
      if (active(owner) && App.calendarState.year === year) purgeYear(owner, snapshot.key);
    }, () => {
      if (!active(owner)) return;
      App.calendarState.cleanupError = "Previous-year cleanup is unavailable. Check database access.";
      render();
    });
  }

  function attachReminders(owner) {
    if (!active(owner)) return;
    unsubscribe(owner.remindersListener);
    App.calendarState.remindersReady = false;
    App.calendarState.remindersError = "";
    owner.remindersListener = listen(owner.remindersRef, "value", snapshot => {
      if (!active(owner)) return;
      owner.rawReminders = snapshot.val() || {};
      App.calendarState.reminders = usableReminders(owner.rawReminders, App.calendarState.today);
      App.calendarState.remindersReady = true;
      App.calendarState.remindersError = "";
      purgeExpiredReminders(owner);
      showDueReminders(owner);
      render();
    }, () => {
      if (!active(owner)) return;
      App.calendarState.remindersReady = false;
      App.calendarState.remindersError = "Your reminders could not be loaded. Check your connection and database access.";
      render();
    });
  }

  function maintenance(owner) {
    if (!active(owner)) return;
    if (owner.activeYearListener?.failed) attachActiveYear(owner);
    publishYearMetadata(owner);
    if (owner.notesListener?.failed || owner.yearCleanupListener?.failed) attachYear(owner);
    if (owner.remindersListener?.failed) attachReminders(owner);
    for (const year of owner.failedYears) purgeYear(owner, year);
    purgeExpiredReminders(owner);
    showDueReminders(owner);
  }

  function scheduleMidnight(owner) {
    clearTimeout(owner.midnightTimer);
    if (!active(owner)) return;
    const date = now();
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    owner.midnightTimer = setTimeout(() => {
      if (!active(owner)) return;
      App.refreshCalendarDate();
      maintenance(owner);
    }, Math.max(50, Math.min(86400000, midnight.getTime() - date.getTime() + 25)));
  }

  App.refreshCalendarDate = function () {
    if (!App.calendarState) App.calendarState = initialState();
    const state = App.calendarState;
    const date = now();
    const today = App.calendarDateKey(date);
    const oldToday = state.today;
    const yearChanged = state.year !== date.getFullYear();
    const monthChanged = oldToday.slice(0, 7) !== today.slice(0, 7);
    state.year = date.getFullYear();
    state.today = today;
    if (monthChanged) state.month = date.getMonth();
    if (oldToday !== today) state.selectedDate = today;
    const owner = session;
    if (yearChanged) {
      state.notes = {};
      state.ready = false;
      if (active(owner)) attachYear(owner);
      if (active(owner)) publishYearMetadata(owner);
    }
    if (active(owner)) {
      if (oldToday !== today) {
        clearToasts(owner);
        owner.shownReminders.clear();
        state.reminders = usableReminders(owner.rawReminders, today);
        purgeExpiredReminders(owner);
        showDueReminders(owner);
      }
      scheduleMidnight(owner);
    }
    if (oldToday !== today || yearChanged) render();
    return state;
  };

  App.startCalendarSession = function () {
    const code = String(App.currentUser?.code || "");
    if (!code || !App.db) return;
    if (active(session)) {
      App.refreshCalendarDate();
      return;
    }
    App.stopCalendarSession();
    App.calendarState = initialState();
    const owner = {
      code, generation, rawReminders: {}, shownReminders: new Set(),
      toastHandles: new Map(), failedYears: new Set(), purgingYears: new Set(),
      remindersRef: App.db.ref(`calendarReminders/${code}`)
    };
    session = owner;
    attachActiveYear(owner);
    attachYear(owner);
    attachReminders(owner);
    owner.connectionListener = listen(App.db.ref(".info/connected"), "value", snapshot => {
      if (!active(owner)) return;
      App.calendarState.connected = snapshot.val() === true;
      if (App.calendarState.connected) {
        App.refreshCalendarDate();
        maintenance(owner);
      }
      render();
    }, () => {
      if (active(owner)) {
        App.calendarState.connected = false;
        render();
      }
    });
    owner.foreground = event => {
      if (!active(owner)) return;
      App.refreshCalendarDate();
      if (event?.type === "pageshow" && event.persisted) {
        clearToasts(owner);
        owner.shownReminders.clear();
        showDueReminders(owner);
      }
      maintenance(owner);
    };
    globalThis.addEventListener?.("focus", owner.foreground);
    globalThis.addEventListener?.("pageshow", owner.foreground);
    globalThis.addEventListener?.("online", owner.foreground);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", owner.foreground);
    owner.interval = setInterval(owner.foreground, 30000);
    scheduleMidnight(owner);
    render();
  };

  App.stopCalendarSession = function () {
    const owner = session;
    session = null;
    generation += 1;
    if (owner) {
      for (const name of ["notesListener", "remindersListener", "connectionListener", "yearCleanupListener", "activeYearListener"]) unsubscribe(owner[name]);
      clearTimeout(owner.midnightTimer);
      clearInterval(owner.interval);
      globalThis.removeEventListener?.("focus", owner.foreground);
      globalThis.removeEventListener?.("pageshow", owner.foreground);
      globalThis.removeEventListener?.("online", owner.foreground);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", owner.foreground);
      clearToasts(owner);
    }
    App.calendarState = initialState();
    App.resetCalendarUI?.();
  };

  function validateSave(owner, date, reminder) {
    if (!active(owner)) throw error("signed-out", "Sign in again before saving.");
    if (!App.calendarState.connected) throw error("offline", "Reconnect before saving your calendar changes.");
    const parsed = parseDate(date);
    if (!parsed) throw error("invalid-date", "Choose a valid calendar day.");
    if (parsed.getFullYear() !== now().getFullYear()) throw error("year-changed", "The calendar year has changed. Choose a day in the current year.");
    if (!reminder && App.calendarState.serverYear == null) throw error("loading", "The shared calendar is still connecting. Try again in a moment.");
    if (!reminder && App.calendarState.serverYear > parsed.getFullYear()) throw error("year-ended", "This shared calendar year has ended. It will reopen when your local new year begins.");
    if (reminder && date < App.calendarDateKey(now())) throw error("past-reminder", "Reminders can only be set for today or a future day.");
  }

  async function saveEntry(date, id, text, expectedText) {
    App.refreshCalendarDate();
    const owner = session;
    validateSave(owner, date, false);
    if (typeof text !== "string") throw error("invalid-text", "Enter text to save.");
    if (text.length > 10000) throw error("too-long", "Keep notes under 10,000 characters.");
    if (id != null && !validEntryId(id)) throw error("invalid-id", "This entry could not be saved. Reopen the day and try again.");
    if (!id && !text.trim()) return null;
    const parent = App.db.ref(`calendar/years/${date.slice(0, 4)}/${date}`);
    const ref = id ? parent.child(id) : parent.push();
    // New independent IDs survive profile edits. Legacy password-shaped IDs
    // keep the public username lookup; an editor never replaces the author.
    const authorUsername = String(App.currentUser.username || "").trim().slice(0, 120);
    const authorCode = /^uid_[A-Za-z0-9_-]+$/.test(App.currentUser.code || "") ? App.currentUser.code : "";
    let failure = null;
    const transactionRef = App.db.ref("calendar");
    const result = await transactionRef.transaction(root => {
      failure = null;
      try { validateSave(owner, date, false); } catch (reason) { failure = reason; return; }
      const year = date.slice(0, 4);
      if (Number(root?.activeYear || 0) > Number(year)) {
        failure = error("year-ended", "This shared calendar year has ended. It will reopen when your local new year begins.");
        return;
      }
      const current = root?.years?.[year]?.[date]?.[ref.key] || null;
      if (id && expectedText !== undefined && String(current?.text || "") !== String(expectedText)) {
        failure = error("conflict", "This entry changed while you were editing. Review the latest version before saving again.");
        // Firebase may call a root transaction with null before its server data
        // has been cached. A null proposal obtains the server retry; an absent
        // root is a no-op and is still reported as a conflict after completion.
        if (root == null) return null;
        return;
      }
      const timestamp = App.firebase?.database?.ServerValue?.TIMESTAMP || now().getTime();
      const record = text.trim() ? { text, createdAt: current?.createdAt || timestamp, updatedAt: timestamp } : null;
      if (record) {
        if (Number.isSafeInteger(current?.order) && current.order >= 0) record.order = current.order;
        if (current) {
          if (typeof current.authorCode === "string") record.authorCode = current.authorCode;
          if (typeof current.authorUsername === "string" && current.authorUsername.trim()) {
            record.authorUsername = current.authorUsername.slice(0, 120);
          }
          // Older notes store only a display name. Preserve it for the live
          // profile resolver rather than assuming the current editor wrote it.
          record.authorName = String(current.authorName || record.authorUsername || "User").slice(0, 120);
        } else {
          if (authorCode) record.authorCode = authorCode;
          if (authorUsername) record.authorUsername = authorUsername;
          record.authorName = authorUsername || "User";
        }
      }
      const calendar = { ...(root || {}) };
      calendar.activeYear = Math.max(Number(calendar.activeYear) || 0, Number(year));
      const years = { ...(calendar.years || {}) };
      const days = { ...(years[year] || {}) };
      const records = { ...(days[date] || {}) };
      if (record) records[ref.key] = record;
      else delete records[ref.key];
      if (Object.keys(records).length) days[date] = records;
      else delete days[date];
      if (Object.keys(days).length) years[year] = days;
      else delete years[year];
      calendar.years = years;
      return calendar;
    }, undefined, false);
    if (failure) throw failure;
    if (!result.committed) throw failure || error("save-failed", "This entry could not be saved. Please try again.");
    // A previously queued offline save must not resurrect an expired record.
    const expired = Number(date.slice(0, 4)) < now().getFullYear();
    if (expired) {
      await ref.remove();
      throw error("expired", "The day or year ended before this save completed.");
    }
    if (!active(owner)) throw error("signed-out", "Your account changed while saving. Reopen the calendar to check the entry.");
    return text.trim() ? ref.key : null;
  }

  App.saveCalendarNote = function (date, id, text, expectedText) {
    return saveEntry(date, id, text, expectedText);
  };

  App.moveCalendarNote = async function (date, id, direction) {
    App.refreshCalendarDate();
    const owner = session;
    validateSave(owner, date, false);
    if (!validEntryId(id)) throw error("invalid-id", "This note could not be moved. Reopen the day and try again.");
    if (direction !== -1 && direction !== 1) throw error("invalid-order", "Choose Move up or Move down.");
    let failure = null, atBoundary = false;
    // Match note saves' root transaction so a year rollover or concurrent text
    // edit cannot be overwritten by a reorder based on an older client snapshot.
    const result = await App.db.ref("calendar").transaction(root => {
      failure = null;
      atBoundary = false;
      try { validateSave(owner, date, false); } catch (reason) { failure = reason; return; }
      const year = date.slice(0, 4);
      if (Number(root?.activeYear || 0) > Number(year)) {
        failure = error("year-ended", "This shared calendar year has ended.");
        return;
      }
      const day = root?.years?.[year]?.[date];
      const entries = App.getCalendarNoteEntries(day);
      const index = entries.findIndex(([key]) => key === id);
      if (index < 0) {
        failure = error("note-missing", "This note was removed. Reopen the day to see the latest notes.");
        // Obtain the server retry when Firebase's local transaction cache is empty.
        return root == null ? null : undefined;
      }
      const next = index + direction;
      if (next < 0 || next >= entries.length) { atBoundary = true; return; }
      [entries[index], entries[next]] = [entries[next], entries[index]];
      const reordered = { ...day };
      entries.forEach(([key, record], order) => { reordered[key] = { ...record, order }; });
      return { ...root, years: { ...root.years, [year]: { ...root.years[year], [date]: reordered } } };
    }, undefined, false);
    if (failure) throw failure;
    if (!active(owner)) throw error("signed-out", "Your account changed while moving the note. Reopen the calendar to check the order.");
    if (atBoundary) return false;
    if (!result.committed) throw error("save-failed", "The note order could not be saved. Please try again.");
    return true;
  };

  App.isCalendarNoteReminder = function (date, noteId) {
    if (!active(session) || !validEntryId(noteId) || date < App.calendarDateKey(now())) return false;
    return App.calendarState.reminders[date]?.[noteId]?.noteId === noteId;
  };

  App.setCalendarNoteReminder = async function (date, noteId, enabled) {
    App.refreshCalendarDate();
    const owner = session;
    validateSave(owner, date, true);
    if (!validEntryId(noteId)) throw error("invalid-id", "Save a note before setting its reminder.");
    if (typeof enabled !== "boolean") throw error("invalid-reminder", "Choose whether to remind you about this note.");
    const ref = owner.remindersRef.child(date).child(noteId);
    if (!enabled) {
      await ref.remove();
      if (!active(owner)) throw error("signed-out", "Your account changed while saving. Reopen the calendar to check the reminder.");
      return false;
    }
    validateSave(owner, date, false);
    if (!App.calendarState.ready) throw error("loading", "Shared notes are still loading. Try again in a moment.");
    // Read the selected note before setting a private tag. Never copy shared
    // text into the tag or put a personal reminder flag on the public note.
    const noteRef = App.db.ref(`calendar/years/${date.slice(0, 4)}/${date}/${noteId}`);
    const note = (await noteRef.once("value")).val();
    validateSave(owner, date, true);
    if (!note || typeof note.text !== "string" || !note.text.trim()) throw error("note-missing", "This note was removed. Choose another note.");
    let failure = null;
    const result = await ref.transaction(current => {
      failure = null;
      try { validateSave(owner, date, true); } catch (reason) { failure = reason; return; }
      const day = parseDate(date);
      return {
        noteId,
        createdAt: current?.noteId === noteId && current.createdAt || App.firebase?.database?.ServerValue?.TIMESTAMP || now().getTime(),
        expiresAt: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
      };
    }, undefined, false);
    if (failure) throw failure;
    if (!result.committed) throw error("save-failed", "This reminder could not be saved. Try again.");
    if (date < App.calendarDateKey(now()) || Number(date.slice(0, 4)) < now().getFullYear()) {
      await ref.remove();
      throw error("expired", "The day ended before this reminder was saved.");
    }
    if (!active(owner)) throw error("signed-out", "Your account changed while saving. Reopen the calendar to check the reminder.");
    // Missing-note tags stay silent and expire normally. A missing local note
    // may still be arriving from Firebase, so it is not proof of an orphan.
    purgeExpiredReminders(owner);
    return true;
  };

  App.register("calendar/data", function initializeCalendarData() {
    App.calendarState = initialState();
  });
})(globalThis.ChatApp);
