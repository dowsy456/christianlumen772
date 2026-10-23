/* activities/window-controls: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.getDefaultGamesWindowRect = function () {
  const visualViewport = window.visualViewport;
  const vw = Math.max(240, Number(visualViewport?.width || window.innerWidth || 0));
  const vh = Math.max(240, Number(visualViewport?.height || window.innerHeight || 0));
  const mobile = document.body.dataset.mobileUi === "1" || vw <= 700;
  const margin = mobile ? 0 : App.GAMES_VIEWPORT_MARGIN;
  const originX = mobile ? Math.max(0, Number(visualViewport?.offsetLeft || 0)) : 0;
  const originY = mobile ? Math.max(0, Number(visualViewport?.offsetTop || 0)) : 0;
  const availableWidth = Math.max(240, vw - margin * 2);
  const availableHeight = Math.max(220, vh - margin * 2);
  const width = Math.min(availableWidth, 1120);
  const height = Math.min(availableHeight, 720);
  return {
    x: Math.round(originX + (vw - width) / 2),
    y: Math.round(originY + Math.max(margin, (vh - height) / 2)),
    width,
    height
  };
};
App.getMaximizedGamesWindowRect = function () {
  const visualViewport = window.visualViewport;
  const vw = Math.max(240, Number(visualViewport?.width || window.innerWidth || 0));
  const vh = Math.max(220, Number(visualViewport?.height || window.innerHeight || 0));
  const margin = document.body.dataset.mobileUi === "1" || vw <= 700 ? 0 : App.GAMES_VIEWPORT_MARGIN;
  const originX = margin === 0 ? Math.max(0, Number(visualViewport?.offsetLeft || 0)) : 0;
  const originY = margin === 0 ? Math.max(0, Number(visualViewport?.offsetTop || 0)) : 0;
  return {
    x: originX + margin,
    y: originY + margin,
    width: Math.max(240, vw - margin * 2),
    height: Math.max(220, vh - margin * 2)
  };
};
App.clampGamesWindowRect = function (rect) {
  const visualViewport = window.visualViewport;
  const vw = Math.max(240, Number(visualViewport?.width || window.innerWidth || 0));
  const vh = Math.max(220, Number(visualViewport?.height || window.innerHeight || 0));
  const mobile = document.body.dataset.mobileUi === "1" || vw <= 700;
  const margin = mobile ? 0 : App.GAMES_VIEWPORT_MARGIN;
  const originX = mobile ? Math.max(0, Number(visualViewport?.offsetLeft || 0)) : 0;
  const originY = mobile ? Math.max(0, Number(visualViewport?.offsetTop || 0)) : 0;
  const availableWidth = Math.max(240, vw - margin * 2);
  const availableHeight = Math.max(220, vh - margin * 2);
  const minWidth = Math.min(App.GAMES_MIN_WIDTH, availableWidth);
  const minHeight = Math.min(App.GAMES_MIN_HEIGHT, availableHeight);
  const width = Math.max(minWidth, Math.min(Number(rect?.width) || minWidth, availableWidth));
  const height = Math.max(minHeight, Math.min(Number(rect?.height) || minHeight, availableHeight));
  const minX = originX + margin;
  const minY = originY + margin;
  const maxX = Math.max(minX, originX + vw - width - margin);
  const maxY = Math.max(minY, originY + vh - height - margin);
  return {
    x: Math.min(maxX, Math.max(minX, Number(rect?.x) || minX)),
    y: Math.min(maxY, Math.max(minY, Number(rect?.y) || minY)),
    width,
    height
  };
};
App.ensureGamesWindowRect = function (forceReset = false) {
  if (forceReset || !App.gamesWindowRect) App.gamesWindowRect = App.getDefaultGamesWindowRect();
  App.gamesWindowRect = App.clampGamesWindowRect(App.gamesWindowRect);
  return App.gamesWindowRect;
};
App.applyGamesWindowRect = function () {
  const wrap = App.$("games-stage-wrap");
  if (!wrap) return;
  const rect = App.clampGamesWindowRect(App.gamesWindowRect || App.getDefaultGamesWindowRect());
  App.gamesWindowRect = rect;
  wrap.style.left = `${rect.x}px`;
  wrap.style.top = `${rect.y}px`;
  wrap.style.width = `${rect.width}px`;
  wrap.style.height = `${rect.height}px`;
};
App.updateGamesWindowChrome = function () {
  const wrap = App.$("games-stage-wrap");
  const maxBtn = App.$("games-stage-maximize");
  if (wrap) wrap.classList.toggle("is-maximized", !!App.gamesStageMaximized);
  if (maxBtn) maxBtn.setAttribute("aria-label", App.gamesStageMaximized ? "Restore" : "Maximize");
};
App.toggleGamesStageMaximize = function () {
  if (!App.gamesStageOpen) return;
  if (App.gamesStageMaximized) {
    App.gamesStageMaximized = false;
    App.gamesWindowRect = App.clampGamesWindowRect(App.gamesWindowRectBeforeMaximize || App.getDefaultGamesWindowRect());
  } else {
    App.gamesWindowRectBeforeMaximize = App.clampGamesWindowRect(App.gamesWindowRect || App.getDefaultGamesWindowRect());
    App.gamesStageMaximized = true;
    App.gamesWindowRect = App.getMaximizedGamesWindowRect();
  }
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
};
App.beginGamesWindowDrag = function (e) {
  if (!App.gamesStageOpen) return;
  if (document.body.dataset.mobileUi === "1") return;
  if (e.button !== 0) return;
  if (e.target.closest(".games-stage-winbtn") || e.target.closest(".games-stage-head-actions")) return;
  if (App.gamesStageMaximized) {
    App.gamesStageMaximized = false;
    App.gamesWindowRect = App.clampGamesWindowRect(App.gamesWindowRectBeforeMaximize || App.getDefaultGamesWindowRect());
    App.applyGamesWindowRect();
    App.updateGamesWindowChrome();
  }
  const rect = App.clampGamesWindowRect(App.gamesWindowRect || App.getDefaultGamesWindowRect());
  App.gamesStageSuppressOverlayCloseUntil = Date.now() + 500;
  App.gamesWindowDragState = {
    pointerId: e.pointerId,
    mode: "move",
    startX: e.clientX,
    startY: e.clientY,
    startRect: {
      ...rect
    }
  };
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  e.preventDefault();
};
App.beginGamesWindowResize = function (e, dir) {
  if (!App.gamesStageOpen) return;
  if (document.body.dataset.mobileUi === "1") return;
  if (e.button !== 0) return;
  if (App.gamesStageMaximized) {
    App.gamesStageMaximized = false;
    App.gamesWindowRect = App.clampGamesWindowRect(App.gamesWindowRectBeforeMaximize || App.getDefaultGamesWindowRect());
    App.applyGamesWindowRect();
    App.updateGamesWindowChrome();
  }
  const rect = App.clampGamesWindowRect(App.gamesWindowRect || App.getDefaultGamesWindowRect());
  App.gamesStageSuppressOverlayCloseUntil = Date.now() + 500;
  App.gamesWindowDragState = {
    pointerId: e.pointerId,
    mode: "resize",
    dir,
    startX: e.clientX,
    startY: e.clientY,
    startRect: {
      ...rect
    }
  };
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {}
  e.preventDefault();
};
App.handleGamesWindowPointerMove = function (e) {
  if (!App.gamesWindowDragState || e.pointerId !== App.gamesWindowDragState.pointerId) return;
  const dx = e.clientX - App.gamesWindowDragState.startX;
  const dy = e.clientY - App.gamesWindowDragState.startY;
  const start = App.gamesWindowDragState.startRect;
  if (App.gamesWindowDragState.mode === "move") {
    App.gamesWindowRect = App.clampGamesWindowRect({
      x: start.x + dx,
      y: start.y + dy,
      width: start.width,
      height: start.height
    });
    App.applyGamesWindowRect();
    return;
  }
  let next = {
    x: start.x,
    y: start.y,
    width: start.width,
    height: start.height
  };
  const dir = App.gamesWindowDragState.dir || "";
  if (dir.includes("e")) next.width = start.width + dx;
  if (dir.includes("s")) next.height = start.height + dy;
  if (dir.includes("w")) {
    next.width = start.width - dx;
    next.x = start.x + dx;
  }
  if (dir.includes("n")) {
    next.height = start.height - dy;
    next.y = start.y + dy;
  }
  if (next.width < App.GAMES_MIN_WIDTH) {
    if (dir.includes("w")) next.x -= App.GAMES_MIN_WIDTH - next.width;
    next.width = App.GAMES_MIN_WIDTH;
  }
  if (next.height < App.GAMES_MIN_HEIGHT) {
    if (dir.includes("n")) next.y -= App.GAMES_MIN_HEIGHT - next.height;
    next.height = App.GAMES_MIN_HEIGHT;
  }
  App.gamesWindowRect = App.clampGamesWindowRect(next);
  App.applyGamesWindowRect();
};
App.endGamesWindowPointer = function (e) {
  if (!App.gamesWindowDragState) return;
  if (e && e.pointerId != null && e.pointerId !== App.gamesWindowDragState.pointerId) return;
  App.gamesWindowDragState = null;
  App.gamesStageSuppressOverlayCloseUntil = Date.now() + 200;
};
App.bindGamesWindowInteractions = function () {
  const head = App.$("games-stage-head");
  if (head && head.dataset.bound !== "1") {
    head.dataset.bound = "1";
    head.addEventListener("pointerdown", App.beginGamesWindowDrag);
    head.addEventListener("dblclick", e => {
      if (e.target.closest(".games-stage-winbtn") || e.target.closest(".games-stage-head-actions")) return;
      App.toggleGamesStageMaximize();
    });
  }
  document.querySelectorAll("[data-games-resize]").forEach(handle => {
    if (handle.dataset.bound === "1") return;
    handle.dataset.bound = "1";
    handle.addEventListener("pointerdown", e => App.beginGamesWindowResize(e, handle.dataset.gamesResize));
  });
  if (!window.__gamesStageWindowBound) {
    window.__gamesStageWindowBound = true;
    window.addEventListener("pointermove", App.handleGamesWindowPointerMove);
    window.addEventListener("pointerup", App.endGamesWindowPointer);
    window.addEventListener("pointercancel", App.endGamesWindowPointer);
    const syncGamesWindowToViewport = App.rafThrottle(() => {
      if (!App.gamesStageOpen) return;
      App.gamesWindowRect = App.gamesStageMaximized ? App.getMaximizedGamesWindowRect() : App.clampGamesWindowRect(App.gamesWindowRect || App.getDefaultGamesWindowRect());
      App.applyGamesWindowRect();
    });
    window.addEventListener("resize", syncGamesWindowToViewport);
    window.visualViewport?.addEventListener("resize", syncGamesWindowToViewport);
    window.visualViewport?.addEventListener("scroll", syncGamesWindowToViewport);
  }
};
App.openUnsavedHtmlFile = async function (file) {
  const ok = file.type === "text/html" || /\.html?$/i.test(file.name || "");
  if (!ok) {
    App.showToast({
      title: "Invalid file",
      body: "Please choose an .html file.",
      duration: 3500
    });
    return;
  }
  const html = await file.text();
  await App.openHtmlStage({
    id: "upload",
    label: `Uploaded: ${file.name || "HTML"}`,
    activityLabel: file.name || "index.html",
    uploadFileName: file.name || "index.html",
    html,
    __upload: true,
    hubId: null
  });
};
App.getCurrentHtmlActivityPayload = function () {
  if (!App.currentUser || !App.selectedGame || !App.gamesStageOpen) return null;
  const isHub = !!App.selectedGame.hubId;
  const rawTitle = isHub ? String(App.selectedGame.label || "").trim() : String(App.selectedGame.uploadFileName || App.selectedGame.activityLabel || App.selectedGame.label || "").trim();
  const title = rawTitle || (isHub ? "Untitled HTML" : "index.html");
  return {
    type: isHub ? "hub" : "upload",
    title,
    hubId: isHub ? String(App.selectedGame.hubId || "") : "",
    fileName: isHub ? "" : title,
    updatedAt: App.firebase.database.ServerValue.TIMESTAMP
  };
};
App.syncMyHtmlActivityPresence = async function () {
  if (!App.currentUser?.code) return;
  const code = String(App.currentUser.code), accountGeneration = App.accountSessionGeneration;
  const operation = (App.htmlActivityPresenceOperation || 0) + 1;
  App.htmlActivityPresenceOperation = operation;
  const isCurrent = () => App.currentUser?.code === code && App.accountSessionGeneration === accountGeneration && App.htmlActivityPresenceOperation === operation;
  const ref = App.db.ref(`users/${code}/htmlActivity`);
  const payload = App.getCurrentHtmlActivityPayload();
  if (!payload) {
    try {
      await ref.onDisconnect().cancel();
    } catch {}
    if (!isCurrent()) return;
    try {
      await ref.remove();
    } catch {}
    if (!isCurrent()) return;
    App.htmlActivityPresenceRef = null;
    App.currentUser.htmlActivity = null;
    const selfCode = String(App.currentUser.code || "");
    if (selfCode && App.liveUserCache.has(selfCode)) {
      App.liveUserCache.set(selfCode, {
        ...(App.liveUserCache.get(selfCode) || {}),
        htmlActivity: null
      });
    }
    try {
      App.renderOnlineIndicator();
    } catch {}
    try {
      App.refreshOpenUserProfileCard();
    } catch {}
    return;
  }
  App.htmlActivityPresenceRef = ref;
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  payload.sessionId = sessionId;
  try {
    await ref.onDisconnect().remove();
  } catch {}
  if (!isCurrent()) return;
  try {
    await ref.set(payload);
  } catch {}
  if (!isCurrent()) {
    // The legacy compatibility leaf is shared. Remove only this obsolete
    // operation so a later login or another device's newer activity survives.
    try { await ref.transaction(value => value?.sessionId === sessionId ? null : undefined, undefined, false); } catch {}
    return;
  }
  App.currentUser.htmlActivity = {
    ...payload
  };
  const selfCode = String(App.currentUser.code || "");
  if (selfCode) {
    App.liveUserCache.set(selfCode, {
      ...(App.liveUserCache.get(selfCode) || {}),
      code: selfCode,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
      bio: String(App.currentUser.bio || "").slice(0, 400),
      photoDataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.currentUser.photoTransform || null,
      bannerDataURL: String(App.currentUser.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340),
      htmlActivity: {
        ...payload
      }
    });
  }
  try {
    App.renderOnlineIndicator();
  } catch {}
  try {
    App.refreshOpenUserProfileCard();
  } catch {}
};

App.register("activities/window-controls", function initializeFeature() {

});
})(globalThis.ChatApp);
