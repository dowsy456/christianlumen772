/* chat/mentions: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.preciseRangeValueFromPointer = function (range, e) {
  const rect = range.getBoundingClientRect();
  const min = Number(range.min || 0);
  const max = Number(range.max || 100);
  if (!rect.width || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return range.value;
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  let next = min + (max - min) * ratio;
  const stepRaw = range.getAttribute("step");
  if (stepRaw && stepRaw !== "any") {
    const step = Number(stepRaw);
    if (Number.isFinite(step) && step > 0) {
      next = min + Math.round((next - min) / step) * step;
    }
  }
  next = Math.max(min, Math.min(max, next));
  return String(Math.round(next * 1000000) / 1000000);
};
App.setPreciseRangeFromPointer = function (range, e, emitChange = false) {
  const next = App.preciseRangeValueFromPointer(range, e);
  if (range.value !== next) {
    range.value = next;
    App.syncPreciseRangeVisual(range);
    range.dispatchEvent(new Event("input", {
      bubbles: true
    }));
  } else {
    App.syncPreciseRangeVisual(range);
  }
  if (emitChange) range.dispatchEvent(new Event("change", {
    bubbles: true
  }));
};
App.initPreciseRangeSliders = function (root = document) {
  const scope = root instanceof Element || root instanceof Document || root instanceof DocumentFragment ? root : document;
  if (scope.matches?.('input[type="range"]')) App.syncPreciseRangeVisual(scope);
  scope.querySelectorAll?.('input[type="range"]').forEach(App.syncPreciseRangeVisual);
};
App.beginPreciseRangeDrag = function (e) {
  if (e.button != null && e.button !== 0) return;
  const range = e.target?.closest?.('input[type="range"]');
  if (!(range instanceof HTMLInputElement) || range.disabled) return;
  App.preciseRangeDragState = {
    range,
    pointerId: e.pointerId
  };
  try {
    range.focus({
      preventScroll: true
    });
  } catch {}
  try {
    range.setPointerCapture(e.pointerId);
  } catch {}
  App.setPreciseRangeFromPointer(range, e);
  e.preventDefault();
};
App.handlePreciseRangeMove = function (e) {
  if (!App.preciseRangeDragState || e.pointerId !== App.preciseRangeDragState.pointerId) return;
  App.setPreciseRangeFromPointer(App.preciseRangeDragState.range, e);
  e.preventDefault();
};
App.endPreciseRangeDrag = function (e) {
  if (!App.preciseRangeDragState || e.pointerId != null && e.pointerId !== App.preciseRangeDragState.pointerId) return;
  const range = App.preciseRangeDragState.range;
  App.preciseRangeDragState = null;
  if (range instanceof HTMLInputElement) {
    try {
      range.releasePointerCapture(e.pointerId);
    } catch {}
    App.syncPreciseRangeVisual(range);
    range.dispatchEvent(new Event("change", {
      bubbles: true
    }));
  }
};
App.showView = function (name) {
  if (name !== "chat") document.body.dataset.calendarPage = "0";
  if (name !== "chat" && App.callMenuOpen) App.closeCallMenu();
  Object.values(App.views).forEach(v => v.dataset.active = "false");
  App.views[name].dataset.active = "true";
  App.syncDesktopNotificationPolicy?.();
  App.hideError("create");
  App.hideError("login");
  if (name === "chat") document.body.dataset.mode = "chat";else delete document.body.dataset.mode;
  App.syncTimeDisplayChatAction?.();

  // Landing-only educational disguise; revert instantly in chat view.
  try {
    const saved = localStorage.getItem("chatapp_tab_name");
    if (!saved) {
      document.title = name === "chat" ? "GradeSort | Grade Sorter, Study Helper" : "GradeSort | Grade Sorter, Study Helper";
    }
  } catch {}
  if (name === "home") {
    try {
      window.scrollTo(0, 0);
    } catch {}
  }
  try {
    App.syncSidebarRoomActiveStates();
  } catch {}
};
App.setError = function (which, msg) {
  const el = which === "create" ? App.$("create-error") : App.$("login-error");
  el.textContent = msg;
  el.hidden = false;
};
App.hideError = function (which) {
  const el = which === "create" ? App.$("create-error") : App.$("login-error");
  el.hidden = true;
  el.textContent = "";
};
App.escapeHtml = function (s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
};
App.escapeRegExp = function (s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};
App.getRoomMentionUsers = function () {
  const out = [];
  const codes = new Set();
  try {
    for (const code of App.roomMembersCache.keys()) {
      if (code) codes.add(String(code));
    }
  } catch {}
  const selfCode = String(App.currentUser?.code || "");
  try {
    if (selfCode && App.roomMembersCache.has(selfCode)) codes.add(selfCode);
  } catch {}
  for (const code of codes) {
    const u = String(App.currentUser?.code || "") === code ? App.currentUser : App.liveUserCache.get(code);
    const username = App.sanitizeUsername(u?.username || "");
    if (!username) continue;
    out.push({
      code,
      username,
      usernameLower: String(u?.usernameLower || username).toLowerCase(),
      displayName: App.sanitizeUsername(u?.displayName || username) || username,
      displayNameLower: String(u?.displayNameLower || u?.displayName || username).toLowerCase()
    });
  }
  return out;
};
App.getRoomMentionTargetByUsername = function (username) {
  const cleaned = App.sanitizeUsername(username);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  for (const u of App.getRoomMentionUsers()) {
    if (u.usernameLower === lower) return u;
  }
  return null;
};
App.formatMentionTokens = function (s) {
  const raw = String(s ?? "");
  const re = /(^|\s)@([A-Za-z0-9_]{1,32})\b/g;
  let out = "";
  let last = 0;
  let m;
  while (m = re.exec(raw)) {
    const start = m.index;
    const pre = m[1] || "";
    const username = m[2] || "";
    const mentionStart = start + pre.length;
    out += App.escapeHtml(raw.slice(last, mentionStart));
    const broadcast = username.toLowerCase();
    if (broadcast === "everyone" || broadcast === "all" || broadcast === "a") {
      out += `<span class="mention-label mention-broadcast" data-mention-kind="broadcast">@${App.escapeHtml(username)}</span>`;
      last = re.lastIndex;
      continue;
    }
    const target = App.getRoomMentionTargetByUsername(username);
    if (target) {
      out += `<button type="button" class="mention-label mention-link" data-usercode="${App.escapeHtml(target.code)}" aria-label="Open ${App.escapeHtml(target.username)}'s profile">@${App.escapeHtml(target.username)}</button>`;
    } else {
      out += App.escapeHtml(`@${username}`);
    }
    last = re.lastIndex;
  }
  out += App.escapeHtml(raw.slice(last));
  return out;
};
App.normalizeMessageURL = function (raw) {
  try {
    const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    return ["https:", "http:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
};
App.formatMessageInline = function (raw) {
  const tokens = /`([^`\n]+)`|(?:https?:\/\/|www\.)[^\s<>`]+/gi;
  let out = "", last = 0;
  for (const match of raw.matchAll(tokens)) {
    out += App.formatMentionTokens(raw.slice(last, match.index));
    let token = match[0], trailing = "";
    if (match[1] != null) out += `<code>${App.escapeHtml(match[1])}</code>`;
    else {
      while (/[.,!?;:"']$/.test(token) || /[)\]}]$/.test(token) && [...token].filter(c => c === token.at(-1)).length > [...token].filter(c => c === ({")":"(","]":"[","}":"{"})[token.at(-1)]).length) {
        trailing = token.at(-1) + trailing; token = token.slice(0, -1);
      }
      const href = App.normalizeMessageURL(token);
      out += href ? `<button type="button" class="mention-label message-url" data-message-url="${App.escapeHtml(href)}" aria-haspopup="dialog">${App.escapeHtml(token)}</button>` : App.escapeHtml(token);
      out += App.escapeHtml(trailing);
    }
    last = match.index + match[0].length;
  }
  return out + App.formatMentionTokens(raw.slice(last));
};
App.formatTextWithMentions = function (s) {
  let code = false;
  return String(s ?? "").split(/\r?\n/).map(line => {
    if (/^```/.test(line)) { code = !code; return App.escapeHtml(line); }
    if (code) return App.escapeHtml(line);
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) return `<span role="heading" aria-level="${heading[1].length}" class="message-heading message-heading-${heading[1].length}">${App.formatMessageInline(heading[2])}</span>`;
    if (line.startsWith("-# ")) return `<span class="message-subtext">${App.formatMessageInline(line.slice(3))}</span>`;
    return App.formatMessageInline(line);
  }).join("\n");
};
App.closeMessageURL = function () {
  const menu = App.messageURLMenu;
  if (!menu) return;
  App.messageURLMenu = null;
  menu.classList.remove("open");
  menu.classList.add("closing");
  menu.style.opacity = "0";
  if (menu.contains(document.activeElement)) App.messageURLAnchor?.focus?.({ preventScroll: true });
  setTimeout(() => menu.remove(), 150);
};
App.positionMessageURL = function () {
  const menu = App.messageURLMenu, anchor = App.messageURLAnchor;
  if (!menu || !anchor?.isConnected) { App.closeMessageURL(); return; }
  const view = window.visualViewport, width = view?.width || innerWidth, height = view?.height || innerHeight;
  const x = view?.offsetLeft || 0, y = view?.offsetTop || 0, rect = anchor.getBoundingClientRect();
  menu.style.setProperty("--chat-popup-width", `${Math.min(460, width - 16)}px`);
  menu.style.setProperty("--chat-popup-max-height", `${height - 16}px`);
  menu.style.setProperty("--chat-popup-left", `${Math.max(x + 8, Math.min(rect.left, x + width - menu.offsetWidth - 8))}px`);
  const top = rect.bottom + 8 + menu.offsetHeight <= y + height - 8 ? rect.bottom + 8 : rect.top - menu.offsetHeight - 8;
  menu.style.setProperty("--chat-popup-top", `${Math.max(y + 8, Math.min(top, y + height - menu.offsetHeight - 8))}px`);
};
App.openMessageURL = function (anchor) {
  const href = App.normalizeMessageURL(anchor.dataset.messageUrl || "");
  if (!href) return;
  App.closeMessageURL();
  const menu = document.createElement("section");
  menu.className = "chat-popup message-url-popup";
  menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", "Open Link");
  menu.style.opacity = "0";
  menu.innerHTML = `<div class="chat-popup-heading"><div class="chat-popup-heading-copy"><strong>Open Link</strong></div><button class="chat-popup-close chat-icon-button" type="button" aria-label="Close Open Link"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="message-url-content"><p>Open this URL in your default browser in a new tab?</p><div class="message-url-address">${App.escapeHtml(href)}</div><div class="btn-row"><button class="btn" type="button" data-url-copy>Copy URL</button><a class="btn primary" data-url-open href="${App.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open Link</a></div><div class="muted small" role="status" data-url-status></div></div>`;
  document.body.append(menu); App.messageURLMenu = menu; App.messageURLAnchor = anchor;
  App.positionMessageURL();
  requestAnimationFrame(() => { if (App.messageURLMenu === menu) { menu.classList.add("open"); menu.style.opacity = "1"; menu.querySelector("[data-url-open]").focus({ preventScroll: true }); } });
  menu.querySelector(".chat-popup-close").onclick = App.closeMessageURL;
  menu.querySelector("[data-url-open]").onclick = () => App.closeMessageURL();
  menu.querySelector("[data-url-copy]").onclick = async () => {
    try { await App.copyTextToClipboard(href); menu.querySelector("[data-url-status]").textContent = "URL Copied"; }
    catch { menu.querySelector("[data-url-status]").textContent = "Could Not Copy URL"; }
  };
};
App.replaceDisplayNameMentionsInComposer = function (input) {
  if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) return false;
  const users = App.getRoomMentionUsers().filter(u => u.username && u.displayName && u.displayNameLower !== u.usernameLower).sort((a, b) => b.displayName.length - a.displayName.length);
  if (!users.length) return false;
  const original = String(input.value || "");
  let next = original;
  let delta = 0;
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : original.length;
  for (const u of users) {
    const displayName = String(u.displayName || "").trim();
    const username = String(u.username || "").trim();
    if (!displayName || !username) continue;
    const re = new RegExp(`(^|\\s)@(${App.escapeRegExp(displayName)})(?=$|\\s)`, "gi");
    next = next.replace(re, (match, pre, typed, offset) => {
      const replacement = `${pre}@${username}`;
      if (offset < caret) delta += replacement.length - match.length;
      return replacement;
    });
  }
  if (next === original) return false;
  input.value = next;
  App.lastMsgInputVal = next;
  const newCaret = Math.max(0, Math.min(next.length, caret + delta));
  try {
    input.setSelectionRange(newCaret, newCaret);
  } catch {}
  if (App.pingBarEl && !App.pingBarEl.hidden) App.closePingBar({
    quiet: true
  });
  return true;
};
App.refreshMentionFormattingForRenderedMessages = function (root = document) {
  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  scope.querySelectorAll(".bubble-text[data-raw-text]").forEach(el => {
    el.innerHTML = App.formatTextWithMentions(el.dataset.rawText || "");
  });
};

App.register("chat/mentions", function initializeFeature() {
document.addEventListener("click", event => {
  const link = event.target.closest?.("[data-message-url]");
  if (link) { event.preventDefault(); event.stopPropagation(); App.openMessageURL(link); }
});
document.addEventListener("pointerdown", event => {
  if (App.messageURLMenu && !App.messageURLMenu.contains(event.target) && !event.target.closest?.("[data-message-url]")) App.closeMessageURL();
}, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && App.messageURLMenu) { event.preventDefault(); event.stopPropagation(); App.closeMessageURL(); }
}, true);
window.addEventListener("resize", App.positionMessageURL);
document.addEventListener("scroll", () => { if (App.messageURLMenu) App.positionMessageURL(); }, true);
document.addEventListener("pointerdown", App.beginPreciseRangeDrag, true);
window.addEventListener("pointermove", App.handlePreciseRangeMove, {
  passive: false
});
window.addEventListener("pointerup", App.endPreciseRangeDrag, true);
window.addEventListener("pointercancel", App.endPreciseRangeDrag, true);
document.addEventListener("input", e => {
  if (e.target instanceof HTMLInputElement && e.target.type === "range") App.syncPreciseRangeVisual(e.target);
}, true);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => App.initPreciseRangeSliders(), {
    once: true
  });
} else {
  App.initPreciseRangeSliders();
}
if (typeof MutationObserver !== "undefined") {
  new MutationObserver(mutations => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => App.initPreciseRangeSliders(node));
    });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}
App.views = {
  home: App.$("view-home"),
  create: App.$("view-create"),
  login: App.$("view-login"),
  chat: App.$("view-chat")
};
});
})(globalThis.ChatApp);
