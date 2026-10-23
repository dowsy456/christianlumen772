/* ui/toasts: methods register before ordered initialization. */
(function (App) {
  "use strict";
const pendingToasts = [];
let activeQueuedToast = null;

function getQueuedContent(entry) {
  if (entry.cancelled || entry.opts.isValid?.() === false) return null;
  const content = entry.opts.getContent?.();
  if (content === null) return null;
  return { ...entry.opts, ...(content || {}) };
}

function showNextQueuedToast() {
  if (App.$("toast") && !App.$("toast").hidden) return;
  while (pendingToasts.length) {
    const entry = pendingToasts.shift();
    let opts;
    try { opts = getQueuedContent(entry); } catch { opts = null; }
    if (!opts) {
      entry.cancelled = true;
      try { entry.opts.onClose?.("cancelled"); } catch {}
      if (App.$("toast") && !App.$("toast").hidden) return;
      continue;
    }
    activeQueuedToast = entry;
    displayToast({ ...opts, onClose: reason => {
      if (activeQueuedToast === entry) activeQueuedToast = null;
      if (reason === "replaced" && !entry.cancelled) {
        // Login and other immediate notices may interrupt a queued notice.
        // Resume it afterwards so a just-opened reminder is not lost.
        pendingToasts.unshift(entry);
        return;
      }
      entry.cancelled = true;
      opts.onClose?.(reason);
    } });
    try { opts.onShow?.(); } catch {}
    return;
  }
}

App.showToast = function (opts = {}) {
  if (typeof opts === "string") opts = {
    body: opts
  };else if (!opts || typeof opts !== "object") opts = {};
  if (!opts.queue) return displayToast(opts);
  const entry = { opts, cancelled: false };
  const handle = {
    cancel() {
      if (entry.cancelled) return;
      entry.cancelled = true;
      const index = pendingToasts.indexOf(entry);
      if (index >= 0) pendingToasts.splice(index, 1);
      if (activeQueuedToast === entry) App.closeToast("cancelled");
      else { try { entry.opts.onClose?.("cancelled"); } catch {} }
    },
    refresh() {
      if (activeQueuedToast !== entry || entry.cancelled) return;
      let current;
      try { current = getQueuedContent(entry); } catch { current = null; }
      if (!current) return handle.cancel();
      const title = App.$("toast-title"), body = App.$("toast-body");
      if (title) title.textContent = current.title || "Notice";
      if (body) {
        if (current.bodyHTML != null) body.innerHTML = current.bodyHTML;
        else body.textContent = current.body || "";
      }
    }
  };
  pendingToasts.push(entry);
  showNextQueuedToast();
  return handle;
};

function displayToast(opts) {
  const {
    title = "Notice",
    body = "",
    bodyHTML = null,
    code = null,
    showCopy = false,
    duration = 10000,
    onClose = null
  } = opts;
  const toastEl = App.$("toast");
  const titleEl = App.$("toast-title");
  const bodyEl = App.$("toast-body");
  const codeEl = App.$("toast-code");
  const copyBtn = App.$("btn-copy-code");
  const bar = App.$("toast-timer-bar");
  clearTimeout(App.toastTimer);
  clearTimeout(App.toastHideTimer);

  // If a toast is already showing, treat this as replacement and run prior onClose.
  if (toastEl && !toastEl.hidden && typeof App.toastOnClose === "function") {
    const previousOnClose = App.toastOnClose;
    App.toastOnClose = null;
    try {
      previousOnClose("replaced");
    } catch {}
  }
  App.toastCloseSeq += 1;
  App.toastOnClose = typeof onClose === "function" ? onClose : null;
  if (titleEl) titleEl.textContent = title;
  if (bodyEl) {
    if (bodyHTML != null) bodyEl.innerHTML = bodyHTML;else bodyEl.textContent = body;
  }
  if (codeEl) {
    if (code) {
      codeEl.hidden = false;
      codeEl.textContent = code;
    } else {
      codeEl.hidden = true;
      codeEl.textContent = "";
    }
  }
  if (copyBtn) copyBtn.hidden = !showCopy;
  if (toastEl) {
    const toneSource = `${title} ${body}`.toLowerCase();
    toastEl.dataset.tone = /fail|error|invalid|denied|blocked|missing|not found|deleted/.test(toneSource) ? "danger" : /warn|offline|paused|expired/.test(toneSource) ? "warning" : /created|saved|copied|updated|enabled|logged|joined|cleared|sent|success/.test(toneSource) ? "success" : "info";
    toastEl.hidden = false;
    toastEl.classList.remove("is-leaving");
    void toastEl.offsetHeight;
    toastEl.classList.add("is-showing");
  }
  if (bar) {
    bar.style.animation = "none";
    void bar.offsetHeight;
    bar.style.animation = `toastbar ${duration}ms linear forwards`;
  }
  App.toastTimer = setTimeout(() => App.closeToast("timeout"), Math.max(0, Number(duration) || 0));
}
App.closeToast = function (reason = "manual") {
  clearTimeout(App.toastTimer);
  clearTimeout(App.toastHideTimer);
  const toastEl = App.$("toast");
  App.activePingToastRoomId = null;
  const cb = App.toastOnClose;
  App.toastOnClose = null;
  const closeSeq = ++App.toastCloseSeq;
  if (toastEl) {
    toastEl.classList.remove("is-showing");
    toastEl.classList.add("is-leaving");
  }
  App.toastHideTimer = setTimeout(() => {
    if (closeSeq !== App.toastCloseSeq) return;
    if (toastEl) {
      toastEl.hidden = true;
      toastEl.classList.remove("is-leaving");
    }
    showNextQueuedToast();
  }, 180);
  // A callback may display another toast. Schedule this close first so that
  // displayToast can cancel it, keeping the new notice and its timer intact.
  if (typeof cb === "function") {
    try { cb(reason); } catch {}
  }
};

App.register("ui/toasts", function initializeFeature() {
App.toastTimer = null;
App.toastHideTimer = null;
App.toastOnClose = null;
App.toastCloseSeq = 0;
App.$("btn-toast-close").addEventListener("click", () => App.closeToast("manual"));
App.$("btn-copy-code").addEventListener("click", async () => {
  const code = App.$("toast-code").textContent || "";
  try {
    await navigator.clipboard.writeText(code);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
});
});
})(globalThis.ChatApp);
