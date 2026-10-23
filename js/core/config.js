/* core/config: methods register before ordered initialization. */
(function (App) {
  "use strict";

App.FILE_UPLOAD_LIMIT_DEFAULT_MB = 100;
App.FILE_UPLOAD_LIMIT_PATH = "admin/fileUploadLimitMB";
App.parseFileUploadLimitMB = function (value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim();
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const megabytes = Number(text);
  const bytes = Math.floor(megabytes * 1024 * 1024);
  return Number.isFinite(megabytes) && megabytes > 0 && Number.isSafeInteger(bytes) && bytes >= 1 ? megabytes : null;
};
App.normalizeFileUploadLimitMB = function (value) {
  return App.parseFileUploadLimitMB(value) ?? App.FILE_UPLOAD_LIMIT_DEFAULT_MB;
};
App.applyFileUploadLimitMB = function (value) {
  const megabytes = App.normalizeFileUploadLimitMB(value);
  App.fileUploadLimitMB = megabytes;
  App.CHAT_FILE_MAX_BYTES = Math.floor(megabytes * 1024 * 1024);
  App.CHAT_FILE_MAX_LABEL = `${megabytes} MB`;
  App.syncFileUploadLimitInput?.();
  return megabytes;
};
App.applyFileUploadLimitMB(App.FILE_UPLOAD_LIMIT_DEFAULT_MB);
App.startFileUploadLimitListener = function () {
  if (App.fileUploadLimitListener || !App.db) return;
  App.fileUploadLimitLoaded = false;
  App.fileUploadLimitError = "";
  let resolveReady, rejectReady;
  App.fileUploadLimitReady = new Promise((resolve, reject) => {
    resolveReady = resolve; rejectReady = reject;
  });
  // The listener starts before anyone uploads. Retain the failure for callers
  // without producing an unhandled rejection while the app is idle.
  App.fileUploadLimitReady.catch(() => {});
  const listener = { ref: null, cb: null };
  App.fileUploadLimitListener = listener;
  listener.cb = snapshot => {
    if (App.fileUploadLimitListener !== listener) return;
    App.fileUploadLimitLoaded = true;
    App.fileUploadLimitError = "";
    resolveReady(App.applyFileUploadLimitMB(snapshot.val()));
  };
  const cancelled = error => {
    if (App.fileUploadLimitListener !== listener) return;
    // Firebase cancels a denied subscription. A panel reopen or the next
    // upload can subscribe again after permissions/connectivity recover.
    App.fileUploadLimitListener = null;
    App.fileUploadLimitLoaded = false;
    App.fileUploadLimitError = error?.message || "Could not load the File Upload Limit.";
    rejectReady(new Error(App.fileUploadLimitError));
    App.syncFileUploadLimitInput?.();
  };
  App.syncFileUploadLimitInput?.();
  try {
    listener.ref = App.db.ref(App.FILE_UPLOAD_LIMIT_PATH);
    listener.ref.on("value", listener.cb, cancelled);
  } catch (error) { cancelled(error); }
};
App.ensureFileUploadLimitLoaded = async function () {
  App.startFileUploadLimitListener();
  if (App.fileUploadLimitError) throw new Error(App.fileUploadLimitError);
  if (App.fileUploadLimitLoaded) return App.fileUploadLimitMB;
  if (!App.fileUploadLimitReady) throw new Error("The File Upload Limit is still loading. Please try again.");
  return App.fileUploadLimitReady;
};
App.setFileUploadLimitMB = async function (value) {
  if (!App.isVinny?.()) throw new Error("Only Vinny can change the File Upload Limit.");
  if (!App.fileUploadLimitLoaded || App.fileUploadLimitError) throw new Error(App.fileUploadLimitError || "The File Upload Limit is still loading. Please try again.");
  const megabytes = App.parseFileUploadLimitMB(value);
  if (megabytes === null) throw new Error("Enter a positive file size in MB.");
  await App.db.ref(App.FILE_UPLOAD_LIMIT_PATH).set(megabytes);
};

// Native releases and GitHub web revisions are independent. Bump this only
// when publishing a new EXE; the Admin Panel saves it alongside the URL.
App.NATIVE_RELEASE_VERSION = "1.7.4";
App.NATIVE_UPDATE_PATH = "admin/desktopUpdate";
App.NATIVE_UPDATE_CACHE = "chatapp_native_update_policy_v2";
App.isNativeDesktop = function () {
  return globalThis.location?.protocol === "chatapp:" || !!globalThis.chatDesktopPreferences || !!globalThis.chatDesktopGames;
};
App.compareNativeVersions = function (left, right) {
  const parts = value => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(String(value || "")) ? String(value).split(".").map(Number) : [0, 0, 0];
  const a = parts(left), b = parts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
};
App.getInstalledNativeVersion = function () {
  const value = App.nativeBuildInfo?.nativeVersion || globalThis.chatDesktopBuild?.nativeVersion;
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(String(value || "")) && value !== "0.0.0" ? String(value) : null;
};
App.normalizeNativeUpdateURL = function (value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 4096) throw new Error("The Update URL is too long.");
  let url;
  try { url = new URL(text); } catch { throw new Error("Enter a valid HTTPS download URL."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("Enter a valid HTTPS download URL without a username or password.");
  return text;
};
App.normalizeNativeUpdatePolicy = function (value) {
  if (!value || typeof value !== "object") return null;
  try {
    const url = App.normalizeNativeUpdateURL(value.url);
    if (!url || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(String(value.minimumVersion || ""))) return null;
    return { url, minimumVersion: String(value.minimumVersion) };
  } catch { return null; }
};
App.needsNativeUpdate = function (policy = App.nativeUpdatePolicy) {
  const clean = App.normalizeNativeUpdatePolicy(policy);
  const installed = App.getInstalledNativeVersion();
  // An absent/late bridge is unknown, not version zero. Only native binary
  // identity can require replacing an EXE; web/GitHub revisions never can.
  if (!App.isNativeDesktop() || !clean) return false;
  if (installed) return App.compareNativeVersions(installed, clean.minimumVersion) < 0;
  // Verified 1.6.x preloads expose Preferences v1 without Build. From 1.7.0
  // onward Build is exposed synchronously BEFORE Preferences. This exact
  // legacy signature establishes an upper bound, not an invented version.
  const knownLegacy = !Object.prototype.hasOwnProperty.call(globalThis, 'chatDesktopBuild') && globalThis.chatDesktopPreferences?.version === 1;
  return knownLegacy && App.compareNativeVersions(clean.minimumVersion, '1.7.0') >= 0;
};
App.renderNativeUpdateGate = function () {
  const required = App.needsNativeUpdate();
  App.nativeUpdateRequired = required;
  document.documentElement.toggleAttribute("data-native-update-required", required);
  let gate = document.getElementById("native-update-gate");
  if (!required) {
    if (gate?.open) gate.close();
    return;
  }
  if (!gate) {
    gate = document.createElement("dialog");
    gate.id = "native-update-gate";
    gate.setAttribute("aria-labelledby", "native-update-title");
    gate.setAttribute("aria-describedby", "native-update-description");
    gate.setAttribute("closedby", "none");
    const content = document.createElement("section");
    const title = document.createElement("h1");
    title.id = "native-update-title"; title.textContent = "Update required";
    const description = document.createElement("p");
    description.id = "native-update-description"; description.textContent = "Download the latest Chat App to continue.";
    const link = document.createElement("a");
    link.id = "native-update-download"; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.style.textDecoration = "none";
    link.addEventListener("click", async event => {
      const open = globalThis.chatDesktopBuild?.openUpdateAndQuit;
      if (!open) {
        // Older binaries have no exit bridge. Let their existing external-link
        // handler open the browser, and make their next Close actually quit.
        globalThis.chatDesktopPreferences?.setBackgroundRunning?.(false);
        if (App.accidentalCloseBeforeUnload) window.removeEventListener('beforeunload', App.accidentalCloseBeforeUnload);
        window.onbeforeunload = null;
        description.textContent = 'Your browser is opening the download. Close Chat App before opening the new EXE.';
        return;
      }
      event.preventDefault();
      if (link.dataset.opening === "1") return;
      link.dataset.opening = "1";
      try {
        if (!await open(App.nativeUpdatePolicy.url)) throw new Error("The download could not be opened. Try again.");
      } catch (error) {
        description.textContent = error?.message || "The download could not be opened. Try again.";
      } finally { delete link.dataset.opening; }
    });
    content.append(title, description, link); gate.append(content); document.body.append(gate);
    gate.addEventListener("cancel", event => event.preventDefault());
    gate.addEventListener("close", () => { if (App.nativeUpdateRequired && !gate.open) gate.showModal(); });
  }
  const link = gate.querySelector("a");
  link.href = App.nativeUpdatePolicy.url; link.textContent = App.nativeUpdatePolicy.url;
  // A modal dialog is in the browser's top layer, above the cloak's maximum
  // z-index. Exiting element fullscreen also keeps it above games and videos.
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  if (!gate.open) gate.showModal();
};
App.startNativeUpdateListener = function () {
  if (App.nativeUpdateListener || !App.db) return;
  if (App.isNativeDesktop()) {
    // Retain offline metadata, but never lock the app using an obsolete cached
    // policy before Firebase has supplied the current requirement.
    if (globalThis.chatDesktopBuild?.getInfo) void globalThis.chatDesktopBuild.getInfo().then(info => {
      App.nativeBuildInfo = info;
      if (App.nativeUpdatePolicyLoaded) App.renderNativeUpdateGate();
    }).catch(() => {});
  }
  if (!App.nativeUpdateKeysBound) {
    App.nativeUpdateKeysBound = true;
    // Capture before document hotkeys (including cloak and modal shortcuts).
    for (const name of ["keydown", "keyup", "keypress"]) window.addEventListener(name, event => {
      if (!App.nativeUpdateRequired) return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") event.preventDefault();
    }, true);
    document.addEventListener("fullscreenchange", () => {
      if (App.nativeUpdateRequired && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    });
  }
  const ref = App.db.ref(App.NATIVE_UPDATE_PATH);
  const cb = snapshot => {
    App.nativeUpdatePolicy = App.normalizeNativeUpdatePolicy(snapshot.val());
    App.nativeUpdatePolicyLoaded = true; App.nativeUpdatePolicyError = "";
    if (App.isNativeDesktop()) {
      try {
        if (App.nativeUpdatePolicy) localStorage.setItem(App.NATIVE_UPDATE_CACHE, JSON.stringify({ nativeVersion: App.getInstalledNativeVersion(), policy: App.nativeUpdatePolicy }));
        else localStorage.removeItem(App.NATIVE_UPDATE_CACHE);
      } catch {}
      App.renderNativeUpdateGate();
    }
    const input = document.getElementById("panel-update-url");
    if (input && input.dataset.dirty !== "1") input.value = App.nativeUpdatePolicy?.url || "";
  };
  App.nativeUpdateListener = { ref, cb };
  ref.on("value", cb, error => {
    App.nativeUpdatePolicyError = error?.message || "Could not load the Update URL.";
    const status = document.getElementById("panel-update-status");
    if (status) status.textContent = App.nativeUpdatePolicyError;
  });
};
App.setNativeUpdateURL = async function (value) {
  if (!App.isVinny?.()) throw new Error("Only Vinny can change the Update URL.");
  if (!App.nativeUpdatePolicyLoaded) throw new Error("The Update URL is still loading. Please try again.");
  const url = App.normalizeNativeUpdateURL(value);
  // The download URL targets a native release, independent of web revisions.
  // Re-saving the same URL must not retroactively require a newly published
  // binary that is not yet available at that URL.
  await App.db.ref(App.NATIVE_UPDATE_PATH).transaction(current => {
    if (!App.isVinny?.()) return;
    if (!url) return null;
    const previous = App.normalizeNativeUpdatePolicy(current);
    const minimumVersion = previous?.url === url ? previous.minimumVersion : App.NATIVE_RELEASE_VERSION;
    return { url, minimumVersion };
  }, undefined, false).then(result => {
    if (!result.committed) throw new Error("The Update URL could not be saved.");
  });
};

// Binary objects live outside RTDB. Only committed descriptors enter messages
// and HTML Hub. Legacy RTDB readers remain available in their feature modules.
App.assertExternalStorageConfigured = function () {
  const value = String(globalThis.CHAT_FILE_CONFIG?.endpoint || '').trim();
  let url;
  try { url = new URL(value); } catch {}
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('File storage needs setup: set CHAT_FILE_CONFIG.endpoint in call-config.js using the README instructions.');
  }
  return url.origin;
};
App.isExternalBlobDescriptor = function (record) {
  return !!record && record.provider === 'b2-worker-v1' &&
    /^(attachments|html)\/[A-Za-z0-9_/-]+$/.test(String(record.objectKey || '')) &&
    !String(record.objectKey).includes('//') && String(record.objectKey).length <= 400 &&
    Number.isSafeInteger(record.size) && record.size >= 0;
};
App.getExternalBlobURL = function (record) {
  if (!App.isExternalBlobDescriptor(record)) throw new Error('Invalid stored file reference.');
  return `${App.assertExternalStorageConfigured()}/objects/${record.objectKey}`;
};
App.externalFileRequest = async function (route, body, signal) {
  const response = await fetch(`${App.assertExternalStorageConfigured()}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal, credentials: 'omit', cache: 'no-store'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `File storage returned ${response.status}. Check its free-plan quota and setup.`), { status: response.status });
  return result;
};
App.retryDesktopFileTransfer = async function (operation, signal) {
  const desktop = globalThis.chatDesktopRings?.version === 1 || globalThis.chatDesktopOverlay?.version === 1;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' });
    try { return await operation(); }
    catch (error) {
      const transient = error?.name === 'TypeError' || error?.transient === true ||
        [408, 429, 500, 502, 503, 504].includes(Number(error?.status));
      if (!desktop || !transient || error?.name === 'AbortError' || signal?.aborted || attempt >= 2) throw error;
      // Retry the same signed object; a lost response must not publish a second file.
      await new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 400 * (attempt + 1));
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
};
App.deleteExternalBlob = async function (record) {
  if (!App.isExternalBlobDescriptor(record)) return;
  await App.deleteExternalBlobPrefix(record.objectKey, { exact: true });
};
App.deleteExternalBlobPrefix = async function (prefix, options = {}) {
  let cursor = null;
  // Each Worker request stays below the Free plan's subrequest ceiling. The
  // continuation is provider state, never a scan of RTDB message history.
  do {
    const result = await App.externalFileRequest('/delete', {
      prefix, exact: options.exact === true, keepPrefixes: options.keepPrefixes || [], cursor
    });
    cursor = result.cursor || null;
  } while (cursor);
};
App.uploadExternalBlob = async function (blob, options = {}) {
  App.assertExternalStorageConfigured();
  await App.ensureFileUploadLimitLoaded();
  if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > App.CHAT_FILE_MAX_BYTES) {
    throw new Error(`Each attachment must be ${App.CHAT_FILE_MAX_LABEL} or smaller.`);
  }
  if (!/^(attachments|html)\/[A-Za-z0-9_/-]+$/.test(String(options.path || '')) || String(options.path).includes('//')) {
    throw new Error('Invalid upload location.');
  }
  const signal = options.signal;
  const abortError = () => Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' });
  if (signal?.aborted) throw abortError();
  const plan = await App.retryDesktopFileTransfer(() => App.externalFileRequest('/sign', {
    path: options.path, size: blob.size, mimeType: blob.type || 'application/octet-stream'
  }, signal), signal);
  const descriptor = { provider: 'b2-worker-v1', objectKey: plan.objectKey,
    size: blob.size, mimeType: blob.type || 'application/octet-stream' };
  if (!App.isExternalBlobDescriptor(descriptor)) throw new Error('File storage returned an invalid upload location.');
  let uploadURL;
  try { uploadURL = new URL(plan.uploadURL); } catch {}
  if (!uploadURL || uploadURL.protocol !== 'https:' || !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(uploadURL.hostname) || uploadURL.username || uploadURL.password) {
    throw new Error('File storage returned an invalid upload server.');
  }
  descriptor.downloadURL = App.getExternalBlobURL(descriptor);
  try {
    if (signal?.aborted) throw abortError();
    await App.retryDesktopFileTransfer(() => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const clean = () => signal?.removeEventListener('abort', abort);
      const abort = () => { xhr.abort(); clean(); reject(abortError()); };
      xhr.open('PUT', uploadURL.href, true);
      xhr.timeout = 10 * 60 * 1000; // Weak mobile links can complete; no artificial pacing.
      xhr.setRequestHeader('Content-Type', /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(plan.contentType || '') ? plan.contentType : 'application/octet-stream');
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) options.onProgress?.(Math.min(1, event.loaded / Math.max(1, event.total)));
      };
      xhr.onload = () => {
        clean();
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(Object.assign(new Error(`Upload failed (${xhr.status}). Check file-storage quota and CORS settings.`), { status: xhr.status }));
      };
      xhr.onerror = () => { clean(); reject(Object.assign(new Error('Upload connection failed. Check your connection and file-storage CORS settings.'), { transient: true })); };
      xhr.ontimeout = () => { clean(); reject(Object.assign(new Error('Upload timed out. Please retry on a stronger connection.'), { transient: true })); };
      xhr.onabort = () => { clean(); reject(abortError()); };
      signal?.addEventListener('abort', abort, { once: true });
      xhr.send(blob); // Browser streams the original File/Blob, including on mobile.
    }), signal);
    if (signal?.aborted) throw abortError();
    // Verify the persisted object before publishing its descriptor to readers.
    await App.retryDesktopFileTransfer(() => App.externalFileRequest('/complete', { objectKey: descriptor.objectKey, size: blob.size }, signal), signal);
    options.onProgress?.(1);
    return descriptor;
  } catch (error) {
    // A cancelled network request may have already reached object storage.
    // Cleanup is independent of its aborted signal and remains best effort.
    try { await App.deleteExternalBlob(descriptor); } catch {}
    throw error;
  }
};

App.register("core/config", function initializeFeature() {
App.DATABASE_SCHEMA_VERSION = 6;
App.firebaseConfig = Object.freeze({
  apiKey: "AIzaSyDDoTlac99Bhlki-aPJtzcSpQeb8KLbguQ",
  authDomain: "chatappv6-e9da9.firebaseapp.com",
  databaseURL: "https://chatappv6-e9da9-default-rtdb.firebaseio.com",
  projectId: "chatappv6-e9da9",
  storageBucket: "chatappv6-e9da9.firebasestorage.app",
  messagingSenderId: "355141406495",
  appId: "1:355141406495:web:78d50a2fca39eae1fb6a2a",
  measurementId: "G-BHWJP24Q2B"
});
App.firebase = globalThis.firebase || null;
if (!App.firebase?.initializeApp || !App.firebase?.database) {
  throw new Error("Firebase failed to load before app.js. Make sure firebase-app-compat.js and firebase-database-compat.js are loaded first.");
}
if (!App.firebase.apps.length) {
  App.firebase.initializeApp(App.firebaseConfig);
}
App.db = App.firebase.database();
App.startFileUploadLimitListener();
App.startNativeUpdateListener();
});
})(globalThis.ChatApp);
