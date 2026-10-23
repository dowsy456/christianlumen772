/* media/video-player: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.getVideoUiConfig = async function () {
  if (App.videoUiConfigCache) return App.videoUiConfigCache;
  if (App.videoUiConfigPromise) return App.videoUiConfigPromise;
  App.videoUiConfigPromise = (async () => {
    try {
      const snap = await App.db.ref("ui/videoPlayer").once("value");
      const raw = snap.val();
      // Defaults already ship locally; only administrator overrides need data.
      const cfg = {
        ...App.VIDEO_UI_DEFAULTS,
        ...(raw || {}),
        mediaZoom: {
          ...App.VIDEO_UI_DEFAULTS.mediaZoom,
          ...(raw && raw.mediaZoom || {})
        }
      };
      cfg.stepBackSec = Math.round(App.clampNum(cfg.stepBackSec, 1, 30, App.VIDEO_UI_DEFAULTS.stepBackSec));
      cfg.stepFwdSec = Math.round(App.clampNum(cfg.stepFwdSec, 1, 30, App.VIDEO_UI_DEFAULTS.stepFwdSec));
      cfg.maxCustomSpeed = App.clampNum(cfg.maxCustomSpeed, 2, 10, App.VIDEO_UI_DEFAULTS.maxCustomSpeed);
      const speeds = Array.isArray(cfg.speeds) ? cfg.speeds : App.VIDEO_UI_DEFAULTS.speeds;
      cfg.speeds = Array.from(new Set(speeds.map(s => App.clampNum(s, 0.05, cfg.maxCustomSpeed, 1)))).sort((a, b) => a - b);
      if (!cfg.speeds.some(s => Math.abs(s - 1) < 1e-9)) cfg.speeds.push(1);
      cfg.speeds.sort((a, b) => a - b);
      cfg.mediaZoom.step = App.clampNum(Math.max(Number(cfg.mediaZoom.step) || 0, App.VIDEO_UI_DEFAULTS.mediaZoom.step), 0.05, 2, App.VIDEO_UI_DEFAULTS.mediaZoom.step);
      cfg.mediaZoom.wheelStep = App.clampNum(Math.max(Number(cfg.mediaZoom.wheelStep) || 0, App.VIDEO_UI_DEFAULTS.mediaZoom.wheelStep), 0.02, 1, App.VIDEO_UI_DEFAULTS.mediaZoom.wheelStep);
      cfg.mediaZoom.maxScale = App.clampNum(Math.max(Number(cfg.mediaZoom.maxScale) || 0, App.VIDEO_UI_DEFAULTS.mediaZoom.maxScale), 1.25, 24, App.VIDEO_UI_DEFAULTS.mediaZoom.maxScale);
      cfg.mediaZoom.doubleTapScale = App.clampNum(cfg.mediaZoom.doubleTapScale, 1.25, cfg.mediaZoom.maxScale, App.VIDEO_UI_DEFAULTS.mediaZoom.doubleTapScale);
      App.videoUiConfigCache = cfg;
      return cfg;
    } catch {
      App.videoUiConfigCache = {
        ...App.VIDEO_UI_DEFAULTS,
        mediaZoom: {
          ...App.VIDEO_UI_DEFAULTS.mediaZoom
        }
      };
      return App.videoUiConfigCache;
    } finally {
      App.videoUiConfigPromise = null;
    }
  })();
  return App.videoUiConfigPromise;
};
App.videoKeyFor = async function (fileName, src) {
  // Per-video settings key: stable per file without hashing an entire huge data URL.
  const srcText = String(src || "");
  const sample = srcText.length > 4096 ? `${srcText.slice(0, 2048)}::${srcText.slice(-2048)}::${srcText.length}` : srcText;
  const base = `${String(fileName || "")}::${sample}`;
  try {
    return await App.sha256Hex(base);
  } catch {
    return App.fnv1aHex(base);
  }
};
App.getVideoPrefs = async function (roomId, videoKey) {
  const rid = App.sanitizeRoomCode(roomId || App.currentRoomId);
  if (!App.currentUser?.code || !rid || !videoKey) return {};
  try {
    const snap = await App.db.ref(`users/${App.currentUser.code}/prefs/videoPlayerByRoom/${rid}/${videoKey}`).once("value");
    return snap.val() || {};
  } catch {
    return {};
  }
};
App.saveVideoPrefs = async function (roomId, videoKey, patch) {
  const rid = App.sanitizeRoomCode(roomId || App.currentRoomId);
  if (!App.currentUser?.code || !rid || !videoKey) return;
  const p = patch && typeof patch === "object" ? patch : {};
  const mapKey = `${rid}::${videoKey}`;
  const pending = {
    ...(App.videoPrefsPendingByKey.get(mapKey) || {}),
    ...p
  };
  App.videoPrefsPendingByKey.set(mapKey, pending);
  const prev = App.videoPrefsTimerByKey.get(mapKey);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    const toWrite = App.videoPrefsPendingByKey.get(mapKey) || {};
    App.videoPrefsPendingByKey.delete(mapKey);
    App.videoPrefsTimerByKey.delete(mapKey);
    try {
      await App.db.ref(`users/${App.currentUser.code}/prefs/videoPlayerByRoom/${rid}/${videoKey}`).update(toWrite);
    } catch {}
  }, 150);
  App.videoPrefsTimerByKey.set(mapKey, t);
};
App.fmtTime = function (sec) {
  const s = Math.max(0, Number(sec) || 0);
  const whole = Math.floor(s);
  const m = Math.floor(whole / 60);
  const r = whole % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};
App.svgIcon = function (name) {
  // Minimal custom icons (no external assets).
  if (name === "play") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M9 7v10l8-5-8-5Z" fill="currentColor"/></svg>`;
  if (name === "pause") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M7 6h3v12H7V6Zm7 0h3v12h-3V6Z" fill="currentColor"/></svg>`;
  if (name === "back5") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M11 5 5 9l6 4V5Z" fill="currentColor"/><path d="M20 7v10h-2V7h2Z" fill="currentColor"/><path d="M9 19a8 8 0 1 1 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (name === "fwd5") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M13 5v8l6-4-6-4Z" fill="currentColor"/><path d="M4 7v10h2V7H4Z" fill="currentColor"/><path d="M15 19a8 8 0 1 0-8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (name === "loop") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M7 7h9a3 3 0 0 1 3 3v1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 17H8a3 3 0 0 1-3-3v-1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 9 18 11 16 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15l2-2 2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (name === "vol") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M4 10v4h3l5 4V6L7 10H4Z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 6.5a8 8 0 0 1 0 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (name === "mute") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M4 10v4h3l5 4V6L7 10H4Z" fill="currentColor"/><path d="M16 9l5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (name === "menu") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 6h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 18h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  if (name === "full") return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M8 3H3v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 3h5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 21H3v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M16 21h5v-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  return "";
};
App.initVideoPlayer = function (root, {
  fileName = null,
  videoKey = null,
  roomId = null
} = {}) {
  const host = root && root.classList && root.classList.contains("vpu") ? root : root.querySelector(".vpu");
  if (!host) return () => {};
  const vid = host.querySelector("video");
  const timeEl = host.querySelector(".vpu-time");
  const seek = host.querySelector(".vpu-seek");
  const btnPlay = host.querySelector(".vpu-play");
  const btnBack = host.querySelector(".vpu-back");
  const btnFwd = host.querySelector(".vpu-fwd");
  const btnLoop = host.querySelector(".vpu-loop");
  const btnMenu = host.querySelector(".vpu-menu");
  const btnFull = host.querySelector(".vpu-full");
  const pop = host.querySelector(".vpu-pop");
  const speedWrap = host.querySelector(".vpu-speedwrap");
  const speedCustom = host.querySelector(".vpu-speedcustom");
  const volBtn = host.querySelector(".vpu-volbtn");
  const volRange = host.querySelector(".vpu-volrange");
  const volPct = host.querySelector(".vpu-volpct");
  const _vk = videoKey ? String(videoKey) : null;
  const _rid = App.sanitizeRoomCode(roomId || App.currentRoomId);
  const savePrefs = patch => {
    try {
      if (_vk && _rid) App.saveVideoPrefs(_rid, _vk, patch);
    } catch {}
  };
  let destroyed = false;
  let lastVol = 1;

  // WebAudio volume boost (lets us go past HTMLMediaElement's 1.0 limit)
  let audioCtx = null;
  let gainNode = null;
  let mediaSrcNode = null;

  // Track the user's intended volume (0..2). Don't rely on vid.volume for >1.
  let uiVol = 1;
  function ensureAudioBoost() {
    if (gainNode || mediaSrcNode) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      mediaSrcNode = audioCtx.createMediaElementSource(vid);
      gainNode = audioCtx.createGain();
      mediaSrcNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);
    } catch {
      // If this fails (rare), fall back to native volume only.
      audioCtx = null;
      gainNode = null;
      mediaSrcNode = null;
    }
  }
  function applyBoostedVolume(vRaw) {
    const v = App.clampNum(vRaw, 0, 2, 1);
    uiVol = v;

    // Always try to enable boost so 200% works when supported.
    ensureAudioBoost();
    if (gainNode) {
      try {
        gainNode.gain.value = v;
      } catch {}
      // Keep native volume pinned to 1 so gain controls the full range.
      try {
        vid.volume = 1;
      } catch {}
      // Resume context on interaction (best-effort; may remain suspended until a gesture)
      try {
        if (audioCtx && audioCtx.state === "suspended" && !vid.muted && v > 0) audioCtx.resume();
      } catch {}
      return;
    }

    // Fallback: native volume only (0..1)
    try {
      vid.volume = Math.min(1, v);
    } catch {}
  }
  function setPlayIcon() {
    btnPlay.innerHTML = vid.paused ? App.svgIcon("play") : App.svgIcon("pause");
  }
  function setLoopUI() {
    const on = !!vid.loop;
    btnLoop.setAttribute("aria-pressed", on ? "true" : "false");
    host.dataset.loop = on ? "1" : "0";
  }
  function setVolumeUI() {
    const v = App.clampNum(vid.muted ? 0 : uiVol, 0, 2, 1);
    volRange.value = String(v);
    volPct.textContent = `${Math.round(v * 100)}%`;
    volBtn.innerHTML = v === 0 ? App.svgIcon("mute") : App.svgIcon("vol");
  }
  function syncTimeUI() {
    const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
    const cur = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    timeEl.textContent = `${App.fmtTime(cur)} / ${App.fmtTime(dur)}`;
    seek.max = String(Math.max(0, dur || 0));
    seek.value = String(Math.min(dur || 0, Math.max(0, cur || 0)));
  }
  function closePop() {
    pop.hidden = true;
    host.dataset.menu = "0";
    try {
      btnMenu.setAttribute("aria-pressed", "false");
    } catch {}
  }
  function openPop() {
    pop.hidden = false;
    host.dataset.menu = "1";
    try {
      btnMenu.setAttribute("aria-pressed", "true");
    } catch {}
  }
  function highlightSpeed() {
    const r = Number(vid.playbackRate) || 1;
    const btns = speedWrap.querySelectorAll("button[data-rate]");
    btns.forEach(b => {
      const v = Number(b.dataset.rate);
      b.dataset.active = Math.abs(v - r) < 1e-9 ? "1" : "0";
    });
  }

  // hard-disable default browser/Google video context options
  vid.controls = false;
  vid.setAttribute("controlslist", "nodownload noplaybackrate noremoteplayback");
  vid.setAttribute("disablepictureinpicture", "");
  try {
    vid.disablePictureInPicture = true;
  } catch {}
  vid.addEventListener("contextmenu", e => e.preventDefault());
  vid.addEventListener("dragstart", e => e.preventDefault());
  vid.playsInline = true;

  // Eager-load to reduce “invisible video” cases (height=0 until metadata) and speed up start.
  try {
    vid.preload = "auto";
  } catch {}
  try {
    vid.setAttribute("preload", "auto");
  } catch {}
  try {
    vid.load();
  } catch {}

  // Apply saved settings BEFORE first UI paint (so toggles render correctly on refresh)
  try {
    const il = host.dataset.initialLoop;
    if (il != null) vid.loop = il === "1" || il === "true";
  } catch {}
  try {
    const im = host.dataset.initialMuted;
    if (im != null) vid.muted = im === "1" || im === "true";
  } catch {}
  try {
    const iv = Number(host.dataset.initialVolume);
    if (Number.isFinite(iv)) {
      const v = App.clampNum(iv, 0, 2, 1);
      applyBoostedVolume(v);
      if (v > 0) lastVol = v;
    }
  } catch {}
  try {
    const ir = Number(host.dataset.initialRate);
    if (Number.isFinite(ir) && ir > 0) {
      vid.playbackRate = ir;
    }
  } catch {}
  try {
    const cr = host.dataset.initialCustomRate;
    if (cr != null) {
      const v = String(cr);
      if (speedCustom) speedCustom.value = v;
    }
  } catch {}

  // Initial UI state (now reflects saved settings)
  closePop(); // ensures menu is visually OFF on load
  setPlayIcon();
  setLoopUI();
  setVolumeUI();
  syncTimeUI();
  highlightSpeed();
  const off = [];
  const on = (el, ev, fn, opts) => {
    el.addEventListener(ev, fn, opts);
    off.push(() => el.removeEventListener(ev, fn, opts));
  };
  const resumeBoostedAudio = () => {
    try {
      if (audioCtx?.state === "suspended") void audioCtx.resume();
    } catch {}
  };
  on(host, "pointerdown", resumeBoostedAudio, {
    passive: true
  });
  on(host, "keydown", resumeBoostedAudio);

  // Only recover once, and only for genuinely broken initial loads.
  let vpuReloaded = false;
  const canSafelyReloadSource = () => {
    const hasDuration = Number.isFinite(vid.duration) && vid.duration > 0;
    return !hasDuration && vid.readyState < HTMLMediaElement.HAVE_METADATA;
  };
  const forceReload = () => {
    if (vpuReloaded || !canSafelyReloadSource()) return;
    vpuReloaded = true;
    try {
      const src = vid.getAttribute("src") || vid.src || "";
      if (!src) return;
      try {
        vid.pause();
      } catch {}
      vid.src = src;
      try {
        vid.load();
      } catch {}
    } catch {}
  };
  let isScrubbing = false;
  let pendingSeekTime = null;
  const paintSeekUI = nextTime => {
    const dur = Number.isFinite(vid.duration) ? vid.duration : 0;
    const clamped = Math.max(0, Math.min(dur || Number.MAX_SAFE_INTEGER, Number(nextTime) || 0));
    if (!Number.isFinite(clamped)) return null;
    try {
      seek.value = String(clamped);
    } catch {}
    try {
      timeEl.textContent = `${App.fmtTime(clamped)} / ${App.fmtTime(dur)}`;
    } catch {}
    return clamped;
  };
  const seekVideoInstant = nextTime => {
    const clamped = paintSeekUI(nextTime);
    if (clamped == null) return;
    try {
      if (Math.abs((Number(vid.currentTime) || 0) - clamped) > 0.01) {
        if (typeof vid.fastSeek === "function") vid.fastSeek(clamped);else vid.currentTime = clamped;
      }
    } catch {
      try {
        vid.currentTime = clamped;
      } catch {}
    }
    if (!isScrubbing) requestAnimationFrame(syncTimeUI);
  };
  const commitPendingSeek = () => {
    if (pendingSeekTime == null) return;
    const t = pendingSeekTime;
    pendingSeekTime = null;
    seekVideoInstant(t);
  };
  on(vid, "error", forceReload);
  on(vid, "stalled", () => {
    if (canSafelyReloadSource()) forceReload();
  });
  on(btnPlay, "click", () => {
    if (vid.paused) vid.play().catch(() => {});else vid.pause();
  });
  on(vid, "click", e => {
    e.preventDefault();
    e.stopPropagation();
    if (vid.paused) vid.play().catch(() => {});else vid.pause();
  });
  on(btnBack, "click", () => {
    const step = Number(host.dataset.stepBack) || 5;
    isScrubbing = false;
    pendingSeekTime = null;
    seekVideoInstant((vid.currentTime || 0) - step);
  });
  on(btnFwd, "click", () => {
    const step = Number(host.dataset.stepFwd) || 5;
    isScrubbing = false;
    pendingSeekTime = null;
    seekVideoInstant((vid.currentTime || 0) + step);
  });
  on(btnLoop, "click", () => {
    vid.loop = !vid.loop;
    setLoopUI();
  });
  on(seek, "pointerdown", () => {
    isScrubbing = true;
    pendingSeekTime = Number(seek.value);
  });
  on(seek, "input", () => {
    const t = Number(seek.value);
    if (!Number.isFinite(t)) return;
    pendingSeekTime = t;
    paintSeekUI(t);
    if (!isScrubbing) commitPendingSeek();
  });
  on(seek, "change", () => {
    isScrubbing = false;
    commitPendingSeek();
  });
  on(seek, "pointerup", () => {
    isScrubbing = false;
    commitPendingSeek();
  });
  on(seek, "pointercancel", () => {
    isScrubbing = false;
    commitPendingSeek();
  });
  on(vid, "timeupdate", App.rafThrottle(() => {
    if (!isScrubbing) syncTimeUI();
  }));
  on(vid, "seeking", () => {
    if (!isScrubbing) syncTimeUI();
  });
  on(vid, "seeked", () => {
    if (!isScrubbing) syncTimeUI();
  });
  on(vid, "durationchange", syncTimeUI);
  on(vid, "loadedmetadata", () => {
    syncTimeUI();
    // Re-assert desired playback rate after metadata loads (some browsers reset it)
    const want = Number(host.dataset.initialRate);
    if (Number.isFinite(want) && want > 0) {
      try {
        vid.playbackRate = want;
      } catch {}
      requestAnimationFrame(() => {
        try {
          vid.playbackRate = want;
        } catch {}
      });
      highlightSpeed();
    }
  });
  on(vid, "play", setPlayIcon);
  on(vid, "pause", setPlayIcon);
  on(vid, "volumechange", App.rafThrottle(setVolumeUI));
  on(vid, "ratechange", highlightSpeed);
  on(volRange, "input", () => {
    const v = App.clampNum(volRange.value, 0, 2, 1);
    vid.muted = false;
    applyBoostedVolume(v);
    if (v > 0) lastVol = v;
    savePrefs({
      volume: v,
      muted: false
    });
    setVolumeUI(); // WebAudio gain changes don't always trigger `volumechange`
  });
  on(volBtn, "click", () => {
    if (vid.muted || uiVol <= 0) {
      const restored = Math.max(0.05, lastVol || 1);
      vid.muted = false;
      applyBoostedVolume(restored);
      savePrefs({
        muted: false,
        volume: restored
      });
    } else {
      if (uiVol > 0) lastVol = uiVol;
      vid.muted = true;
      savePrefs({
        muted: true,
        volume: uiVol
      });
    }
    setVolumeUI();
  });
  on(btnMenu, "click", e => {
    e.stopPropagation();
    if (!pop.hidden) closePop();else openPop();
  });
  on(document, "click", e => {
    if (pop.hidden) return;
    if (!host.contains(e.target)) closePop();
  });
  on(btnFull, "click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // Keep the custom transport and zoom controls available in fullscreen.
        await host.requestFullscreen?.();
      }
    } catch {}
  });

  // Speed controls (preset buttons + custom input)
  function applyRate(r, {
    custom = false
  } = {}) {
    const max = Number(host.dataset.maxCustomSpeed) || 10;
    const want = App.clampNum(r, 0.05, max, 1);

    // Save desired rate on the host so loadedmetadata can re-assert it.
    host.dataset.initialRate = String(want);
    try {
      vid.playbackRate = want;
    } catch {}
    // Re-assert next frame (fixes occasional “doesn’t stick”)
    requestAnimationFrame(() => {
      try {
        vid.playbackRate = want;
      } catch {}
    });
    highlightSpeed();
    if (!custom) {
      try {
        speedCustom.value = "";
      } catch {}
      savePrefs({
        playbackRate: want,
        customRate: null
      });
    } else {
      savePrefs({
        playbackRate: want,
        customRate: want
      });
    }
  }
  on(speedWrap, "click", e => {
    const b = e.target.closest("button[data-rate]");
    if (!b) return;
    const r = Number(b.dataset.rate);
    if (!Number.isFinite(r)) return;
    applyRate(r, {
      custom: false
    });
  });
  on(speedCustom, "change", () => {
    applyRate(speedCustom.value, {
      custom: true
    });
  });

  // Optional: show file name in the menu header.
  if (fileName) {
    const title = host.querySelector(".vpu-pop-title");
    if (title) title.textContent = String(fileName);
  }

  // Return teardown
  return () => {
    if (destroyed) return;
    destroyed = true;
    try {
      closePop();
    } catch {}
    try {
      vid.pause();
    } catch {}
    off.reverse().forEach(fn => {
      try {
        fn();
      } catch {}
    });

    // Cleanup WebAudio boost (if created)
    try {
      vid.removeAttribute("src");
    } catch {}
    try {
      vid.load?.();
    } catch {}
    try {
      if (mediaSrcNode) mediaSrcNode.disconnect();
    } catch {}
    try {
      if (gainNode) gainNode.disconnect();
    } catch {}
    try {
      if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
    } catch {}
    mediaSrcNode = null;
    gainNode = null;
    audioCtx = null;
  };
};

App.register("media/video-player", function initializeFeature() {
App.VIDEO_UI_DEFAULTS = {
  stepBackSec: 5,
  stepFwdSec: 5,
  speeds: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  maxCustomSpeed: 10,
  mediaZoom: {
    step: 0.5,
    wheelStep: 0.5,
    maxScale: 20,
    doubleTapScale: 2.5
  }
};
App.videoUiConfigCache = null;
App.videoUiConfigPromise = null;
App.videoPrefsPendingByKey = new Map();
App.videoPrefsTimerByKey = new Map();
App.videoPlayerTeardowns = new Map();
});
})(globalThis.ChatApp);
