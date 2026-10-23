/* core/session: methods register before ordered initialization. */
(function (App) {
  "use strict";
const tabValues = new Map();
let savedSettings = null;
App.rememberLoadedSettings = function (code, settings) {
  savedSettings = { code: String(code), value: App.normalizeSettings(settings) };
};
// Defaults are shipped with the app. Persist only changed leaves, so toggling
// one preference never re-uploads the wallpaper or custom sound recordings.
App.settingsWritePatch = function (before, after) {
  const patch = {};
  const defaults = App.normalizeSettings(App.cloneDefaultSettings());
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const visit = (oldValue, newValue, defaultValue, path) => {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    if (object(newValue)) {
      for (const key of new Set([...Object.keys(oldValue || {}), ...Object.keys(newValue)])) {
        visit(oldValue?.[key], newValue[key], defaultValue?.[key], path ? `${path}/${key}` : key);
      }
    } else if (path) {
      patch[path] = newValue === undefined || JSON.stringify(newValue) === JSON.stringify(defaultValue) ? null : newValue;
    }
  };
  visit(before, after, defaults, "");
  return patch;
};
App.readTabScopedValue = function (key, fallback = "") {
  if (tabValues.has(key)) return tabValues.get(key);
  try {
    const value = sessionStorage.getItem(key);
    if (value !== null) return value;
  } catch {}
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
  } catch {}
  return fallback;
};
App.writeTabScopedValue = function (key, value) {
  const next = String(value ?? "");
  tabValues.set(key, next);
  try {
    sessionStorage.setItem(key, next);
  } catch {}
  try {
    localStorage.setItem(key, next);
  } catch {}
  return next;
};
App.getStoredAccountCode = function () {
  return App.readTabScopedValue(App.LS.CODE, "");
};
App.setStoredAccountCode = function (code) {
  return App.writeTabScopedValue(App.LS.CODE, code);
};
App.clearStoredAccountCode = function (code = "") {
  tabValues.set(App.LS.CODE, "");
  try {
    sessionStorage.removeItem(App.LS.CODE);
  } catch {}
  try {
    if (!code || localStorage.getItem(App.LS.CODE) === String(code)) localStorage.removeItem(App.LS.CODE);
  } catch {}
};
App.getStoredPlace = function () {
  return App.readTabScopedValue(App.LS.PLACE, "home");
};
App.setStoredPlace = function (place) {
  const next = place || "home";
  const stored = App.writeTabScopedValue(App.LS.PLACE, next);
  document.body.dataset.calendarPage = next === "calendar" || next.startsWith("calendar:") ? "1" : "0";
  if (App.currentUser) void App.syncMySchedulePresence(next === "schedules");
  App.syncTimeDisplayChatAction?.();
  return stored;
};
App.clearStoredPlace = function (code = "") {
  tabValues.set(App.LS.PLACE, "home");
  try {
    sessionStorage.removeItem(App.LS.PLACE);
  } catch {}
  try {
    if (!code || localStorage.getItem(App.LS.CODE) === String(code)) localStorage.removeItem(App.LS.PLACE);
  } catch {}
};
App.cloneDefaultSettings = function () {
  return {
    backgroundRunning: true,
    autoScroll: App.SETTINGS_DEFAULTS.autoScroll,
    pushNotifications: App.SETTINGS_DEFAULTS.pushNotifications,
    soundEffectsEnabled: true,
    soundEffects: App.normalizeSoundEffects?.({}) || {},
    customSoundEffects: {},
    accidentalClosePrevention: App.SETTINGS_DEFAULTS.accidentalClosePrevention,
    theme: App.SETTINGS_DEFAULTS.theme,
    sidebarPosition: App.SETTINGS_DEFAULTS.sidebarPosition,
    typingIndicatorMode: App.SETTINGS_DEFAULTS.typingIndicatorMode,
    tab: {
      ...App.SETTINGS_DEFAULTS.tab
    },
    blackoutCloakKeys: [...App.SETTINGS_DEFAULTS.blackoutCloakKeys],
    background: {
      ...App.SETTINGS_DEFAULTS.background
    }
  };
};
App.normalizeCloakKeyName = function (raw) {
  const key = raw === " " ? "Space" : String(raw || "").trim();
  if (!key || ["Unidentified", "Process", "Dead"].includes(key)) return null;
  const aliases = { esc: "Escape", escape: "Escape", ctrl: "Control", control: "Control", shift: "Shift", alt: "Alt", meta: "Meta", space: "Space", spacebar: "Space" };
  return aliases[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
};
App.normalizeCloakKeysSetting = function (raw) {
  if (Array.isArray(raw)) {
    const arr = raw.map(App.normalizeCloakKeyName).filter(Boolean).slice(0, 4);
    return arr.length ? arr : [...App.SETTINGS_DEFAULTS.blackoutCloakKeys];
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return App.normalizeCloakKeysSetting(parsed);
    } catch {}
    const parts = raw.split("+").map(App.normalizeCloakKeyName).filter(Boolean).slice(0, 4);
    if (parts.length) return parts;
  }
  return [...App.SETTINGS_DEFAULTS.blackoutCloakKeys];
};
App.clampBg = function (n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
};
App.cssUrlEscape = function (s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "");
};
App.normalizeSettings = function (raw) {
  const src = raw || {};
  const tab = src.tab && typeof src.tab === "object" ? src.tab : {};
  const background = src.background && typeof src.background === "object" ? src.background : {};
  const out = App.cloneDefaultSettings();
  out.backgroundRunning = src.backgroundRunning !== false;
  out.autoScroll = src.autoScroll !== false;
  out.pushNotifications = src.pushNotifications !== false;
  out.soundEffectsEnabled = src.soundEffectsEnabled !== false;
  out.soundEffects = App.normalizeSoundEffects?.(src.soundEffects) || {};
  if (Object.values(out.soundEffects).length && !Object.values(out.soundEffects).some(Boolean)) out.soundEffectsEnabled = false;
  out.customSoundEffects = App.normalizeCustomSoundEffects?.(src.customSoundEffects) || {};
  out.accidentalClosePrevention = !!src.accidentalClosePrevention;
  out.theme = "dark";
  out.sidebarPosition = String(src.sidebarPosition || "").toLowerCase() === "right" ? "right" : "left";
  out.typingIndicatorMode = String(src.typingIndicatorMode || "").toLowerCase() === "member-list" ? "member-list" : "bar";
  out.tab.name = String(tab.name ?? src.tabName ?? App.SETTINGS_DEFAULTS.tab.name);
  out.tab.icon = String(tab.icon ?? src.tabIcon ?? "").trim();
  out.blackoutCloakKeys = App.normalizeCloakKeysSetting(src.blackoutCloakKeys ?? src.cloakKeys ?? src.blackoutCloak ?? App.SETTINGS_DEFAULTS.blackoutCloakKeys);
  const bgDataURL = background.dataURL ?? src.bgImage ?? src.backgroundImage ?? src.backgroundDataURL ?? null;
  out.background.dataURL = typeof bgDataURL === "string" && bgDataURL.trim() ? bgDataURL.trim() : null;
  out.background.blur = App.clampBg(background.blur ?? src.bgBlur ?? src.backgroundBlur ?? 0, 0, 30);
  out.background.zoom = App.clampBg(background.zoom ?? src.bgZoom ?? src.backgroundZoom ?? 1, 0.5, 5);
  return out;
};
App.mergeSettings = function (base, patch) {
  const next = App.normalizeSettings(base);
  if (!patch || typeof patch !== "object") return next;
  if ("backgroundRunning" in patch) next.backgroundRunning = patch.backgroundRunning !== false;
  if ("autoScroll" in patch) next.autoScroll = patch.autoScroll !== false;
  if ("pushNotifications" in patch) next.pushNotifications = patch.pushNotifications !== false;
  if ("soundEffectsEnabled" in patch) {
    next.soundEffectsEnabled = patch.soundEffectsEnabled !== false;
    if (next.soundEffectsEnabled && !Object.values(next.soundEffects).some(Boolean)) next.soundEffects = App.normalizeSoundEffects?.({}) || {};
  }
  if (patch.soundEffects && typeof patch.soundEffects === "object") {
    const enableOne = Object.entries(patch.soundEffects).some(([key, value]) => key in next.soundEffects && value === true);
    if (!next.soundEffectsEnabled && enableOne) {
      next.soundEffects = Object.fromEntries(Object.keys(next.soundEffects).map(key => [key, false]));
      next.soundEffectsEnabled = true;
    }
    next.soundEffects = { ...next.soundEffects, ...patch.soundEffects };
  }
  if (patch.customSoundEffects && typeof patch.customSoundEffects === "object") next.customSoundEffects = { ...next.customSoundEffects, ...patch.customSoundEffects };
  if ("accidentalClosePrevention" in patch) next.accidentalClosePrevention = !!patch.accidentalClosePrevention;
  if ("theme" in patch) next.theme = "dark";
  if ("sidebarPosition" in patch) next.sidebarPosition = String(patch.sidebarPosition || "").toLowerCase() === "right" ? "right" : "left";
  if ("typingIndicatorMode" in patch) next.typingIndicatorMode = String(patch.typingIndicatorMode || "").toLowerCase() === "member-list" ? "member-list" : "bar";
  if ("blackoutCloakKeys" in patch) next.blackoutCloakKeys = App.normalizeCloakKeysSetting(patch.blackoutCloakKeys);
  if (patch.tab && typeof patch.tab === "object") {
    if ("name" in patch.tab) next.tab.name = String(patch.tab.name ?? "");
    if ("icon" in patch.tab) next.tab.icon = String(patch.tab.icon ?? "").trim();
  }
  if (patch.background && typeof patch.background === "object") {
    if ("dataURL" in patch.background) {
      const raw = patch.background.dataURL;
      next.background.dataURL = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    }
    if ("blur" in patch.background) next.background.blur = App.clampBg(patch.background.blur, 0, 30);
    if ("zoom" in patch.background) next.background.zoom = App.clampBg(patch.background.zoom, 0.5, 5);
  }
  return App.normalizeSettings(next);
};
App.writeSettingsCache = function (settings) {
  const s = App.normalizeSettings(settings);
  try {
    localStorage.setItem(App.LS.AUTOSCROLL, s.autoScroll ? "1" : "0");
    localStorage.setItem(App.LS.PUSH_NOTIFS, s.pushNotifications ? "1" : "0");
    localStorage.setItem(App.LS.ACC_CLOSE_PREVENT, s.accidentalClosePrevention ? "1" : "0");
    localStorage.setItem(App.LS.THEME, "dark");
    localStorage.setItem(App.LS.SIDEBAR_POS, s.sidebarPosition);
    localStorage.setItem(App.LS.TAB_NAME, s.tab.name);
    localStorage.setItem(App.LS.TAB_ICON, s.tab.icon);
    localStorage.setItem(App.LS.CLOAK_KEYS, JSON.stringify(s.blackoutCloakKeys));
    if (s.background.dataURL) {
      localStorage.setItem(App.LS.BG_IMAGE, s.background.dataURL);
      localStorage.setItem(App.LS.BG_BLUR, String(s.background.blur));
      localStorage.setItem(App.LS.BG_ZOOM, String(s.background.zoom));
    } else {
      localStorage.removeItem(App.LS.BG_IMAGE);
      localStorage.removeItem(App.LS.BG_BLUR);
      localStorage.removeItem(App.LS.BG_ZOOM);
    }
  } catch {}
};
App.clearSettingsCache = function () {
  try {
    [App.LS.AUTOSCROLL, App.LS.PUSH_NOTIFS, App.LS.ACC_CLOSE_PREVENT, App.LS.TAB_NAME, App.LS.TAB_ICON, App.LS.CLOAK_KEYS, App.LS.BG_IMAGE, App.LS.BG_BLUR, App.LS.BG_ZOOM, App.LS.SIDEBAR_POS].forEach(key => localStorage.removeItem(key));
    localStorage.setItem(App.LS.THEME, "dark");
  } catch {}
};
App.readCachedSettings = function () {
  const defaults = App.cloneDefaultSettings();
  try {
    defaults.autoScroll = (localStorage.getItem(App.LS.AUTOSCROLL) ?? "1") !== "0";
    defaults.pushNotifications = (localStorage.getItem(App.LS.PUSH_NOTIFS) ?? "1") === "1";
    defaults.accidentalClosePrevention = (localStorage.getItem(App.LS.ACC_CLOSE_PREVENT) ?? "0") === "1";
    defaults.sidebarPosition = String(localStorage.getItem(App.LS.SIDEBAR_POS) || "").toLowerCase() === "right" ? "right" : "left";
    const cachedName = localStorage.getItem(App.LS.TAB_NAME);
    defaults.tab.name = cachedName !== null ? cachedName : App.APP_TAB_TITLE_DEFAULT;
    defaults.tab.icon = String(localStorage.getItem(App.LS.TAB_ICON) || "").trim();
    defaults.blackoutCloakKeys = App.normalizeCloakKeysSetting(localStorage.getItem(App.LS.CLOAK_KEYS));
    const dataURL = localStorage.getItem(App.LS.BG_IMAGE) || null;
    defaults.background.dataURL = typeof dataURL === "string" && dataURL.trim() ? dataURL.trim() : null;
    defaults.background.blur = App.clampBg(parseFloat(localStorage.getItem(App.LS.BG_BLUR)), 0, 30);
    defaults.background.zoom = App.clampBg(parseFloat(localStorage.getItem(App.LS.BG_ZOOM)), 0.5, 5);
  } catch {}
  return App.normalizeSettings(defaults);
};
App.queueCurrentSettingsSave = function (delay = 0) {
  if (!App.currentUser?.code) return;
  if (App.settingsSaveTimer) clearTimeout(App.settingsSaveTimer);
  if (App.passwordChangeInFlight) { App.settingsSaveTimer = null; return; }
  const code = String(App.currentUser.code);
  App.settingsSaveTimer = setTimeout(() => {
    App.settingsSaveTimer = null;
    App.flushCurrentSettingsSave(code);
  }, Math.max(0, delay));
};
App.flushCurrentSettingsSave = async function (expectedCode) {
  if (!expectedCode) return false;
  if (!App.currentUser || String(App.currentUser.code) !== String(expectedCode)) return false;
  if (App.settingsSavePromise) {
    App.settingsSaveAgain = true;
    await App.settingsSavePromise;
    // A concurrent account/session may own the in-flight save. Always flush
    // this request's latest state after it completes, never just acknowledge
    // an older snapshot while a password migration proceeds.
    return App.flushCurrentSettingsSave(expectedCode);
  }
  App.settingsSaveInFlight = true;
  const save = (async () => {
    let success = true;
    do {
      App.settingsSaveAgain = false;
      if (String(App.currentUser?.code || "") !== String(expectedCode)) return false;
      const snapshot = App.normalizeSettings(App.currentSettings);
      try {
        const before = savedSettings?.code === expectedCode ? savedSettings.value : App.cloneDefaultSettings();
        const patch = App.settingsWritePatch(before, snapshot);
        if (Object.keys(patch).length) await App.db.ref(`users/${expectedCode}/settings`).update(patch);
        savedSettings = { code: expectedCode, value: snapshot };
      }
      catch (error) { console.error("settings save failed:", error); success = false; }
    } while (App.settingsSaveAgain && String(App.currentUser?.code || "") === String(expectedCode));
    return success;
  })();
  App.settingsSavePromise = save;
  try {
    return await save;
  } finally {
    if (App.settingsSavePromise === save) {
      App.settingsSavePromise = null;
      App.settingsSaveInFlight = false;
      App.settingsSaveAgain = false;
    }
  }
};
App.cancelQueuedSettingsSave = function () {
  if (App.settingsSaveTimer) {
    clearTimeout(App.settingsSaveTimer);
    App.settingsSaveTimer = null;
  }
  App.settingsSaveAgain = false;
};
App.updateSettingsState = function (patch, {
  queueRemote = true
} = {}) {
  App.currentSettings = App.mergeSettings(App.currentSettings, patch);
  App.writeSettingsCache(App.currentSettings);
  App.syncSoundEffectPreferences?.();
  globalThis.chatDesktopPreferences?.setBackgroundRunning(App.currentSettings.backgroundRunning !== false);
  if (queueRemote && App.currentUser?.code) {
    App.queueCurrentSettingsSave();
  }
  return App.currentSettings;
};
App.loadSettingsForUser = async function (code) {
  const defaults = App.cloneDefaultSettings();
  const ref = App.db.ref(`users/${code}/settings`);
  const snap = await ref.once("value");
  const settings = App.normalizeSettings(snap.exists() ? snap.val() : defaults);
  App.rememberLoadedSettings(code, settings);
  return settings;
};
App.applyAppBackground = function (state, {
  persist = true
} = {}) {
  const s = state || {};
  const dataURL = typeof s.dataURL === "string" && s.dataURL.trim() ? s.dataURL.trim() : null;
  const blur = App.clampBg(s.blur, 0, 30);
  const zoom = App.clampBg(s.zoom, 0.5, 5);
  App.appBgCommitted = {
    dataURL,
    blur,
    zoom
  };
  const root = document.documentElement;
  if (dataURL) {
    document.body.dataset.hasBg = "1";
    root.style.setProperty("--app-bg-image", `url("${App.cssUrlEscape(dataURL)}")`);
    root.style.setProperty("--app-bg-blur", `${blur}px`);
    root.style.setProperty("--app-bg-zoom", `${zoom}`);
  } else {
    delete document.body.dataset.hasBg;
    root.style.removeProperty("--app-bg-image");
    root.style.removeProperty("--app-bg-blur");
    root.style.removeProperty("--app-bg-zoom");
  }
  if (persist) {
    App.updateSettingsState({
      background: {
        dataURL,
        blur,
        zoom
      }
    });
  }
  return App.appBgCommitted;
};
App.clearAppBackground = function ({
  persist = true
} = {}) {
  return App.applyAppBackground({
    ...App.APP_BG_DEFAULT
  }, {
    persist
  });
};
App.getSavedSidebarPosition = function () {
  return App.currentSettings?.sidebarPosition === "right" ? "right" : "left";
};
App.applySidebarPosition = function (pos, {
  persist = true
} = {}) {
  const next = String(pos || "").toLowerCase() === "right" ? "right" : "left";
  document.body.dataset.sidebarPosition = next;
  if (persist) {
    App.updateSettingsState({
      sidebarPosition: next
    });
  }
  return next;
};
App.getSavedTypingIndicatorMode = function () {
  return App.currentSettings?.typingIndicatorMode === "member-list" ? "member-list" : "bar";
};
App.applyTypingIndicatorMode = function (mode, {
  persist = true
} = {}) {
  const next = String(mode || "").toLowerCase() === "member-list" ? "member-list" : "bar";
  document.body.dataset.typingIndicatorMode = next;
  if (persist) {
    App.updateSettingsState({
      typingIndicatorMode: next
    });
  }
  try {
    App.renderOnlineIndicator();
  } catch {}
  return next;
};
App.clearDynamicFavicon = function () {
  const link = document.getElementById("dynamic-favicon");
  if (!link) return;
  // Help force browsers to drop the previous favicon instead of caching it.
  try {
    link.href = "data:,";
  } catch {}
  try {
    link.remove();
  } catch {}
};
App.setDynamicFavicon = function (href) {
  const clean = String(href || "").trim();
  if (!clean) {
    App.clearDynamicFavicon();
    return;
  }
  let link = document.getElementById("dynamic-favicon");
  if (!link) {
    link = document.createElement("link");
    link.id = "dynamic-favicon";
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = clean;
};
App.applyResolvedSettings = function (settings, {
  persistCache = true
} = {}) {
  const resolved = App.normalizeSettings(settings);
  App.currentSettings = resolved;
  App.syncSoundEffectPreferences?.();
  globalThis.chatDesktopPreferences?.setBackgroundRunning(App.currentSettings.backgroundRunning !== false);
  if (persistCache) {
    App.writeSettingsCache(resolved);
  }
  App.autoScrollEnabled = resolved.autoScroll;
  App.pushNotifsEnabled = resolved.pushNotifications;
  App.syncDesktopNotificationPolicy?.();
  App.accidentalClosePreventionEnabled = resolved.accidentalClosePrevention;
  document.documentElement.dataset.theme = "dark";
  App.syncAccidentalClosePrevention();
  App.applyAppBackground(resolved.background, {
    persist: false
  });
  App.applySidebarPosition(resolved.sidebarPosition, {
    persist: false
  });
  App.applyTypingIndicatorMode(resolved.typingIndicatorMode, {
    persist: false
  });
  document.title = resolved.tab.name || App.APP_TAB_TITLE_DEFAULT;
  if (resolved.tab.icon) App.setDynamicFavicon(resolved.tab.icon);else App.clearDynamicFavicon();
  try {
    localStorage.setItem(App.LS.CLOAK_KEYS, JSON.stringify(resolved.blackoutCloakKeys));
  } catch {}
  return resolved;
};
App.resetVisualSettingsToDefaults = function () {
  App.currentSettings = App.cloneDefaultSettings();
  App.clearSettingsCache();
  App.applyResolvedSettings(App.currentSettings, {
    persistCache: false
  });
};
App.clampRoomLoadNumber = function (n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
};
App.formatRoomLoadPercent = function (loaded, total) {
  const t = App.clampRoomLoadNumber(total);
  const l = App.clampRoomLoadNumber(loaded);
  if (!t) return l ? "100.00%" : "00.00%";
  const pct = Math.min(100, Math.max(0, Math.min(l, t) / t * 100));
  if (pct >= 100) return "100.00%";
  return pct.toFixed(2).padStart(5, "0") + "%";
};
App.roomLoadBarWidth = function (loaded, total) {
  const t = App.clampRoomLoadNumber(total);
  const l = App.clampRoomLoadNumber(loaded);
  if (!t) return l ? "100%" : "0%";
  return `${Math.min(100, Math.max(0, Math.min(l, t) / t * 100)).toFixed(4)}%`;
};
App.roomLoadDetailText = function (loaded, total) {
  const l = App.clampRoomLoadNumber(loaded);
  const t = App.clampRoomLoadNumber(total);
  if (!t) return `${l.toLocaleString()} messages loaded`;
  const label = t === 1 ? "message" : "messages";
  return `${Math.min(l, t).toLocaleString()} / ${t.toLocaleString()} recent ${label} loaded`;
};
App.createRoomLoadingStateNode = function () {
  const el = document.createElement("div");
  el.className = "room-loading-state";
  el.id = "room-loading-state";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-busy", "true");
  el.dataset.roomLoading = "1";
  const card = document.createElement("div");
  card.className = "room-loading-card";
  const kicker = document.createElement("div");
  kicker.className = "room-loading-kicker";
  kicker.textContent = "Loading Room";
  const title = document.createElement("div");
  title.className = "room-loading-title";
  const row = document.createElement("div");
  row.className = "room-loading-progress-row";
  const pct = document.createElement("div");
  pct.className = "room-loading-percent";
  pct.id = "room-loading-percent";
  const detail = document.createElement("div");
  detail.className = "room-loading-detail";
  detail.id = "room-loading-detail";
  const track = document.createElement("div");
  track.className = "room-loading-track";
  track.setAttribute("aria-hidden", "true");
  const bar = document.createElement("div");
  bar.className = "room-loading-bar";
  bar.id = "room-loading-bar";
  row.appendChild(pct);
  row.appendChild(detail);
  track.appendChild(bar);
  card.appendChild(kicker);
  card.appendChild(title);
  card.appendChild(row);
  card.appendChild(track);
  el.appendChild(card);
  return el;
};
App.paintRoomLoadingState = function ({
  seq = App.roomLoadingSeq,
  roomId = App.currentRoomId,
  loaded = 0,
  total = null
} = {}) {
  if (seq !== App.roomLoadingSeq || !App.messagesListEl) return;
  const safeRoomId = App.sanitizeRoomCode(roomId);
  const safeLoaded = App.clampRoomLoadNumber(loaded);
  const safeTotal = App.clampRoomLoadNumber(total);
  let el = App.$("room-loading-state");
  if (!el) {
    el = App.createRoomLoadingStateNode();
    App.messagesListEl.prepend(el);
  }
  el.hidden = false;
  el.setAttribute("aria-busy", "true");
  el.dataset.roomLoading = "1";
  const percentEl = App.$("room-loading-percent");
  const detailEl = App.$("room-loading-detail");
  const barEl = App.$("room-loading-bar");
  const titleEl = el.querySelector(".room-loading-title");
  el.dataset.indeterminate = total === null ? "1" : "0";
  if (percentEl) percentEl.textContent = total === null ? "" : App.formatRoomLoadPercent(safeLoaded, safeTotal);
  if (detailEl) detailEl.textContent = total === null ? "Fetching Recent Messages…" : App.roomLoadDetailText(safeLoaded, safeTotal);
  if (barEl) barEl.style.width = App.roomLoadBarWidth(safeLoaded, safeTotal);
  if (titleEl) titleEl.textContent = App.roomDisplayName(safeRoomId, App.roomsMetaCache.get(safeRoomId) || null) || "Room";
};
App.clearRoomLoadingState = function (seq = App.roomLoadingSeq) {
  if (seq !== App.roomLoadingSeq) return;
  const el = App.$("room-loading-state");
  if (el) {
    el.setAttribute("aria-busy", "false");
    el.dataset.roomLoading = "0";
    el.remove();
  }
  App.scheduleRoomEmptyStateSync();
};
App.beginRoomLoading = function ({
  seq = App.roomLoadingSeq,
  roomId = App.currentRoomId,
  loaded = 0,
  total = 0
} = {}) {
  App.roomLoadingActive = true;
  App.paintRoomLoadingState({
    seq,
    roomId,
    loaded,
    total
  });
  App.scheduleRoomEmptyStateSync();
};
App.finishRoomLoading = function (seq = App.roomLoadingSeq) {
  if (seq !== App.roomLoadingSeq) return;
  App.roomLoadingActive = false;
  App.clearRoomLoadingState(seq);
  App.queueReadReceiptSync?.();
  App.scheduleRoomEmptyStateSync();
};
App.readCachedUserBootstrap = function (code) {
  try {
    const wantedCode = String(code || "");
    const raw = [sessionStorage, localStorage].map(storage => {
      try {
        return storage.getItem(App.LS.USER_BOOTSTRAP);
      } catch {
        return null;
      }
    }).find(candidate => {
      if (!candidate) return false;
      try {
        const cached = JSON.parse(candidate);
        return String(cached?.password || (App.DATABASE_SCHEMA_VERSION < 6 ? cached?.code : "") || "") === wantedCode;
      } catch {
        return false;
      }
    });
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !cached.code || String(cached.password || (App.DATABASE_SCHEMA_VERSION < 6 ? cached.code : "") || "") !== wantedCode) return null;
    const username = App.sanitizeUsername(cached.username || "");
    const displayName = App.sanitizeUsername(cached.displayName || cached.username || "");
    if (!username || !displayName) return null;
    return {
      code: String(cached.code),
      password: String(cached.password || ""),
      credentialHash: String(cached.credentialHash || ""),
      username,
      usernameLower: String(cached.usernameLower || username.toLowerCase()).toLowerCase(),
      displayName,
      displayNameLower: String(cached.displayNameLower || displayName.toLowerCase()).toLowerCase(),
      bio: String(cached.bio || "").slice(0, 400),
      photoDataURL: String(cached.photoDataURL || App.defaultStickmanDataURL()),
      photoTransform: App.normalizeTransformToRel(cached.photoTransform, 84),
      bannerDataURL: String(cached.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(cached.bannerTransform, 340),
      htmlActivity: cached.htmlActivity || null,
      htmlActivities: cached.htmlActivities || null,
      htmlActivitiesVersion: cached.htmlActivitiesVersion === 1 ? 1 : 0,
      gameActivitySessions: cached.gameActivitySessions || null,
      spotifySessions: cached.spotifySessions || null,
      notificationStatus: cached.notificationStatus === "dnd" ? "dnd" : cached.notificationStatus === "online" ? "online" : null,
      settings: App.readCachedSettings()
    };
  } catch {
    return null;
  }
};
App.writeCurrentUserBootstrapCache = function () {
  if (!App.currentUser?.code) return;
  try {
    const serialized = JSON.stringify({
      code: String(App.currentUser.code),
      password: String(App.currentUser.password || ""),
      credentialHash: String(App.currentUser.credentialHash || ""),
      username: String(App.currentUser.username || "User"),
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: String(App.currentUser.displayName || App.currentUser.username || "User"),
      displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
      bio: String(App.currentUser.bio || "").slice(0, 400),
      photoDataURL: String(App.currentUser.photoDataURL || App.defaultStickmanDataURL()),
      photoTransform: App.normalizeTransformToRel(App.currentUser.photoTransform, 84),
      bannerDataURL: String(App.currentUser.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340),
      htmlActivity: App.currentUser.htmlActivity || null,
      htmlActivities: App.currentUser.htmlActivities || null,
      htmlActivitiesVersion: App.currentUser.htmlActivitiesVersion === 1 ? 1 : 0,
      gameActivitySessions: App.currentUser.gameActivitySessions || null,
      spotifySessions: App.currentUser.spotifySessions || null,
      notificationStatus: App.currentUser.notificationStatus || null,
      savedAt: Date.now()
    });
    try {
      sessionStorage.setItem(App.LS.USER_BOOTSTRAP, serialized);
    } catch {}
    try {
      localStorage.setItem(App.LS.USER_BOOTSTRAP, serialized);
    } catch {}
  } catch {}
};
App.clearBootstrapCaches = function () {
  try {
    sessionStorage.removeItem(App.LS.USER_BOOTSTRAP);
  } catch {}
  try {
    localStorage.removeItem(App.LS.USER_BOOTSTRAP);
  } catch {}
};

App.register("core/session", function initializeFeature() {
App.LS = {
  CODE: "chatapp_code",
  PLACE: "chatapp_last_place",
  // "home" or "room:ROOM" or "schedules"
  AUTOSCROLL: "chatapp_autoscroll",
  // cached "1" / "0"
  PUSH_NOTIFS: "chatapp_push_notifs",
  // cached "1" / "0"
  // cached "1" / "0"
  ACC_CLOSE_PREVENT: "chatapp_acc_close_prevent",
  // cached "1" / "0"
  TAB_NAME: "chatapp_tab_name",
  TAB_ICON: "chatapp_tab_icon",
  CLOAK_KEYS: "chatapp_cloak_keys",
  // JSON array of key names (max 4)
  PINS: "chatapp_pinned_rooms",
  // JSON array of room ids
  THEME: "chatapp_theme",
  // cached "dark"
  BG_IMAGE: "chatapp_bg_image",
  // cached dataURL
  BG_BLUR: "chatapp_bg_blur",
  // cached "0".."30"
  BG_ZOOM: "chatapp_bg_zoom",
  // cached "0.5".."5"
  SIDEBAR_POS: "chatapp_sidebar_position",
  // cached "left" / "right"
  CALL_ROOM: "chatapp_call_room",
  // room code if you were in-call (refresh => leave)
  USER_BOOTSTRAP: "chatapp_user_bootstrap"
};
// Old-project accounts, rooms and preferences must never hydrate the new app.
if (App.firebaseConfig?.projectId) {
  for (const key of Object.keys(App.LS)) App.LS[key] += `:${App.firebaseConfig.projectId}`;
}
App.APP_TAB_TITLE_DEFAULT = "GradeSort | Grade Sorter, Study Helper";
App.APP_BG_DEFAULT = {
  dataURL: null,
  blur: 0,
  zoom: 1
};
App.SETTINGS_DEFAULTS = Object.freeze({
  autoScroll: true,
  pushNotifications: true,
  accidentalClosePrevention: false,
  theme: "dark",
  sidebarPosition: "left",
  typingIndicatorMode: "bar",
  tab: {
    name: App.APP_TAB_TITLE_DEFAULT,
    icon: ""
  },
  blackoutCloakKeys: ["Shift", "Z"],
  background: {
    dataURL: null,
    blur: 0,
    zoom: 1
  }
});
App.currentSettings = App.cloneDefaultSettings();
App.appBgCommitted = {
  ...App.APP_BG_DEFAULT
};
App.settingsSaveTimer = null;
App.settingsSaveInFlight = false;
App.settingsSavePromise = null;
App.settingsSaveAgain = false;
App.roomLoadingSeq = 0;
App.roomLoadingActive = false;
(() => {
  try {
    const cached = App.readCachedSettings();
    App.applyResolvedSettings(cached, {
      persistCache: false
    });
  } catch {}
})();
App.currentUser = null;
App.accountSessionGeneration = 0;
App.currentRoomId = null;
App.ACCOUNT_CODE_RESERVATIONS_NODE = "passwordReservations";
App.ACCOUNT_CODE_SOURCE_LOCKS_NODE = "passwordSourceLocks";
});
})(globalThis.ChatApp);
