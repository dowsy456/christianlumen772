/* Shared notification mixer. Every message has its own voice; loops are independent. */
(function (App) {
  "use strict";
  const files = { message: "Message", ping: "Ping", ringing: "Ringing", called: "Called", joincall: "JoinCall", leavecall: "LeaveCall", startscreen: "StartScreen", endscreen: "EndScreen", startwatching: "StartWatching", stopwatching: "StopWatching" };
  App.soundEffectCatalog = Object.freeze({ message: "New Message", ping: "Mention", ringing: "Outgoing Ring", called: "Incoming Ring", joincall: "Join Call", leavecall: "Leave Call", startscreen: "Start Screen Share", endscreen: "Stop Screen Share", startwatching: "Start Watching Screen", stopwatching: "Stop Watching Screen" });
  App.SOUND_EFFECT_MAX_BYTES = 2 * 1024 * 1024;
  App.waitForCustomSoundSaves = async function () {
    while (App.customSoundSaves?.size) await Promise.all(Array.from(App.customSoundSaves));
  };
  App.normalizeCustomSoundEffects = function (raw) {
    const result = {};
    for (const key of Object.keys(files)) {
      const record = raw?.[key];
      const dataURL = record?.dataURL;
      if (typeof dataURL !== "string" || dataURL.length > Math.ceil(App.SOUND_EFFECT_MAX_BYTES / 3) * 4 + 100 || !/^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(dataURL)) continue;
      result[key] = { name: String(record.name || "Custom Audio").slice(0, 160), dataURL };
    }
    return result;
  };
  App.readCustomSoundEffect = async function (file) {
    const extensions = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", weba: "audio/webm", aif: "audio/aiff", aiff: "audio/aiff" };
    const mime = String(file?.type || extensions[String(file?.name || "").split(".").pop().toLowerCase()] || "");
    if (!file?.size || !/^audio\//i.test(mime)) throw new Error("Choose an audio file.");
    if (file.size > App.SOUND_EFFECT_MAX_BYTES) throw new Error("Choose an audio file smaller than 2 MB.");
    const blob = new Blob([file], { type: mime });
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("This audio file could not be read. Try another format.")), 8000);
        const finish = callback => { clearTimeout(timer); callback(); };
        audio.onloadedmetadata = () => finish(() => resolve());
        audio.onerror = () => finish(() => reject(new Error("This audio file cannot be played on this device.")));
        audio.preload = "metadata";
        audio.src = url;
      });
      const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("This audio file could not be read."));
        reader.readAsDataURL(blob);
      });
      return { name: String(file.name || "Custom Audio").slice(0, 160), dataURL };
    } finally {
      audio.onloadedmetadata = audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    }
  };
  App.normalizeSoundEffects = function (raw) {
    return Object.fromEntries(Object.keys(files).map(key => [key, raw?.[key] !== false]));
  };
  App.isSoundEffectEnabled = function (name) {
    const key = String(name || "").toLowerCase();
    return !!files[key] && App.currentSettings?.soundEffectsEnabled !== false && App.currentSettings?.soundEffects?.[key] !== false;
  };
  const voices = new Set();
  const loops = new Map();
  const buffers = new Map();
  const watchSoundTimes = new Map();
  let audioGeneration = 0;
  let callCueGeneration = 0;
  let context = null, bus = null;
  const policyAllows = name => {
    if (["message", "ping", "called"].includes(name) && App.desktopNotificationPolicyReady?.() === false) return false;
    return !App.isDoNotDisturb?.() || !["message", "ping", ...(App.statusSelectionAvailable?.() ? ["called"] : [])].includes(name);
  };
  function retryLoops() {
    if (context && context.state !== "running") return;
    for (const [name, ticket] of loops) if (App.isSoundEffectEnabled(name) && policyAllows(name) && !ticket.voice && !ticket.loading) startLoop(name, ticket);
  }
  function startLoop(name, ticket) {
    ticket.loading = true;
    void play(name, ticket).catch(() => {}).finally(() => {
      ticket.loading = false;
      if (ticket.retryOnReady && context?.state === "running") {
        ticket.retryOnReady = false;
        retryLoops();
      }
    });
  }
  function mixer() {
    if (context?.state === "closed") { context = null; bus = null; buffers.clear(); }
    if (context) return context;
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
    context.addEventListener?.("statechange", () => {
      for (const ticket of loops.values()) if (ticket.loading) ticket.retryOnReady = true;
      retryLoops();
    });
    bus = context.createGain();
    bus.gain.value = 0.8;
    // A shared soft limiter protects against simultaneous alerts without
    // interrupting either sound or affecting microphone/call audio.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    bus.connect(compressor).connect(context.destination);
    return context;
  }
  function balance() {
    const count = Math.max(1, voices.size);
    const level = 1 / Math.sqrt(count);
    for (const voice of voices) {
      if (voice.gain && !voice.stopping) voice.gain.gain.setTargetAtTime(level, context.currentTime, 0.015);
      // HTMLAudio has no shared compressor. Its total possible peak stays
      // bounded, including voices currently fading out.
      else if (voice.audio) voice.audio.volume = 0.7 / count * (voice.fade ?? 1);
    }
  }
  function release(voice) {
    voices.delete(voice);
    const ticket = loops.get(voice.name);
    if (ticket?.voice === voice) ticket.voice = null;
    try { voice.source?.disconnect(); voice.gain?.disconnect(); } catch {}
    balance();
    retryLoops();
  }
  function stop(voice, immediate = false) {
    if (!voice || voice.stopping) return;
    voice.stopping = true;
    if (immediate) {
      if (voice.source) { try { voice.gain.gain.cancelScheduledValues(context.currentTime); voice.gain.gain.value = 0; voice.source.stop(); } catch {} }
      else voice.audio?.pause();
      release(voice);
      return;
    }
    if (voice.source) {
      voice.gain.gain.cancelScheduledValues(context.currentTime);
      voice.gain.gain.setTargetAtTime(0, context.currentTime, 0.04);
      try { voice.source.stop(context.currentTime + 0.18); } catch { release(voice); }
    } else {
      const startedAt = Date.now();
      const fade = setInterval(() => {
        voice.fade = Math.max(0, 1 - (Date.now() - startedAt) / 180);
        balance();
        if (Date.now() - startedAt >= 180) { clearInterval(fade); voice.audio.pause(); release(voice); }
      }, 20);
    }
  }
  function soundURL(name) {
    return App.currentSettings?.customSoundEffects?.[name]?.dataURL || new URL(`assets/sounds/${files[name]}.mp3`, document.baseURI).href;
  }
  function decodedBuffer(name, url, ctx) {
    const existing = buffers.get(name);
    if (existing?.url === url) return existing.promise;
    const entry = { url, promise: null };
    entry.promise = fetch(url).then(response => {
      if (!response.ok) throw new Error("Notification audio unavailable");
      return response.arrayBuffer();
    }).then(bytes => ctx.decodeAudioData(bytes)).catch(error => {
      if (buffers.get(name) === entry) buffers.delete(name);
      throw error;
    });
    buffers.set(name, entry);
    return entry.promise;
  }
  function bounded(promise, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ms);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
    });
  }
  function prewarm() {
    if (new URL(document.baseURI).protocol === "file:") return;
    let ctx;
    try { ctx = mixer(); } catch { return; }
    if (!ctx) return;
    for (const name of Object.keys(files)) if (App.isSoundEffectEnabled(name)) void decodedBuffer(name, soundURL(name), ctx).catch(() => {});
  }
  async function play(name, ticket = null) {
    if (!App.isSoundEffectEnabled(name) || !policyAllows(name)) return;
    const callCue = name === "joincall" || name === "leavecall";
    const generation = callCue ? callCueGeneration : audioGeneration;
    const assetURL = new URL(soundURL(name));
    let ctx = null, buffer = null;
    try {
      // Browsers can play local media but block fetch(file://) with a CORS
      // console error. Static ZIP previews use the media element directly.
      ctx = assetURL.protocol === "file:" ? null : mixer();
      if (ctx) {
        if (ctx.state !== "running") {
          // resume() can remain pending until the next gesture. Never keep a
          // loop marked loading forever or queue a burst of old one-shots.
          await bounded(ctx.resume(), 350);
        }
        // A blocked Web Audio context must not discard a sound when HTMLAudio
        // is permitted. The bounded decode also covers slow first downloads.
        if (ctx.state === "running") buffer = await bounded(decodedBuffer(name, assetURL.href, ctx), 1200);
      }
    } catch {}
    if (generation !== (callCue ? callCueGeneration : audioGeneration) || !App.isSoundEffectEnabled(name) || assetURL.href !== soundURL(name) || (ticket && loops.get(name) !== ticket)) return;
    if (!policyAllows(name)) return;
    const voice = { name, url: assetURL.href, source: null, gain: null, audio: null, stopping: false };
    if (buffer && ctx?.state === "running") {
      voice.source = ctx.createBufferSource();
      voice.source.buffer = buffer;
      voice.source.loop = !!ticket;
      voice.gain = ctx.createGain();
      voice.source.connect(voice.gain).connect(bus);
      voice.source.onended = () => release(voice);
      voices.add(voice);
      balance();
      voice.source.start();
    } else if (typeof Audio === "function") {
      // Also supports static file previews and browsers without Web Audio.
      voice.audio = new Audio(assetURL.href);
      voice.audio.loop = !!ticket;
      voice.audio.addEventListener("ended", () => release(voice), { once: true });
      voice.audio.addEventListener("error", () => release(voice), { once: true });
      voices.add(voice);
      balance();
      try { await voice.audio.play(); } catch { release(voice); }
    } else return;
    if (ticket) {
      if (loops.get(name) !== ticket) stop(voice);
      else if (voices.has(voice)) ticket.voice = voice;
    }
  }
  App.playNotificationSound = function (name) {
    const key = String(name || "").toLowerCase();
    if (!App.isSoundEffectEnabled(key) || !policyAllows(key)) return;
    if (key === "startwatching" || key === "stopwatching") {
      const now = Date.now();
      const recent = (watchSoundTimes.get(key) || []).filter(time => now - time < 6000);
      if (recent.length >= 2) return;
      recent.push(now);
      watchSoundTimes.set(key, recent);
    }
    void play(key).catch(() => {});
  };
  App.setNotificationLoop = function (name, enabled) {
    const key = String(name || "").toLowerCase();
    if (key !== "ringing" && key !== "called") return;
    const previous = loops.get(key);
    if (!enabled) { loops.delete(key); stop(previous?.voice, !policyAllows(key)); return; }
    if (previous) return;
    const ticket = {};
    loops.set(key, ticket);
    startLoop(key, ticket);
  };
  App.stopNotificationAudio = function ({ preserveCallCues = false } = {}) {
    audioGeneration++;
    if (!preserveCallCues) callCueGeneration++;
    watchSoundTimes.clear();
    loops.clear();
    for (const voice of voices) {
      if (preserveCallCues && (voice.name === "joincall" || voice.name === "leavecall")) continue;
      stop(voice);
    }
  };
  App.syncSoundEffectPreferences = function () {
    App.syncDesktopNotificationPolicy?.();
    for (const voice of voices) if (!App.isSoundEffectEnabled(voice.name) || voice.url !== soundURL(voice.name)) stop(voice);
    prewarm();
    retryLoops();
  };
  App.register("chat/notification-audio", function () {
    const unlock = () => {
      try {
        const ctx = new URL(document.baseURI).protocol === "file:" ? null : mixer();
        if (ctx && ctx.state !== "running") void ctx.resume().then(retryLoops).catch(() => {});
        else retryLoops();
        prewarm();
      } catch {}
    };
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock, { passive: true });
    window.addEventListener("pageshow", unlock);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) unlock(); });
    window.addEventListener("pagehide", App.stopNotificationAudio);
    window.addEventListener("app:status-changed", () => {
      for (const voice of voices) if (!policyAllows(voice.name)) stop(voice, true);
      retryLoops();
    });
  });
})(globalThis.ChatApp);
