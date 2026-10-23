/* chat/header: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.syncComposerPrimaryAction = function () {
  const placeNow = App.getStoredPlace() || "home";
  const send = App.$("btn-send");
  if (!send) return;
  const setAction = (action, label, svg) => {
    send.dataset.action = action;
    send.dataset.tooltip = label;
    send.setAttribute("aria-label", label);
    send.removeAttribute("title");
    send.innerHTML = `<span class="composer-send-icon" aria-hidden="true">${svg}</span>`;
  };
  const sendSvg = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m21 3-6.5 18-4-7.5L3 9.5 21 3ZM21 3 10.5 13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  const cancelSvg = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.75 5.5A2.75 2.75 0 0 1 7.5 2.75h6A2.75 2.75 0 0 1 16.25 5.5v3.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M7.75 8.5h5M7.75 11.5h3.25" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
      <path d="m15.85 13.85 5.4 5.4M21.25 13.85l-5.4 5.4" stroke="currentColor" stroke-width="2.15" stroke-linecap="round"/>
      <path d="M6.75 18.5h4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
    </svg>
  `;
  const roomId = App.sanitizeRoomCode(App.currentRoomId);
  const editingThisRoom = !!(App.editState && roomId && App.editState.roomId === roomId && placeNow === `room:${roomId}`);
  setAction(editingThisRoom ? "cancel" : "send", editingThisRoom ? "Cancel Editing" : "Send Message", editingThisRoom ? cancelSvg : sendSvg);
};
App.setComposerEnabled = function (enabled) {
  const placeNow = App.getStoredPlace() || "home";
  const isRoom = placeNow.startsWith("room:");
  document.body.classList.toggle("composer-hidden-page", !enabled && (placeNow === "home" || placeNow === "schedules" || placeNow === "calendar" || placeNow.startsWith("calendar:")));
  const input = App.$("msg-input");
  const send = App.$("btn-send");
  const up = App.$("btn-upload");
  if (input) {
    input.disabled = !enabled;
    input.setAttribute("aria-label", "Message");
  }
  if (send) send.disabled = !enabled;
  if (up) {
    if (!enabled) {
      up.hidden = true;
      up.disabled = true;
    } else if (isRoom) {
      up.hidden = false;
      up.disabled = false;
    } else {
      up.hidden = true;
      up.disabled = true;
    }
  }
  if (input) {
    const editingThisRoom = !!(App.editState && App.currentRoomId && App.editState.roomId === App.sanitizeRoomCode(App.currentRoomId) && isRoom);
    input.placeholder = !enabled ? "Select a room to chat…" : editingThisRoom ? "Edit your message…" : "Type a message…";
  }
  App.syncComposerPrimaryAction();
  App.syncComposerToolLayout();
};

// One room toolbar is moved into the call header, retaining focus and handlers.
App.syncRoomToolbar = function () {
  const bar = App.$("room-toolbar");
  if (!bar) return;
  const inRoom = document.body.dataset.roomView === "1" && !!App.currentUser;
  const call = App.$("call-menu");
  const callActive = !!App.currentUser && !!call && !call.hidden && App.callMenuOpen && !!(App.currentCallRoomId || App.currentRoomId);
  const companion = (App.getCompanionChatMode?.() || "none") !== "none";
  const merged = callActive && !companion;
  const active = inRoom || merged;
  const room = merged ? App.currentCallRoomId || App.currentRoomId : App.currentRoomId;
  if (App.pinnedMessagePanelState && (!active || App.pinnedMessagePanelState.room !== room)) App.closePinnedMessages();
  if (App.roomSearchState && (!active || App.roomSearchState.room !== room)) App.closeRoomSearch();
  bar.hidden = !active;
  const members = App.$("btn-members");
  if (members) {
    members.hidden = !active;
    members.setAttribute("aria-expanded", String(room === App.currentRoomId && document.body.dataset.membersSidebar === "1"));
  }
  const host = merged ? call.querySelector(".call-menu-head") : document.querySelector(".chat-main");
  if (bar.parentElement !== host) host.prepend(bar);
  bar.classList.toggle("in-call", !!merged);
  const actions = App.roomToolbarCallActions;
  const actionHost = callActive && companion ? call.querySelector(".call-menu-head") : bar;
  if (actions.parentElement !== actionHost) actionHost.append(actions);
  actions.hidden = !callActive;
  const nav = App.$("btn-mobile-nav");
  const navHome = document.querySelector(".mobile-nav-anchor");
  if (active && nav.parentElement !== bar) bar.prepend(nav);
  if (!active && nav.parentElement !== navHome) navHome.prepend(nav);
  const meta = App.roomsMetaCache?.get(room);
  const name = App.roomDisplayName?.(room, meta) || room || "Room";
  const title = App.$("room-toolbar-name");
  if (title.textContent !== name) title.textContent = name;
  App.applyRoomIcon(App.$("room-toolbar-icon"), room, meta);
  App.$("room-search-input").placeholder = `Search ${name}`;
  App.$("room-search-input").setAttribute("aria-label", `Search messages in ${name}`);
  App.syncCompanionToolbarControls?.();
};

App.parseRoomSearch = function (raw) {
  const filters = {}, terms = [];
  const pattern = /(?:([a-z]+):\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+))|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
  for (const match of String(raw || "").matchAll(pattern)) {
    const key = match[1]?.toLowerCase();
    let value = String(match[2] || match[3] || "");
    if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/\\(['\\])/g, "$1");
    value = value.toLowerCase();
    if (key && ["from", "mentions", "has", "before", "after", "during", "on", "author", "is", "pinned"].includes(key)) (filters[key] ||= []).push(value);
    else terms.push(key ? `${key}:${value}` : value);
  }
  return { filters, terms };
};
App.roomSearchMatches = function (message, query) {
  const f = query.filters, text = String(message.text || "").toLowerCase();
  const attachments = Object.values(message.files || message.attachments || {}).filter(file => file && typeof file === "object");
  const systemText = message.t === "system" ? App.getSystemMessageText?.(message.system || {}) : "";
  const searchable = [text, systemText, message.poll?.question, message.fileName, ...attachments.map(file => file.fileName || file.name || "")].filter(Boolean).join(" ").toLowerCase();
  if (!query.terms.every(term => searchable.includes(term))) return false;
  // Compile identities once for a render's query. Filtering thousands of
  // messages must not rescan the entire member cache for every sender/mention.
  if ((f.from || f.mentions) && !query.userIndex) {
    const normalize = value => String(value || "").toLowerCase();
    query.userIndex = new Map();
    const requested = new Set((f.mentions || []).map(value => value.replace(/^@/, "")));
    if (requested.has("me")) requested.add(normalize(App.currentUser?.code));
    const targets = new Set(requested);
    for (const [code, user] of App.liveUserCache?.entries?.() || []) {
      const names = [...new Set([code, user?.username, user?.displayName].filter(Boolean).map(normalize))];
      query.userIndex.set(normalize(code), names);
      if (names.some(name => requested.has(name))) names.forEach(name => targets.add(name));
    }
    query.fromNames = new Set((f.from || []).map(value => value.replace(/^@/, "")));
    if (query.fromNames.has("me")) query.fromNames.add(normalize(App.currentUser?.code));
    query.mentionNames = targets;
    const names = [...targets].filter(Boolean).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    query.mentionPattern = names.length ? new RegExp(`(^|\\s)@(?:${names.join("|")})(?=\\s|$|[.,!?])`, "i") : null;
  }
  const code = String(message.userCode || "").toLowerCase();
  if (f.from && ![...(query.userIndex.get(code) || [code]), message.username, message.displayName].some(name => query.fromNames.has(String(name || "").toLowerCase()))) return false;
  if (f.mentions) {
    const mentions = Array.isArray(message.mentions) ? message.mentions : Object.keys(message.mentions || {}).filter(key => message.mentions[key]);
    const explicit = mentions.some(value => query.mentionNames.has(String(value).toLowerCase()));
    const token = [...text.matchAll(/@\{([^}]+)\}|<@([^>]+)>/g)].some(match => query.mentionNames.has(match[1] || match[2]));
    if (!explicit && !token && !query.mentionPattern?.test(text)) return false;
  }
  const has = kind => {
    if (kind === "link") return /https?:\/\/\S+/.test(text);
    if (kind === "embed") return !!(message.embed || message.embeds || /https?:\/\/\S+/.test(text));
    if (kind === "file") return attachments.length > 0 || ["image", "video", "audio", "file"].includes(message.t);
    if (kind === "poll") return !!message.poll;
    if (kind === "sticker") return message.t === "sticker" || attachments.some(a => a.stickerId || a.kind === "sticker" || a.type === "sticker") || !!message.sticker;
    const prefix = { image: "image", video: "video", sound: "audio", audio: "audio" }[kind];
    return !!prefix && (message.t === prefix || attachments.some(a => String(a.mime || a.mimeType || a.type || a.kind || "").startsWith(prefix)));
  };
  if (f.has && !f.has.every(has)) return false;
  const timestamp = App.getMessageSortTimestamp?.(message, message._key) || Number(message.createdAt);
  const day = value => {
    query.dayIndex ||= new Map();
    if (!query.dayIndex.has(value)) {
      const date = new Date(`${value}T00:00:00`);
      const canonical = Number.isFinite(+date) ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
      query.dayIndex.set(value, /^\d{4}-\d{2}-\d{2}$/.test(value) && canonical === value ? +date : NaN);
    }
    return query.dayIndex.get(value);
  };
  if (f.before && !f.before.every(value => timestamp < day(value))) return false;
  if (f.after && !f.after.every(value => { const d = new Date(day(value)); d.setDate(d.getDate() + 1); return timestamp >= +d; })) return false;
  if ((f.during || f.on) && ![...(f.during || []), ...(f.on || [])].every(value => { const start = day(value), end = new Date(start); end.setDate(end.getDate() + 1); return timestamp >= start && timestamp < +end; })) return false;
  const author = message.t === "system" || message.system || message.systemEvent || message.type === "system" ? "system" : message.bot || message.webhookId ? "bot" : "user";
  if ((f.author || f.is) && ![...(f.author || []), ...(f.is || [])].includes(author)) return false;
  if (f.pinned && !f.pinned.some(value => (value === "true") === !!message.pinned)) return false;
  return true;
};
App.disposeRoomSearchRow = function (row) {
  for (const message of row.querySelectorAll?.(".msg-row") || []) {
    try { message.__stickerUnsubscribe?.(); } catch {}
    App.messageAvatarObserver?.unobserve(message);
    App.messageAvatarRows?.delete(message);
    for (const audio of message.__previewAudio || []) {
      try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {}
      App.chatAudioPlayers?.delete(audio);
    }
  }
  row.querySelectorAll?.("video,audio").forEach(media => { try { media.pause(); media.removeAttribute("src"); media.load(); } catch {} });
};
App.closeRoomSearch = function ({ preserveQuery = false } = {}) {
  const state = App.roomSearchState;
  App.roomSearchState = null;
  App.cancelLiveUpdate?.("room-search");
  if (App.roomSearchRenderFrame) cancelAnimationFrame(App.roomSearchRenderFrame);
  App.roomSearchRenderFrame = 0;
  clearTimeout(App.roomSearchCloseTimer);
  const panel = App.$("room-search-panel");
  // Remove the surface from hit testing before releasing listeners or media.
  if (panel) { panel.hidden = true; panel.classList.remove("open", "closing"); }
  const input = App.$("room-search-input");
  input?.setAttribute("aria-expanded", "false");
  if (input && !preserveQuery) input.value = "";
  if (state) {
    state.closed = true;
    state.renderRevision = (state.renderRevision || 0) + 1;
    clearTimeout(state.renderTimer);
    const rows = [...state.rows.values()];
    // Closing stays constant-time even after searching a long room history.
    const release = () => {
      const end = performance.now() + 4;
      while (state.listeners.length && performance.now() < end) {
        const [ref, event, cb] = state.listeners.pop(); ref.off(event, cb);
      }
      while (rows.length && performance.now() < end) App.disposeRoomSearchRow(rows.pop());
      if (state.listeners.length || rows.length) setTimeout(release, 0);
    };
    setTimeout(release, 0);
  }
  App.closeCalendarDatePicker?.();
  panel?.querySelectorAll?.("select").forEach(select => App.closeCustomSelect?.(App.customSelectState?.get(select)));
  App.$("room-search-results")?.replaceChildren();
  App.$("room-search-suggestions")?.replaceChildren();
};
App.renderRoomSearch = async function () {
  const state = App.roomSearchState;
  if (!state || state.closed) return;
  const revision = state.renderRevision = (state.renderRevision || 0) + 1;
  const current = () => App.roomSearchState === state && !state.closed && revision === state.renderRevision;
  const query = App.parseRoomSearch(App.$("room-search-input").value);
  const author = App.$("room-search-author"), authorValue = query.filters.author?.[0] || query.filters.is?.[0] || "";
  if (author && author.value !== authorValue) author.value = authorValue;
  for (const key of ["before", "after", "during"]) {
    const picker = App.$("room-search-date-" + key);
    const value = query.filters[key]?.[0] || (key === "during" ? query.filters.on?.[0] : "") || "";
    if (picker && picker.dataset.value !== value) App.updateCalendarDatePicker?.(picker, { value });
  }
  const list = App.$("room-search-results");
  const populated = !!App.$("room-search-input").value.trim() && !/^(from|mentions|has):\s*$/i.test(App.$("room-search-input").value.trim());
  App.$("room-search-status").dataset.filters = String(!populated);
  App.$("room-search-filters").hidden = populated;
  list.hidden = !populated;
  const sortControl = App.$("room-search-sort");
  App.customSelectState?.get(sortControl)?.wrap?.toggleAttribute("hidden", !populated);
  sortControl.hidden = !populated;
  App.$("room-search-more").hidden = true;
  if (!populated) {
    state.rows?.forEach(row => App.disposeRoomSearchRow(row));
    state.rows?.clear();
    list.replaceChildren();
    App.$("room-search-status").textContent = "Filters";
    App.positionRoomSearch?.();
    return;
  }
  App.loadRoomSearchHistory?.(state);
  const sort = App.$("room-search-sort").value;
  const results = [];
  let totalMatches = 0;
  const compare = (a, b) => (sort === "oldest" ? 1 : -1) * App.compareMessagesChronologically(a, b);
  let budget = performance.now() + 4;
  for (const message of state.messages.values()) {
    if (App.roomSearchMatches(message, query)) {
      totalMatches++;
      // Keep only the visible best matches; sorting an entire room would
      // create another uninterrupted main-thread task after the scan.
      let low = 0, high = results.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compare(message, results[middle]) < 0) high = middle; else low = middle + 1; }
      if (low < state.limit) { results.splice(low, 0, message); if (results.length > state.limit) results.pop(); }
    }
    if (performance.now() >= budget) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current()) return;
      budget = performance.now() + 4;
    }
  }
  if (!current()) return;
  App.$("room-search-status").textContent = String(totalMatches) + (state.loading ? "+" : "") + " results" + (state.loading ? " · Searching older messages…" : state.error ? " · Could not load all history" : "");
  const visible = new Set();
  const nodes = [];
  state.rows ||= new Map();
  for (const message of results.slice(0, state.limit)) {
    const key = message._key;
    const replyKey = String(message.replyTo?.key || "");
    const reply = replyKey ? state.messages.get(replyKey) : null;
    const replyDeleted = state.deleted.has(replyKey);
    visible.add(key);
    let row = state.rows.get(key);
    if (!row || row.__searchMessage !== message || row.__searchReply !== reply || row.__searchReplyDeleted !== replyDeleted) {
      if (row) App.disposeRoomSearchRow(row);
      row = document.createElement("article");
      row.className = "room-search-result";
      row.dataset.searchKey = key;
      row.__searchMessage = message;
      row.__searchReply = reply;
      row.__searchReplyDeleted = replyDeleted;
      App.appendMessageRow(message, {
        target: row, preview: true, roomId: state.room,
        replyTargetMessage: reply, replyDeleted,
        onReplyJump: App.jumpToRoomSearchMessage
      });
      const jump = document.createElement("button");
      jump.className = "room-search-jump"; jump.type = "button"; jump.textContent = "Jump";
      jump.setAttribute("aria-label", "Jump to message");
      jump.addEventListener("click", () => void App.jumpToRoomSearchMessage(key));
      row.append(jump);
      state.rows.set(key, row);
      if (performance.now() >= budget) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return;
        budget = performance.now() + 4;
      }
    }
    if (replyKey && !/[.#$\[\]/\u0000-\u001f\u007f]/.test(replyKey) && !state.replyKeys.has(replyKey)) {
      state.replyKeys.add(replyKey);
      const ref = App.db.ref("messages/" + state.room + "/" + replyKey);
      const cb = snap => {
        if (state.closed) return;
        state.liveTouched.add(snap.key);
        if (snap.exists()) { state.deleted.delete(snap.key); state.messages.set(snap.key, { ...snap.val(), _key: snap.key }); }
        else { state.messages.delete(snap.key); state.deleted.add(snap.key); }
        App.scheduleRoomSearchRender();
      };
      ref.on("value", cb);
      state.listeners.push([ref, "value", cb]);
    }
    nodes.push(row);
  }
  for (const [key, row] of state.rows) if (!visible.has(key)) { App.disposeRoomSearchRow(row); state.rows.delete(key); }
  if (!results.length) {
    const empty = document.createElement("p"); empty.className = "room-search-empty";
    empty.textContent = state.loading ? "Searching room history…" : "No messages match these filters.";
    nodes.push(empty);
  }
  App.reconcileChildren(list, nodes);
  for (const row of list.querySelectorAll(".msg-row")) App.queueMessageAvatarAlignment?.(row);
  App.$("room-search-more").hidden = totalMatches <= state.limit;
  App.positionRoomSearch?.();
};
App.scheduleRoomSearchRender = function () {
  const state = App.roomSearchState;
  if (!state || state.closed || state.renderTimer) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = 0;
    if (App.roomSearchState === state && !state.closed) App.queueLiveUpdate("room-search", () => void App.renderRoomSearch());
  }, 80);
};
App.openRoomSearch = function () {
  const room = App.$("room-toolbar").classList.contains("in-call") ? App.currentCallRoomId || App.currentRoomId : App.currentRoomId;
  if (!room || !App.currentUser) return;
  if (App.roomSearchState?.room === room) return;
  // Opening also releases an old search session; retain newly entered text.
  App.closeRoomSearch({ preserveQuery: true });
  clearTimeout(App.roomSearchCloseTimer);
  const panel = App.$("room-search-panel");
  panel.hidden = false;
  panel.classList.remove("closing");
  panel.classList.remove("open");
  App.positionRoomSearch?.();
  void panel.offsetWidth;
  panel.classList.add("open");
  App.$("room-search-input").setAttribute("aria-expanded", "true");
  const state = App.roomSearchState = { room, owner: String(App.currentUser.code), rows: new Map(), messages: new Map(), liveTouched: new Set(), deleted: new Set(), replyKeys: new Set(), serverKeys: new Set(), listeners: [], limit: 30, loading: false, closed: false };
  const cacheKey = state.owner + ":" + room;
  App.roomSearchCache ||= new Map();
  const cached = App.roomSearchCache.get(cacheKey);
  if (cached) state.messages = new Map(cached);
  if (room === App.currentRoomId) App.msgDataByKey?.forEach((message, key) => { if (!message.__stub) state.messages.set(key, { ...message, _key: key }); });
  App.renderRoomSearch();
};
App.loadRoomSearchHistory = function (state) {
  if (!state || state.started || state.closed) return;
  state.started = true; state.loading = true;
  const base = App.db.ref("messages/" + state.room);
  const current = () => !state.closed && App.roomSearchState === state && String(App.currentUser?.code) === state.owner;
  const failed = failure => {
    if (!current()) return;
    state.error = true;
    if (/permission.?denied/i.test(String(failure?.code || failure?.message || ""))) {
      App.roomSearchCache.delete(state.owner + ":" + state.room);
      App.closeRoomSearch();
      App.showToast?.({ title: "Search unavailable", body: "You no longer have access to search this room.", duration: 3500 });
      return;
    }
    App.scheduleRoomSearchRender();
  };
  const update = snap => {
    if (!current() || !snap.val()) return;
    state.liveTouched.add(snap.key); state.deleted.delete(snap.key);
    state.messages.set(snap.key, { ...snap.val(), _key: snap.key });
    App.scheduleRoomSearchRender();
  };
  const remove = snap => {
    if (!current()) return;
    state.liveTouched.add(snap.key); state.messages.delete(snap.key); state.deleted.add(snap.key);
    App.scheduleRoomSearchRender();
  };
  const listen = (ref, event, callback) => {
    if (!current()) return;
    state.listeners.push([ref, event, callback]); ref.on(event, callback, failed);
  };
  // A limited live tail avoids downloading the entire room on focus. Older
  // ranges are watched only after their bounded page has been indexed.
  const tail = base.orderByKey().limitToLast(100);
  listen(tail, "child_added", update);
  listen(tail, "child_changed", update);
  listen(tail, "child_removed", snap => {
    // Leaving a limited query can mean eviction, not deletion.
    void base.child(snap.key).once("value").then(value => {
      if (!current()) return;
      if (value.exists()) update(value); else remove(snap);
    }).catch(failed);
  });
  void (async () => {
    let oldest = null;
    const seededKeys = [...state.messages.keys()];
    try {
      while (current()) {
        let page = base.orderByKey(); if (oldest) page = page.endAt(oldest);
        const snapshot = await page.limitToLast(101).once("value");
        if (!current()) return;
        const entries = []; snapshot.forEach(child => { if (child.key !== oldest) entries.push(child); });
        for (const child of entries) {
          state.serverKeys.add(child.key);
          if (!state.liveTouched.has(child.key) && !state.deleted.has(child.key)) state.messages.set(child.key, { ...child.val(), _key: child.key });
        }
        if (entries.length) {
          const atBeginning = entries.length < (oldest ? 100 : 101);
          let range = base.orderByKey().endAt(oldest || entries.at(-1).key);
          if (!atBeginning) range = range.startAt(entries[0].key);
          listen(range, "child_changed", update); listen(range, "child_removed", remove);
          // Covers delayed offline writes whose keys land inside this page.
          listen(range, "child_added", update);
        } else if (oldest) {
          // Exact multiples end with an empty page. Still observe delayed
          // offline inserts that sort before the first known message.
          const beginning = base.orderByKey().endAt(oldest);
          listen(beginning, "child_added", update);
          listen(beginning, "child_changed", update);
          listen(beginning, "child_removed", remove);
        }
        App.scheduleRoomSearchRender();
        if (entries.length < (oldest ? 100 : 101)) break;
        oldest = entries[0]?.key; if (!oldest) break;
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (current()) for (const key of seededKeys) if (!state.serverKeys.has(key) && !state.liveTouched.has(key)) { state.messages.delete(key); state.deleted.add(key); }
    } catch (failure) { failed(failure); }
    finally {
      state.loading = false;
      if (current()) {
        const key = state.owner + ":" + state.room;
        // Memory only: old account data never persists onto disk, and at most
        // three modest room indexes survive closing their search menu.
        if (state.messages.size <= 10000) {
          App.roomSearchCache.delete(key); App.roomSearchCache.set(key, state.messages);
          while (App.roomSearchCache.size > 3) App.roomSearchCache.delete(App.roomSearchCache.keys().next().value);
        }
        App.scheduleRoomSearchRender();
      }
    }
  })();
};
App.jumpToRoomSearchMessage = async function (key) {
  return App.jumpToRoomMessage(key, { roomId: App.roomSearchState?.room });
};
// Search, pins and reply previews share the same bounded history-window jump.
App.jumpToRoomMessage = async function (key, { roomId, retainedPin = false } = {}) {
  const room = App.sanitizeRoomCode(roomId || App.currentRoomId), owner = String(App.currentUser?.code || "");
  key = String(key || "");
  if (!room || !owner || !key || /[.#$\[\]/\u0000-\u001f\u007f]/.test(key)) return;
  const jump = App.roomSearchJumpSeq = (App.roomSearchJumpSeq || 0) + 1;
  const sameAccount = () => jump === App.roomSearchJumpSeq && owner === String(App.currentUser?.code || "");
  let deadline, cancelled = false, validContext = sameAccount;
  try {
    if (room !== App.currentRoomId) await App.openRoom(room, { quiet: true });
    const loadSeq = App.roomLoadingSeq;
    let revision = App.msgHistoryRevision;
    const current = () => sameAccount() && room === App.currentRoomId && loadSeq === App.roomLoadingSeq && revision === App.msgHistoryRevision && App.getStoredPlace() === `room:${room}`;
    validContext = current;
    if (!current()) return;
    // A newly opened call room first finishes its own initial-tail render. Its
    // queued initial rows must not repopulate the old tail after we jump away.
    const ready = async () => {
      while (!cancelled && current() && (App.msgInitialTailPending || App.bulkLoading)) await new Promise(resolve => setTimeout(resolve, 20));
    };
    await Promise.race([ready(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("timeout")), 10000); })]);
    clearTimeout(deadline);
    if (!current()) return;
    if (!App.msgElByKey.has(key)) {
      const ref = App.db.ref(`messages/${room}`).orderByKey(), liveRevision = App.msgLiveRevision;
      const snapshots = await Promise.race([
        Promise.all([ref.endAt(key).limitToLast(25).once("value"), ref.startAt(key).limitToFirst(26).once("value"), retainedPin ? App.db.ref(`pinnedMessages/${room}/${key}`).once("value") : null]),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("timeout")), 10000); })
      ]);
      clearTimeout(deadline);
      if (!current()) return;
      const byKey = new Map();
      for (const snapshot of snapshots.slice(0, 2)) snapshot.forEach(child => { if (child.val()) byKey.set(child.key, { ...child.val(), _key: child.key }); });
      const retainedOnly = !byKey.has(key) && !!snapshots[2]?.val();
      // Clearing a room can remove the original while its pinned copy survives.
      // Display that copy without writing it back into the room's history.
      if (retainedOnly) byKey.set(key, { ...snapshots[2].val(), _key: key, pinned: true });
      if (!byKey.has(key)) { App.showToast?.({ title: "Message unavailable", body: "That message has been deleted or is no longer available.", duration: 3000 }); return; }
      // Replace the visible window instead of leaving a silent gap between an
      // old search hit and today's tail. Retain the room's live subscription.
      App.stopChatBottomFollowing?.(); App.cancelRoomEntryScroll?.();
      App.suspendAutoScrollUntil = Date.now() + 2500;
      App.suppressHistoryAutoLoadUntil = Date.now() + 1400;
      revision = App.msgHistoryRevision = (revision || 0) + 1;
      App.msgLoadingOlder = false; App.msgLoadingNewer = false; App.msgHasNewerHistory = true;
      const retired = [...App.msgElByKey.keys()];
      for (const [retiredKey, row] of App.msgElByKey) {
        row.querySelectorAll?.("audio,video").forEach(media => { try { media.pause(); media.removeAttribute("src"); media.load(); } catch {} });
        try { row.__stickerUnsubscribe?.(); } catch {}
        App.messageAvatarObserver?.unobserve(row); App.messageAvatarRows?.delete(row);
        App.cancelMessageMediaRefresh?.(room, retiredKey); row.remove();
      }
      App.msgElByKey.clear(); App.msgDataByKey.clear(); App.renderedMsgKeys.clear();
      App.replyTargetPreviewCache?.clear(); App.replyTargetHydratePending?.clear();
      App.releaseMessageWindowKeys?.(retired);
      const items = [...byKey.values()].sort(App.compareMessagesChronologically), fragment = document.createDocumentFragment();
      for (const message of items) {
        App.renderedMsgKeys.add(message._key);
        App.appendMessageRow(message, { target: fragment, suppressScroll: true });
        const displayed = App.msgDataByKey.get(message._key) || message;
        if (App.messageHasPendingChunkedMedia?.(displayed)) App.scheduleMessageMediaRefresh?.(room, message._key, 120);
      }
      for (const row of [...fragment.childNodes]) { App.insertMessageRowChronologically(App.messagesListEl, row); App.messageAvatarObserver?.observe(row); App.queueMessageAvatarAlignment?.(row); }
      App.msgOldestKey = [...App.renderedMsgKeys].sort(App.compareMessageKeys)[0] || null;
      App.msgAllHistoryLoaded = snapshots[0].numChildren() < 25;
      App.msgHasNewerHistory = snapshots[1].numChildren() >= 26 || liveRevision !== App.msgLiveRevision;
      App.watchMessageHistoryPage?.(retainedOnly ? items.filter(item => item._key !== key) : items);
      App.scheduleRoomEmptyStateSync?.();
    }
    if (!current()) return;
    App.closeRoomSearch(); App.closePinnedMessages?.(); App.closeCallMenu?.();
    await App.scrollToMessageKey(key);
  } catch {
    if (validContext() && room === App.currentRoomId) App.showToast?.({ title: "Message unavailable", body: "Could not load this message. Check your connection and try again.", duration: 3500 });
  } finally { cancelled = true; clearTimeout(deadline); }
};

App.register("chat/header", function initializeFeature() {
  App.roomToolbarCallActions = document.querySelector(".call-menu-head-actions");
  const bar = document.createElement("header"); bar.id = "room-toolbar"; bar.className = "room-toolbar"; bar.hidden = true;
  bar.innerHTML = '<div class="room-toolbar-heading"><span class="room-toolbar-avatar"><img id="room-toolbar-icon" alt="" draggable="false"></span><strong id="room-toolbar-name"></strong></div><div class="room-search-wrap"><input id="room-search-input" type="text" enterkeyhint="search" autocomplete="off" placeholder="Search room" aria-expanded="false" aria-controls="room-search-panel"></div>';
  document.querySelector(".chat-main").prepend(bar);
  const pinsButton = document.createElement("button"); pinsButton.type="button"; pinsButton.id="btn-pinned-messages";
  pinsButton.className="icon-btn room-toolbar-action"; pinsButton.setAttribute("aria-label","Pinned Messages");
  pinsButton.setAttribute("aria-expanded","false"); pinsButton.dataset.tooltip="Pinned Messages"; pinsButton.innerHTML=App.getMessagePinIcon();
  pinsButton.onclick=()=>App.pinnedMessagePanelState ? App.closePinnedMessages() : App.openPinnedMessages(); bar.append(pinsButton);
  document.addEventListener("pointerdown",event=>{if(App.pinnedMessagePanelState && !event.target.closest('#pinned-messages-panel,#btn-pinned-messages,#msg-menu,.user-profile-popover')) App.closePinnedMessages();});
  document.addEventListener("keydown",event=>{if(event.key==="Escape") App.closePinnedMessages();});
  window.addEventListener("resize",App.positionPinnedMessages);
  window.visualViewport?.addEventListener("resize",App.positionPinnedMessages);
  for (const id of ["btn-activities", "btn-members", "btn-side-call"]) {
    const button = App.$(id);
    if (!button) continue;
    button.className = "icon-btn room-toolbar-action";
    bar.append(button);
  }
  const panel = document.createElement("section"); panel.id = "room-search-panel"; panel.className = "room-search-panel chat-popup"; panel.hidden = true; panel.setAttribute("aria-label", "Search room messages");
  panel.innerHTML = '<div class="room-search-panel-head"><strong id="room-search-status" role="status"></strong><select id="room-search-sort" aria-label="Sort results"><option value="newest">Newest</option><option value="oldest">Oldest</option></select><button type="button" id="room-search-close" class="chat-icon-button" aria-label="Close Search" data-tooltip="Close Search"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></button></div><div id="room-search-filters"><button type="button" data-filter="from:"><b>From a specific user</b><span>from: username</span></button><button type="button" data-filter="has:"><b>Includes a specific type of data</b><span>has: link, embed or file</span></button><button type="button" data-filter="mentions:"><b>Mentions a specific user</b><span>mentions: username</span></button><button type="button" id="room-search-more-filters" aria-expanded="false"><b>More filters</b><span>Dates, author type, and more</span></button></div><div id="room-search-suggestions"></div><div id="room-search-advanced" hidden><label data-filter-date="before">Before</label><label data-filter-date="after">After</label><label data-filter-date="during">On Date</label><label>Author Type<select id="room-search-author"><option value="">Everyone</option><option value="user">User</option><option value="bot">Bot</option><option value="system">System</option></select></label></div><div id="room-search-results"></div><button type="button" id="room-search-more" hidden>Show more results</button>';
  panel.insertBefore(panel.querySelector("#room-search-suggestions"), panel.querySelector("#room-search-filters"));
  document.body.append(panel);
  const input = App.$("room-search-input");
  const position = App.positionRoomSearch = () => {
    if (panel.hidden) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const rect = bar.getBoundingClientRect();
    const pane = document.querySelector(".chat-main")?.getBoundingClientRect();
    const companion = (App.getCompanionChatMode?.() || "none") !== "none";
    const desired = companion && pane?.width >= 240 ? Math.min(500, pane.width - 16) : 500;
    const panelWidth = Math.max(1, Math.min(desired, width - 16));
    const below = Math.max(0, top + height - rect.bottom - 16);
    const above = Math.max(0, rect.top - top - 16);
    const useBelow = below >= Math.min(240, height / 2) || below >= above;
    const available = Math.max(1, Math.min(height - 16, useBelow ? below : above));
    panel.style.setProperty("--chat-popup-width", panelWidth + "px");
    panel.style.setProperty("--chat-popup-max-height", available + "px");
    const panelHeight = panel.offsetHeight;
    const x = Math.max(left + 8, Math.min(rect.right - panelWidth - 8, left + width - panelWidth - 8));
    const y = Math.max(top + 8, Math.min(useBelow ? rect.bottom + 8 : rect.top - panelHeight - 8, top + height - panelHeight - 8));
    panel.style.setProperty("--chat-popup-left", x + "px");
    panel.style.setProperty("--chat-popup-top", y + "px");
  };
  const suggest = () => {
    const match = input.value.match(/(?:^|\s)(from|mentions|has):\s*([^\s]*)$/i), host = App.$("room-search-suggestions"); host.replaceChildren();
    if (!match) return;
    const values = match[1].toLowerCase() === "has" ? ["link", "embed", "file", "image", "video", "sound", "sticker", "poll"] : [...new Set([...(App.liveUserCache?.values?.() || [])].filter(u => u?.username).map(u => u.username))];
    values.filter(value => value.toLowerCase().includes(match[2].toLowerCase())).slice(0, 12).forEach(value => {
      const button = document.createElement("button"); button.type = "button";
      if (match[1].toLowerCase() !== "has") {
        const user = [...(App.liveUserCache?.values?.() || [])].find(user => user?.username === value);
        const avatar = document.createElement("span"); avatar.className = "room-search-user-avatar";
        App.applyAvatar(avatar, user); button.append(avatar);
      }
      const name = document.createElement("span"); name.textContent = value; button.append(name);
      button.addEventListener("click", () => {
        input.value = input.value.slice(0, match.index) + " " + match[1] + ":" + JSON.stringify(value) + " ";
        input.dispatchEvent(new Event("input")); input.focus();
      });
      host.append(button);
    });
  };
  const open = () => { App.openRoomSearch(); position(); suggest(); };
  input.addEventListener("focus", open);
  input.addEventListener("input", () => { open(); if (App.roomSearchState) App.roomSearchState.limit = 30; App.renderRoomSearch(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { App.closeRoomSearch(); input.blur(); }
    if (event.key === "Enter") { event.preventDefault(); open(); App.renderRoomSearch(); }
    if (event.key === "ArrowDown") { event.preventDefault(); panel.querySelector("#room-search-suggestions button, #room-search-filters button")?.focus(); }
  });
  App.$("room-search-close").addEventListener("click", () => { App.closeRoomSearch(); input.blur(); });
  panel.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => { input.value += (input.value ? " " : "") + button.dataset.filter; input.focus(); input.dispatchEvent(new Event("input")); }));
  App.$("room-search-more-filters").addEventListener("click", event => {
    const advanced = App.$("room-search-advanced");
    advanced.hidden = !advanced.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!advanced.hidden)); position();
  });
  const setFilter = (key, value) => {
    input.value = (input.value.replace(new RegExp("(?:^|\\s)" + key + ":\\S+", "gi"), "").trim() + (value ? " " + key + ":" + value : "")).trim();
    App.renderRoomSearch();
  };
  panel.querySelectorAll("[data-filter-date]").forEach(field => {
    const key = field.dataset.filterDate;
    field.append(App.createCalendarDatePicker({
      id: "room-search-date-" + key, value: "", label: field.textContent,
      allowYears: true, allowClear: true, min: "1900-01-01", max: "9999-12-31",
      onChange: value => setFilter(key, value)
    }));
  });
  App.$("room-search-author").addEventListener("change", event => setFilter("author", event.target.value));
  App.$("room-search-sort").addEventListener("change", App.renderRoomSearch);
  App.$("room-search-more").addEventListener("click", () => { if (App.roomSearchState) { App.roomSearchState.limit += 30; App.renderRoomSearch(); } });
  document.addEventListener("pointerdown", event => {
    if (panel.hidden || panel.contains(event.target) || event.target.closest('.room-search-wrap, .calendar-date-picker-pop[data-search-picker="1"], .modal, .user-profile-popover, #msg-menu, #msg-text-menu')) return;
    if ([...panel.querySelectorAll("select")].some(select => App.customSelectState?.get(select)?.pop?.contains(event.target))) return;
    const pollMenu = App.$("poll-popover");
    if (pollMenu?.contains(event.target) && panel.contains(pollMenu._chatPopupAnchor)) return;
    App.closeRoomSearch();
  });
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "f" && !bar.hidden) { event.preventDefault(); input.focus(); }
    if (event.key === "Escape" && !panel.hidden) App.closeRoomSearch();
  });
  window.addEventListener("resize", position);
  window.visualViewport?.addEventListener("resize", position);
  window.visualViewport?.addEventListener("scroll", position);
  const sync = App.rafThrottle(() => { App.syncRoomToolbar(); position(); });
  new ResizeObserver(position).observe(bar);
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["data-room-view", "data-mode", "data-mobile-ui", "data-companion-mode", "data-companion-chat"] });
  new MutationObserver(sync).observe(App.$("call-menu"), { attributes: true, attributeFilter: ["hidden", "class"] });
  new MutationObserver(sync).observe(App.$("rooms-list"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "style"] });
});
})(globalThis.ChatApp);
