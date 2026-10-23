/* admin/panel: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.isVinny = function () {
  return !!(App.currentUser && String(App.currentUser.username || "") === "Vinny");
};
App.syncPanelButtonVisibility = function () {
  const btn = App.$("btn-side-panel");
  if (!btn) return;
  btn.hidden = !App.isVinny();
};
App.normalizeAdminGhostRooms = function (raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [roomId, enabled] of Object.entries(raw)) {
    const id = App.sanitizeRoomCode(roomId);
    if (id && enabled === true) out[id] = true;
  }
  return out;
};
App.isGhostModeEnabledForRoom = function (roomId, userCode = App.currentUser?.code) {
  const id = App.sanitizeRoomCode(roomId);
  const code = String(userCode || "").trim();
  if (!id || !code) return false;
  const live = App.liveUserCache.get(code) || null;
  const user = String(App.currentUser?.code || "") === code ? App.currentUser : null;
  const ghostRooms = App.normalizeAdminGhostRooms(live?.adminGhostRooms || user?.adminGhostRooms || {});
  return ghostRooms[id] === true;
};
App.setGhostModeForRoom = async function (roomId, enabled) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !App.currentUser || !App.isVinny()) return false;
  const selfCode = String(App.currentUser.code || "");
  const nextRooms = App.normalizeAdminGhostRooms(App.currentUser.adminGhostRooms || {});
  if (enabled) nextRooms[id] = true;else delete nextRooms[id];
  await App.db.ref(`users/${selfCode}/${App.ADMIN_GHOST_ROOMS_NODE}/${id}`).set(enabled ? true : null);
  App.currentUser.adminGhostRooms = nextRooms;
  App.liveUserCache.set(selfCode, {
    ...(App.liveUserCache.get(selfCode) || {}),
    code: selfCode,
    username: App.currentUser.username || "User",
    usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
    displayName: App.currentUser.displayName || App.currentUser.username || "User",
    displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
    photoDataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
    photoTransform: App.currentUser.photoTransform || null,
    adminGhostRooms: nextRooms
  });
  if (App.currentRoomId === id) {
    if (enabled) {
      App.stopRoomPresence();
      App.onlinePresenceCache.delete(selfCode);
      App.roomMembersCache.delete(selfCode);
      App.roomCallMembersCache.delete(selfCode);
    } else {
      App.roomMembersCache.set(selfCode, true);
      App.startRoomPresence(id);
    }
    try {
      App.renderOnlineIndicator();
    } catch {}
  }
  App.showToast({
    title: enabled ? "Ghost Mode enabled" : "Ghost Mode disabled",
    body: enabled ? `You are hidden in ${App.roomDisplayName(id)}.` : `You are visible in ${App.roomDisplayName(id)}.`,
    duration: 1800
  });
  return true;
};

// Expand branches in place. Shallow reads never download attachment collections.
App.normalizeDatabasePath = function (value) {
  const valuePath = String(value || "").trim().replace(/^\/+|\/+$/g, "");
  if (valuePath.length > 2048 || /[.#$\[\]\u0000-\u001f\u007f]/.test(valuePath) || valuePath.split("/").some(key => !key && valuePath)) throw new Error("Enter a valid database path.");
  return valuePath;
};
App.adminDatabaseCurrent = state => App.adminDatabase === state && !state.closed && App.isVinny() && state.owner === App.currentUser?.code;
// Expanding a payload's parent must not download every megabyte-sized leaf.
// Individual values remain fully editable when explicitly loaded.
App.isDatabasePayloadPath = path => /^(?:attachmentBlobs\/.*\/parts\/[^/]+|htmlHub\/files\/[^/]+\/html\d*|stickers\/assets\/[^/]+\/dataURL\d*)$/.test(path) || /\/(?:photoDataURL|bannerDataURL|dataURL)\d*$/.test(path);
App.stopAdminDatabase = function () {
  const state = App.adminDatabase;
  if (!state) return;
  state.closed = true;
  clearInterval(state.refreshTimer);
  for (const node of state.nodes.values()) { node.controller?.abort(); node.ref?.off("value", node.cb); }
  App.setAdminDatabaseExpanded(false);
  App.adminDatabase = null;
};
App.setAdminDatabaseExpanded = function (expanded) {
  const state = App.adminDatabase;
  if (!state) return;
  const close = App.$("btn-modal-close");
  if (expanded && !state.expanded && close) {
    state.closeHome = close.parentNode;
    state.closeNext = close.nextSibling;
    state.host.querySelector(".database-actions")?.append(close);
  } else if (!expanded && state.expanded && close && state.closeHome) {
    state.closeHome.insertBefore(close, state.closeNext?.parentNode === state.closeHome ? state.closeNext : null);
  }
  state.expanded = !!expanded;
  App.modalEl.classList.toggle("database-expanded", !!expanded);
  state.host.querySelector('[data-db-action="expand"]')?.setAttribute("aria-pressed", String(!!expanded));
  const button = state.host.querySelector('[data-db-action="expand"]');
  if (button) { button.setAttribute("aria-label", expanded ? "Collapse Database" : "Expand Database"); button.title = button.getAttribute("aria-label"); }
  if (expanded) { state.scrollBeforeExpand = App.$("modal-body").scrollTop; App.$("modal-body").scrollTop = 0; }
  else if (state.scrollBeforeExpand != null) App.$("modal-body").scrollTop = state.scrollBeforeExpand;
};
App.bindAdminDatabase = function () {
  App.stopAdminDatabase();
  const host = App.$("panel-database");
  if (!host || !App.isVinny()) return;
  const state = { host, owner: App.currentUser.code, nodes: new Map(), closed: false, jobs: [], active: 0 };
  App.adminDatabase = state;
  const expandIcon = App.$("btn-time-display-expand")?.innerHTML || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/></svg>';
  host.innerHTML = '<div class="database-heading"><strong>Realtime Database</strong><div class="database-actions"><button class="icon-btn" type="button" data-db-action="refresh" aria-label="Refresh Database" title="Refresh Database">↻</button><button class="icon-btn" type="button" data-db-action="expand" aria-label="Expand Database" title="Expand Database" aria-pressed="false">' + expandIcon + '</button></div></div><div class="muted small" role="status" data-db-status></div><div class="database-tree" role="tree" aria-label="Realtime Database"></div>';
  host.onclick = event => {
    const button = event.target.closest("[data-db-action]");
    if (!button || !App.adminDatabaseCurrent(state)) return;
    const node = state.nodes.get(button.closest("[data-db-node]")?.dataset.dbNode || "");
    const action = button.dataset.dbAction;
    if (action === "expand") return App.setAdminDatabaseExpanded(!state.expanded);
    if (action === "refresh") return App.refreshAdminDatabase();
    if (!node) return;
    if (action === "toggle") {
      node.expanded = !node.expanded;
      App.renderAdminDatabaseNode(node);
      if (node.expanded) void App.loadAdminDatabaseNode(node, true);
    }
    if (action === "more") { node.limit += 100; App.renderAdminDatabaseChildren(node); }
    if (action === "retry" || action === "load") void App.loadAdminDatabaseNode(node, true);
    if (action === "add") App.addAdminDatabaseChild(node);
    if (action === "delete") {
      if (!node.path) return;
      if (button.dataset.confirm !== "1") { button.dataset.confirm = "1"; button.textContent = "Delete?"; button.title = "Confirm Delete"; return; }
      button.disabled = true;
      void App.db.ref(node.path).remove().then(() => { App.adminDatabaseStatus("Deleted"); void App.loadAdminDatabaseNode(state.nodes.get(node.parent), true); }).catch(error => { button.disabled = false; App.adminDatabaseStatus(error.message); });
    }
  };
  host.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.expanded) { event.stopPropagation(); event.preventDefault(); App.setAdminDatabaseExpanded(false); }
  });
  App.createAdminDatabaseNode("", "", host.querySelector(".database-tree"));
  const rootNode = state.nodes.get(""); rootNode.expanded = true;
  void App.loadAdminDatabaseNode(rootNode);
  state.refreshTimer = setInterval(() => { if (!document.hidden) void App.refreshAdminDatabase({ quiet: true }); }, 15000);
};
App.adminDatabaseStatus = function (message) {
  const target = App.adminDatabase?.host.querySelector("[data-db-status]");
  if (target) target.textContent = message;
};
App.createAdminDatabaseNode = function (valuePath, parent, host) {
  const state = App.adminDatabase;
  const el = document.createElement("div"); el.className = "database-node"; el.dataset.dbNode = valuePath;
  el.setAttribute("role", "treeitem");
  const node = { path: valuePath, parent, el, loaded: false, branch: true, expanded: false, limit: 100, keys: [] };
  el.innerHTML = '<div class="database-row"></div><div class="database-children" role="group" hidden></div>';
  state.nodes.set(valuePath, node); host.append(el); App.renderAdminDatabaseNode(node);
  return node;
};
App.queueAdminDatabaseRead = function (job) {
  const state = App.adminDatabase;
  return new Promise(resolve => {
    state.jobs.push(async () => { try { await job(); } finally { resolve(); } });
    const run = () => {
      while (!state.closed && state.active < 6 && state.jobs.length) {
        state.active++;
        void state.jobs.shift()().finally(() => { state.active--; run(); });
      }
      if (state.closed) { for (const pending of state.jobs.splice(0)) void pending(); }
    };
    run();
  });
};
App.loadAdminDatabaseNode = async function (node, refresh = false) {
  const state = App.adminDatabase;
  if (!node || !App.adminDatabaseCurrent(state) || !node.el.isConnected) return;
  if (node.pending) {
    await node.pendingPromise;
    if (!refresh || !App.adminDatabaseCurrent(state) || !node.el.isConnected) return;
  }
  if (node.loaded && !refresh) return;
  node.pending = true;
  if (!node.loaded) App.renderAdminDatabaseNode(node);
  node.pendingPromise = App.queueAdminDatabaseRead(async () => {
    if (!App.adminDatabaseCurrent(state) || !node.el.isConnected) { node.pending = false; return; }
    const controller = node.controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const base = String(App.firebaseConfig?.databaseURL || "").replace(/\/+$/, "");
      const url = new URL(base + "/" + node.path.split("/").map(encodeURIComponent).join("/") + ".json");
      url.searchParams.set("shallow", "true");
      const authUser = App.firebase?.auth?.()?.currentUser;
      if (authUser) url.searchParams.set("auth", await authUser.getIdToken());
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Database access failed (" + response.status + ").");
      const value = await response.json();
      if (!App.adminDatabaseCurrent(state) || !node.el.isConnected) return;
      node.error = ""; node.loaded = true; node.branch = !!value && typeof value === "object";
      node.value = value; node.keys = node.branch ? Object.keys(value).sort() : [];
      node.ref?.off("value", node.cb); node.ref = null;
      if (!node.branch && node.path && !App.isDatabasePayloadPath(node.path)) {
        node.ref = App.db.ref(node.path);
        node.cb = snap => {
          if (!App.adminDatabaseCurrent(state) || !node.el.isConnected) return;
          const next = snap.val();
          if (next && typeof next === "object") { void App.loadAdminDatabaseNode(node, true); return; }
          node.value = next;
          if (!node.editing && !node.saving) App.renderAdminDatabaseNode(node);
        };
        node.ref.on("value", node.cb, error => App.adminDatabaseStatus(error.message));
      }
    } catch (error) {
      if (App.adminDatabaseCurrent(state)) node.error = error.name === "AbortError" ? "Timed Out — Retry" : error.message;
    } finally {
      clearTimeout(timeout); node.pending = false;
      if (App.adminDatabaseCurrent(state) && !node.editing && node.el.isConnected) App.renderAdminDatabaseNode(node);
    }
  });
  await node.pendingPromise;
};
App.adminDatabaseIdentityCode = function (path, value) {
  if (typeof value !== "string" || !value || /[.#$\[\]/\u0000-\u001f\u007f]/.test(value)) return "";
  const pieces = String(path || "").split("/"), leaf = pieces.at(-1);
  if (["createdBy", "userCode", "ownerCode", "creatorCode", "authorCode", "startedBy", "fromCode", "toCode"].includes(leaf)) return value;
  if (pieces[0] === "pings" && leaf === "from") return value;
  if (["usernames", "displayNames"].includes(pieces[0]) && ["code", "c"].includes(leaf)) return value;
  if (pieces[0] === "credentials" && pieces.length === 2) return value;
  return "";
};
App.renderAdminDatabaseNode = function (node) {
  const row = node.el.firstElementChild, esc = App.escapeHtml;
  const name = node.path ? node.path.split("/").pop() : new URL(App.firebaseConfig.databaseURL).hostname.split(".")[0];
  row.innerHTML = '<button class="database-toggle" type="button" data-db-action="toggle" aria-label="' + (node.expanded ? 'Collapse ' : 'Expand ') + esc(name) + '" ' + (node.loaded && !node.branch ? 'disabled' : '') + '>' + (node.branch ? (node.expanded ? '▾' : '▸') : '') + '</button><span class="database-key">' + esc(name) + '</span>' + (node.error ? '<button class="btn tiny" data-db-action="retry">' + esc(node.error) + '</button>' : !node.loaded ? '<span class="muted small">' + (node.pending ? 'Loading…' : '') + '</span>' : node.branch ? '<span class="database-count">{' + node.keys.length + '}</span>' : '<span class="database-colon">:</span><textarea class="database-value" rows="1" aria-label="Value of ' + esc(name) + '" data-value-type="' + typeof node.value + '">' + esc(typeof node.value === "string" ? node.value : JSON.stringify(node.value)) + '</textarea>') + '<span class="database-node-actions">' + (node.branch ? '<button class="icon-btn" type="button" data-db-action="add" aria-label="Add Child to ' + esc(name) + '" title="Add Child">+</button>' : '') + (node.path ? '<button class="icon-btn" type="button" data-db-action="delete" aria-label="Delete ' + esc(name) + '" title="Delete">−</button>' : '') + '</span>';
  const identityCode = node.loaded && !node.branch ? App.adminDatabaseIdentityCode(node.path, node.value) : "";
  if (identityCode) {
    const label = document.createElement("span");
    label.className = "muted small";
    label.title = "Permanent account ID. The account's password can change without changing ownership.";
    label.append(document.createTextNode("Account: "));
    const person = document.createElement("span");
    person.dataset.displayNameUsercode = identityCode;
    person.textContent = App.getUserDisplayName?.(identityCode) || "Loading profile…";
    label.append(person);
    row.append(label);
    App.ensureLiveUserListener?.(identityCode);
  }
  const input = row.querySelector(".database-value");
  if (input) {
    input.onfocus = () => { node.editing = true; node.dirty = false; node.expected = node.value; };
    input.oninput = () => { node.dirty = true; input.rows = Math.min(8, Math.max(1, input.value.split("\n").length)); };
    input.onkeydown = event => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") { event.stopPropagation(); node.editing = false; node.dirty = false; App.renderAdminDatabaseNode(node); }
    };
    input.onblur = () => { node.editing = false; if (node.dirty) { node.dirty = false; input.disabled = true; void App.saveAdminDatabaseValue(node, input.value); } };
  }
  node.el.setAttribute("aria-expanded", String(node.expanded));
  node.el.lastElementChild.hidden = !node.expanded || !node.branch;
  if (node.expanded && node.loaded && node.branch) App.renderAdminDatabaseChildren(node);
};
App.renderAdminDatabaseChildren = function (node) {
  const state = App.adminDatabase, host = node.el.lastElementChild, keys = node.keys.slice(0, node.limit);
  host.querySelector(':scope > [data-db-action="more"]')?.remove();
  for (const child of Array.from(host.children)) {
    if (!child.hasAttribute("data-db-node")) continue;
    if (!keys.includes(child.dataset.dbNode.split("/").pop())) {
      for (const [key, item] of state.nodes) if (key === child.dataset.dbNode || key.startsWith(child.dataset.dbNode + "/")) { item.controller?.abort(); item.ref?.off("value", item.cb); state.nodes.delete(key); }
      child.remove();
    }
  }
  let position = 0;
  for (const key of keys) {
    const valuePath = [node.path, key].filter(Boolean).join("/");
    let child = state.nodes.get(valuePath);
    if (!child) child = App.createAdminDatabaseNode(valuePath, node.path, host);
    if (host.children[position] !== child.el) host.insertBefore(child.el, host.children[position] || null);
    position++;
    if (!child.loaded && !App.isDatabasePayloadPath(child.path)) void App.loadAdminDatabaseNode(child);
    else if (!child.loaded && !child.pending) {
      const row = child.el.firstElementChild;
      if (!row.querySelector('[data-db-action="load"]')) {
        const load = document.createElement("button"); load.type = "button"; load.className = "btn tiny";
        load.dataset.dbAction = "load"; load.textContent = "Load Value"; row.append(load);
      }
    }
  }
  if (keys.length < node.keys.length) {
    const more = document.createElement("button"); more.className = "btn tiny database-more"; more.dataset.dbAction = "more"; more.textContent = "Show More (" + (node.keys.length - keys.length) + ")"; host.append(more);
  }
};
App.refreshAdminDatabase = function ({ quiet = false } = {}) {
  const state = App.adminDatabase;
  if (!state || !App.adminDatabaseCurrent(state)) return;
  if (state.refreshPromise) {
    if (!quiet) { state.refreshQuiet = false; App.adminDatabaseStatus("Refreshing…"); }
    return state.refreshPromise;
  }
  state.refreshQuiet = quiet;
  const button = state.host.querySelector('[data-db-action="refresh"]');
  const tree = state.host.querySelector(".database-tree");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  tree.setAttribute("aria-busy", "true");
  if (!quiet) App.adminDatabaseStatus("Refreshing…");
  let failed = 0;
  // Refresh each visible row, including collapsed branch counts and values.
  // Only recurse into expanded branches; every request remains shallow.
  const visit = async node => {
    if (!node || !App.adminDatabaseCurrent(state) || !node.el.isConnected || node.editing || node.saving) return;
    if (App.isDatabasePayloadPath(node.path) && (!node.loaded || state.refreshQuiet)) return;
    // Scalar listeners already deliver changes; quiet refresh discovers keys.
    if (state.refreshQuiet && node.loaded && !node.branch && node.ref) return;
    await App.loadAdminDatabaseNode(node, true);
    if (!App.adminDatabaseCurrent(state) || !node.el.isConnected) return;
    if (node.error) failed++;
    if (node.expanded && node.branch) {
      await Promise.all(node.keys.slice(0, node.limit).map(key => visit(state.nodes.get([node.path, key].filter(Boolean).join("/")))));
    }
  };
  state.refreshPromise = visit(state.nodes.get("")).catch(error => {
    failed++;
    if (App.adminDatabaseCurrent(state)) App.adminDatabaseStatus(error.message || "Database refresh failed. Try again.");
  }).finally(() => {
    state.refreshPromise = null;
    if (!App.adminDatabaseCurrent(state)) return;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    tree.removeAttribute("aria-busy");
    if (failed) App.adminDatabaseStatus("Refresh incomplete — " + failed + " request" + (failed === 1 ? "" : "s") + " failed. Try again.");
    else if (!state.refreshQuiet) App.adminDatabaseStatus("");
  });
  return state.refreshPromise;
};
App.saveAdminDatabaseValue = async function (node, text) {
  const state = App.adminDatabase;
  if (!App.adminDatabaseCurrent(state) || node.saving || !node.path) return;
  try {
    const value = typeof node.expected === "string" ? text : JSON.parse(text);
    if (JSON.stringify(value) === JSON.stringify(node.expected)) return;
    if (value && typeof value === "object") throw new Error("Use Add Child to create a branch.");
    node.saving = true;
    const expected = JSON.stringify(node.expected);
    const result = await App.db.ref(node.path).transaction(current => {
      if (!App.adminDatabaseCurrent(state)) return;
      if (JSON.stringify(current) === expected) return value;
      // REST-only payload reads do not hydrate the SDK cache. A null proposal
      // lets Firebase retry against the server instead of aborting cold edits.
      if (current === null) return null;
    }, undefined, false);
    if (!result.committed || JSON.stringify(result.snapshot.val()) !== JSON.stringify(value)) throw new Error("This value changed elsewhere. Your edit was not saved; refresh and try again.");
    node.value = value; App.adminDatabaseStatus("Saved");
  } catch (error) { App.adminDatabaseStatus(error.message); }
  finally { node.saving = false; if (App.adminDatabaseCurrent(state)) App.renderAdminDatabaseNode(node); }
};
App.addAdminDatabaseChild = function (node) {
  if (node.el.querySelector(':scope > .database-add')) return;
  const form = document.createElement("form"); form.className = "database-add";
  form.innerHTML = '<input class="input" name="key" aria-label="Child Key" placeholder="Key" required maxlength="768"><select class="input" name="type" aria-label="Value Type"><option>String</option><option>Number</option><option>Boolean</option><option>JSON</option></select><input class="input" name="value" aria-label="Child Value" placeholder="Value"><button class="btn tiny primary" type="submit">Add</button><button class="icon-btn" type="button" aria-label="Cancel Add Child">×</button>';
  node.el.insertBefore(form, node.el.lastElementChild); form.elements.key.focus();
  form.querySelector('[type="button"]').onclick = () => form.remove();
  const state = App.adminDatabase;
  form.onsubmit = async event => {
    event.preventDefault();
    if (!App.adminDatabaseCurrent(state)) return;
    try {
      const key = form.elements.key.value.trim();
      if (!key || key.includes("/")) throw new Error("Enter one child key.");
      const valuePath = App.normalizeDatabasePath([node.path, key].filter(Boolean).join("/"));
      const type = form.elements.type.value, raw = form.elements.value.value;
      const value = type === "String" ? raw : JSON.parse(raw);
      if (value === null || (type === "Number" && typeof value !== "number") || (type === "Boolean" && typeof value !== "boolean")) throw new Error("Enter a valid " + type.toLowerCase() + " value.");
      const result = await App.db.ref(valuePath).transaction(current => { if (App.adminDatabaseCurrent(state) && current === null) return value; }, undefined, false);
      if (!result.committed) throw new Error("This key already exists.");
      form.remove(); node.expanded = true; await App.loadAdminDatabaseNode(node, true); App.adminDatabaseStatus("Child Added");
    } catch (error) { App.adminDatabaseStatus(error.message); }
  };
};

App.register("admin/panel", function initializeFeature() {
App.ADMIN_GHOST_ROOMS_NODE = "adminGhostRooms";
});
})(globalThis.ChatApp);
