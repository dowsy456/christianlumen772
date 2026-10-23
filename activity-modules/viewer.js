/* activities/viewer: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.destroyGamesFrame = function ({
  preserve = false
} = {}) {
  const frame = App.$("games-frame");
  if (frame) {
    const parked = preserve && App.parkCurrentGamesFrame();
    if (parked) {
      return;
    }
    App.resetGamesFrameInput(frame);
    try {
      App.revokeGamesFrameBlobURL(frame);
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
  }
  const body = App.$("games-stage-body");
  if (body) {
    try {
      Array.from(body.children).forEach(child => { if (child.id !== "merge-party-paused-frame") child.remove(); });
    } catch {}
    body.classList.remove("game-mode");
  }
};
App.syncGamesStageFullscreenButton = function () {
  const btn = App.$("games-stage-fullscreen");
  const frame = App.$("games-frame");
  if (!btn) {
    return;
  }
  if (!App.gamesStageLoaded || !frame) {
    btn.style.display = "none";
    btn.textContent = "Fullscreen";
    return;
  }
  btn.style.display = "";
  btn.textContent = document.fullscreenElement === frame ? "Exit Fullscreen" : "Fullscreen";
};
App.requestGamesStageFullscreen = async function () {
  const frame = App.$("games-frame");
  if (!App.gamesStageLoaded || !frame) return;
  try {
    if (document.fullscreenElement === frame) {
      await document.exitFullscreen?.();
    } else {
      await frame.requestFullscreen?.();
    }
  } catch {}
  App.syncGamesStageFullscreenButton();
};
App.closeGamesStage = async function ({
  preserve = false
} = {}) {
  if (App.gamesStageClosingPromise) return App.gamesStageClosingPromise;
  App.gamesStageSuppressOverlayCloseUntil = Date.now() + 250;
  const overlay = App.$("games-stage-overlay");
  if (overlay) overlay.classList.remove("open");
  const gameToClose = App.selectedGame ? {
    ...App.selectedGame
  } : null;
  // A networked Bopl match cannot be paused, even by legacy window controls.
  if (gameToClose?.roomActivityId === App.ROOM_ACTIVITY_BOPL_ROYALE) preserve = false;
  App.gamesStageClosingPromise = (async () => {
    if (document.fullscreenElement === App.$("games-frame")) {
      try {
        await document.exitFullscreen?.();
      } catch {}
    }
    if (!preserve && gameToClose?.roomActivityId === App.ROOM_ACTIVITY_BOPL_ROYALE) {
      const controller = App.$("games-frame")?.contentWindow?.__boplRoyale;
      try {
        controller?.resetInput?.();
      } catch {}
      if (controller?.leaveActivity) {
        try {
          await Promise.race([Promise.resolve(controller.leaveActivity()), new Promise(resolve => setTimeout(resolve, 5000))]);
        } catch {}
      }
      await App.releaseBoplRoyaleRoomActivity(gameToClose);
      try {
        delete window.__boplRoyaleLaunchConfig;
      } catch {}
    }
    const mergeParked = preserve && App.parkMergePartyFrame?.(gameToClose);
    if (gameToClose?.roomActivityId === App.ROOM_ACTIVITY_MERGE_PARTY) {
      const controller = App.$("games-frame")?.contentWindow?.__mergeParty;
      if (!mergeParked && controller?.leaveActivity) {
        try {
          await Promise.race([Promise.resolve(controller.leaveActivity()), new Promise(resolve => setTimeout(resolve, 1400))]);
        } catch {}
      }
      await App.releaseMergePartyRoomActivity(gameToClose);
      try {
        delete window.__mergePartyLaunchConfig;
      } catch {}
    }
    if (mergeParked) {
      App.destroyGamesFrame();
    } else if (preserve && !gameToClose?.roomActivityId) {
      App.destroyGamesFrame({
        preserve: true
      });
    } else {
      App.forgetParkedGamesFrame(gameToClose);
      App.destroyGamesFrame();
    }
    App.gamesStageOpen = false;
    App.gamesStageLoaded = false;
    App.gamesStageMaximized = false;
    App.gamesWindowRect = null;
    App.gamesWindowRectBeforeMaximize = null;
    App.selectedGame = null;
    App.leaveRoomActivityMode?.();
    await App.syncMyHtmlActivityPresence();
    await App.syncMyRoomActivityPresence();
    App.syncGamesStageFullscreenButton();
    App.syncHtmlHubSidebarButton();
  })();
  try {
    await App.gamesStageClosingPromise;
  } finally {
    App.gamesStageClosingPromise = null;
  }
};
App.renderGamesStage = async function (forceReloadFrame = false) {
  if (!App.gamesStageOpen) return;
  const body = App.$("games-stage-body");
  if (!body) return;
  const btnFullscreen = App.$("games-stage-fullscreen");
  const btnOpen = App.$("games-stage-open-tab");
  const btnLoad = App.$("games-stage-load");
  const btnReload = App.$("games-stage-reload");
  const title = App.$("games-stage-title");
  if (!App.selectedGame) {
    App.closeGamesStage();
    return;
  }
  if (title) title.textContent = App.selectedGame.label || "HTML";
  if (btnFullscreen) btnFullscreen.style.display = App.gamesStageLoaded ? "" : "none";
  if (btnOpen) btnOpen.style.display = App.selectedGame.roomActivityId ? "none" : "";
  if (btnLoad) btnLoad.style.display = App.gamesStageLoaded ? "none" : "";
  if (btnReload) btnReload.style.display = App.gamesStageLoaded ? "" : "none";
  App.ensureGamesWindowRect();
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
  if (!App.gamesStageLoaded) {
    App.destroyGamesFrame();
    body.classList.remove("game-mode");
    body.insertAdjacentHTML("beforeend", `
      <div class="games-stage-splash">
        <div class="games-stage-splash-card">
          <div class="games-stage-splash-title">${App.escapeHtml(App.selectedGame.label || "HTML")}</div>
          <div class="games-stage-splash-copy">Click <b>Load</b> to run this HTML here.</div>        </div>
    `);
    return;
  }
  body.classList.add("game-mode");
  let frame = null;
  if (!forceReloadFrame) {
    frame = App.restoreMergePartyFrame?.(App.selectedGame) || App.takeParkedGamesFrame(App.selectedGame) || App.$("games-frame");
  }
  if (!frame || forceReloadFrame) {
    App.forgetParkedGamesFrame(App.selectedGame);
    App.destroyGamesFrame();
    body.classList.add("game-mode");
    body.insertAdjacentHTML("beforeend", `<iframe class="games-frame" id="games-frame" title="${App.escapeAttr(App.selectedGame.label || "Activity")}" src="about:blank" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups" allow="fullscreen" allowfullscreen></iframe>`);
    frame = App.$("games-frame");
    await App.writeHtmlIntoIframeSameOrigin(frame, App.selectedGame.html);
  }
  if (App.selectedGame.roomActivityId) App.syncActivityChatLayout?.();
};
App.openGameInNewTab = async function (game) {
  const w = window.open("about:blank", "_blank");
  if (!w) return;
  const loadedGame = await App.ensureHtmlHubGameLoaded(game);
  if (!loadedGame) {
    try {
      w.close();
    } catch {}
    return;
  }
  const html = App.patchUploadedHtmlToSameOrigin(loadedGame.html || "");
  w.document.open();
  w.document.write(html);
  w.document.close();
  App.trackHtmlActivityPopup?.(w, loadedGame);
};
App.escapeAttr = function (s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
};
App.injectIntoHead = function (html, snippet) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + snippet);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + "<head>" + snippet + "</head>");
  return "<head>" + snippet + "</head>" + html;
};
App.getGamesStageLifecycleScript = function () {
  return `<script>
(() => {
  if (window.__gamesStageLifecycle) return;

  const nativeRAF = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : null;
  const nativeCAF = typeof window.cancelAnimationFrame === "function"
    ? window.cancelAnimationFrame.bind(window)
    : null;

  let paused = false;
  let nextRafId = 1;
  const rafCallbacks = new Map();
  const rafNativeIds = new Map();
  const audioContexts = new Set();

  function scheduleRaf(id){
    if (!nativeRAF || !rafCallbacks.has(id)) return;
    const cb = rafCallbacks.get(id);
    const nativeId = nativeRAF((ts) => {
      if (!rafCallbacks.has(id)) return;
      if (paused){
        rafNativeIds.set(id, 0);
        return;
      }
      rafNativeIds.delete(id);
      rafCallbacks.delete(id);
      try{ cb(ts); }catch(err){ setTimeout(() => { throw err; }, 0); }
    });
    rafNativeIds.set(id, nativeId);
  }

  if (nativeRAF && nativeCAF){
    window.requestAnimationFrame = function(cb){
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      scheduleRaf(id);
      return id;
    };
    window.cancelAnimationFrame = function(id){
      const nativeId = rafNativeIds.get(id);
      if (nativeId) nativeCAF(nativeId);
      rafNativeIds.delete(id);
      rafCallbacks.delete(id);
    };
  }

  function trackAudioContext(ctx){
    if (ctx && typeof ctx === "object") audioContexts.add(ctx);
    return ctx;
  }

  function wrapAudioContext(name){
    const NativeCtor = window[name];
    if (typeof NativeCtor !== "function") return;

    function WrappedAudioContext(...args){
      return trackAudioContext(Reflect.construct(NativeCtor, args, WrappedAudioContext));
    }

    WrappedAudioContext.prototype = NativeCtor.prototype;
    Object.setPrototypeOf(WrappedAudioContext, NativeCtor);
    window[name] = WrappedAudioContext;
  }

  wrapAudioContext("AudioContext");
  wrapAudioContext("webkitAudioContext");

  window.__gamesStageLifecycle = {
    pause(){
      paused = true;
      try{ document.documentElement.dataset.gamesStagePaused = "1"; }catch{}
      audioContexts.forEach((ctx) => {
        try{
          const shouldResume = ctx.state === "running";
          ctx.__gamesStageResumeOnRestore = shouldResume ? "1" : "";
          if (shouldResume) ctx.suspend?.();
        }catch{}
      });
    },
    resume(){
      paused = false;
      try{ delete document.documentElement.dataset.gamesStagePaused; }catch{}
      rafCallbacks.forEach((_, id) => {
        if (!rafNativeIds.get(id)) scheduleRaf(id);
      });
      audioContexts.forEach((ctx) => {
        try{
          if (ctx.__gamesStageResumeOnRestore === "1"){
            ctx.__gamesStageResumeOnRestore = "";
            if (ctx.state !== "closed") ctx.resume?.();
          }
        }catch{}
      });
    },
    clear(){
      paused = false;
      try{ delete document.documentElement.dataset.gamesStagePaused; }catch{}
      if (nativeCAF){
        rafNativeIds.forEach((nativeId) => {
          if (nativeId) nativeCAF(nativeId);
        });
      }
      rafNativeIds.clear();
      rafCallbacks.clear();
      audioContexts.forEach((ctx) => {
        try{ ctx.__gamesStageResumeOnRestore = ""; }catch{}
      });
    }
  };
})();
</script>`;
};
App.patchUploadedHtmlToSameOrigin = function (html) {
  // The SVG launcher supplies the real app base inside its srcdoc frame.
  const baseHref = (document.baseURI || location.href).split("#")[0];
  let out = String(html || "");
  const baseTag = /<base\b/i.test(out) ? "" : `<base href="${App.escapeAttr(baseHref)}">`;
  out = out.replace(/(<script\b[^>]*\bsrc\s*=\s*["'])([^"']*build\/three(?:\.min)?\.js)(["'][^>]*>\s*<\/script>)/gi, `$1https://unpkg.com/three@0.149.0/build/three.min.js$3`);

  // Fast path: for large HTML, avoid heavy regex work that can stall/crash the UI.
  if (out.length > 300000) {
    return App.injectIntoHead(out, baseTag + App.getGamesStageLifecycleScript());
  }
  out = out.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/i, (full, headContent) => {
    let nextHead = String(headContent || "");

    // Defer external scripts (cheap regex, avoids catastrophic backtracking).
    nextHead = nextHead.replace(/<script\b([^>]*?)\bsrc=(["'][^"']+["'])([^>]*)>\s*<\/script>/gi, (m, beforeSrc, srcValue, afterSrc) => {
      const attrs = `${beforeSrc}src=${srcValue}${afterSrc}`;
      if (/\bdefer\b/i.test(attrs)) return m;
      if (/\basync\b/i.test(attrs)) return m;
      if (/\btype\s*=\s*["']module["']/i.test(attrs)) return m;
      return `<script${beforeSrc}src=${srcValue}${afterSrc} defer></script>`;
    });

    // Wrap inline scripts to run after DOMContentLoaded (skip module/ld+json).
    nextHead = nextHead.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, code) => {
      const a = String(attrs || "");
      if (/\bsrc\s*=/i.test(a)) return m;
      if (/\btype\s*=\s*["'](?:module|application\/ld\+json)["']/i.test(a)) return m;
      const c = String(code || "");
      if (!c.trim()) return m;
      return `<script${a}>
document.addEventListener("DOMContentLoaded", () => {
${c}
}, { once:true });
</script>`;
    });
    return full.replace(headContent, nextHead);
  });
  out = App.injectIntoHead(out, baseTag + App.getGamesStageLifecycleScript());
  return out;
};
App.revokeGamesFrameBlobURL = function (frame) {
  if (!frame) return;
  const url = frame.getAttribute("data-games-blob-url");
  if (url && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  frame.removeAttribute("data-games-blob-url");
};
App.writeHtmlIntoIframeSameOrigin = async function (iframe, html) {
  if (!iframe) return;
  App.revokeGamesFrameBlobURL(iframe);
  const patched = App.patchUploadedHtmlToSameOrigin(html || "");

  // Let the UI paint "Loading..." before we hand a big document to the iframe.
  await App.sleep();
  const useSrcdocDirectly = location.protocol === "file:" || location.origin === "null";
  if (useSrcdocDirectly) {
    try {
      iframe.removeAttribute("srcdoc");
      iframe.srcdoc = patched;
      return;
    } catch {}
  }
  try {
    const blob = new Blob([patched], {
      type: "text/html;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    iframe.setAttribute("data-games-blob-url", url);
    try {
      iframe.removeAttribute("srcdoc");
    } catch {}
    iframe.src = url;
  } catch {
    try {
      iframe.removeAttribute("srcdoc");
      iframe.srcdoc = patched;
    } catch {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        doc.open();
        doc.write(patched);
        doc.close();
      } catch {}
    }
  }
};

App.register("activities/viewer", function initializeFeature() {
App.syncHtmlHubSidebarButton();
});
})(globalThis.ChatApp);
