/* core/validation: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.sanitizeUsername = function (raw) {
  let s = (raw ?? "").replace(/\s+/g, " ").trim(); // collapses whitespace runs
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || code > 126) return null; // ASCII printable only
  }
  if (!s) return null;
  if (s.length > 20) return null;
  return s;
};
App.sanitizeRoomName = function (raw) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || code > 126) return null;
  }
  if (!s || s.length > 20) return null;
  if (/[.#$\[\]\/]/.test(s)) return null;
  return s;
};
App.sanitizeRoomCode = function (raw) {
  const name = App.sanitizeRoomName(raw);
  return name ? name.toLowerCase() : null;
};
App.roomDisplayName = function (roomId, meta = null) {
  const pending = App.pendingRoomNames?.get?.(App.sanitizeRoomCode(roomId));
  if (pending) return pending;
  // Room IDs are normalized for storage; visible names keep the creator's case.
  // Resolve cached metadata even when a menu only passes the stable room ID.
  const cached = App.roomsMetaCache?.get?.(App.sanitizeRoomCode(roomId));
  const metaName = App.sanitizeRoomName(meta?.name) || App.sanitizeRoomName(cached?.name);
  if (metaName) return metaName;
  const rawId = String(roomId ?? "").trim();
  const idName = App.sanitizeRoomName(rawId);
  if (idName) return idName;
  return rawId || "Room";
};
App.sanitizeRoomPassword = function (raw) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || code > 126) return null;
  }
  return s || null;
};
App.legacyRoomPasswordHashInput = function (password, roomId) {
  const clean = App.sanitizeRoomPassword(password);
  if (!clean) return null;
  return `chatapp-room-password-v1:${App.sanitizeRoomCode(roomId) || ""}:${clean}`;
};
App.legacyRoomPasswordHashFallback = function (input) {
  let h = 2166136261;
  const s = String(input || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
App.legacyFallbackRoomPasswordHash = function (password, roomId) {
  const input = App.legacyRoomPasswordHashInput(password, roomId);
  return input ? `fallback:${App.legacyRoomPasswordHashFallback(input)}` : null;
};
App.computeLegacyRoomPasswordHash = async function (password, roomId) {
  const input = App.legacyRoomPasswordHashInput(password, roomId);
  if (!input) return null;
  try {
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {}
  return App.legacyFallbackRoomPasswordHash(password, roomId);
};
App.isPrivateRoomMeta = function (meta) {
  return !!(meta && (meta.private === true || String(meta.password || "").trim() || String(meta.passwordHash || "").trim()));
};
App.verifyLegacyRoomPasswordHash = async function (meta, password, roomId) {
  const expectedHash = String(meta?.passwordHash || "").trim();
  if (!expectedHash) return false;
  if (expectedHash.startsWith("fallback:")) {
    return expectedHash === App.legacyFallbackRoomPasswordHash(password, roomId);
  }
  const hash = await App.computeLegacyRoomPasswordHash(password, roomId);
  return !!hash && hash === expectedHash;
};
App.migrateLegacyRoomPassword = async function (roomId, meta, password) {
  const id = App.sanitizeRoomCode(roomId);
  const clean = App.sanitizeRoomPassword(password);
  if (!id || !clean || !String(meta?.passwordHash || "").trim()) return;
  const nextMeta = {
    ...(App.roomsMetaCache.get(id) || meta || {}),
    private: true,
    password: clean,
    passwordHash: null
  };
  try {
    await App.db.ref(`rooms/${id}`).update({
      private: true,
      password: clean,
      passwordHash: null
    });
    App.roomsMetaCache.set(id, nextMeta);
    App.scheduleRoomsListCacheSave();
    App.refreshRoomIconSurfaces(id);
  } catch {}
};
App.verifyRoomPassword = async function (meta, password, roomId) {
  if (!App.isPrivateRoomMeta(meta)) return true;
  const clean = App.sanitizeRoomPassword(password);
  if (!clean) return false;
  const expectedPassword = String(meta?.password || "").trim();
  if (expectedPassword) return expectedPassword === clean;
  const legacyOk = await App.verifyLegacyRoomPasswordHash(meta, clean, roomId);
  if (legacyOk) await App.migrateLegacyRoomPassword(roomId, meta, clean);
  return legacyOk;
};
App.roomLockIconSVG = function () {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7.5 10V8a4.5 4.5 0 0 1 9 0v2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <rect x="5.5" y="10" width="13" height="10" rx="2.4" stroke="currentColor" stroke-width="2"/>
      <path d="M12 14v2.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
};
App.privateRoomMarkHTML = function (meta) {
  return App.isPrivateRoomMeta(meta) ? `<span class="room-lock-mark" aria-label="Private Room" data-tooltip="Private">${App.roomLockIconSVG()}</span>` : "";
};
App.fnv1aHex = function (str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};
App.sha256Hex = async function (text) {
  try {
    if (!crypto?.subtle) return App.fnv1aHex(text);
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return App.fnv1aHex(text);
  }
};
// A small per-account lock serializes display-name changes across devices.
// Its disconnect cleanup is token-specific, so it cannot remove a later lock.
App.acquireUserIdentityLock = async function (code) {
  const token = App.db.ref("userIdentityLocks").push().key;
  const parent = App.db.ref(`userIdentityLocks/${code}`);
  const entry = App.db.ref(`userIdentityLocks/${code}/${token}`);
  const disconnected = entry.onDisconnect?.();
  const connection = App.db.ref(".info/connected");
  let lost = false, owned = false;
  const callback = snap => { if (snap.val() === false) lost = true; };
  connection.on?.("value", callback);
  const release = async () => {
    connection.off?.("value", callback);
    if (owned) await entry.remove().catch(() => {});
    await disconnected?.cancel().catch(() => {});
  };
  try {
    await disconnected?.remove();
    const result = await parent.transaction(value => lost ? undefined : value === null || !Object.keys(value).length ? { [token]: true } : undefined, undefined, false);
    owned = result.committed;
    if (!owned || lost) throw new Error("This profile is being edited on another device or the connection was lost. Try again.");
    return { valid: () => !lost, release };
  } catch (error) { await release(); throw error; }
};
App.claimDisplayName = async function (displayName, code) {
  const cleaned = App.sanitizeUsername(displayName);
  const ownerCode = String(code || "").trim();
  if (!cleaned || !ownerCode) return { ok: false, reason: "invalid" };
  const displayNameLower = cleaned.toLowerCase();
  const hash = await App.sha256Hex(displayNameLower);
  const ref = App.db.ref(`${App.DISPLAY_NAME_INDEX_NODE}/${hash}`);
  try {
    const result = await ref.transaction(current => current === null ? { d: displayNameLower, code: ownerCode } : undefined, undefined, false);
    const current = result.snapshot.val();
    const currentCode = typeof current === "string" ? current : String(current?.code || current?.c || "").trim();
    const currentName = typeof current === "object" && current ? String(current.d || current.displayNameLower || "").toLowerCase() : displayNameLower;
    if (currentCode !== ownerCode || currentName && currentName !== displayNameLower) return { ok: false, reason: "taken" };
    return { ok: true, cleaned, displayNameLower, hash, ref };
  } catch { return { ok: false, reason: "unavailable" }; }
};
App.releaseDisplayName = async function (displayName, code) {
  const cleaned = App.sanitizeUsername(displayName);
  const ownerCode = String(code || "").trim();
  if (!cleaned || !ownerCode) return;
  const displayNameLower = cleaned.toLowerCase();
  const hash = await App.sha256Hex(displayNameLower);
  const ref = App.db.ref(`${App.DISPLAY_NAME_INDEX_NODE}/${hash}`);
  await ref.transaction(current => {
    const currentCode = typeof current === "string" ? current : String(current?.code || current?.c || "").trim();
    const currentName = typeof current === "object" && current ? String(current.d || current.displayNameLower || "").toLowerCase() : displayNameLower;
    return currentCode === ownerCode && (!currentName || currentName === displayNameLower) ? null : undefined;
  }, undefined, false);
};
App.saveUserDisplayName = async function (code, previous, next, isCurrent = () => true) {
  const ref = App.db.ref(`users/${code}/displayName`);
  if (previous !== next) {
    const result = await ref.transaction(value => {
      if (!isCurrent()) return;
      if (value === previous) return next;
      // Cold transaction caches must obtain the current server value before
      // checking the expected name; missing existing accounts are a no-op.
      return value === null && previous !== null ? null : undefined;
    }, undefined, false);
    if (!result.committed || result.snapshot.val() !== next) throw new Error("This display name changed on another device. Review it and try again.");
  }
  // Lowercase is only a search hint; the displayName leaf is authoritative.
  // A delayed hint update must not replace a newer device's distinct hint.
  const oldLower = String(previous || "").toLowerCase(), nextLower = next.toLowerCase();
  await App.db.ref(`users/${code}/displayNameLower`).transaction(value => {
    if (!isCurrent() || value === nextLower) return;
    return value === null || value === oldLower ? nextLower : undefined;
  }, undefined, false).catch(() => {});
};
App.buildDisplayNameFallback = function (base, ownerCode, n = 0) {
  const suffix = n <= 0 ? "" : String(ownerCode || "").slice(-Math.min(4, n + 1));
  const joiner = suffix ? "-" : "";
  const maxBaseLen = Math.max(1, 20 - joiner.length - suffix.length);
  const root = String(base || "User").slice(0, maxBaseLen) || "User";
  return `${root}${joiner}${suffix}`;
};
App.ensureOwnedDisplayNameForUser = async function (code, rec) {
  const ownerCode = String(code || "").trim();
  if (!ownerCode) return {
    displayName: "User",
    displayNameLower: "user"
  };
  const lock = await App.acquireUserIdentityLock(ownerCode);
  try {
  // A second device may have saved a name since login read the account.
  const identity = await Promise.all(["username", "displayName", "displayNameLower"].map(async field => [field, (await App.db.ref(`users/${ownerCode}/${field}`).once("value")).val()]));
  rec = { ...rec, ...Object.fromEntries(identity) };
  if (!rec.username || !lock.valid()) throw new Error("The account changed. Please log in again.");
  const username = App.sanitizeUsername(rec?.username || "") || "User";
  const currentDisplay = App.sanitizeUsername(rec?.displayName || "") || username;
  const currentDisplayLower = currentDisplay.toLowerCase();
  const candidates = [];
  const seen = new Set();
  const addCandidate = value => {
    const cleaned = App.sanitizeUsername(value);
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    candidates.push(cleaned);
  };
  addCandidate(currentDisplay);
  addCandidate(username);
  for (let i = 1; i <= 4; i += 1) {
    addCandidate(App.buildDisplayNameFallback(username, ownerCode, i));
  }
  let claim = null;
  for (const candidate of candidates) {
    claim = await App.claimDisplayName(candidate, ownerCode);
    if (claim?.reason === "unavailable") throw new Error("Could not check display name availability.");
    if (claim?.ok) break;
  }
  if (!claim?.ok) {
    const forced = App.buildDisplayNameFallback("User", ownerCode, 4);
    claim = await App.claimDisplayName(forced, ownerCode);
  }
  if (!claim?.ok) {
    throw new Error("Could not secure a unique display name.");
  }
  const nextDisplayName = claim.cleaned;
  const nextDisplayNameLower = claim.displayNameLower;
  if (!lock.valid()) throw new Error("The connection was lost. Try again.");
  if (rec?.displayName !== nextDisplayName || String(rec?.displayNameLower || "").toLowerCase() !== nextDisplayNameLower) {
    await App.saveUserDisplayName(ownerCode, rec.displayName || null, nextDisplayName, lock.valid);
  }
  if (currentDisplayLower !== nextDisplayNameLower && lock.valid()) await App.releaseDisplayName(currentDisplay, ownerCode).catch(() => {});
  return {
    displayName: nextDisplayName,
    displayNameLower: nextDisplayNameLower
  };
  } finally { await lock.release(); }
};

App.register("core/validation", function initializeFeature() {
App.DISPLAY_NAME_INDEX_NODE = "displayNames";
});
})(globalThis.ChatApp);
