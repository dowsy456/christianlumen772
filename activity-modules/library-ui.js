/* activities/library-ui: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.htmlHubDisplayTitle = function (title) {
  const text = String(title || "Untitled HTML").trim();
  const words = [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)];
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "via"]);
  let index = 0;
  return text.replace(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu, word => {
    const atEdge = index === 0 || index === words.length - 1;
    index++;
    return !atEdge && smallWords.has(word.toLowerCase()) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1);
  });
};
App.htmlHubInitials = function (title) {
  const words = String(title || "HTML").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map(word => word[0]).join("") : String(words[0] || "HTML").slice(0, 2);
  return String(letters || "HT").slice(0, 2).toUpperCase();
};
App.htmlHubCountText = function (count) {
  const n = Number(count || 0);
  return `${n} saved HTML file${n === 1 ? "" : "s"}`;
};
App.htmlHubFileSizeText = function (bytes) {
  const n = Math.max(0, Number(bytes || 0));
  if (!n) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
App.htmlHubCardMeta = function (item, paused = false) {
  if (paused) return "Paused - open to continue";
  const pieces = [];
  const fileName = String(item?.fileName || "").trim();
  const sizeText = App.htmlHubFileSizeText(item?.byteSize);
  const updatedAt = Number(item?.updatedAt || 0);
  if (fileName) pieces.push(fileName);
  if (sizeText) pieces.push(sizeText);
  if (updatedAt) {
    try {
      pieces.push(`Updated ${App.getDateTimeFormatter("en-US", {
        month: "short",
        day: "numeric",
        ...(new Date(updatedAt).getFullYear() !== new Date().getFullYear() ? {
          year: "numeric"
        } : {})
      }).format(new Date(updatedAt))}`);
    } catch {}
  }
  return pieces.join(" - ") || "Saved web page";
};
App.htmlHubSidebarHTML = function (mode, count) {
  const isAdd = mode === "add";
  return `
    <aside class="html-hub-sidebar" aria-label="HTML Hub navigation">
      <div class="html-hub-sidebar-title">HTML Hub</div>
      <button class="html-hub-nav-item${isAdd ? "" : " is-active"}" id="html-hub-back-btn" type="button">
        <span>Shared Files</span>
        <span class="html-hub-nav-count">${Math.max(0, Number(count) || 0)}</span>
      </button>
      <button class="html-hub-nav-item${isAdd ? " is-active" : ""}" id="html-hub-add-btn" type="button">
        <span>New HTML File</span>
      </button>
      <button class="html-hub-nav-item" id="html-hub-upload-temp-btn" type="button">
        <span>Open Unsaved File</span>
      </button>
    </aside>
  `;
};
App.htmlHubListBodyHTML = function (items, query = "", totalCount = items.length) {
  const hasQuery = !!String(query || "").trim();
  const cards = items.map(item => {
    const title = App.htmlHubDisplayTitle(item.title);
    const paused = App.isHtmlHubPaused(item.id);
    const ownerCode = String(item.ownerCode || "");
    const ownerUsername = String(item.ownerUsername || "Unknown user");
    return `
      <article class="html-hub-card${paused ? " is-paused" : ""}" data-html-hub-id="${App.escapeAttr(item.id)}" tabindex="0" aria-label="${App.escapeAttr(`Open ${title}`)}">
        <button class="html-hub-card-main" type="button" data-open-html-id="${App.escapeAttr(item.id)}">
          <span class="html-hub-card-mark" aria-hidden="true">${App.escapeHtml(App.htmlHubInitials(title))}</span>
          <span class="html-hub-card-copy">
            <span class="html-hub-card-title">${App.escapeHtml(title)}</span>
            <span class="html-hub-card-meta">${App.escapeHtml(App.htmlHubCardMeta(item, paused))}</span>
            <span class="html-hub-card-owner">
              <span class="html-hub-owner-avatar" data-avatar-usercode="${App.escapeAttr(ownerCode)}" aria-hidden="true"></span>
              <span class="html-hub-owner-copy">Uploaded by <span class="html-hub-owner-username" data-username-usercode="${App.escapeAttr(ownerCode)}">${App.escapeHtml(ownerUsername)}</span></span>
            </span>
          </span>
          ${paused ? `<span class="html-hub-paused-pill">Paused</span>` : ``}
          <span class="html-hub-card-open" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </button>
        <button class="html-hub-card-options" type="button" data-html-options-id="${App.escapeAttr(item.id)}" aria-label="More options for ${App.escapeAttr(title)}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>
        </button>
      </article>
    `;
  }).join("");
  return `
    <div class="html-hub-layout">
      ${App.htmlHubSidebarHTML("list", totalCount)}
      <main class="html-hub-content">
        <div class="html-hub-grid">
          ${cards || `<div class="html-hub-empty">${hasQuery ? "No matching HTML files found." : "No shared HTML files yet. Add one to get started."}</div>`}
        </div>
      </main>
    </div>
  `;
};
App.stopHtmlHubOwnerListeners = function () {
  for (const [, listener] of App.htmlHubOwnerListeners) {
    try {
      listener.ref.off("value", listener.cb);
    } catch {}
  }
  App.htmlHubOwnerListeners.clear();
};
App.ensureHtmlHubOwnerListener = function (code) {
  const ownerCode = String(code || "").trim();
  if (!ownerCode || App.htmlHubOwnerListeners.has(ownerCode)) return;
  const ref = App.db.ref(`users/${ownerCode}`);
  const cb = snap => {
    if (!snap.exists()) return;
    const rec = snap.val() || {};
    const username = String(rec.username || "Unknown user");
    const user = {
      code: ownerCode,
      username,
      photoDataURL: rec.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.normalizeTransformToRel(rec.photoTransform, 84)
    };
    const listener = App.htmlHubOwnerListeners.get(ownerCode);
    if (listener) listener.user = user;
    const root = App.$("modal-body");
    if (!root || App.modalEl.dataset.size !== "html-hub") return;
    const safeCode = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(ownerCode) : ownerCode.replace(/"/g, '\\"');
    root.querySelectorAll(`[data-avatar-usercode="${safeCode}"]`).forEach(avatar => App.applyAvatar(avatar, user));
    root.querySelectorAll(`[data-username-usercode="${safeCode}"]`).forEach(el => {
      el.textContent = username;
    });
  };
  App.htmlHubOwnerListeners.set(ownerCode, {
    ref,
    cb,
    user: null
  });
  ref.on("value", cb);
};
App.hydrateHtmlHubOwners = function (root = App.$("modal-body")) {
  if (!root) return;
  const wantedCodes = new Set();
  root.querySelectorAll(".html-hub-card-owner").forEach(row => {
    const avatar = row.querySelector(".html-hub-owner-avatar[data-avatar-usercode]");
    const usernameEl = row.querySelector("[data-username-usercode]");
    const code = String(avatar?.getAttribute("data-avatar-usercode") || usernameEl?.getAttribute("data-username-usercode") || "");
    if (!code) return;
    wantedCodes.add(code);
    const user = App.htmlHubOwnerListeners.get(code)?.user || (code === String(App.currentUser?.code || "") ? App.currentUser : App.liveUserCache.get(code));
    if (avatar) {
      App.applyAvatar(avatar, user || {
        code,
        username: String(usernameEl?.textContent || "Unknown user"),
        photoDataURL: App.defaultStickmanDataURL(),
        photoTransform: null
      });
    }
    if (usernameEl && user?.username) usernameEl.textContent = String(user.username);
    App.ensureHtmlHubOwnerListener(code);
  });
  for (const [code, listener] of App.htmlHubOwnerListeners) {
    if (wantedCodes.has(code)) continue;
    try {
      listener.ref.off("value", listener.cb);
    } catch {}
    App.htmlHubOwnerListeners.delete(code);
  }
};
App.htmlHubAddBodyHTML = function (count = 0) {
  return `
    <div class="html-hub-layout">
      ${App.htmlHubSidebarHTML("add", count)}
      <main class="html-hub-content">
        <div class="html-hub-content-head">
          <div>
            <h3>Add an HTML File</h3>
            <p>Choose a local .html file and give it a short title.</p>
          </div>
        </div>
        <div class="html-hub-form-card">
          <label class="html-hub-label" for="html-hub-title-input">Title</label>
          <input class="input" id="html-hub-title-input" maxlength="20" placeholder="Page Title" autocomplete="off" />

          <label class="html-hub-label" for="html-hub-file-pick">HTML File</label>
          <div class="html-hub-file-drop">
            <button class="btn" id="html-hub-file-pick" type="button">Choose File</button>
            <span class="html-hub-file-name" id="html-hub-file-name">No file selected</span>
          </div>

          <div class="html-hub-upload-status" id="html-hub-upload-status" hidden>Loading…</div>
          <button class="btn primary html-hub-save-wide" id="html-hub-save-btn" type="button">Add HTML</button>
        </div>
      </main>
    </div>
  `;
};
App.ensureHtmlHubContextMenu = function () {
  if (App.htmlHubMenuEl) return App.htmlHubMenuEl;
  App.htmlHubMenuEl = document.createElement("div");
  App.htmlHubMenuEl.id = "html-hub-menu";
  App.htmlHubMenuEl.className = "msg-menu html-hub-menu";
  App.htmlHubMenuEl.hidden = true;
  App.htmlHubMenuEl.innerHTML = `
    <button class="msg-menu-btn" type="button" data-html-hub-menu-act="download">
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="msg-menu-label">Download HTML</span>
    </button>
    <button class="msg-menu-btn" type="button" data-html-hub-menu-act="rename" data-html-hub-manage-only>
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M5 19h4.3L19.1 9.2a2.1 2.1 0 0 0 0-3L17.8 4.9a2.1 2.1 0 0 0-3 0L5 14.7V19Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          <path d="M13.6 6.1l4.3 4.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M4 21h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="msg-menu-label">Edit Title</span>
    </button>
    <button class="msg-menu-btn" type="button" data-html-hub-menu-act="delete" data-html-hub-manage-only>
      <span class="msg-menu-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M5 7h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <path d="M8 7l.6 12.1A2 2 0 0 0 10.6 21h2.8a2 2 0 0 0 2-1.9L16 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
          <path d="M9.5 7l.5-3h4l.5 3" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="msg-menu-label">Delete</span>
    </button>
  `;
  document.body.appendChild(App.htmlHubMenuEl);
  App.htmlHubMenuEl.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-html-hub-menu-act]");
    if (!btn) return;
    const id = App.htmlHubMenuCtx?.id || "";
    const act = btn.getAttribute("data-html-hub-menu-act");
    App.closeHtmlHubContextMenu();
    if (!id) return;
    if (act === "download") {
      await App.downloadHtmlHubById(id);
      return;
    }
    if (act === "rename") {
      await App.renameHtmlHubById(id);
      return;
    }
    if (act === "delete") {
      await App.deleteHtmlHubById(id);
    }
  });
  document.addEventListener("pointerdown", e => {
    if (!App.htmlHubMenuEl || App.htmlHubMenuEl.hidden) return;
    if (App.htmlHubMenuEl.contains(e.target)) return;
    App.closeHtmlHubContextMenu();
  }, {
    capture: true
  });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || App.htmlHubMenuEl?.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    App.closeHtmlHubContextMenu(true, true);
  }, true);
  window.addEventListener("blur", () => App.closeHtmlHubContextMenu(true));
  window.addEventListener("resize", () => App.closeHtmlHubContextMenu(true));
  return App.htmlHubMenuEl;
};
App.positionHtmlHubContextMenu = function (x, y) {
  const menu = App.ensureHtmlHubContextMenu();
  if (!menu || menu.hidden) return;
  App.positionContextMenu(menu, App.htmlHubMenuCtx?.placement || { x, y });
};
App.openHtmlHubContextMenu = function (id, x, y, anchor = null) {
  if (!id) return;
  const menu = App.ensureHtmlHubContextMenu();
  const item = App.getCachedHtmlHubItem(id);
  if (!item) return;
  App.closeCallScreenContextMenu?.(true);
  const canManage = App.canManageHtmlHubItem(item);
  menu.querySelectorAll("[data-html-hub-manage-only]").forEach(button => {
    button.hidden = !canManage;
  });
  App.htmlHubMenuCtx = {
    id,
    item,
    placement: { x, y, anchor, avoidAnchor: !!anchor },
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null
  };
  App.htmlHubMenuCloseSeq += 1;
  if (App.htmlHubMenuCloseOnEnd) {
    menu.removeEventListener("animationend", App.htmlHubMenuCloseOnEnd);
    App.htmlHubMenuCloseOnEnd = null;
  }
  menu.hidden = false;
  menu.classList.remove("closing");
  menu.classList.add("open");
  App.positionHtmlHubContextMenu(x, y);
  requestAnimationFrame(() => {
    try {
      menu.querySelector("button:not([hidden]):not([disabled])")?.focus({
        preventScroll: true
      });
    } catch {}
  });
};
App.closeHtmlHubContextMenu = function (immediate = false, restoreFocus = false) {
  const menu = App.htmlHubMenuEl;
  if (!menu || menu.hidden) return;
  const returnFocus = App.htmlHubMenuCtx?.returnFocus;
  const restore = () => {
    if (!restoreFocus || !returnFocus || !document.contains(returnFocus)) return;
    try {
      returnFocus.focus({
        preventScroll: true
      });
    } catch {}
  };
  App.htmlHubMenuCloseSeq += 1;
  const seq = App.htmlHubMenuCloseSeq;
  if (App.htmlHubMenuCloseOnEnd) {
    menu.removeEventListener("animationend", App.htmlHubMenuCloseOnEnd);
    App.htmlHubMenuCloseOnEnd = null;
  }
  if (immediate) {
    menu.hidden = true;
    menu.classList.remove("open", "closing");
    App.htmlHubMenuCtx = null;
    restore();
    return;
  }
  menu.classList.remove("open");
  menu.classList.add("closing");
  App.htmlHubMenuCloseOnEnd = () => {
    if (seq !== App.htmlHubMenuCloseSeq) return;
    App.htmlHubMenuCloseOnEnd = null;
    menu.hidden = true;
    menu.classList.remove("closing");
    App.htmlHubMenuCtx = null;
    restore();
  };
  menu.addEventListener("animationend", App.htmlHubMenuCloseOnEnd, {
    once: true
  });
};
App.htmlHubDownloadFileName = function (item) {
  const preferred = String(item?.fileName || item?.title || "shared-page").trim() || "shared-page";
  const safe = preferred.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").slice(0, 160) || "shared-page";
  return /\.html?$/i.test(safe) ? safe : `${safe}.html`;
};
App.downloadHtmlHubById = async function (id) {
  const cached = App.getCachedHtmlHubItem(id);
  const item = await App.readHtmlHubItem(id);
  if (!item) {
    App.showToast({
      title: "Download failed",
      body: "That shared HTML file is no longer available.",
      duration: 2600
    });
    return;
  }
  let objectUrl = "";
  try {
    const blob = new Blob([String(item.html || "")], {
      type: "text/html;charset=utf-8"
    });
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = App.htmlHubDownloadFileName({
      ...item,
      fileName: cached?.fileName || item.fileName
    });
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (e) {
    console.error("HTML Hub download failed:", e);
    App.showToast({
      title: "Download failed",
      body: "Could not download that HTML file.",
      duration: 2600
    });
  } finally {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
};
App.renameHtmlHubById = async function (id) {
  const itemsNow = await App.readHtmlHub();
  const item = itemsNow.find(x => x.id === id);
  if (!item) return;
  if (!App.canManageHtmlHubItem(item)) {
    App.showToast({
      title: "Not allowed",
      body: "Only the uploader or Vinny can edit this HTML.",
      duration: 2800
    });
    return;
  }
  await App.sleep();
  const next = prompt("Edit Title", item.title);
  if (next == null) return;
  const cleaned = App.sanitizeHtmlHubTitle(next);
  if (!cleaned) {
    App.showToast({
      title: "Invalid title",
      body: "Use the same rules as usernames.",
      duration: 3500
    });
    return;
  }
  const updated = await App.updateHtmlHubTitle(id, cleaned);
  if (!updated) {
    App.showToast({
      title: "Not allowed",
      body: "Only the uploader or Vinny can edit this HTML.",
      duration: 2800
    });
    return;
  }
  if (App.selectedGame?.hubId === id) {
    App.selectedGame.label = cleaned;
    void App.syncMyHtmlActivityPresence();
  }
  App.showToast({
    title: "Title updated",
    body: `Renamed to ${cleaned}.`,
    duration: 1800
  });
};
App.deleteHtmlHubById = async function (id) {
  const itemsNow = await App.readHtmlHub();
  const item = itemsNow.find(x => x.id === id);
  if (!item) return;
  if (!App.canManageHtmlHubItem(item)) {
    App.showToast({
      title: "Not allowed",
      body: "Only the uploader or Vinny can delete this HTML.",
      duration: 2800
    });
    return;
  }
  await App.sleep();
  const ok = confirm(`Delete "${item.title}"?`);
  if (!ok) return;
  const deleted = await App.deleteHtmlHubItem(id);
  if (!deleted) {
    App.showToast({
      title: "Not allowed",
      body: "Only the uploader or Vinny can delete this HTML.",
      duration: 2800
    });
    return;
  }
  App.showToast({
    title: "HTML deleted",
    body: `${item.title} was removed from the HTML Hub.`,
    duration: 1800
  });
};
App.teardownHtmlHubModal = function () {
  App.htmlHubModalRequestSeq += 1;
  App.stopHtmlHubRealtimeListener();
  App.stopHtmlHubOwnerListeners();
  App.closeHtmlHubContextMenu(true);
  if (App.htmlHubModalBindingsAbort) {
    try {
      App.htmlHubModalBindingsAbort.abort();
    } catch {}
  }
  App.htmlHubModalBindingsAbort = null;
};
App.openHtmlHubModal = async function (mode = "list") {
  if (!App.currentUser) return;
  App.teardownHtmlHubModal();
  const requestSeq = App.htmlHubModalRequestSeq;
  const modalMotionAtRequest = App.modalMotionId;
  let items = await App.readHtmlHub();
  if (requestSeq !== App.htmlHubModalRequestSeq || modalMotionAtRequest !== App.modalMotionId || !App.currentUser) return;
  if (typeof App.modalBeforeClose !== "undefined" && App.modalBeforeClose === App.teardownHtmlHubModal) App.modalBeforeClose = null;
  const controller = new AbortController();
  App.htmlHubModalBindingsAbort = controller;
  const listenerOptions = {
    signal: controller.signal
  };
  App.openModal({
    title: "HTML Hub",
    bodyHTML: mode === "add" ? App.htmlHubAddBodyHTML(items.length) : App.htmlHubListBodyHTML(items, "", items.length),
    size: "html-hub",
    onBeforeClose: App.teardownHtmlHubModal
  });
  const titleEl = App.$("modal-title");
  const bodyEl = App.$("modal-body");
  if (!titleEl || !bodyEl) return;
  titleEl.innerHTML = mode === "add" ? `
    <div class="html-hub-titlebar">
      <div class="html-hub-title-stack">
        <span class="html-hub-title-text">HTML Hub</span>
        <span class="html-hub-title-sub">Add a Shared Page</span>
      </div>
    </div>
  ` : `
    <div class="html-hub-titlebar">
      <div class="html-hub-title-stack">
        <span class="html-hub-title-text">HTML Hub</span>
        <span class="html-hub-title-sub">${App.escapeHtml(App.htmlHubCountText(items.length))}</span>
      </div>
      <input
        class="html-hub-search-input"
        id="html-hub-search-input"
        type="search"
        placeholder="Search shared files or uploaders"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search shared HTML files"
      />
    </div>
  `;
  if (mode === "add") {
    let chosenFile = null;
    const updateLiveCount = nextItems => {
      items = nextItems;
      const count = bodyEl.querySelector(".html-hub-nav-count");
      if (count) count.textContent = String(items.length);
    };
    App.startHtmlHubRealtimeListener(updateLiveCount);
    void App.migrateLegacyHtmlLibrariesToHub();
    App.$("html-hub-back-btn")?.addEventListener("click", () => {
      void App.openHtmlHubModal("list");
    }, listenerOptions);
    App.$("html-hub-upload-temp-btn")?.addEventListener("click", App.openTempHtmlUploadPicker, listenerOptions);
    const setUploadBusyState = (busy, pct = 0) => {
      const titleInput = App.$("html-hub-title-input");
      const pickBtn = App.$("html-hub-file-pick");
      const saveBtn = App.$("html-hub-save-btn");
      const tempBtn = App.$("html-hub-upload-temp-btn");
      const backBtn = App.$("html-hub-back-btn");
      const closeBtn = App.$("btn-modal-close");
      const nameEl = App.$("html-hub-file-name");
      const statusEl = App.$("html-hub-upload-status");
      const pctText = App.formatUploadPercentText(pct);
      if (busy) App.modalEl.dataset.busy = "1";else delete App.modalEl.dataset.busy;
      [titleInput, pickBtn, tempBtn, backBtn, closeBtn].forEach(el => {
        if (el) el.disabled = busy;
      });
      if (saveBtn) {
        saveBtn.disabled = busy;
        saveBtn.textContent = busy ? `Uploading ${pctText}` : "Add HTML";
      }
      if (nameEl) nameEl.textContent = busy ? `${chosenFile ? chosenFile.name : "HTML"} • ${pctText}` : chosenFile ? chosenFile.name : "No file selected";
      if (statusEl) {
        statusEl.hidden = !busy;
        statusEl.textContent = `Uploading ${pctText}`;
      }
    };
    App.$("html-hub-file-pick")?.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const pickBtn = event.currentTarget;
      if (!pickBtn || pickBtn.dataset.picking === "1") return;
      pickBtn.dataset.picking = "1";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".html,.htm,text/html";
      input.style.display = "none";
      document.body.appendChild(input);
      const cleanup = () => {
        delete pickBtn.dataset.picking;
        try {
          input.remove();
        } catch {}
      };
      input.addEventListener("change", changeEvent => {
        chosenFile = changeEvent.target.files?.[0] || null;
        const nameEl = App.$("html-hub-file-name");
        if (nameEl) nameEl.textContent = chosenFile ? chosenFile.name : "No file selected";
        cleanup();
      }, {
        once: true
      });
      setTimeout(() => {
        try {
          input.click();
        } catch {
          cleanup();
        }
        setTimeout(() => {
          if (input.isConnected && (!input.files || !input.files.length)) cleanup();
        }, 300);
      }, 0);
    }, listenerOptions);
    App.$("html-hub-save-btn")?.addEventListener("click", async () => {
      const title = App.sanitizeHtmlHubTitle(App.$("html-hub-title-input")?.value || "");
      if (!title) {
        App.showToast({
          title: "Invalid title",
          body: "Use the same rules as usernames.",
          duration: 3500
        });
        return;
      }
      if (!chosenFile) {
        App.showToast({
          title: "Missing file",
          body: "Choose an .html file first.",
          duration: 3500
        });
        return;
      }
      if (!(chosenFile.type === "text/html" || /\.html?$/i.test(chosenFile.name || ""))) {
        App.showToast({
          title: "Invalid file",
          body: "Please choose an .html file.",
          duration: 3500
        });
        return;
      }
      setUploadBusyState(true, 0);
      try {
        await App.createHtmlHubItem({
          title,
          file: chosenFile,
          onProgress: pct => setUploadBusyState(true, pct)
        });
        setUploadBusyState(false);
        App.showToast({
          title: "HTML saved",
          body: `${title} was added to the HTML Hub.`,
          duration: 2200
        });
        await App.openHtmlHubModal("list");
      } catch (err) {
        console.error("HTML Hub upload failed:", err);
        setUploadBusyState(false);
        App.showToast({
          title: "Upload failed",
          body: "Could not save this HTML file. Please try again.",
          duration: 3500
        });
      }
    }, listenerOptions);
    return;
  }
  let query = "";
  const renderList = (nextItems = items, {
    preserve = true
  } = {}) => {
    if (App.modalEl.hidden || App.modalEl.dataset.size !== "html-hub") return;
    items = nextItems;
    const contentBefore = bodyEl.querySelector(".html-hub-content");
    const scrollTop = preserve ? Number(contentBefore?.scrollTop || 0) : 0;
    const focusedCardId = preserve ? String(document.activeElement?.closest?.("[data-html-hub-id]")?.getAttribute("data-html-hub-id") || "") : "";
    const q = String(query || "").trim().toLowerCase();
    const filtered = q ? items.filter(item => `${item.titleLower} ${String(item.fileName || "").toLowerCase()} ${item.ownerUsernameLower}`.includes(q)) : items;
    bodyEl.innerHTML = App.htmlHubListBodyHTML(filtered, q, items.length);
    App.hydrateHtmlHubOwners(bodyEl);
    const contentAfter = bodyEl.querySelector(".html-hub-content");
    if (contentAfter) contentAfter.scrollTop = scrollTop;
    if (focusedCardId) {
      const safeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(focusedCardId) : focusedCardId.replace(/"/g, '\\"');
      try {
        bodyEl.querySelector(`[data-html-hub-id="${safeId}"]`)?.focus({
          preventScroll: true
        });
      } catch {}
    }
    const subtitle = titleEl.querySelector(".html-hub-title-sub");
    if (subtitle) subtitle.textContent = App.htmlHubCountText(items.length);
  };
  renderList(items, {
    preserve: false
  });
  App.$("html-hub-search-input")?.addEventListener("input", event => {
    query = event.target.value || "";
    renderList(items);
  }, listenerOptions);
  bodyEl.addEventListener("click", async event => {
    App.closeHtmlHubContextMenu(true);
    const optionsBtn = event.target.closest("[data-html-options-id]");
    if (optionsBtn) {
      const rect = optionsBtn.getBoundingClientRect();
      App.openHtmlHubContextMenu(optionsBtn.getAttribute("data-html-options-id"), rect.right, rect.bottom, optionsBtn);
      return;
    }
    if (event.target.closest("#html-hub-add-btn")) {
      void App.openHtmlHubModal("add");
      return;
    }
    if (event.target.closest("#html-hub-upload-temp-btn")) {
      App.openTempHtmlUploadPicker();
      return;
    }
    const openBtn = event.target.closest("[data-open-html-id]");
    if (openBtn) await App.openSavedHtmlFromHub(openBtn.getAttribute("data-open-html-id"));
  }, listenerOptions);
  bodyEl.addEventListener("contextmenu", event => {
    const card = event.target.closest(".html-hub-card[data-html-hub-id]");
    if (!card || !bodyEl.contains(card)) return;
    event.preventDefault();
    event.stopPropagation();
    App.openHtmlHubContextMenu(card.getAttribute("data-html-hub-id"), event.clientX, event.clientY);
  }, listenerOptions);
  bodyEl.addEventListener("keydown", event => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const card = event.target.closest(".html-hub-card[data-html-hub-id]");
    if (!card || !bodyEl.contains(card)) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    App.openHtmlHubContextMenu(card.getAttribute("data-html-hub-id"), rect.left + 18, rect.top + 18, card);
  }, listenerOptions);
  App.startHtmlHubRealtimeListener(nextItems => {
    if (App.htmlHubMenuCtx?.id && !nextItems.some(item => item.id === App.htmlHubMenuCtx.id)) App.closeHtmlHubContextMenu(true);
    if (App.selectedGame?.hubId) {
      const selected = nextItems.find(item => item.id === App.selectedGame.hubId);
      if (selected && App.selectedGame.label !== selected.title) {
        App.selectedGame.label = selected.title;
        App.updateGamesWindowChrome();
        void App.syncMyHtmlActivityPresence();
      } else if (!selected && App.gamesStageOpen) {
        void App.closeGamesStage({
          preserve: false
        });
      }
    }
    renderList(nextItems);
  });
  void App.migrateLegacyHtmlLibrariesToHub();
};
App.ensureGamesStage = function () {
  if (App.$("games-stage-overlay")) return;
  const style = document.createElement("style");
  style.textContent = `
    .games-stage-overlay{
      position:fixed;
      inset:0;
      background:transparent;
      z-index:99999;
      display:none;
      pointer-events:none;
    }
    .games-stage-overlay.open{ display:block; }
    .games-stage-wrap{
      position:fixed;
      left:${App.GAMES_VIEWPORT_MARGIN}px;
      top:${App.GAMES_VIEWPORT_MARGIN}px;
      width:960px;
      height:620px;
      display:flex;
      flex-direction:column;
      border-radius:18px;
      overflow:hidden;
      background:#05070d;
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 28px 90px rgba(0,0,0,.55);
      pointer-events:auto;
      user-select:none;
    }
    .games-stage-wrap.is-maximized{ border-radius:16px; }
    .games-stage-head{
      height:46px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      padding:0 12px 0 14px;
      background:linear-gradient(180deg, rgba(28,34,48,.96), rgba(17,22,33,.96));
      border-bottom:1px solid rgba(255,255,255,.08);
      cursor:grab;
      flex:0 0 auto;
    }
    .games-stage-head:active{ cursor:grabbing; }
    .games-stage-head-left{
      display:flex;
      align-items:center;
      gap:12px;
      min-width:0;
    }
    .games-stage-traffic{
      display:flex;
      align-items:center;
      gap:8px;
      flex:0 0 auto;
    }
    .games-stage-winbtn{
      width:12px;
      height:12px;
      border-radius:999px;
      border:0;
      padding:0;
      cursor:pointer;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,.22);
    }
    .games-stage-winbtn.maximize{ background:#62d26f; }
    .games-stage-winbtn.minimize{ background:#f4c84a; }
    .games-stage-winbtn.close{ background:#ff6b6b; }
    .games-stage-title{
      min-width:0;
      color:rgba(255,255,255,.92);
      font-size:13px;
      font-weight:700;
      letter-spacing:.15px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .games-stage-head-actions{
      display:flex;
      align-items:center;
      gap:8px;
      flex:0 0 auto;
    }
    .games-stage-action{
      appearance:none;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.05);
      color:rgba(255,255,255,.9);
      height:32px;
      padding:0 12px;
      border-radius:10px;
      cursor:pointer;
      font:inherit;
      font-size:12px;
      font-weight:700;
      letter-spacing:.15px;
    }
    .games-stage-action:hover{
      background:rgba(255,255,255,.085);
      border-color:rgba(255,255,255,.18);
    }
    .games-stage-body{
      position:relative;
      flex:1 1 auto;
      min-height:0;
      background:#000;
      overflow:hidden;
    }
    .games-stage-body.game-mode{ padding:0; }
    .games-stage-splash{
      position:absolute;
      inset:0;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
      background:linear-gradient(180deg, rgba(8,11,18,.92), rgba(4,6,11,.96));
      color:rgba(255,255,255,.88);
    }
    .games-stage-splash-card{
      width:min(520px, 100%);
      border:1px solid rgba(255,255,255,.09);
      background:rgba(255,255,255,.04);
      border-radius:18px;
      padding:18px 18px 16px;
      box-shadow:0 16px 40px rgba(0,0,0,.25);
    }
    .games-stage-splash-title{
      font-size:16px;
      font-weight:800;
      margin-bottom:6px;
    }
    .games-stage-splash-copy{
      opacity:.8;
      line-height:1.45;
      font-size:13px;
    }
    .games-frame{
      width:100%;
      height:100%;
      border:0;
      background:#000;
      display:block;
    }
    .games-stage-resize{
      position:absolute;
      z-index:4;
      background:transparent;
      pointer-events:auto;
    }
    .games-stage-resize[data-games-resize="n"],
    .games-stage-resize[data-games-resize="s"]{
      left:12px;
      right:12px;
      height:10px;
    }
    .games-stage-resize[data-games-resize="n"]{ top:-5px; cursor:n-resize; }
    .games-stage-resize[data-games-resize="s"]{ bottom:-5px; cursor:s-resize; }
    .games-stage-resize[data-games-resize="e"],
    .games-stage-resize[data-games-resize="w"]{
      top:12px;
      bottom:12px;
      width:10px;
    }
    .games-stage-resize[data-games-resize="e"]{ right:-5px; cursor:e-resize; }
    .games-stage-resize[data-games-resize="w"]{ left:-5px; cursor:w-resize; }
    .games-stage-resize[data-games-resize="ne"],
    .games-stage-resize[data-games-resize="nw"],
    .games-stage-resize[data-games-resize="se"],
    .games-stage-resize[data-games-resize="sw"]{
      width:14px;
      height:14px;
    }
    .games-stage-resize[data-games-resize="ne"]{ top:-7px; right:-7px; cursor:ne-resize; }
    .games-stage-resize[data-games-resize="nw"]{ top:-7px; left:-7px; cursor:nw-resize; }
    .games-stage-resize[data-games-resize="se"]{ right:-7px; bottom:-7px; cursor:se-resize; }
    .games-stage-resize[data-games-resize="sw"]{ left:-7px; bottom:-7px; cursor:sw-resize; }
  `;
  document.head.appendChild(style);
  const overlay = document.createElement("div");
  overlay.id = "games-stage-overlay";
  overlay.className = "games-stage-overlay";
  overlay.innerHTML = `
    <div class="games-stage-wrap" id="games-stage-wrap">
      <div class="games-stage-resize" data-games-resize="n"></div>
      <div class="games-stage-resize" data-games-resize="e"></div>
      <div class="games-stage-resize" data-games-resize="s"></div>
      <div class="games-stage-resize" data-games-resize="w"></div>
      <div class="games-stage-resize" data-games-resize="ne"></div>
      <div class="games-stage-resize" data-games-resize="nw"></div>
      <div class="games-stage-resize" data-games-resize="se"></div>
      <div class="games-stage-resize" data-games-resize="sw"></div>

      <div class="games-stage-head" id="games-stage-head">
        <div class="games-stage-head-left">
          <div class="games-stage-app-icon" aria-hidden="true">${App.htmlHubButtonIconSVG()}</div>
          <div class="games-stage-title" id="games-stage-title">HTML</div>
        </div>
        <div class="games-stage-head-actions">
          <button class="games-stage-action" id="games-stage-open-tab" type="button">Open in New Tab</button>
          <button class="games-stage-action" id="games-stage-load" type="button">Load</button>
          <button class="games-stage-action" id="games-stage-reload" type="button" style="display:none">Reload</button>
          <button class="games-stage-action games-stage-window-action minimize" id="games-stage-minimize" type="button" aria-label="Minimize" data-tooltip="Keep Paused">&minus;</button>
          <button class="games-stage-action games-stage-window-action maximize" id="games-stage-maximize" type="button" aria-label="Maximize" data-tooltip="Maximize">□</button>
          <button class="games-stage-action games-stage-window-action close" id="games-stage-close" type="button" aria-label="Close" data-tooltip="Close">×</button>
        </div>
      </div>

      <div class="games-stage-body" id="games-stage-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  App.bindGamesWindowInteractions();
  App.ensureGamesWindowRect(true);
  App.applyGamesWindowRect();
  App.updateGamesWindowChrome();
  App.$("games-stage-close").onclick = () => {
    App.closeGamesStage({
      preserve: false
    });
  };
  App.$("games-stage-minimize").onclick = () => {
    App.closeGamesStage({
      preserve: true
    });
  };
  App.$("games-stage-maximize").onclick = App.toggleGamesStageMaximize;
  App.$("games-stage-load").onclick = async () => {
    if (!App.selectedGame) return;
    const btn = App.$("games-stage-load");
    const prev = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Loading...";
    }
    try {
      const game = await App.ensureHtmlHubGameLoaded(App.selectedGame);
      if (!game) return;
      App.gamesStageLoaded = true;
      await App.renderGamesStage();
      App.syncGamesStageFullscreenButton();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev || "Load";
      }
    }
  };
  App.$("games-stage-reload").onclick = async () => {
    if (!App.selectedGame) return;
    const btn = App.$("games-stage-reload");
    const prev = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Loading...";
    }
    const frame = App.$("games-frame");
    if (frame) {
      App.resetGamesFrameInput(frame);
      if (App.selectedGame?.roomActivityId === App.ROOM_ACTIVITY_BOPL_ROYALE) {
        const controller = frame.contentWindow?.__boplRoyale;
        if (controller?.leaveActivity) {
          try {
            await Promise.race([Promise.resolve(controller.leaveActivity()), new Promise(resolve => setTimeout(resolve, 3000))]);
          } catch {}
        }
      }
      try {
        App.revokeGamesFrameBlobURL(frame);
        frame.removeAttribute("srcdoc");
        frame.src = "about:blank";
        frame.contentWindow?.stop?.();
        frame.contentWindow?.location?.replace?.("about:blank");
      } catch {}
      try {
        frame.remove();
      } catch {}
    }
    App.forgetParkedGamesFrame(App.selectedGame);
    const body = App.$("games-stage-body");
    if (body) {
      try {
        Array.from(body.children).forEach(child => { if (child.id !== "merge-party-paused-frame") child.remove(); });
      } catch {}
      body.classList.remove("game-mode");
    }
    try {
      const game = await App.ensureHtmlHubGameLoaded(App.selectedGame);
      if (!game) return;
      App.gamesStageLoaded = true;
      await App.renderGamesStage(true);
      App.syncGamesStageFullscreenButton();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev || "Reload";
      }
    }
  };
  App.$("games-stage-open-tab").onclick = async () => {
    if (!App.selectedGame) return;
    const btn = App.$("games-stage-open-tab");
    const prev = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Loading...";
    }
    try {
      const game = await App.ensureHtmlHubGameLoaded(App.selectedGame);
      if (!game) return;
      await App.openGameInNewTab(game);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev || "Open in Tab";
      }
    }
  };
  document.addEventListener("fullscreenchange", App.syncGamesStageFullscreenButton);
  overlay.addEventListener("click", e => {
    if (e.target !== overlay) return;
    if (App.gamesWindowDragState) return;
    if (Date.now() < App.gamesStageSuppressOverlayCloseUntil) return;
    App.closeGamesStage();
  });
};

App.register("activities/library-ui", function initializeFeature() {
App.htmlHubMenuEl = null;
App.htmlHubMenuCtx = null;
App.htmlHubMenuCloseOnEnd = null;
App.htmlHubMenuCloseSeq = 0;
App.htmlHubModalBindingsAbort = null;
});
})(globalThis.ChatApp);
