/* chat/composer-overlays: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.canUsePingBox = function () {
  const placeNow = App.getStoredPlace() || "home";
  return !!(App.currentUser && App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true");
};
App.attachPingRoster = function () {
  if (App.pingRosterRef || !App.canUsePingBox()) return;
  App.pingRosterRef = App.db.ref("memberships");
  App.pingRosterCb = snap => {
    App.pingRosterValCache = snap.exists() ? snap.val() || {} : {};
    if (App.pingBarEl && !App.pingBarEl.hidden) App.renderPingList();
  };
  App.pingRosterRef.on("value", App.pingRosterCb);
};
App.detachPingRoster = function () {
  if (App.pingRosterRef && App.pingRosterCb) {
    try {
      App.pingRosterRef.off("value", App.pingRosterCb);
    } catch {}
  }
  App.pingRosterRef = null;
  App.pingRosterCb = null;
  App.pingRosterValCache = null;
};
App.openPingBar = function ({
  tokenStart = null
} = {}) {
  if (!App.canUsePingBox()) return;
  App.initOverlaysUI();
  if (!App.pingBarEl) return;
  if (typeof tokenStart === "number") App.pingTokenStart = tokenStart;
  App.pingBarEl.hidden = false;
  App.pingBarEl.classList.remove("closing");
  App.pingBarEl.classList.add("open");
  App.attachPingRoster();
  App.renderPingList();
  App.syncChatOverlayMetrics();
};
App.closePingBar = function ({
  quiet = false
} = {}) {
  if (!App.pingBarEl) return;
  if (App.pingBarEl.hidden) {
    App.syncChatOverlayMetrics();
    return;
  }
  if (quiet) {
    App.pingBarEl.hidden = true;
    App.pingBarEl.classList.remove("open", "closing");
    if (App.pingListEl) App.pingListEl.innerHTML = "";
    App.pingTokenStart = -1;
    App.detachPingRoster();
    App.syncChatOverlayMetrics();
    return;
  }
  App.pingBarEl.classList.remove("open");
  App.pingBarEl.classList.add("closing");
  const onEnd = () => {
    App.pingBarEl?.removeEventListener("animationend", onEnd);
    if (App.pingBarEl) {
      App.pingBarEl.hidden = true;
      App.pingBarEl.classList.remove("closing");
    }
    if (App.pingListEl) App.pingListEl.innerHTML = "";
    App.pingTokenStart = -1;
    App.detachPingRoster();
    App.syncChatOverlayMetrics();
  };
  App.pingBarEl.addEventListener("animationend", onEnd);
};
App.getPingFilter = function () {
  const input = App.$("msg-input");
  const val = String(input?.value || "");
  if (!input || App.pingTokenStart < 0 || App.pingTokenStart >= val.length) return {
    query: "",
    done: true
  };
  const after = val.slice(App.pingTokenStart);
  const m = after.match(/^@([A-Za-z0-9_]*)/);
  if (!m) return {
    query: "",
    done: true
  };
  const q = String(m[1] || "");

  // If the next char after the username token is punctuation (not whitespace), stop ping mode.
  const consumedLen = 1 + q.length;
  const nextCh = after[consumedLen] || "";
  if (nextCh && !/\s/.test(nextCh)) return {
    query: q,
    done: true
  };
  const nextSpaceAt = after.search(/\s/);
  if (nextSpaceAt !== -1 && nextSpaceAt <= input.selectionStart - App.pingTokenStart) return {
    query: q,
    done: true
  };
  return {
    query: q,
    done: false
  };
};
App.computePingUserList = function () {
  const root = App.pingRosterValCache || {};
  const roomId = App.currentRoomId;
  if (!roomId) return [];
  const out = [];
  for (const [userCode, rooms] of Object.entries(root)) {
    if (!userCode) continue;
    if (String(userCode) === String(App.currentUser?.code || "")) continue;
    if (!rooms || typeof rooms !== "object") continue;
    if (!rooms[roomId]) continue;
    out.push(String(userCode));
  }
  return out;
};
App.applyPingSuggestion = function (name) {
  const input = App.$("msg-input");
  if (!input) return;
  const cleanName = String(name || "").trim();
  if (!cleanName) return;
  const val = String(input.value || "");
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : val.length;
  const start = Math.max(0, Math.min(App.pingTokenStart, val.length));
  const end = Math.max(start + 1, caret);
  const mention = `@${cleanName} `;
  const next = val.slice(0, start) + mention + val.slice(end);
  input.value = next;
  App.lastMsgInputVal = next;
  const newCaret = start + mention.length;
  try {
    input.setSelectionRange(newCaret, newCaret);
  } catch {}
  App.closePingBar({
    quiet: true
  });
  input.focus();
};
App.renderPingList = function () {
  App.initOverlaysUI();
  if (!App.pingListEl || !App.pingBarEl) return;
  if (App.pingBarEl.hidden) return;
  const {
    query,
    done
  } = App.getPingFilter();
  if (done) {
    App.closePingBar({
      quiet: true
    });
    return;
  }
  const q = query.toLowerCase();
  const codes = App.computePingUserList();
  codes.sort((a, b) => {
    const au = String(App.liveUserCache.get(a)?.displayName || App.liveUserCache.get(a)?.username || "").toLowerCase();
    const bu = String(App.liveUserCache.get(b)?.displayName || App.liveUserCache.get(b)?.username || "").toLowerCase();
    if (au && bu) return au.localeCompare(bu);
    if (au) return -1;
    if (bu) return 1;
    return a.localeCompare(b);
  });

  // If user fully typed an exact username, auto-close. If they typed an exact display name, rewrite it to the username.
  if (q) {
    for (const code of codes) {
      const u = App.liveUserCache.get(code);
      const username = String(u?.username || "").trim();
      const uname = username.toLowerCase();
      const dname = String(u?.displayName || u?.username || "").toLowerCase();
      if (uname && uname === q) {
        App.closePingBar({
          quiet: true
        });
        App.syncChatOverlayMetrics();
        return;
      }
      if (username && dname && dname === q && dname !== uname) {
        App.applyPingSuggestion(username);
        return;
      }
    }
  }
  App.pingListEl.innerHTML = "";
  let rendered = 0;
  let activeAssigned = false;
  for (const code of codes) {
    App.ensureLiveUserListener(code);
    const u = App.liveUserCache.get(code);
    const displayName = String(u?.displayName || u?.username || "").trim();
    const username = String(u?.username || "").trim();
    if (!displayName || !username) continue;
    const qMatch = !q || displayName.toLowerCase().startsWith(q) || username.toLowerCase().startsWith(q);
    if (!qMatch) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "file-item ping-item";
    item.setAttribute("data-ping-name", username);
    item.setAttribute("aria-label", `Ping ${displayName}`);
    const ava = document.createElement("div");
    ava.className = "mini-avatar ping-item-avatar";
    ava.dataset.usercode = code;
    App.applyAvatar(ava, u);
    const meta = document.createElement("div");
    meta.className = "ping-item-meta";
    const nameEl = document.createElement("div");
    nameEl.className = "ping-item-name";
    nameEl.textContent = displayName;
    const userEl = document.createElement("div");
    userEl.className = "ping-item-username";
    userEl.textContent = `@${username}`;
    meta.appendChild(nameEl);
    meta.appendChild(userEl);
    item.appendChild(ava);
    item.appendChild(meta);
    if (!activeAssigned) {
      item.classList.add("is-active");
      activeAssigned = true;
    }
    item.addEventListener("click", () => App.applyPingSuggestion(username));
    App.pingListEl.appendChild(item);
    rendered++;
  }
  if (!rendered) {
    const empty = document.createElement("div");
    empty.className = "overlay-empty";
    empty.textContent = q ? `No room members match @${q}.` : "No other room members are available.";
    App.pingListEl.appendChild(empty);
  }
  if (App.pingBarQueryEl) App.pingBarQueryEl.textContent = q ? `Filtering @${q}` : "Type after @ to filter";
  if (App.pingBarCountEl) App.pingBarCountEl.textContent = `${rendered} ${rendered === 1 ? "match" : "matches"}`;

  // Show max 6 without scroll; become scrollable when there are 7+ results
  App.pingListEl.classList.toggle("ping-scroll", rendered >= 7);
  App.syncChatOverlayMetrics();
};
App.openFilesBar = function () {
  App.initOverlaysUI();
  if (!App.filesBarEl) return;
  App.filesBarEl.hidden = false;
  App.filesBarEl.classList.remove("closing");
  App.filesBarEl.classList.add("open");
  App.syncChatOverlayMetrics();
};
App.closeFilesBar = function ({
  quiet = false
} = {}) {
  if (!App.filesBarEl) return;
  if (App.filesBarEl.hidden) {
    App.syncChatOverlayMetrics();
    return;
  }
  if (quiet) {
    App.filesBarEl.hidden = true;
    App.filesBarEl.classList.remove("open", "closing");
    if (App.filesListEl) App.filesListEl.innerHTML = "";
    App.syncChatOverlayMetrics();
    return;
  }
  App.filesBarEl.classList.remove("open");
  App.filesBarEl.classList.add("closing");
  const onEnd = () => {
    App.filesBarEl?.removeEventListener("animationend", onEnd);
    if (App.filesBarEl) {
      App.filesBarEl.hidden = true;
      App.filesBarEl.classList.remove("closing");
    }
    if (App.filesListEl) App.filesListEl.innerHTML = "";
    App.syncChatOverlayMetrics();
  };
  App.filesBarEl.addEventListener("animationend", onEnd);
};
App.clearPendingFiles = function ({
  quiet = false
} = {}) {
  if (!quiet) {
    for (const f of App.pendingFiles) {
      try {
        if (String(f?.previewURL || "").startsWith("blob:")) URL.revokeObjectURL(f.previewURL);
      } catch {}
    }
  }
  App.pendingFiles = [];
  App.syncVoicePopoverUI?.();
  App.closeFilesBar({
    quiet
  });
};
App.removePendingFile = function (idx) {
  if (idx < 0 || idx >= App.pendingFiles.length) return;
  const [removed] = App.pendingFiles.splice(idx, 1);
  try {
    if (String(removed?.previewURL || "").startsWith("blob:")) URL.revokeObjectURL(removed.previewURL);
  } catch {}
  App.renderFilesBar();
};
App.renderFilesBar = function () {
  App.initOverlaysUI();
  App.syncVoicePopoverUI?.();
  if (!App.filesBarEl || !App.filesListEl) return;
  const any = App.getTotalPendingAttachmentCount() > 0;
  if (!any) {
    App.closeFilesBar({
      quiet: true
    });
    return;
  }
  const total = App.getTotalPendingAttachmentCount();
  if (App.filesBarLimitEl) {
    App.filesBarLimitEl.textContent = `${total}/${App.CHAT_FILE_MAX_COUNT}`;
    App.filesBarLimitEl.setAttribute("aria-label", `${total} of ${App.CHAT_FILE_MAX_COUNT} files attached`);
  }
  App.filesListEl.innerHTML = "";
  const renderAttachmentItem = (f, idx, type) => {
    const item = document.createElement("div");
    item.className = "file-item attachment-item";
    if (f?.isVoiceMessage) item.dataset.voice = "1";
    const kind = f?.isVoiceMessage ? "voice" : String(f?.kind || type || "file").toLowerCase();
    item.dataset.kind = kind;
    const thumb = document.createElement("div");
    thumb.className = "file-thumb";
    thumb.setAttribute("aria-hidden", "true");
    const fileName = String(f.fileName || f.name || "file");
    const extension = (fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1] || kind || "file").slice(0, 4).toUpperCase();
    const thumbSrc = App.readChunkedField(f, "dataURL") || String(f?.previewURL || f?.dataURL || "");
    if (kind === "image" && thumbSrc) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.src = thumbSrc;
      thumb.appendChild(img);
    } else if (kind === "voice" || kind === "audio") {
      // Use the audio-file symbol from the message gallery for both recordings and uploads.
      thumb.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M9 17V5l11-2v12 M9 9l11-2" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><ellipse cx="6" cy="18" rx="3" ry="2.5" stroke="currentColor" stroke-width="1.7"/><ellipse cx="17" cy="16" rx="3" ry="2.5" stroke="currentColor" stroke-width="1.7"/></svg>';
    } else if (kind === "video") {
      thumb.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.5v11l9-5.5-9-5.5Z"/></svg>';
    } else {
      // Match the document glyph and extension label used in the file gallery.
      thumb.classList.add("att-file-icon");
      thumb.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${App.escapeHtml(extension)}</span>`;
    }
    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = kind === "voice" ? "Voice Message" : fileName;
    name.title = name.textContent;
    const sub = document.createElement("div");
    sub.className = "file-sub";
    const size = App.htmlHubFileSizeText(App.getChatAttachmentByteSize(f));
    const typeLabel = kind === "voice" || kind === "audio" ? "Audio" : kind === "image" ? "Image" : kind === "video" ? "Video" : /\.pdf$/i.test(fileName) ? "PDF Document" : /\.txt$/i.test(fileName) ? "Text Document" : kind === "html" ? "HTML File" : `${extension} File`;
    sub.textContent = [typeLabel, size].filter(Boolean).join(" · ");
    meta.appendChild(name);
    meta.appendChild(sub);
    const rm = document.createElement("button");
    rm.className = "file-remove";
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${name.textContent}`);
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
    rm.addEventListener("click", () => App.removePendingFile(idx));
    item.appendChild(thumb);
    item.appendChild(meta);
    item.appendChild(rm);
    App.filesListEl.appendChild(item);
  };
  App.pendingFiles.forEach((f, idx) => renderAttachmentItem(f, idx, "file"));
  App.openFilesBar();
};
App.getReplyTargetAttachmentCount = function (msg) {
  if (!msg || typeof msg !== "object") return 0;
  if (msg.t === "sticker" || msg.sticker?.id || msg.stickerId) return 1;
  let files = Array.isArray(msg.files) ? msg.files : [];
  if (!files.length && (msg.t === "image" || msg.t === "video" || msg.t === "html" || msg.t === "audio") && msg.dataURL) {
    files = [{
      kind: msg.t,
      dataURL: msg.dataURL
    }];
  }
  return files.length;
};
App.getReplyTargetPreviewText = function (msg) {
  if (!msg) return "Original message is still loading.";
  const text = String(msg.text || "").trim().replace(/\s+/g, " ");
  const stickerName = String(msg?.sticker?.name || "").trim();
  const attCount = App.getReplyTargetAttachmentCount(msg);
  if (text) return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  if (msg.t === "sticker" || msg.sticker?.id || msg.stickerId) return stickerName ? `Sticker: ${stickerName}` : "Sticker";
  if (attCount === 1) return "1 attachment";
  if (attCount > 1) return `${attCount} attachments`;
  return "Original message";
};
App.updateReplyBarPreview = function () {
  if (!App.replyState) return;
  const key = String(App.replyState.key || "");
  const targetMsg = key ? App.getReplyTargetMessage(key) : null;
  if (key && !targetMsg) App.scheduleReplyTargetPreviewHydrate(App.currentRoomId, key);
  const userCode = String(targetMsg?.userCode || App.replyState.userCode || "");
  if (userCode) App.ensureLiveUserListener(userCode);
  const live = userCode ? App.liveUserCache.get(userCode) : null;
  const username = App.normalizeReplyDisplayName(live?.username || targetMsg?.username || App.replyState.username || "User");
  const displayName = App.normalizeReplyDisplayName(live?.displayName || targetMsg?.displayName || App.replyState.displayName || username || "User", username);
  App.replyState.displayName = displayName;
  App.replyState.username = username;
  if (userCode) App.replyState.userCode = userCode;
  if (App.replyBarTextEl) {
    const handle = username.toLowerCase() === displayName.toLowerCase() ? "" : ` <span class="reply-bar-username">@${App.escapeHtml(username)}</span>`;
    App.replyBarTextEl.innerHTML = `${App.escapeHtml(displayName)}${handle}`;
  }
  if (App.replyBarMessageEl) App.replyBarMessageEl.textContent = App.getReplyTargetPreviewText(targetMsg);
  if (App.replyBarAvatarEl) {
    if (userCode) App.replyBarAvatarEl.dataset.usercode = userCode;else delete App.replyBarAvatarEl.dataset.usercode;
    App.applyAvatar(App.replyBarAvatarEl, live || targetMsg || {
      ...App.replyState,
      username,
      displayName
    });
  }
};
App.setReplyState = function (next) {
  if (!next?.key) return;
  App.initOverlaysUI();
  App.replyState = {
    key: String(next.key || ""),
    userCode: next.userCode || "",
    username: App.normalizeReplyDisplayName(next.username || "User"),
    displayName: App.normalizeReplyDisplayName(next.displayName || next.username || "User")
  };
  App.updateReplyBarPreview();
  if (App.replyBarEl) {
    App.replyBarEl.hidden = false;
    App.replyBarEl.classList.remove("closing");
    App.replyBarEl.classList.add("open");
  }
  App.syncChatOverlayMetrics();
  App.$("msg-input")?.focus();
};
App.clearReplyState = function ({
  quiet = false
} = {}) {
  App.replyState = null;
  App.initOverlaysUI();
  if (!App.replyBarEl) return;
  if (App.replyBarEl.hidden) {
    App.syncChatOverlayMetrics();
    return;
  }
  if (quiet) {
    App.replyBarEl.hidden = true;
    App.replyBarEl.classList.remove("open", "closing");
    App.syncChatOverlayMetrics();
    return;
  }
  App.replyBarEl.classList.remove("open");
  App.replyBarEl.classList.add("closing");
  const onEnd = () => {
    App.replyBarEl?.removeEventListener("animationend", onEnd);
    if (App.replyBarEl) {
      App.replyBarEl.hidden = true;
      App.replyBarEl.classList.remove("closing");
    }
    App.syncChatOverlayMetrics();
  };
  App.replyBarEl.addEventListener("animationend", onEnd);
};

App.register("chat/composer-overlays", function initializeFeature() {

});
})(globalThis.ChatApp);
