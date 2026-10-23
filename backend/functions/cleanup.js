"use strict";

// Pure helpers also exercised by local tests; only calendar-owned records change.
function expireCalendar(calendar, now) {
  if (!calendar || typeof calendar !== "object") return undefined;
  let activeYear = Number(calendar.activeYear) || 0;
  for (const [year, deadline] of Object.entries(calendar.yearExpiry || {})) {
    if (/^\d{4}$/.test(year) && Number(deadline) > 0 && Number(deadline) <= now) {
      activeYear = Math.max(activeYear, Number(year) + 1);
    }
  }
  let changed = activeYear !== (Number(calendar.activeYear) || 0);
  const years = { ...(calendar.years || {}) };
  for (const year of Object.keys(years)) {
    if (/^\d{4}$/.test(year) && Number(year) < activeYear) {
      delete years[year];
      changed = true;
    }
  }
  if (!changed) return undefined;
  return { ...calendar, activeYear, years };
}

function expireReminders(days, now) {
  if (!days || typeof days !== "object") return undefined;
  const remaining = {};
  let changed = false;
  for (const [date, reminders] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !reminders || typeof reminders !== "object") {
      remaining[date] = reminders;
      continue;
    }
    const next = {};
    for (const [id, record] of Object.entries(reminders)) {
      const expiresAt = Number(record?.expiresAt);
      if (expiresAt > 0 && expiresAt <= now) changed = true;
      else next[id] = record;
    }
    if (Object.keys(next).length) remaining[date] = next;
  }
  if (!changed) return undefined;
  return Object.keys(remaining).length ? remaining : null;
}

module.exports = { expireCalendar, expireReminders };
