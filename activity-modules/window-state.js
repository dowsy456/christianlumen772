/* activities/window-state: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.htmlHubPath = function () {
  return App.HTML_HUB_FILES_NODE;
};
App.htmlHubMetaPath = function () {
  return App.HTML_HUB_META_NODE;
};
App.sanitizeHtmlHubTitle = function (raw) {
  return App.sanitizeUsername(raw);
};
App.makeHtmlHubId = function () {
  const owner = String(App.currentUser?.code || "user").replace(/[.#$\[\]\/]/g, "_");
  return `html_${owner}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};
App.getHtmlHubResumeKey = function (game = App.selectedGame) {
  if (game?.hubId) return `hub:${game.hubId}`;
  if (game?.roomActivityId && game?.roomActivityRoomId) {
    return `room-activity:${App.sanitizeRoomCode(game.roomActivityRoomId)}:${String(game.roomActivityId)}`;
  }
  return "";
};
App.isHtmlHubPaused = function (gameOrId = App.selectedGame) {
  const key = typeof gameOrId === "string" ? `hub:${gameOrId}` : App.getHtmlHubResumeKey(gameOrId);
  return !!(key && App.parkedHtmlHubKey === key);
};
App.clearGamesFrameResumeMarkers = function (frame = App.$("games-frame")) {
  if (!frame) return;
  try {
    frame.contentWindow?.__gamesStageLifecycle?.clear?.();
  } catch {}
  try {
    frame.contentWindow?.document?.querySelectorAll?.("audio").forEach(el => {
      el.removeAttribute("data-games-resume-on-restore");
    });
  } catch {}
};
App.resetGamesFrameInput = function (frame = App.$("games-frame")) {
  if (!frame) return;
  try {
    frame.contentWindow?.__boplRoyale?.resetInput?.();
  } catch {}
};
App.pauseGamesFrameMedia = function (frame = App.$("games-frame")) {
  if (!frame) return;
  App.resetGamesFrameInput(frame);
  try {
    frame.contentWindow?.__boplRoyale?.setAfk?.(true);
  } catch {}
  try {
    frame.contentWindow?.__gamesStageLifecycle?.pause?.();
  } catch {}
  try {
    frame.contentWindow?.document?.querySelectorAll?.("audio").forEach(el => {
      const shouldResume = !el.paused && !el.ended;
      if (shouldResume) el.setAttribute("data-games-resume-on-restore", "1");else el.removeAttribute("data-games-resume-on-restore");
      try {
        el.pause?.();
      } catch {}
    });
  } catch {}
};
App.resumeGamesFrameMedia = function (frame = App.$("games-frame")) {
  if (!frame) return;
  try {
    frame.contentWindow?.__gamesStageLifecycle?.resume?.();
  } catch {}
  try {
    frame.contentWindow?.__boplRoyale?.setAfk?.(false);
  } catch {}
  try {
    frame.contentWindow?.document?.querySelectorAll?.("audio").forEach(el => {
      if (el.getAttribute("data-games-resume-on-restore") === "1") {
        el.removeAttribute("data-games-resume-on-restore");
        try {
          el.play?.();
        } catch {}
      }
    });
  } catch {}
};
App.forgetParkedGamesFrame = function (gameOrKey) {
  const key = typeof gameOrKey === "string" ? gameOrKey : App.getHtmlHubResumeKey(gameOrKey);
  if (!key) return;
  const frame = App.$("games-frame");
  const frameKey = frame?.getAttribute("data-games-parked-key") || "";
  if (App.parkedHtmlHubKey !== key && frameKey !== key) return;
  App.parkedHtmlHubKey = "";
  App.resetGamesFrameInput(frame);
  App.clearGamesFrameResumeMarkers(frame);
  if (!frame) return;
  try {
    frame.removeAttribute("data-games-parked");
    frame.removeAttribute("data-games-parked-key");
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
    frame.contentWindow?.stop?.();
    frame.contentWindow?.location?.replace?.("about:blank");
  } catch {}
  try {
    frame.remove();
  } catch {}
};
App.takeParkedGamesFrame = function (game = App.selectedGame) {
  const key = App.getHtmlHubResumeKey(game);
  const frame = App.$("games-frame");
  if (!key || App.parkedHtmlHubKey !== key || !frame) return null;
  App.parkedHtmlHubKey = "";
  frame.removeAttribute("data-games-parked");
  frame.removeAttribute("data-games-parked-key");
  App.resumeGamesFrameMedia(frame);
  return frame;
};
App.parkCurrentGamesFrame = function () {
  const frame = App.$("games-frame");
  const key = App.getHtmlHubResumeKey(App.selectedGame);
  if (!frame || !key) return false;
  App.pauseGamesFrameMedia(frame);
  App.parkedHtmlHubKey = key;
  frame.setAttribute("data-games-parked", "1");
  frame.setAttribute("data-games-parked-key", key);
  return true;
};
App.clearOtherParkedGamesFrames = function (exceptKey = "") {
  if (!App.parkedHtmlHubKey || App.parkedHtmlHubKey === exceptKey) return;
  App.forgetParkedGamesFrame(App.parkedHtmlHubKey);
};
App.normalizeHtmlHubMeta = function (id, raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const title = String(item.title || "Untitled HTML").trim() || "Untitled HTML";
  const ownerCode = String(item.ownerCode || item.userCode || "").trim();
  const ownerUsername = String(item.ownerUsername || item.username || "Unknown user").trim() || "Unknown user";
  return {
    id: String(id || ""),
    title,
    titleLower: String(item.titleLower || title).toLowerCase(),
    ownerCode,
    ownerUsername,
    ownerUsernameLower: String(item.ownerUsernameLower || ownerUsername).toLowerCase(),
    createdAt: Math.max(0, Number(item.createdAt || 0)),
    updatedAt: Math.max(0, Number(item.updatedAt || item.createdAt || 0)),
    fileName: String(item.fileName || ""),
    byteSize: Math.max(0, Number(item.byteSize || 0)),
    schemaVersion: Math.max(2, Number(item.schemaVersion || 2)),
    legacySource: item.legacySource && typeof item.legacySource === "object" ? item.legacySource : null,
    uploadPending: !!item.uploadPending,
    deleted: !!item.deleted,
    deletedAt: Math.max(0, Number(item.deletedAt || 0))
  };
};
App.sortHtmlHubItems = function (items) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => {
    const byTitle = String(a?.titleLower || "").localeCompare(String(b?.titleLower || ""));
    if (byTitle) return byTitle;
    const byOwner = String(a?.ownerUsernameLower || "").localeCompare(String(b?.ownerUsernameLower || ""));
    if (byOwner) return byOwner;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
};
App.htmlHubItemsFromIndex = function (raw) {
  const index = raw && typeof raw === "object" ? raw : {};
  return App.sortHtmlHubItems(Object.entries(index).map(([id, item]) => App.normalizeHtmlHubMeta(id, item)).filter(item => item.id && item.ownerCode && !item.uploadPending && !item.deleted));
};
App.getCachedHtmlHubItem = function (id) {
  const key = String(id || "");
  return App.htmlHubItemsCache.find(item => item.id === key) || null;
};
App.readHtmlHubMetaById = async function (id) {
  const key = String(id || "");
  if (!key) return null;
  try {
    const snap = await App.db.ref(`${App.htmlHubMetaPath()}/${key}`).once("value");
    if (!snap.exists() || snap.val()?.deleted) return null;
    return App.normalizeHtmlHubMeta(key, snap.val());
  } catch {
    return null;
  }
};
App.canManageHtmlHubItem = function (item) {
  const ownerCode = String(item?.ownerCode || "");
  const selfCode = String(App.currentUser?.code || "");
  return !!(ownerCode && selfCode && (ownerCode === selfCode || App.isVinny()));
};
App.readHtmlHubFileMeta = async function (id, {
  includeMigrationPending = false
} = {}) {
  const key = String(id || "");
  if (!key) return null;
  const fileRef = App.db.ref(`${App.htmlHubPath()}/${key}`);
  try {
    const fields = ["title", "titleLower", "ownerCode", "ownerUsername", "ownerUsernameLower", "createdAt", "updatedAt", "fileName", "byteSize", "uploadPending", "migrationPending", "migrationReady", "migrationToken", "migrationSourceSignature", "legacySource"];
    const snaps = await Promise.all(fields.map(field => fileRef.child(field).once("value")));
    const raw = {};
    fields.forEach((field, index) => {
      raw[field] = snaps[index].val();
    });
    if (raw.uploadPending) return null;
    if ((raw.migrationPending || raw.migrationReady) && !includeMigrationPending) return null;
    return {
      ...App.normalizeHtmlHubMeta(key, raw),
      migrationPending: !!raw.migrationPending,
      migrationReady: !!raw.migrationReady,
      migrationToken: String(raw.migrationToken || ""),
      migrationSourceSignature: String(raw.migrationSourceSignature || "")
    };
  } catch {
    return null;
  }
};
App.cacheHtmlHubMeta = async function (items) {
  if (!App.currentUser?.code || !Array.isArray(items) || !items.length) return;
  for (const raw of items) {
    const item = App.normalizeHtmlHubMeta(raw?.id, raw);
    if (!item.id || !item.ownerCode || item.deleted) continue;
    const candidate = {
      title: item.title,
      titleLower: item.titleLower,
      ownerCode: item.ownerCode,
      ownerUsername: item.ownerUsername,
      ownerUsernameLower: item.ownerUsernameLower,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      fileName: item.fileName,
      byteSize: item.byteSize,
      schemaVersion: 2,
      ...(item.legacySource ? {
        legacySource: item.legacySource
      } : {})
    };
    try {
      const cached = await App.db.ref(`${App.htmlHubMetaPath()}/${item.id}`).transaction(current => {
        if (current?.deleted) return;
        return current == null ? candidate : current;
      }, undefined, false);
      if (!cached.committed || cached.snapshot.val()?.deleted) continue;
      const authoritative = App.normalizeHtmlHubMeta(item.id, cached.snapshot.val());
      if (!authoritative.ownerCode) continue;
      await App.db.ref(`${App.HTML_HUB_BY_OWNER_NODE}/${authoritative.ownerCode}/${item.id}`).set(true);
    } catch {}
  }
};
App.readHtmlHub = async function () {
  if (!App.currentUser?.code) return [];
  try {
    const metaSnap = await App.db.ref(App.htmlHubMetaPath()).once("value");
    App.htmlHubIndexLoaded = true;
    App.htmlHubItemsCache = App.htmlHubItemsFromIndex(metaSnap.val());
  } catch {}
  if (!App.htmlHubItemsCache.length && App.HTML_HUB_ENABLE_LEGACY_MIGRATION) {
    const ids = await App.fetchHtmlHubChildKeys();
    const recovered = (await Promise.all(ids.map(id => App.readHtmlHubFileMeta(id)))).filter(Boolean);
    if (recovered.length) {
      App.htmlHubItemsCache = App.sortHtmlHubItems(recovered);
      void App.cacheHtmlHubMeta(recovered);
    }
  }
  return App.htmlHubItemsCache.slice();
};
App.stopHtmlHubRealtimeListener = function () {
  if (App.htmlHubRealtimeRef && App.htmlHubRealtimeCb) {
    try {
      App.htmlHubRealtimeRef.off("value", App.htmlHubRealtimeCb);
    } catch {}
  }
  App.htmlHubRealtimeRef = null;
  App.htmlHubRealtimeCb = null;
};
App.startHtmlHubRealtimeListener = function (onItems) {
  App.stopHtmlHubRealtimeListener();
  const ref = App.db.ref(App.htmlHubMetaPath());
  const cb = snap => {
    App.htmlHubIndexLoaded = true;
    App.htmlHubItemsCache = App.htmlHubItemsFromIndex(snap.val());
    try {
      onItems?.(App.htmlHubItemsCache.slice());
    } catch (e) {
      console.error("HTML Hub live render failed:", e);
    }
  };
  ref.on("value", cb);
  App.htmlHubRealtimeRef = ref;
  App.htmlHubRealtimeCb = cb;
};
App.makeLegacyHtmlHubId = function (ownerCode, legacyId) {
  const owner = String(ownerCode || "unknown").replace(/[.#$\[\]\/]/g, "_");
  const source = String(legacyId || "item").replace(/[.#$\[\]\/]/g, "_");
  return `legacy_${owner}__${source}`;
};
App.normalizedHtmlChunks = function (raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const chunks = [];
  const hasHtml = Object.prototype.hasOwnProperty.call(item, "html");
  const hasHtml1 = Object.prototype.hasOwnProperty.call(item, "html1");
  if (hasHtml && hasHtml1) return [];
  if (hasHtml) chunks.push(String(item.html ?? ""));else if (hasHtml1) chunks.push(String(item.html1 ?? ""));else return [];
  const numberedChunkIndexes = Object.keys(item).map(key => /^html(\d+)$/.exec(key)).filter(Boolean).map(match => Number(match[1])).filter(index => Number.isSafeInteger(index) && index >= 1);
  const declaredCount = Math.max(0, Number(item.htmlChunkCount || 0));
  if (declaredCount) {
    if (!Number.isSafeInteger(declaredCount) || declaredCount > 10000) return [];
    if (numberedChunkIndexes.some(index => index > declaredCount)) return [];
    for (let index = 2; index <= declaredCount; index += 1) {
      const key = `html${index}`;
      if (!Object.prototype.hasOwnProperty.call(item, key)) return [];
      chunks.push(String(item[key] ?? ""));
    }
    return chunks;
  }
  const inferredCount = Math.max(1, ...numberedChunkIndexes);
  if (inferredCount > 10000) return [];
  for (let index = 2; index <= inferredCount; index += 1) {
    const key = `html${index}`;
    if (!Object.prototype.hasOwnProperty.call(item, key)) return [];
    chunks.push(String(item[key] ?? ""));
  }
  return chunks;
};
App.htmlHubChunkSignature = async function (raw) {
  return await App.sha256Hex(JSON.stringify(App.normalizedHtmlChunks(raw)));
};
App.getLegacyHtmlOwnerUsername = async function (ownerCode) {
  const code = String(ownerCode || "");
  if (!code) return "Unknown user";
  if (code === String(App.currentUser?.code || "")) return String(App.currentUser?.username || "Unknown user");
  try {
    const cached = App.liveUserCache.get(code) || App.schedulesPeopleByCode.get(code);
    if (cached?.username) return String(cached.username);
  } catch {}
  try {
    const snap = await App.db.ref(`users/${code}/username`).once("value");
    return String(snap.val() || "Unknown user");
  } catch {
    return "Unknown user";
  }
};
App.canonicalLegacyMigrationValue = function (value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(App.canonicalLegacyMigrationValue);
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = App.canonicalLegacyMigrationValue(value[key]);
  }
  return out;
};
App.legacyMigrationFingerprint = function (value) {
  return JSON.stringify(App.canonicalLegacyMigrationValue(value));
};
App.legacyHtmlFileWithoutMigrationClaim = function (value) {
  if (!value || typeof value !== "object") return value ?? null;
  const copy = {
    ...value
  };
  delete copy.hubMigrationClaim;
  return copy;
};
App.claimLegacyHtmlSource = async function (ownerCode, sourceId, expectedFile, expectedMeta, migrationToken) {
  const code = String(ownerCode || "");
  const id = String(sourceId || "");
  const token = String(migrationToken || "");
  if (!code || !id || !token) return false;
  const expectedFileFingerprint = App.legacyMigrationFingerprint(App.legacyHtmlFileWithoutMigrationClaim(expectedFile));
  const expectedMetaFingerprint = App.legacyMigrationFingerprint(expectedMeta ?? null);
  try {
    const result = await App.db.ref(`users/${code}`).transaction(current => {
      if (!current || typeof current !== "object") return;
      const currentFile = current?.[App.LEGACY_HTML_LIBRARY_NODE]?.[id] ?? null;
      const currentMeta = current?.[App.LEGACY_HTML_LIBRARY_META_NODE]?.[id] ?? null;
      if (currentFile?.uploadPending || currentMeta?.uploadPending) return;
      if (!App.normalizedHtmlChunks(currentFile).length) return;
      if (App.legacyMigrationFingerprint(App.legacyHtmlFileWithoutMigrationClaim(currentFile)) !== expectedFileFingerprint) return;
      if (App.legacyMigrationFingerprint(currentMeta) !== expectedMetaFingerprint) return;
      const next = {
        ...current
      };
      const files = {
        ...(next[App.LEGACY_HTML_LIBRARY_NODE] || {})
      };
      files[id] = {
        ...currentFile,
        hubMigrationClaim: token
      };
      next[App.LEGACY_HTML_LIBRARY_NODE] = files;
      return next;
    }, undefined, false);
    return !!result.committed;
  } catch {
    return false;
  }
};
App.conditionallyDeleteLegacyHtmlSource = async function (ownerCode, sourceId, expectedFile, expectedMeta, migrationToken) {
  const code = String(ownerCode || "");
  const id = String(sourceId || "");
  const token = String(migrationToken || "");
  if (!code || !id || !token) return false;
  const expectedFileFingerprint = App.legacyMigrationFingerprint(App.legacyHtmlFileWithoutMigrationClaim(expectedFile));
  const expectedMetaFingerprint = App.legacyMigrationFingerprint(expectedMeta ?? null);
  const userRef = App.db.ref(`users/${code}`);
  try {
    const result = await userRef.transaction(current => {
      if (!current || typeof current !== "object") return;
      const currentFile = current?.[App.LEGACY_HTML_LIBRARY_NODE]?.[id] ?? null;
      const currentMeta = current?.[App.LEGACY_HTML_LIBRARY_META_NODE]?.[id] ?? null;
      if (currentFile?.uploadPending || currentMeta?.uploadPending) return;
      if (String(currentFile?.hubMigrationClaim || "") !== token) return;
      if (!App.normalizedHtmlChunks(currentFile).length) return;
      if (App.legacyMigrationFingerprint(App.legacyHtmlFileWithoutMigrationClaim(currentFile)) !== expectedFileFingerprint) return;
      if (App.legacyMigrationFingerprint(currentMeta) !== expectedMetaFingerprint) return;
      const next = {
        ...current
      };
      const files = {
        ...(next[App.LEGACY_HTML_LIBRARY_NODE] || {})
      };
      const metas = {
        ...(next[App.LEGACY_HTML_LIBRARY_META_NODE] || {})
      };
      delete files[id];
      delete metas[id];
      if (Object.keys(files).length) next[App.LEGACY_HTML_LIBRARY_NODE] = files;else delete next[App.LEGACY_HTML_LIBRARY_NODE];
      if (Object.keys(metas).length) next[App.LEGACY_HTML_LIBRARY_META_NODE] = metas;else delete next[App.LEGACY_HTML_LIBRARY_META_NODE];
      return next;
    }, undefined, false);
    return !!result.committed;
  } catch {
    return false;
  }
};

App.register("activities/window-state", function initializeFeature() {
App.gamesStageOpen = false;
App.gamesStageLoaded = false;
App.gamesStageMaximized = false;
App.selectedGame = null;
App.htmlActivityPresenceRef = null;
App.roomActivityClaimRef = null;
App.roomActivityClaimSessionRef = null;
App.roomActivityClaimToken = "";
App.roomActivityClaimActivityId = "";
App.roomActivityClaimRoomId = "";
App.roomActivityClaimHeartbeatTimer = 0;
App.gamesWindowRect = null;
App.gamesWindowRectBeforeMaximize = null;
App.gamesWindowDragState = null;
App.gamesStageClosingPromise = null;
App.gamesStageSuppressOverlayCloseUntil = 0;
App.parkedHtmlHubKey = "";
App.GAMES_MIN_WIDTH = 280;
App.GAMES_MIN_HEIGHT = 220;
App.GAMES_VIEWPORT_MARGIN = 12;
App.CLIENT_INSTANCE_ID = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
App.htmlHubItemsCache = [];
App.htmlHubIndexLoaded = false;
App.htmlHubRealtimeRef = null;
App.htmlHubRealtimeCb = null;
App.htmlHubLegacyMigrationPromise = null;
App.htmlHubLegacyMigrationLastScan = 0;
App.htmlHubOwnerListeners = new Map();
App.htmlHubModalRequestSeq = 0;
});
})(globalThis.ChatApp);
