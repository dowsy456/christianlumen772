/* chat/message-render: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.queueMessageAvatarAlignment = function (row) {
  if (!row) return;
  // Avatar dimensions belong to the message layout, never the wrapping header.
  row.style.removeProperty("--message-avatar-size");
  row.style.removeProperty("--message-avatar-offset");
};
App.appendMessageRow = function (msg, opts = null) {
  msg = App.normalizeMessageMedia(msg);
  if (App.isValidChatMessageRecord && !App.isValidChatMessageRecord(msg)) return null;
  // Search uses the same interactive renderer without registering a second
  // timeline row or allowing its media to move the room's scroll position.
  const preview = !!opts?.preview;
  const roomId = opts?.roomId || App.currentRoomId;
  const targetOverride = opts && opts.target ? opts.target : null;
  const suppressScroll = preview || !!(opts && opts.suppressScroll);
  const msgKey = msg?._key || msg?.key || "";
  const sortTs = App.getMessageSortTimestamp(msg, msgKey);
  const wasNearBottom = !suppressScroll && !App.bulkLoading && (App.isNearBottom(220) || App.scrollQueued);

  // Hard de-dupe: if a row for this key already exists, do NOT create another.
  if (msgKey && !preview) {
    const existing = App.msgElByKey.get(msgKey) || App.messagesListEl?.querySelector?.(`[data-msgkey="${CSS.escape(msgKey)}"]`);
    if (existing) {
      const prev = App.msgDataByKey.get(msgKey);

      // If we previously painted an optimistic stub, swap it for the real payload.
      if (prev && prev.__stub && !msg.__stub) {
        App.replaceMessageRowByKey({
          ...msg,
          _key: msgKey
        });
        return App.msgElByKey.get(msgKey) || existing;
      }
      App.msgElByKey.set(msgKey, existing);
      if (!prev) App.msgDataByKey.set(msgKey, msg);
      return existing;
    }
  }
  const row = document.createElement("div");
  row.className = "msg-row"; // CSS keeps everything on LEFT

  const code = msg?.userCode || "";
  if (code) row.dataset.usercode = code;
  row.dataset.sortts = String(sortTs);
  if (msgKey) {
    row.dataset.msgkey = msgKey;
    if (!preview) {
      App.msgElByKey.set(msgKey, row);
      App.msgDataByKey.set(msgKey, msg);
    }
  }
  if (preview) row.dataset.messagePreview = "1";
  if (msg.t === "system") {
    try { App.renderSystemMessage(row, msg, opts); }
    catch (error) {
      if (!preview && msgKey && App.msgElByKey.get(msgKey) === row) {
        App.msgElByKey.delete(msgKey);
        App.msgDataByKey.delete(msgKey);
        App.renderedMsgKeys?.delete(msgKey);
      }
      throw error;
    }
    const target = targetOverride || (App.bulkLoading && App.bulkMsgFrag ? App.bulkMsgFrag : App.messagesListEl);
    if (target) { if (preview) target.appendChild(row); else App.insertMessageRowChronologically(target, row); }
    if (!preview && App.bulkLoading && App.bulkMsgFrag) App.scheduleBulkMessageFlush();
    if (!App.bulkLoading && !suppressScroll && App.shouldAutoScrollNow(wasNearBottom)) App.forceScrollToBottomFor(900, { reason: "system-message" });
    return row;
  }
  const isOwn = !!(code && App.currentUser && code === App.currentUser.code);
  if (isOwn) row.classList.add("own");
  if (msg && msg.__stub) row.classList.add("stub");
  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  if (code) avatar.dataset.usercode = code;
  if (code) App.ensureLiveUserListener(code);
  const live = code ? App.liveUserCache.get(code) : null;
  App.applyAvatar(avatar, live || msg);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const top = document.createElement("div");
  top.className = "bubble-top";
  const displayName = App.getUserDisplayName?.(msg.userCode, msg) || live?.displayName || live?.username || msg.displayName || msg.username || "User";
  const name = document.createElement("div");
  name.className = "bubble-name";
  if (code) name.dataset.displayNameUsercode = code;
  name.textContent = displayName;
  const time = document.createElement("div");
  time.className = "bubble-time";
  const ts = sortTs;
  const liveText = String(msg?.text || "");
  const previousEditedText = String(msg?.editedPrevText || "");
  const isEditedMessage = !(msg && msg.__stub) && Number(msg?.editedAt || 0) > 0 && previousEditedText !== "";
  const canToggleEditedMessage = isEditedMessage && App.isVinny();
  let body = null;
  const visibleTextForRow = () => {
    if (canToggleEditedMessage && row.dataset.showOld === "1") return previousEditedText;
    return liveText;
  };
  const renderTimeLabel = () => {
    if (msg && msg.__stub) {
      time.removeAttribute("data-tooltip");
      time.removeAttribute("aria-label");
      return "Sending…";
    }
    const parts = App.formatChatTimestampParts(ts);
    if (parts.full) {
      time.dataset.tooltip = parts.full;
      time.setAttribute("aria-label", parts.full);
    } else {
      time.removeAttribute("data-tooltip");
      time.removeAttribute("aria-label");
    }
    const base = parts.short;
    if (!isEditedMessage) return base;
    if (!canToggleEditedMessage) return `${base} (edited)`;
    return `${base} (edited)`;
  };
  time._refreshTimestamp = () => {
    time.textContent = renderTimeLabel();
  };
  time._refreshTimestamp();
  time.addEventListener("pointerenter", event => {
    if (event.pointerType === "touch") return;
    App.showTimestampTooltipFor(time);
  });
  time.addEventListener("pointerleave", App.hideTimestampTooltip);
  time.addEventListener("focus", () => App.showTimestampTooltipFor(time));
  time.addEventListener("blur", App.hideTimestampTooltip);
  if (canToggleEditedMessage) {
    time.tabIndex = 0;
    time.setAttribute("role", "button");
    time.style.cursor = "pointer";
    time.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      row.dataset.showOld = row.dataset.showOld === "1" ? "0" : "1";
      time._refreshTimestamp();
      if (body) {
        const nextVisible = String(visibleTextForRow() || "").trim();
        body.dataset.rawText = nextVisible;
        body.innerHTML = App.formatTextWithMentions(nextVisible);
        body.hidden = !nextVisible;
      }
    });
    time.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      time.click();
    });
  }
  top.appendChild(name);
  top.appendChild(time);

  // Reply preview (Discord-like; only shows the message you replied to)
  let replyPreview = null;
  if (msg?.replyTo?.key) {
    row.classList.add("has-reply");
    const rKey = String(msg.replyTo.key || "");
    const ru = App.normalizeReplyDisplayName(msg?.replyTo?.displayName || msg?.replyTo?.username || "User");
    const targetMsg = rKey ? preview ? opts.replyTargetMessage || null : App.getReplyTargetMessage(rKey) : null;
    if (!preview && rKey && !targetMsg) App.scheduleReplyTargetPreviewHydrate(roomId, rKey);
    const replyFallbackText = String(msg?.replyTo?.previewText || msg?.replyTo?.text || msg?.replyTo?.message || "").trim();
    const targetTextRaw = String(targetMsg?.text || replyFallbackText || "").trim();

    // Attachment count (do not render attachments here)
    let targetFiles = Array.isArray(targetMsg?.files) ? targetMsg.files : [];
    if (!targetFiles.length && (targetMsg?.t === "image" || targetMsg?.t === "video" || targetMsg?.t === "html" || targetMsg?.t === "audio") && targetMsg?.dataURL) {
      targetFiles = [{
        kind: targetMsg.t,
        dataURL: targetMsg.dataURL
      }];
    }
    const fallbackAttachmentCount = Math.max(0, Number(msg?.replyTo?.attachmentCount || msg?.replyTo?.attachments || 0) || 0);
    const attCount = Math.max(targetFiles.length, fallbackAttachmentCount);
    const targetText = opts?.replyDeleted ? "Message deleted" : targetTextRaw || (attCount > 0 ? "Click to see attachment" : "Original message");

    // User avatar inside preview (no timestamp)
    const rCode = String(msg?.replyTo?.userCode || "") || String(targetMsg?.userCode || "");
    if (rCode) App.ensureLiveUserListener(rCode);
    const rLive = rCode ? App.liveUserCache.get(rCode) : null;
    const rp = document.createElement("button");
    rp.type = "button";
    rp.className = "reply-preview";
    rp.setAttribute("aria-label", `Jump to ${ru}'s replied message: ${targetText}`);
    rp.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      void (opts?.onReplyJump || App.scrollToMessageKey)(rKey);
    });
    const rAva = document.createElement("div");
    rAva.className = "reply-preview-avatar";
    if (rCode) rAva.dataset.usercode = rCode;
    App.applyAvatar(rAva, rLive || targetMsg || msg.replyTo || {
      username: ru
    });
    const author = document.createElement("span");
    author.className = "reply-preview-author";
    if (rCode) author.dataset.replyUsercode = rCode;
    author.textContent = App.normalizeReplyDisplayName(rLive?.displayName || targetMsg?.displayName || msg?.replyTo?.displayName || ru || "User");
    const snippet = document.createElement("span");
    snippet.className = "reply-preview-snippet";
    snippet.textContent = targetText;
    if (attCount > 0) {
      const at = document.createElement("span");
      at.className = "reply-preview-attachment-icon";
      at.setAttribute("aria-label", attCount === 1 ? "1 attachment" : `${attCount} attachments`);
      at.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="2"/><path d="m7 16 3.2-3.3 2.8 2.7 2.2-2.1L19 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.5" cy="8.5" r="1.5" fill="currentColor"/></svg>';
      rp.append(rAva, author, snippet, at);
    } else {
      rp.append(rAva, author, snippet);
    }
    replyPreview = rp;
  }
  if (replyPreview) row.appendChild(replyPreview);
  bubble.appendChild(top);

  // Text first
  const initialText = String(visibleTextForRow() || "").trim();
  const hasAnyTextVersion = !!(String(liveText).trim() || String(previousEditedText).trim());
  if (hasAnyTextVersion) {
    body = document.createElement("div");
    body.className = "bubble-text";
    body.dataset.rawText = initialText;
    body.innerHTML = App.formatTextWithMentions(initialText);
    body.hidden = !initialText;
    bubble.appendChild(body);
  }
  const stickerRef = App.normalizeStickerMessageReference(msg);
  if (stickerRef?.id) App.renderStickerMessageInto(bubble, row, stickerRef);
  if (msg.poll) App.renderMessagePoll(bubble, msg, roomId);

  // Files (new combined-message format)
  let files = Array.isArray(msg?.files) ? msg.files : [];

  // Back-compat: old single-media messages {t,dataURL}
  if (!files.length && (msg?.t === "image" || msg?.t === "video" || msg?.t === "html") && msg?.dataURL) {
    files = [{
      kind: msg.t,
      dataURL: msg.dataURL,
      fileName: msg.fileName || null,
      name: msg.name || "",
      size: msg.size || 0
    }];
  }
  if (files.length) {
    bubble.classList.add("has-attachments");
    const gallery = document.createElement("div");
    gallery.className = "att-gallery";
    gallery.dataset.count = String(files.length);
    bubble.appendChild(gallery);
    let galleryLayoutRaf = 0;
    const queueGalleryLayout = () => {
      if (galleryLayoutRaf) cancelAnimationFrame(galleryLayoutRaf);
      galleryLayoutRaf = requestAnimationFrame(() => {
        galleryLayoutRaf = 0;
        App.queueMessageAvatarAlignment(row);
      });
    };
    const dlSvg = `
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true">
        <path d="M12 4v9.25" stroke="currentColor" stroke-width="2.15" stroke-linecap="round"/>
        <path d="M8.35 10.2 12 13.85l3.65-3.65" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5.25 15.25v1.35a3.15 3.15 0 0 0 3.15 3.15h7.2a3.15 3.15 0 0 0 3.15-3.15v-1.35" stroke="currentColor" stroke-width="2.15" stroke-linecap="round"/>
      </svg>`;
    const playSvg = `
      <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
        <path d="M8 6.5v11l9-5.5-9-5.5Z"/>
      </svg>`;
    const ensureExt = (name, ext) => {
      let n = String(name || "").trim();
      if (!n) n = `file.${ext}`;
      if (!/\.[a-z0-9]{2,6}$/i.test(n)) n += `.${ext}`;
      return n;
    };
    const fileCardHTML = (name, status, fileKind, attachment) => {
      const safeName = String(name || "file").trim() || "file";
      const extension = (safeName.match(/\.([a-z0-9]{1,8})$/i)?.[1] || fileKind || "file").slice(0, 4).toUpperCase();
      const sizeText = App.htmlHubFileSizeText(App.getChatAttachmentByteSize(attachment));
      const typeText = /\.pdf$/i.test(safeName) ? "PDF Document" : /\.txt$/i.test(safeName) ? "Text Document" : fileKind === "html" ? "HTML File" : `${extension} File`;
      const meta = [typeText, sizeText, status].filter(Boolean).join(" • ");
      return `
        <span class="att-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${App.escapeHtml(extension)}</span></span>
        <span class="att-file-copy">
          <span class="att-file-name">${App.escapeHtml(safeName)}</span>
          <span class="att-file-sub">${App.escapeHtml(meta)}</span>
        </span>
      `;
    };
    for (const f of files) {
      const kind = String(f?.kind || f?.t || "");
      const storedAttachment = App.isStoredAttachment(f);
      let streamingURL = "";
      if (App.isExternalBlobDescriptor?.(f)) {
        try { streamingURL = App.getExternalBlobURL(f); } catch { /* Keep the retryable attachment card if storage configuration is unavailable. */ }
      }
      // External objects already have a validated streaming URL. Render that
      // source on the first pass instead of waiting for an observer + repaint.
      const dataURL = String(f?.dataURL || (storedAttachment ? App.getCachedAttachmentURL(f) : "") || streamingURL || "");
      const previewURL = String(f?.previewURL || "");
      const hasCommittedData = !!dataURL;
      const stillPending = App.attachmentHasPendingChunkedData(f);
      const isLoading = !hasCommittedData && !!(f?.__loading || f?.uploadPending || stillPending);
      const usableDataURL = hasCommittedData ? dataURL : "";
      const displayDataURL = hasCommittedData ? dataURL : isLoading ? previewURL : "";
      if (!kind) continue;
      const item = document.createElement("div");
      item.className = "att-item";
      item.dataset.kind = kind;
      if (isLoading) item.dataset.loading = "1";
      const isVoiceMessage = !!f?.isVoiceMessage;
      let fn = isVoiceMessage ? String(f.displayName || "Voice Message") : String(f.fileName || f.name || "").trim();
      if (kind === "html") fn = ensureExt(fn || "experience", "html");else if (kind === "image") fn = ensureExt(fn || "image", "png");else if (kind === "video") fn = ensureExt(fn || "video", "mp4");else if (kind === "audio") fn = fn || "audio";else fn = fn || "file";
      const downloadName = isVoiceMessage ? String(f.fileName || `voice-message.${String(f?.mimeType || "").includes("ogg") ? "ogg" : "webm"}`) : fn;
      const dl = document.createElement("button");
      dl.className = "icon-btn att-dl";
      dl.type = "button";
      dl.setAttribute("aria-label", usableDataURL || storedAttachment ? `Download ${downloadName}` : `${downloadName} is still loading`);
      dl.innerHTML = dlSvg;
      dl.disabled = !usableDataURL && !storedAttachment;
      dl.addEventListener("click", async e => {
        e.preventDefault();
        e.stopPropagation();
        if (!usableDataURL && !storedAttachment) return;
        dl.disabled = true;
        dl.setAttribute("aria-busy", "true");
        let downloadStatus = null;
        try {
          if (!usableDataURL) {
            downloadStatus = document.createElement("div");
            downloadStatus.className = "att-loading";
            downloadStatus.textContent = "Downloading…";
            item.appendChild(downloadStatus);
          }
          const source = usableDataURL || await App.resolveAttachmentURL(f, { onProgress: pct => {
            if (downloadStatus) downloadStatus.textContent = `Downloading ${App.formatUploadPercentText(pct)}`;
          } });
          if (kind === "html") await App.downloadHtmlViaObjectURL(source, downloadName);else await App.downloadFileViaObjectURL(source, downloadName);
        } catch (error) {
          App.showToast({ title: "Download failed", body: String(error?.message || "Please try again."), duration: 3500 });
        } finally {
          downloadStatus?.remove(); dl.disabled = false; dl.removeAttribute("aria-busy");
        }
      });
      item.appendChild(dl);
      if (isLoading) {
        const loading = document.createElement("div");
        loading.className = "att-loading";
        loading.textContent = App.formatUploadPercentText(f?.uploadProgress ?? 0);
        item.appendChild(loading);
      }
      const documentKind = App.getDocumentPreviewKind(fn, App.getMediaMimeType(f));
      if (storedAttachment && !usableDataURL) {
        // A ready attachment is immediately visible to everyone. Fetch its
        // bytes only on demand; large files never flood every room subscriber.
        const card = document.createElement("button");
        card.type = "button";
        card.className = "att-file";
        const action = documentKind ? "Open Preview" : kind === "audio" ? "Load audio" : kind === "image" ? "Open image" : kind === "video" ? "Open video" : "Download";
        card.innerHTML = fileCardHTML(fn, action, kind, f);
        const repaint = () => {
          if (!row.isConnected) return;
          if (!preview) {
            const latest = App.msgDataByKey.get(msgKey);
            if (latest && App.msgElByKey.get(msgKey) === row) App.replaceMessageRowByKey(latest);
          } else {
            const fragment = document.createDocumentFragment();
            const nextRow = App.appendMessageRow(msg, { ...opts, target: fragment, suppressScroll: true });
            if (nextRow) row.replaceWith(nextRow);
          }
        };
        let busy = false;
        const load = async (automatic = false) => {
          if (busy || !row.isConnected) return;
          busy = true; card.disabled = true; card.setAttribute("aria-busy", "true");
          const pendingStatus = card.querySelector(".att-file-sub");
          if (pendingStatus) pendingStatus.textContent = "Downloading…";
          try {
            const source = await App.resolveAttachmentURL(f, { onProgress: pct => {
              const status = card.querySelector(".att-file-sub");
              if (status) status.textContent = `Downloading ${App.formatUploadPercentText(pct)}`;
            } });
            if (!row.isConnected) return;
            if (!automatic) {
              if (documentKind) App.openMediaModal(documentKind, source, { fileName: fn, mimeType: App.getMediaMimeType(f) });
              else if (kind === "image" || kind === "video") App.openMediaModal(kind, source, { fileName: fn, mimeType: f.mimeType || "" });
              else if (kind === "html") await App.downloadHtmlViaObjectURL(source, downloadName);
              else if (kind !== "audio") await App.downloadFileViaObjectURL(source, downloadName);
            }
            repaint();
          } catch (error) {
            const status = card.querySelector(".att-file-sub");
            if (status) status.textContent = "Download failed • click to retry";
            if (!automatic) App.showToast({ title: "Attachment unavailable", body: String(error?.message || "Please try again."), duration: 3500 });
          } finally {
            busy = false; card.disabled = false; card.removeAttribute("aria-busy");
          }
        };
        card.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void load(); });
        item.appendChild(card); gallery.appendChild(item); queueGalleryLayout();
        // Small visible images keep their familiar inline preview. Visibility
        // and a small cap prevent history loads from starting huge downloads.
        if (kind === "image" && f.size <= 4 * 1024 * 1024 && typeof IntersectionObserver !== "undefined") {
          const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(true); }
          }, { rootMargin: "600px" });
          observer.observe(card);
          setTimeout(() => observer.disconnect(), 30000);
        }
        continue;
      }
      if (kind === "html" || kind === "code" || kind === "file" || documentKind) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "att-file";
        card.innerHTML = fileCardHTML(fn, usableDataURL ? documentKind ? "Open Preview" : "" : "Preparing…", kind, f);
        card.disabled = !usableDataURL;
        card.addEventListener("click", async e => {
          e.preventDefault();
          e.stopPropagation();
          if (!usableDataURL) return;
          if (documentKind) App.openMediaModal(documentKind, usableDataURL, { fileName: fn, mimeType: App.getMediaMimeType(f) });
          else if (kind === "html") await App.downloadHtmlViaObjectURL(usableDataURL, downloadName);else await App.downloadFileViaObjectURL(usableDataURL, downloadName);
        });
        item.appendChild(card);
        gallery.appendChild(item);
        queueGalleryLayout();
        continue;
      }
      if (kind === "audio") {
        if (!usableDataURL) {
          const ph = document.createElement("div");
          ph.className = "att-media-card";
          ph.innerHTML = `
            <div class="att-media-card-art"></div>
            <div class="att-media-card-meta">
              <div class="att-media-card-title">${App.escapeHtml(fn)}</div>
              <div class="att-media-card-sub">Preparing audio...</div>
            </div>
          `;
          item.appendChild(ph);
          gallery.appendChild(item);
          queueGalleryLayout();
          continue;
        }
        const box = document.createElement("div");
        box.className = "chat-audio-player chat-audio";
        box.innerHTML = `
          <div class="chat-audio-player-top">
            <div class="chat-audio-player-main">
              <span class="chat-audio-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M9 17V5l11-2v12 M9 9l11-2" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><ellipse cx="6" cy="18" rx="3" ry="2.5" stroke="currentColor" stroke-width="1.7"/><ellipse cx="17" cy="16" rx="3" ry="2.5" stroke="currentColor" stroke-width="1.7"/></svg></span>
              <button class="chat-audio-player-btn" type="button" data-audio="toggle" aria-label="Play/Pause">Play</button>
              <div class="chat-audio-player-copy">
                <div class="chat-audio-player-title">${App.escapeHtml(fn)}</div>
              </div>
            </div>
          </div>
          <div class="chat-audio-player-mid">
            <input class="chat-audio-player-range" type="range" min="0" max="1000" value="0" data-audio="seek" aria-label="Seek Audio" />
            <div class="chat-audio-player-time" data-audio="time">0:00 / 0:00</div>
          </div>
          <div class="chat-audio-player-opts">
            <label class="chat-audio-player-loop"><input type="checkbox" data-audio="loop"/> Loop</label>
            <div class="chat-audio-player-vol">
              <span>Vol</span>
              <input class="chat-audio-player-vol-range" type="range" min="0" max="1" step="0.01" value="1" data-audio="vol" aria-label="Audio Volume" />
            </div>
            <label class="chat-audio-player-speed">
              <span>Speed</span>
              <select data-audio="rate">
                <option value="0.25">0.25×</option>
                <option value="0.5">0.5×</option>
                <option value="0.75">0.75×</option>
                <option value="1" selected>1×</option>
                <option value="1.25">1.25×</option>
                <option value="1.5">1.5×</option>
                <option value="1.75">1.75×</option>
                <option value="2">2×</option>
              </select>
            </label>
          </div>
        `;
        const audio = new Audio();
        App.chatAudioPlayers.add(audio);
        if (preview) (row.__previewAudio ||= []).push(audio);
        audio.src = usableDataURL;
        audio.preload = "metadata";
        const btn = box.querySelector('[data-audio="toggle"]');
        const seek = box.querySelector('[data-audio="seek"]');
        const timeEl = box.querySelector('[data-audio="time"]');
        const loop = box.querySelector('[data-audio="loop"]');
        const vol = box.querySelector('[data-audio="vol"]');
        const rate = box.querySelector('[data-audio="rate"]');
        const voiceTrimStartSec = isVoiceMessage && Number(f?.voiceTrimStartSec) > 0 ? Math.max(0, Number(f.voiceTrimStartSec) || 0) : 0;
        const syncUI = () => {
          const dur = Number(audio.duration);
          const hasDur = Number.isFinite(dur) && dur > 0;
          const trimStart = hasDur ? Math.min(voiceTrimStartSec, Math.max(0, dur - 0.05)) : Math.max(0, voiceTrimStartSec);
          const displayDur = hasDur ? Math.max(0, dur - trimStart) : 0;
          const rawCur = Number(audio.currentTime) || 0;
          const cur = Math.max(0, rawCur - trimStart);
          const atStart = cur <= 0.05;
          const atEnd = hasDur && cur >= Math.max(0, displayDur - 0.05);
          if (btn) btn.textContent = audio.paused ? atStart || atEnd ? "Play" : "Resume" : "Pause";
          if (loop instanceof HTMLInputElement) loop.checked = !!audio.loop;
          if (vol instanceof HTMLInputElement) vol.value = String(Number.isFinite(audio.volume) ? audio.volume : 1);
          if (rate instanceof HTMLSelectElement) rate.value = String(Number.isFinite(audio.playbackRate) ? audio.playbackRate : 1);
          if (seek instanceof HTMLInputElement) {
            if (displayDur > 0) {
              const p = Math.round(cur / displayDur * 1000);
              if (!seek.matches(":active")) seek.value = String(App.clampNum(p, 0, 1000));
            } else if (!seek.matches(":active")) {
              seek.value = "0";
            }
          }
          if (timeEl) {
            timeEl.textContent = `${App.fmtAudioTime(cur)} / ${displayDur > 0 ? App.fmtAudioTime(displayDur) : "0:00"}`;
          }
        };
        btn?.addEventListener("click", e => {
          e.preventDefault();
          e.stopPropagation();
          const dur = Number(audio.duration);
          const hasDur = Number.isFinite(dur) && dur > 0;
          const trimStart = hasDur ? Math.min(voiceTrimStartSec, Math.max(0, dur - 0.05)) : Math.max(0, voiceTrimStartSec);
          const displayDur = hasDur ? Math.max(0, dur - trimStart) : 0;
          const rawCur = Number(audio.currentTime) || 0;
          const cur = Math.max(0, rawCur - trimStart);
          const atEnd = hasDur && cur >= Math.max(0, displayDur - 0.05);
          const beforeTrimStart = trimStart > 0 && rawCur < Math.max(0, trimStart - 0.05);
          if (audio.paused) {
            if (atEnd || beforeTrimStart || rawCur <= 0.05) audio.currentTime = trimStart;
            audio.play().catch(() => {});
          } else {
            audio.pause();
          }
          syncUI();
        });
        if (seek instanceof HTMLInputElement) {
          seek.addEventListener("input", e => {
            e.preventDefault();
            e.stopPropagation();
            const dur = Number(audio.duration);
            if (!Number.isFinite(dur) || dur <= 0) return;
            const trimStart = Math.min(voiceTrimStartSec, Math.max(0, dur - 0.05));
            const displayDur = Math.max(0, dur - trimStart);
            if (displayDur <= 0) return;
            const v = App.clampNum(Number(seek.value), 0, 1000) / 1000;
            audio.currentTime = trimStart + v * displayDur;
            syncUI();
          });
        }
        if (loop instanceof HTMLInputElement) {
          const syncLoop = e => {
            e.preventDefault();
            e.stopPropagation();
            audio.loop = !!loop.checked;
            syncUI();
          };
          loop.addEventListener("input", syncLoop);
          loop.addEventListener("change", syncLoop);
        }
        if (vol instanceof HTMLInputElement) {
          vol.addEventListener("input", e => {
            e.preventDefault();
            e.stopPropagation();
            audio.volume = App.clampNum(Number(vol.value), 0, 1, 1);
            syncUI();
          });
        }
        if (rate instanceof HTMLSelectElement) {
          const syncRate = e => {
            e.preventDefault();
            e.stopPropagation();
            audio.playbackRate = App.clampNum(Number(rate.value), 0.25, 2, 1);
            syncUI();
          };
          rate.addEventListener("input", syncRate);
          rate.addEventListener("change", syncRate);
        }
        audio.addEventListener("timeupdate", syncUI);
        audio.addEventListener("loadedmetadata", () => {
          const dur = Number(audio.duration);
          const trimStart = Number.isFinite(dur) && dur > 0 ? Math.min(voiceTrimStartSec, Math.max(0, dur - 0.05)) : Math.max(0, voiceTrimStartSec);
          if (trimStart > 0 && (Number(audio.currentTime) || 0) < trimStart) {
            try {
              audio.currentTime = trimStart;
            } catch {}
          }
          syncUI();
        });
        audio.addEventListener("durationchange", syncUI);
        audio.addEventListener("play", syncUI);
        audio.addEventListener("pause", syncUI);
        audio.addEventListener("ended", syncUI);
        audio.addEventListener("volumechange", syncUI);
        audio.addEventListener("ratechange", syncUI);
        syncUI();
        item.appendChild(box);
        gallery.appendChild(item);
        queueGalleryLayout();
        continue;
      }
      if (kind === "image") {
        if (displayDataURL) {
          const im = document.createElement("img");
          im.className = "att-media";
          im.src = displayDataURL;
          im.alt = fn;
          im.loading = "eager";
          im.decoding = "async";
          if (usableDataURL) {
            im.tabIndex = 0;
            im.setAttribute("role", "button");
            im.setAttribute("aria-label", `Open ${fn}`);
            im.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); im.click(); } });
            im.addEventListener("click", () => App.openMediaModal("image", usableDataURL, {
              fileName: fn
            }));
          }
          im.addEventListener("load", queueGalleryLayout, {
            once: true
          });
          im.addEventListener("error", queueGalleryLayout, {
            once: true
          });
          if (!preview) App.keepBottomPinnedOnMedia(im);
          item.appendChild(im);
        } else {
          const ph = document.createElement("div");
          ph.className = "att-media-card";
          ph.innerHTML = `
            <div class="att-media-card-art"></div>
            <div class="att-media-card-meta">
              <div class="att-media-card-title">${App.escapeHtml(fn)}</div>
              <div class="att-media-card-sub">Preparing preview...</div>
            </div>
          `;
          item.appendChild(ph);
        }
        gallery.appendChild(item);
        queueGalleryLayout();
        continue;
      }
      if (kind === "video") {
        const mimeType = App.getMediaMimeType(f);
        const canInlineVideo = App.canInlineVideoMedia(f);
        const deferInlinePreview = App.shouldDeferInlineVideoPreview(f);
        if (!canInlineVideo) {
          const fallback = document.createElement("button");
          fallback.type = "button";
          fallback.className = "att-file";
          fallback.innerHTML = fileCardHTML(fn, usableDataURL ? "Download to play" : "Uploading…", "video", f);
          fallback.disabled = !usableDataURL;
          fallback.addEventListener("click", async e => {
            e.preventDefault();
            e.stopPropagation();
            if (!usableDataURL) return;
            await App.downloadFileViaObjectURL(usableDataURL, fn);
          });
          item.appendChild(fallback);
          gallery.appendChild(item);
          queueGalleryLayout();
          continue;
        }
        const card = document.createElement("button");
        card.type = "button";
        card.className = "att-video-card";
        card.setAttribute("aria-label", `Open ${fn}`);
        card.title = fn;
        card.disabled = !usableDataURL;
        if (isLoading) {
          card.innerHTML = `
            <div class="att-video-thumb">
              <div class="att-video-fallback"></div>
            </div>
            <div class="att-video-meta">
              <div class="att-video-name">${App.escapeHtml(fn)}</div>
              <div class="att-video-sub">Uploading video...</div>
            </div>
          `;
        } else {
          card.innerHTML = `
            <div class="att-video-thumb">
              <div class="att-video-fallback"></div>
              ${usableDataURL ? `<span class="att-video-play" aria-hidden="true">${playSvg}</span>` : ""}
            </div>
            <div class="att-video-meta">
              <div class="att-video-name">${App.escapeHtml(fn)}</div>
              <div class="att-video-sub">${deferInlinePreview ? "Large video • click to open" : "Click to open video"}</div>
            </div>
          `;
        }
        card.addEventListener("click", e => {
          e.preventDefault();
          e.stopPropagation();
          if (!usableDataURL) return;
          App.openMediaModal("video", usableDataURL, {
            fileName: fn,
            mimeType
          });
        });
        const thumb = card.querySelector(".att-video-thumb");
        if (usableDataURL && thumb) {
          const poster = document.createElement("video");
          poster.className = "att-video-poster";
          poster.preload = "metadata";
          poster.muted = true;
          poster.playsInline = true;
          poster.setAttribute("muted", "");
          poster.setAttribute("playsinline", "");
          poster.setAttribute("preload", "metadata");
          poster.style.position = "absolute";
          poster.style.inset = "0";
          poster.style.opacity = "0";
          thumb.prepend(poster);
          const fallbackEl = thumb.querySelector(".att-video-fallback");
          let posterShown = false;
          const showPoster = () => {
            if (posterShown || !thumb.isConnected) return;
            posterShown = true;
            try {
              poster.style.opacity = "";
              if (fallbackEl && fallbackEl.isConnected) fallbackEl.remove();
            } catch {}
            queueGalleryLayout();
          };
          if (!preview) App.keepBottomPinnedOnMedia(poster);
          poster.addEventListener("loadedmetadata", () => {
            if (poster.videoWidth > 0 && poster.videoHeight > 0) {
              const ratio = poster.videoWidth / poster.videoHeight;
              thumb.style.aspectRatio = String(ratio);
              item.style.width = `${Math.min(168, 168 * ratio)}px`;
            }
            try {
              const dur = Number(poster.duration);
              if (Number.isFinite(dur) && dur > 0) poster.currentTime = Math.min(0.12, Math.max(0.01, dur * 0.01));
            } catch {}
            queueGalleryLayout();
          }, {
            once: true
          });
          poster.addEventListener("loadeddata", showPoster, {
            once: true
          });
          poster.addEventListener("canplay", showPoster, {
            once: true
          });
          poster.addEventListener("error", queueGalleryLayout, {
            once: true
          });
          const loadPoster = async () => {
            const fastSrc = await App.getFastMediaModalSrc(usableDataURL, mimeType);
            if (!poster.isConnected || !fastSrc) return;
            const source = document.createElement("source");
            source.src = fastSrc;
            if (mimeType) source.type = mimeType;
            poster.appendChild(source);
            try {
              poster.load();
            } catch {}
          };
          // The row is appended synchronously below. Start metadata loading
          // in the next microtask instead of an idle callback (up to 900ms).
          queueMicrotask(() => { void loadPoster(); });
        } else {
          queueGalleryLayout();
        }
        item.appendChild(card);
        gallery.appendChild(item);
        queueGalleryLayout();
        continue;
      }
      const fallback = document.createElement("button");
      fallback.type = "button";
      fallback.className = "att-file";
      fallback.innerHTML = fileCardHTML(fn, usableDataURL ? "Download" : "Preparing…", kind, f);
      fallback.disabled = !usableDataURL;
      fallback.addEventListener("click", async e => {
        e.preventDefault();
        e.stopPropagation();
        if (!usableDataURL) return;
        await App.downloadFileViaObjectURL(usableDataURL, fn);
      });
      item.appendChild(fallback);
      gallery.appendChild(item);
      queueGalleryLayout();
    }
  }
  row.appendChild(avatar);
  row.appendChild(bubble);
  const _target = targetOverride || (App.bulkLoading && App.bulkMsgFrag ? App.bulkMsgFrag : App.messagesListEl);
  if (!_target || !_target.appendChild) return row;
  if (preview) _target.appendChild(row); else App.insertMessageRowChronologically(_target, row);
  App.messageAvatarObserver?.observe(row);
  App.queueMessageAvatarAlignment(row);
  row.dataset.pinned=msg.pinned ? "1" : "0";
  if(msg.pinned){const mark=document.createElement("span");mark.className="message-pin-mark";mark.dataset.tooltip="Pinned Message";mark.setAttribute("aria-label","Pinned Message");mark.innerHTML=App.getMessagePinIcon();row.querySelector('.bubble-top')?.append(mark);}

  // Flush bulk batches every frame so initial loads paint immediately
  if (!preview && App.bulkLoading && App.bulkMsgFrag) App.scheduleBulkMessageFlush();

  // Auto-scroll only if the user was already near the bottom.
  if (!App.bulkLoading && !suppressScroll) {
    if (App.shouldAutoScrollNow(wasNearBottom)) {
      App.forceScrollToBottomFor(isOwn ? 1400 : 900, {
        reason: isOwn ? "own-message" : "new-message"
      });
    }
  }
  return row;
};

App.createPollUserIdentity = function (code, fallback = {}) {
  const user = App.liveUserCache.get(code) || (App.currentUser?.code === code ? App.currentUser : null) || fallback;
  const displayName = user.displayName || user.username || "User";
  const avatar = document.createElement("button"); avatar.type = "button"; avatar.className = "msg-avatar poll-user-avatar";
  avatar.dataset.usercode = code; avatar.dataset.avatarUsercode = code;
  avatar.setAttribute("aria-label", `Open ${displayName}'s Profile`);
  App.applyAvatar(avatar, user);
  const name = document.createElement("span"); name.className = "poll-user-name";
  name.dataset.displayNameUsercode = code; name.textContent = displayName;
  App.ensureLiveUserListener(code);
  return { avatar, name };
};
App.renderSystemMessage = function (row, msg, opts = null) {
  row.classList.add("system-message");
  const event = msg.system || {};
  const icon = document.createElement("span"); icon.className = "system-message-icon"; icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = event.type === "poll_ended" ? App.POLL_ICON : `<svg viewBox="0 0 24 24" fill="none"><path d="${event.type === "member_left" ? "M19 12H5m6-6-6 6 6 6" : String(event.type || "").startsWith("call_") ? "M7 3 4 5c-1 6 9 16 15 15l2-3-5-3-2 2-6-6 2-2-3-5Z" : "M5 12h14m-6-6 6 6-6 6"}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const content = document.createElement("span"); content.className = "system-message-content";
  if (event.userCode && ["member_joined", "member_left", "call_started"].includes(event.type)) {
    const { avatar, name } = App.createPollUserIdentity(event.userCode, event);
    name.classList.add("system-message-name"); avatar.classList.add("system-message-avatar");
    row.appendChild(avatar);
    content.append(name, document.createTextNode(event.type === "member_joined" ? " joined the room." : event.type === "member_left" ? " left the room." : " started a call."));
  } else { row.appendChild(icon); content.textContent = App.getSystemMessageText(event); }
  if (event.pollMessageKey) {
    const jump = document.createElement("button"); jump.type = "button"; jump.className = "poll-text-button"; jump.textContent = "View Poll";
    jump.addEventListener("click", () => (opts?.onReplyJump || App.scrollToMessageKey)(event.pollMessageKey)); content.append(" ", jump);
  }
  const time = document.createElement("span"); time.className = "bubble-time system-message-time";
  time.tabIndex = 0;
  time._refreshTimestamp = () => {
    const parts = App.formatChatTimestampParts(App.getMessageSortTimestamp(msg, msg._key || msg.key));
    time.textContent = parts.short || parts.time || "";
    time.dataset.tooltip = parts.full || "";
    time.setAttribute("aria-label", parts.full || time.textContent);
  };
  time._refreshTimestamp();
  time.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") App.showTimestampTooltipFor(time); });
  time.addEventListener("pointerleave", App.hideTimestampTooltip);
  time.addEventListener("focus", () => App.showTimestampTooltipFor(time));
  time.addEventListener("blur", App.hideTimestampTooltip);
  content.append(" ", time);
  row.appendChild(content);
};
App.openPollVotes = function (roomId, key, initialPoll, anchor) {
  const nodes = new Map();
  let latest = initialPoll, signature = "", closed = false;
  const menu = App.openPollMenu({ title: "Poll Votes", anchor, bodyHTML: '<div class="poll-voters"></div>', closeId: "poll-close-votes" });
  menu.dataset.pollRoom = roomId; menu.dataset.pollKey = key;
  const host = menu.querySelector(".poll-voters");
  const render = () => {
    if (closed || menu.hidden || !Array.isArray(latest?.options)) return;
    const nextSignature = JSON.stringify([latest.options, latest.votes]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const result = App.getPollResults(latest), desired = [], active = new Set();
    const scrollTop = menu.scrollTop;
    for (const option of latest.options) {
      const titleKey = "option:" + option.id;
      let title = nodes.get(titleKey);
      if (!title) { title = document.createElement("h3"); nodes.set(titleKey, title); }
      const text = option.text + " · " + (result.counts[option.id] || 0);
      if (title.textContent !== text) title.textContent = text;
      desired.push(title); active.add(titleKey);
      for (const voter of result.voters[option.id] || []) {
        const voterKey = "voter:" + option.id + ":" + voter.code;
        let person = nodes.get(voterKey);
        if (!person) {
          person = document.createElement("div"); person.className = "poll-voter";
          const { avatar, name } = App.createPollUserIdentity(voter.code, voter);
          person.append(avatar, name); nodes.set(voterKey, person);
        }
        desired.push(person); active.add(voterKey);
      }
    }
    if (!result.total) {
      let empty = nodes.get("empty");
      if (!empty) { empty = document.createElement("p"); empty.textContent = "No votes yet."; nodes.set("empty", empty); }
      desired.push(empty); active.add("empty");
    }
    for (const id of nodes.keys()) if (!active.has(id)) nodes.delete(id);
    App.reconcileChildren(host, desired);
    menu.scrollTop = scrollTop;
    App.scheduleChatPopoverLayout?.();
  };
  render(); App.layoutChatPopovers?.();
  const ref = App.db.ref("messages/" + roomId + "/" + key + "/poll");
  const callback = snapshot => {
    if (closed) return;
    if (!snapshot.exists()) { App.closePollPopover({ immediate:true }); return; }
    latest = snapshot.val(); App.queueLiveUpdate("poll-votes", render);
  };
  menu._pollVotesCleanup = () => { closed = true; ref.off("value", callback); App.cancelLiveUpdate("poll-votes"); };
  ref.on("value", callback);
};
App.renderMessagePoll = function (bubble, msg, roomId) {
  const poll = msg.poll;
  if (!Array.isArray(poll?.options) || poll.options.length < 2) return;
  const key = msg._key || msg.key;
  const currentCode = App.currentUser?.code || "";
  const result = App.getPollResults(poll);
  const ended = App.isPollEnded(poll);
  const voted = poll.votes?.[currentCode]?.options || [];
  App.pollSelectionDrafts ||= new Map();
  const draftKey = `${currentCode}:${roomId}:${key}`;
  const savedDraft = App.pollSelectionDrafts.get(draftKey);
  const currentVote = JSON.stringify(voted);
  const restoreDraft = !ended && savedDraft?.baseVote === currentVote;
  let selections = new Set(restoreDraft ? savedDraft.options : voted);
  let editing = !!(restoreDraft && savedDraft.editing);
  if (!restoreDraft) App.pollSelectionDrafts.delete(draftKey);
  const saveDraft = () => {
    App.pollSelectionDrafts.set(draftKey, { options: [...selections], editing, baseVote: currentVote });
    if (App.pollSelectionDrafts.size > 100) App.pollSelectionDrafts.delete(App.pollSelectionDrafts.keys().next().value);
  };
  const card = document.createElement("section"); card.className = "message-poll"; card.dataset.pollKey = key; card.dataset.roomId = roomId;
  card.setAttribute("aria-label", `Poll: ${poll.question}`);
  bubble.appendChild(card);
  const render = () => {
    const showResults = ended || voted.length > 0 && !editing;
    const remaining = Math.max(0, Number(poll.endsAt) - App.pollNow());
    const remainingText = App.pollRemainingText(remaining);
    card.innerHTML = `<div class="poll-heading"><span class="poll-symbol">${App.POLL_ICON}</span><span>${ended ? "Poll Ended" : poll.allowMultiple ? "Select one or more answers" : "Select one answer"}</span></div><h3 class="poll-question"></h3><div class="poll-options"></div><div class="poll-footer"><button class="poll-text-button poll-view-votes" type="button" data-tooltip="View Votes">${result.total} vote${result.total === 1 ? "" : "s"}</button><span>${ended ? "Final Results" : remainingText}</span></div><div class="poll-actions"></div><div class="poll-error" role="alert"></div>`;
    card.querySelector(".poll-question").textContent = poll.question;
    const list = card.querySelector(".poll-options"); list.setAttribute("role", "group"); list.setAttribute("aria-label", "Poll answers");
    poll.options.forEach(option => {
      const count = result.counts[option.id] || 0;
      const percentage = result.total ? Math.round(count / result.total * 100) : 0;
      const button = document.createElement("button"); button.type = "button"; button.className = "poll-option"; button.dataset.optionId = option.id;
      button.classList.toggle("selected", selections.has(option.id)); button.classList.toggle("winner", ended && result.winners.includes(option.text));
      button.setAttribute("aria-pressed", String(selections.has(option.id))); button.disabled = ended || !!msg.__stub || !!(voted.length && !editing);
      if (showResults) button.style.setProperty("--poll-result", `${percentage}%`);
      const mark = document.createElement("span"); mark.className = "poll-option-mark"; mark.setAttribute("aria-hidden", "true"); mark.innerHTML = App.pollActionIcon("vote");
      const label = document.createElement("span"); label.className = "poll-option-label"; label.textContent = option.text;
      const stat = document.createElement("span"); stat.className = "poll-option-result"; stat.textContent = showResults ? `${count} · ${percentage}%` : "";
      button.append(mark, label, stat);
      button.addEventListener("click", () => {
        if (ended || msg.__stub || App.isPollEnded(poll) || voted.length && !editing) return;
        if (poll.allowMultiple) { if (selections.has(option.id)) selections.delete(option.id); else selections.add(option.id); }
        else selections = new Set([option.id]);
        saveDraft(); render();
      }); list.appendChild(button);
    });
    const actions = card.querySelector(".poll-actions");
    const addAction = (text, action, callback, primary = false) => {
      const button = document.createElement("button"); button.type = "button"; button.className = `poll-action-button${primary ? " primary" : ""}`;
      button.setAttribute("aria-label", text); button.dataset.tooltip = text; button.innerHTML = App.pollActionIcon(action);
      button.addEventListener("click", callback); actions.appendChild(button); return button;
    };
    const run = async task => {
      card.querySelectorAll("button").forEach(button => button.disabled = true);
      try { await task(); }
      catch (error) { render(); card.querySelector(".poll-error").textContent = error.message || "Could not update poll. Try again."; }
    };
    if (!ended) {
      if (!voted.length || editing) {
        const vote = addAction(voted.length ? "Save Vote" : "Vote", "vote", () => run(() => App.voteInPoll(roomId, key, [...selections])), true);
        vote.disabled = !selections.size || !!msg.__stub;
      } else addAction("Change Vote", "change", () => { editing = true; saveDraft(); render(); });
      if (voted.length) addAction("Remove Vote", "remove", () => run(() => App.voteInPoll(roomId, key, [])));
      if (msg.userCode === currentCode && !msg.__stub) addAction("End Poll", "end", event => {
        App.openPollMenu({ title: "End Poll", anchor: event.currentTarget, bodyHTML: '<p class="poll-confirm-copy">Voting will close and the final results will be posted in this room.</p>', actionsHTML: '<button class="btn primary" id="poll-confirm-end" type="button">End Poll</button>' });
        App.$("poll-confirm-end").addEventListener("click", () => { App.closePollPopover(); void run(() => App.finishPoll(roomId, key, { early: true })); });
      });
    }
    card.querySelector(".poll-view-votes").addEventListener("click", event => App.openPollVotes(roomId, key, poll, event.currentTarget));
  };
  render();
  if (ended && !msg.__stub) void App.finishPoll(roomId, key).catch(error => console.warn("Poll finalization will retry:", error));
};
App.register("chat/message-render", function initializeFeature() {
  // One clock for every visible poll; room changes leave no per-message timers.
  setInterval(() => {
    for (const card of document.querySelectorAll(".message-poll")) {
      const preview = card.closest('[data-message-preview="1"]');
      const msg = preview && App.roomSearchState?.room === card.dataset.roomId ? App.roomSearchState.messages.get(card.dataset.pollKey) : App.msgDataByKey.get(card.dataset.pollKey);
      if (!msg?.poll || msg.__stub || msg.poll.endedAt || (!preview && card.dataset.roomId !== App.currentRoomId)) continue;
      if (App.isPollEnded(msg.poll)) void App.finishPoll(card.dataset.roomId, card.dataset.pollKey).catch(() => {});
      else {
        const remaining = Number(msg.poll.endsAt) - App.pollNow();
        const label = card.querySelector(".poll-footer > span");
        if (label) label.textContent = App.pollRemainingText(remaining);
      }
    }
  }, 1000);

});
})(globalThis.ChatApp);
