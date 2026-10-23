/* Calendar author identity uses the existing public username index and profile UI. */
(function (App) {
  "use strict";
  let generation = 0;
  let hosts = new WeakMap();
  const resolved = new Map();
  const validCode = value => typeof value === "string" && value.length > 0 && !/[.#$\[\]/\u0000-\u001f\u007f]/.test(value);
  const lower = value => String(value || "").trim().toLowerCase();

  async function lookup(record) {
    const username = String(record.authorUsername || "").trim();
    const legacy = String(record.authorName || "").trim();
    const name = username || legacy;
    const authorCode = validCode(record.authorCode) ? record.authorCode : "";
    if (!name && !authorCode) return null;
    // Older releases saved a display name only. Use its exact owner index;
    // never assign an old note to whoever happens to be editing it now.
    const node = username ? "usernames" : (App.DISPLAY_NAME_INDEX_NODE || "displayNames");
    const identity = authorCode ? `users/${authorCode}` : `${node}/${lower(name)}`;
    if (resolved.has(identity)) return resolved.get(identity);
    const currentGeneration = generation;
    const promise = (async () => {
      if (authorCode) { const rec = await App.readUserProfile(authorCode); return rec ? { ...rec, code: authorCode } : null; }
      const nameKey = lower(name);
      const hash = await App.sha256Hex(nameKey);
      const hashes = [...new Set([hash, App.fnv1aHex(nameKey)])];
      for (const key of hashes) {
        const index = (await App.db.ref(`${node}/${key}`).once("value")).val();
        const code = typeof index === "string" ? index : index?.code || index?.c;
        if (!validCode(code)) continue;
        const rec = await App.readUserProfile(code);
        if (!rec || lower(username ? rec.username : rec.displayName || rec.username) !== nameKey) continue;
        return { ...rec, code };
      }
      // Legacy fixtures/accounts can be missing their index. A verified user
      // already present in this session is sufficient; no full users scan.
      const known = [App.currentUser, ...Array.from(App.liveUserCache?.values?.() || [])];
      return known.find(user => user && validCode(user.code) && lower(username ? user.username : user.displayName || user.username) === nameKey) || null;
    })().catch(() => null);
    resolved.set(identity, promise);
    const result = await promise;
    if (!result && currentGeneration === generation) resolved.delete(identity);
    return result;
  }

  function hydrate(host, entry, user) {
    if (hosts.get(host) !== entry || entry.generation !== generation || !host.isConnected || !user) return;
    if (App.liveUserCache?.has(user.code) && App.liveUserCache.get(user.code) === null) {
      entry.user = user;
      entry.button.disabled = true;
      delete entry.button.dataset.usercode;
      delete entry.name.dataset.usernameUsercode;
      entry.button.title = "This note's author profile is no longer available.";
      entry.name.textContent = user.username || "Author unavailable";
      App.applyAvatar(entry.avatar, null);
      return;
    }
    const current = App.liveUserCache?.get(user.code) || user;
    // The profile toggle reads this same cache synchronously. The realtime
    // listener will refresh it; first-click readiness must not wait for that.
    App.liveUserCache?.set(user.code, current);
    entry.user = current;
    entry.button.disabled = false;
    entry.button.removeAttribute("title");
    entry.button.dataset.usercode = user.code;
    entry.name.dataset.usernameUsercode = user.code;
    entry.name.textContent = current.username || "User";
    App.applyAvatar(entry.avatar, current);
    App.ensureLiveUserListener(user.code);
  }

  function resolveHost(host, entry, record) {
    if (entry.pending) return;
    entry.pending = true;
    void lookup(record).then(user => {
      entry.pending = false;
      if (hosts.get(host) !== entry || entry.generation !== generation || !host.isConnected) return;
      if (user) hydrate(host, entry, user);
      else {
        entry.name.textContent = record.authorUsername || "Author unavailable";
        entry.button.title = "This older note has no resolvable author profile.";
      }
    });
  }

  App.syncCalendarAuthor = function (host, record) {
    if (!host || !record) return;
    const identity = JSON.stringify([record.authorCode || "", record.authorUsername || "", record.authorName || ""]);
    const existing = hosts.get(host);
    if (existing?.identity === identity) {
      if (existing.user) hydrate(host, existing, existing.user);
      else resolveHost(host, existing, record);
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-author-button";
    button.setAttribute("aria-haspopup", "dialog");
    button.disabled = true;
    const avatar = document.createElement("span");
    avatar.className = "calendar-author-avatar";
    avatar.setAttribute("aria-hidden", "true");
    App.applyAvatar(avatar, null);
    const label = document.createElement("span");
    label.className = "calendar-author-label";
    label.append(document.createTextNode("Added by "));
    const name = document.createElement("span");
    name.className = "calendar-author-username";
    name.textContent = record.authorUsername || "Loading author…";
    label.append(name);
    button.append(avatar, label);
    host.replaceChildren(button);
    const entry = { identity, generation, button, avatar, name, user: null, pending: false };
    hosts.set(host, entry);
    resolveHost(host, entry, record);
  };
  App.releaseCalendarAuthor = function (host) { if (host) hosts.delete(host); };
  App.resetCalendarAuthors = function () {
    generation++;
    hosts = new WeakMap();
    resolved.clear();
  };
  App.register("calendar/authors", function () {});
})(globalThis.ChatApp);
