/* chat/send: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.isRoomComposerPreviewActive = function () {
  return !!(App.views.chat?.dataset.active === "true");
};
App.syncComposerPreviewHeight = function ({
  forceCollapsed = false
} = {}) {
  const composer = App.$("composer");
  const input = App.$("msg-input");
  if (!composer || !input) return;
  const mobile = document.body.dataset.mobileUi === "1";
  const visualHeight = Number(window.visualViewport?.height) || 0;
  const viewportH = visualHeight > 0 ? visualHeight : Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0);
  const ratioLimit = Math.floor(viewportH * (mobile ? 0.32 : 0.38));
  const hardLimit = mobile ? 210 : 280;
  const maxHeight = Math.max(App.MSG_INPUT_MIN_HEIGHT, Math.min(hardLimit, ratioLimit || hardLimit));
  input.style.height = `${App.MSG_INPUT_MIN_HEIGHT}px`;
  const measuredHeight = Math.max(App.MSG_INPUT_MIN_HEIGHT, Number(input.scrollHeight) || App.MSG_INPUT_MIN_HEIGHT);
  const contentHeight = Math.min(measuredHeight, maxHeight);
  const hasDraft = String(input.value || "").length > 0;
  const needsExtraRows = /[\r\n]/.test(input.value || "") || measuredHeight > App.MSG_INPUT_MIN_HEIGHT + 2;
  const shouldPreview = !!(App.isRoomComposerPreviewActive() && hasDraft && needsExtraRows && (!forceCollapsed || hasDraft));
  composer.classList.toggle("composer-previewing", shouldPreview);
  input.style.height = `${shouldPreview ? contentHeight : App.MSG_INPUT_MIN_HEIGHT}px`;
  const scrollable = shouldPreview && measuredHeight > maxHeight;
  input.style.overflowY = scrollable ? "auto" : "hidden";
  input.dataset.scrollable = scrollable ? "1" : "0";
  App.syncChatOverlayMetrics();
};
App.canChat = function () {
  return !!(App.currentUser && App.currentRoomId && !App.passwordChangeInFlight && !App.accountSessionRevoked);
};
App.isValidChatMessageRecord = function (message) {
  if (!message || typeof message !== "object") return false;
  if (message.t === "system") return !!message.system;
  if (!String(message.userCode || message.username || message.displayName || "").trim()) return false;
  return !!(String(message.text || "").trim() || message.poll?.question ||
    message.sticker?.id || message.stickerId || message.t === "sticker" ||
    Array.isArray(message.files) && message.files.some(file => file && (file.kind || file.fileName || file.name)) ||
    message.dataURL && ["image", "video", "audio", "html"].includes(message.t));
};
// Updating child paths recreates a deleted message without its author/content.
// A transaction on the complete, compact record retries against concurrent clears.
App.updateExistingMessage = function (ref, patch, { userCode } = {}) {
  return ref.transaction(current => {
    if (current === null) return null;
    if (!App.isValidChatMessageRecord(current) || userCode && String(current.userCode) !== String(userCode)) return;
    return { ...current, ...patch };
  }, undefined, false);
};
App.cancelRoomMessageWork = function (roomId, retainedKeys = null) {
  const room = String(roomId || "");
  App.roomMessageWorkRevision ||= new Map();
  App.roomMessageWorkRevision.set(room, (App.roomMessageWorkRevision.get(room) || 0) + 1);
  for (const scope of Array.from(App.activeFirebaseUploads?.values() || [])) {
    const retained = retainedKeys ? retainedKeys.has(scope.messageKey) : App.currentRoomId === room && App.msgDataByKey?.get(scope.messageKey)?.pinned;
    if (scope.type === "chat-message" && scope.place === `room:${room}` && !retained) scope.abort("Chat cleared");
  }
  if (App.currentRoomId === room) {
    App.cancelEditMessage?.({ quiet: true, keepText: true });
    App.clearReplyState?.({ quiet: true });
  }
};
App.getMessagePreviewText = function (msg) {
  if (msg?.t === "system") return App.getSystemMessageText(msg.system);
  const text = String(msg?.text || "").trim();
  if (text) return text;
  if (msg?.poll?.question) return `[Poll: ${msg.poll.question}]`;
  if (msg?.t === "sticker" || msg?.sticker?.id || msg?.stickerId) {
    const name = String(msg?.sticker?.name || "").trim();
    return name ? `[Sticker: ${name}]` : "[Sticker]";
  }
  let files = Array.isArray(msg?.files) ? msg.files : [];
  if (!files.length && (msg?.t === "image" || msg?.t === "video" || msg?.t === "html" || msg?.t === "audio") && msg?.dataURL) {
    files = [{
      kind: msg.t,
      dataURL: msg.dataURL
    }];
  }
  const all = files;
  if (!all.length) return "";
  const kinds = Array.from(new Set(all.map(f => String(f?.kind || "file"))));
  if (all.length === 1) {
    const k = kinds[0];
    return k === "video" ? "[Video]" : k === "image" ? "[Image]" : k === "audio" ? "[Audio]" : k === "html" ? "[HTML]" : "[File]";
  }
  if (kinds.length === 1) {
    const k = kinds[0];
    return k === "video" ? `[${all.length} Videos]` : k === "image" ? `[${all.length} Images]` : k === "audio" ? `[${all.length} Audio Files]` : k === "html" ? `[${all.length} HTML]` : `[${all.length} Files]`;
  }
  return "[Attachments]";
};
App.getLatestLoadedMessageKey = function () {
  let latestKey = "";
  let latestCreatedAt = -1;
  for (const [key, item] of App.msgDataByKey.entries()) {
    const createdAt = App.getMessageSortTimestamp(item, key);
    if (createdAt > latestCreatedAt || createdAt === latestCreatedAt && String(key).localeCompare(latestKey) > 0) {
      latestKey = String(key);
      latestCreatedAt = createdAt;
    }
  }
  return latestKey;
};
App.formatRoomLastMessagePreview = function (preview, username = App.currentUser?.username) {
  const sender = App.sanitizeUsername(username || "") || "Unknown";
  const body = String(preview || "").trim();
  return (body ? `${sender}: ${body}` : sender).slice(0, 90);
};
App.syncRoomLastMessagePreview = async function (roomId, preview) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  try {
    await App.db.ref(`rooms/${id}`).update({
      lastMessagePreview: App.formatRoomLastMessagePreview(preview)
    });
  } catch {}
};
App.updateRoomLastMessage = async function (roomId, preview, messageKey = "", authorCode = App.currentUser?.code) {
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  try {
    const [room, sent] = await Promise.all([
      App.db.ref(`rooms/${id}`).once("value"),
      messageKey ? App.db.ref(`messages/${id}/${messageKey}`).once("value") : Promise.resolve(null)
    ]);
    if (!room.exists() || messageKey && !sent?.exists()) return;
    const epoch = Number(room.val()?.messagesClearedAt) || 0;
    const createdAt = Number(sent?.val()?.createdAt) || Date.now();
    if (epoch && createdAt <= epoch) return;
    const increment = await App.db.ref(`rooms/${id}`).transaction(current => {
      if (current === null) return null;
      if (!current || (Number(current.messagesClearedAt) || 0) !== epoch) return;
      const next = { ...current, messageCount: (Number(current.messageCount) || 0) + 1 };
      if (createdAt >= (Number(current.lastMessageAt) || 0) || Number(current.lastMessageAt) > App.pollNow() + 60000) {
        next.lastMessageAt = createdAt;
        next.lastMessageKey = messageKey;
        next.lastMessagePreview = App.formatRoomLastMessagePreview(preview, sent?.val()?.username || sent?.val()?.displayName);
      }
      return next;
    }, undefined, false);
    if (messageKey && authorCode && increment.committed && increment.snapshot.val()) {
      await App.creditOwnMessageRead(id, messageKey, authorCode, Number(increment.snapshot.val()?.messageCount) || 0, epoch);
      if (App.pruneReadReceipts) void App.pruneReadReceipts(id, { ...sent.val(), _key: messageKey }).catch(() => {});
    }
  } catch {}
};
App.creditOwnMessageRead = async function (roomId, messageKey, authorCode, totalCount, expectedEpoch = Number(App.roomsMetaCache?.get(roomId)?.messagesClearedAt) || 0) {
  // Sending one message reads that message only. It must not clear earlier
  // messages the sender has not seen while scrolled up or on another screen.
  const seenCount = record => App.getMembershipSeenCount ? App.getMembershipSeenCount(roomId, record) : Number(record?.lastSeenCount) || 0;
  const epoch = Number(App.roomsMetaCache?.get(roomId)?.messagesClearedAt) || 0;
  const locallySeen = String(App.currentUser?.code || "") === String(authorCode) ? seenCount(App.membershipMap?.get(roomId)) : 0;
  await App.db.ref(`memberships/${authorCode}/${roomId}`).transaction(current => {
    if ((Number(App.roomsMetaCache?.get(roomId)?.messagesClearedAt) || 0) !== expectedEpoch || Number(current?.lastSeenEpoch || 0) > expectedEpoch) return;
    if (!current || current.ownReadMessages?.[messageKey]) return;
    const record = typeof current === "object" ? current : {};
    const recent = { ...(record.ownReadMessages || {}), [messageKey]: Date.now() };
    const keys = Object.keys(recent).sort((a, b) => recent[b] - recent[a]);
    for (const key of keys.slice(256)) delete recent[key];
    const seen = Math.max(seenCount(record), locallySeen);
    return { ...record, ownReadMessages: recent, lastSeenEpoch: epoch, lastSeenCount: Math.max(seen, Math.min(totalCount, seen + 1)) };
  }, undefined, false);
};
App.getReplyTargetCacheKey = function (roomId, targetKey) {
  const rid = App.sanitizeRoomCode(roomId || App.currentRoomId);
  const key = String(targetKey || "");
  return rid && key ? `${rid}:${key}` : "";
};
App.getReplyTargetMessage = function (targetKey, roomId = App.currentRoomId) {
  const key = String(targetKey || "");
  if (!key) return null;
  return App.msgDataByKey.get(key) || App.replyTargetPreviewCache.get(App.getReplyTargetCacheKey(roomId, key)) || null;
};
App.scheduleReplyTargetPreviewHydrate = function (roomId, targetKey) {
  const rid = App.sanitizeRoomCode(roomId || App.currentRoomId);
  const key = String(targetKey || "");
  const cacheKey = App.getReplyTargetCacheKey(rid, key);
  if (!rid || !key || !cacheKey) return;
  if (App.msgDataByKey.has(key) || App.replyTargetPreviewCache.has(cacheKey) || App.replyTargetHydratePending.has(cacheKey)) return;
  App.replyTargetHydratePending.add(cacheKey);
  App.db.ref(`messages/${rid}/${key}`).once("value").then(snap => {
    const raw = snap.val();
    if (!raw) return;
    const targetMsg = App.normalizeMessageMedia({
      _key: key,
      ...raw
    });
    App.replyTargetPreviewCache.set(cacheKey, targetMsg);
    App.refreshReplyPreviewDependents(key);
    if (App.replyState && String(App.replyState.key || "") === key) App.updateReplyBarPreview();
  }).catch(() => {}).finally(() => {
    App.replyTargetHydratePending.delete(cacheKey);
  });
};
App.refreshReplyPreviewDependents = function (targetKey) {
  const key = String(targetKey || "");
  if (!key) return;
  const dependents = [];
  for (const [msgKey, item] of App.msgDataByKey.entries()) {
    if (msgKey === key) continue;
    if (String(item?.replyTo?.key || "") !== key) continue;
    dependents.push(item);
  }
  for (const item of dependents) {
    App.replaceMessageRowByKey(item);
  }
};
App.enqueueSendTask = function (taskFn) {
  if (App.passwordChangeInFlight || App.accountSessionRevoked) return Promise.resolve(false);
  App.pendingSendCount = (Number(App.pendingSendCount) || 0) + 1;
  const task = Promise.resolve().then(() => taskFn()).catch(e => {
    console.error("send queue task failed:", e);
  }).finally(() => { App.pendingSendCount = Math.max(0, (Number(App.pendingSendCount) || 1) - 1); });
  return task;
};
App.extractMentionUsernames = function (text) {
  const out = [];
  const me = String(App.currentUser?.username || "").toLowerCase();

  // Match @User where @ is not part of an email/word (prevents "test@email.com" hits)
  const re = /(^|\s)@([A-Za-z0-9_]{1,32})\b/g;
  let m;
  while (m = re.exec(String(text || ""))) {
    const raw = String(m[2] || "").trim();
    if (!raw) continue;
    const cleaned = App.sanitizeUsername(raw);
    if (!cleaned) continue;
    if (cleaned.toLowerCase() === me) continue; // cannot ping yourself
    out.push(cleaned);
  }
  const seen = new Set();
  const uniq = [];
  for (const name of out) {
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(name);
  }
  return uniq;
};
App.findMentionNeedingSpace = function (text) {
  const s = String(text || "");
  const known = new Map();
  const add = name => {
    const cleaned = App.sanitizeUsername(String(name || ""));
    if (!cleaned) return;
    const low = cleaned.toLowerCase();
    if (!known.has(low)) known.set(low, cleaned);
  };
  try {
    (App.schedulesPeopleCache || []).forEach(u => add(u?.username || u?.displayName || ""));
  } catch {}
  add(App.currentUser?.username || "");
  try {
    for (const u of App.liveUserCache.values()) add(u?.username || "");
  } catch {}
  const knownList = Array.from(known.entries()).map(([lower, display]) => ({
    lower,
    display
  })).sort((a, b) => b.lower.length - a.lower.length);

  // Roomwide aliases must also be followed by a literal space.
  const aliasRe = /(^|\s)@(everyone|all|a)(?=$|[^A-Za-z0-9_])/gi;
  let aliasMatch;
  while (aliasMatch = aliasRe.exec(s)) {
    const end = aliasRe.lastIndex;
    const nextCh = s[end] || "";
    if (nextCh !== " ") return aliasMatch[2];
  }
  if (!knownList.length) return null;

  // Find "@Username" tokens. If the token is a known username, it MUST be followed by a literal space.
  // If the token starts with a known username but has extra characters (e.g. "@TJhey"), block send.
  const re = /(^|\s)@([A-Za-z0-9_]{1,32})/g;
  let m;
  while (m = re.exec(s)) {
    const token = String(m[2] || "");
    const tokenLower = token.toLowerCase();
    const end = re.lastIndex;
    const nextCh = s[end] || "";
    for (const u of knownList) {
      if (tokenLower === u.lower) {
        if (nextCh !== " ") return u.display;
        break;
      }
      if (tokenLower.startsWith(u.lower)) {
        return u.display;
      }
    }
  }
  return null;
};
App.resolveUserCodeByUsername = async function (username) {
  const cleaned = App.sanitizeUsername(username);
  if (!cleaned) return null;
  const hash = await App.sha256Hex(cleaned.toLowerCase());
  const snap = await App.db.ref(`usernames/${hash}`).once("value");
  if (!snap.exists()) return null;
  const v = snap.val();
  const code = typeof v === "string" ? v : String((v && typeof v === "object" ? v.code || v.c || "" : "") || "");
  return code ? code : null;
};
App.maybeSendPingsFromText = async function ({
  roomId,
  text,
  msgKey
}) {
  if (!App.currentUser) return;
  const id = App.sanitizeRoomCode(roomId);
  if (!id) return;
  const rawText = String(text || "");
  const names = App.extractMentionUsernames(rawText);
  const wantsRoomwidePing = /(^|\s)@(everyone|all|a)(?=$|[^A-Za-z0-9_])/i.test(rawText);
  const codes = [];
  if (wantsRoomwidePing) {
    try {
      const membershipsSnap = await App.db.ref(`roomMembers/${id}`).once("value");
      const memberships = membershipsSnap.val() || {};
      for (const [userCode, member] of Object.entries(memberships)) {
        if (!userCode) continue;
        if (String(userCode) === String(App.currentUser.code || "")) continue;
        if (!member) continue;
        codes.push(String(userCode));
      }
    } catch {}
  }
  for (const name of names) {
    try {
      const code = await App.resolveUserCodeByUsername(name);
      if (code) codes.push(code);
    } catch {}
  }
  const uniqueCodes = Array.from(new Set(codes)).filter(c => c && c !== App.currentUser.code);
  for (const targetCode of uniqueCodes) {
    try {
      const mem = await App.db.ref(`memberships/${targetCode}/${id}`).once("value");
      if (!mem.exists()) continue;
      const pingRef = App.db.ref(`pings/${targetCode}/${id}`).push();
      await pingRef.set({
        from: App.currentUser.code,
        fromUsername: App.currentUser.username,
        at: App.firebase.database.ServerValue.TIMESTAMP,
        msgKey: msgKey || null
      });
    } catch {}
  }
};
App.sendTextMessage = async function () {
  if (App.passwordChangeInFlight || App.accountSessionRevoked) return;
  const roomId = App.sanitizeRoomCode(App.currentRoomId);
  if (!App.currentUser || !roomId) {
    App.showToast({
      title: "Not in a room",
      body: "Open a room first.",
      duration: 1800
    });
    return;
  }
  App.initOverlaysUI();
  const workRevision = App.roomMessageWorkRevision?.get(roomId) || 0;
  const workIsCurrent = () => (App.roomMessageWorkRevision?.get(roomId) || 0) === workRevision;
  const input = App.$("msg-input");
  const raw = input.value || "";
  const text = raw.trim();
  const hasFiles = Array.isArray(App.pendingFiles) && App.pendingFiles.length > 0;
  const editingThisRoom = !!(App.editState && App.editState.roomId === roomId);
  if (hasFiles && !editingThisRoom) {
    try { App.assertExternalStorageConfigured(); }
    catch (error) {
      App.showToast({ title: "File storage setup required", body: error.message, duration: 6000 });
      return;
    }
  }
  if (editingThisRoom) {
    const editKey = String(App.editState?.key || "");
    const prevMsg = editKey ? App.msgDataByKey.get(editKey) || null : null;
    if (!editKey || !prevMsg) {
      App.cancelEditMessage({
        keepText: true,
        quiet: true
      });
      App.syncComposerPrimaryAction();
      App.showToast({
        title: "Edit expired",
        body: "Open the message menu and try again.",
        duration: 2200
      });
      return;
    }
    if (String(prevMsg.userCode || "") !== String(App.currentUser.code || "")) {
      App.cancelEditMessage({
        keepText: true,
        quiet: true
      });
      App.syncComposerPrimaryAction();
      App.showToast({
        title: "Edit blocked",
        body: "You can only edit your own messages.",
        duration: 2200
      });
      return;
    }
    const prevFiles = Array.isArray(prevMsg.files) ? prevMsg.files : [];
    if (!text && !prevFiles.length && !prevMsg.poll) {
      App.showToast({
        title: "Message is empty",
        body: "Add text before saving this edit.",
        duration: 2200
      });
      return;
    }
    const previousText = String(prevMsg.text || "");
    const optimistic = {
      ...prevMsg,
      text: text || "",
      editedPrevText: previousText,
      editedAt: Date.now()
    };
    App.replaceMessageRowByKey(optimistic);
    App.refreshReplyPreviewDependents(editKey);
    const restoreEditState = () => {
      App.editState = {
        key: editKey,
        roomId,
        originalText: previousText
      };
      if (input) {
        input.value = raw;
        App.lastMsgInputVal = raw;
        input.placeholder = "Edit your message…";
        try {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        } catch {}
      }
      try {
        App.syncComposerPreviewHeight();
      } catch {}
      App.syncComposerPrimaryAction();
    };
    App.editState = null;
    if (input) {
      input.value = "";
      App.lastMsgInputVal = "";
      input.placeholder = "Type a message…";
    }
    App.setMyTyping(false);
    try {
      App.syncComposerPreviewHeight();
    } catch {}
    try {
      input.focus();
    } catch {}
    App.syncComposerPrimaryAction();
    try {
      const editPatch={text:text || "", editedPrevText:previousText, editedAt:App.firebase.database.ServerValue.TIMESTAMP};
      const result = await App.updateExistingMessage(App.db.ref(`messages/${roomId}/${editKey}`), editPatch, { userCode: prevMsg.userCode });
      if (!result.committed || !App.isValidChatMessageRecord(result.snapshot.val())) {
        App.showToast({ title: "Message removed", body: "This message was cleared or deleted before the edit finished.", duration: 2600 });
        return;
      }
      if (!workIsCurrent()) return;
      await App.syncRetainedPinnedMessage?.(roomId, editKey);
      if (App.getLatestLoadedMessageKey() === editKey) {
        await App.syncRoomLastMessagePreview(roomId, App.getMessagePreviewText({
          ...prevMsg,
          text: text || "",
          editedPrevText: previousText,
          editedAt: Date.now()
        }));
      }
    } catch (e) {
      console.error("edit message failed:", e);
      if (!workIsCurrent()) return;
      App.replaceMessageRowByKey(prevMsg);
      App.refreshReplyPreviewDependents(editKey);
      restoreEditState();
      App.showToast({
        title: "Edit failed",
        body: "Check console / rules.",
        duration: 2600
      });
    }
    return;
  }
  if (App.pendingFiles.length > App.CHAT_FILE_MAX_COUNT) { App.showChatFileLimitToast(); return; }
  const oversizedAttachment = App.pendingFiles.find(App.isChatAttachmentOverSizeLimit);
  if (oversizedAttachment) {
    App.showChatFileTooLargeToast(oversizedAttachment);
    return;
  }
  let pollSnap = null;
  try { if (App.pendingPoll) pollSnap = App.validatePollDraft(App.pendingPoll); }
  catch (error) { App.showToast({ title: "Check your poll", body: error.message }); return; }
  if (!text && !hasFiles && !pollSnap) return;
  const shouldPinAfterSend = App.canFollowChatBottom(420);
  const badPing = App.findMentionNeedingSpace(raw);
  if (badPing) {
    App.showToast({
      title: "Ping needs a space",
      body: `Add a space after @${badPing} before sending (example: "@${badPing} hey").`,
      duration: 4200
    });
    return;
  }
  const filesSnap = hasFiles ? App.pendingFiles.slice().map(f => ({
    ...f
  })) : [];
  const replySnap = App.replyState && App.replyState.key ? {
    ...App.replyState
  } : null;
  let lastPreview = text || (pollSnap ? `[Poll: ${pollSnap.question}]` : "");
  if (!lastPreview && filesSnap.length) {
    const all = filesSnap;
    const kinds = Array.from(new Set(all.map(f => {
      if (f?.isVoiceMessage) return "voice";
      return String(f.kind || "file");
    })));
    if (all.length === 1) {
      const k = kinds[0];
      lastPreview = k === "voice" ? "[Voice Message]" : k === "video" ? "[Video]" : k === "image" ? "[Image]" : k === "audio" ? "[Audio]" : k === "html" ? "[HTML]" : "[File]";
    } else if (kinds.length === 1) {
      const k = kinds[0];
      lastPreview = k === "voice" ? `[${all.length} Voice Messages]` : k === "video" ? `[${all.length} Videos]` : k === "image" ? `[${all.length} Images]` : k === "audio" ? `[${all.length} Audio Files]` : k === "html" ? `[${all.length} HTML]` : `[${all.length} Files]`;
    } else {
      lastPreview = "[Attachments]";
    }
  }
  const msg = {
    t: "text",
    text: text || "",
    userCode: App.currentUser.code,
    username: App.currentUser.username,
    displayName: App.currentUser.displayName || App.currentUser.username || "User",
    createdAt: App.firebase.database.ServerValue.TIMESTAMP
  };
  if (pollSnap) msg.poll = {
    question: pollSnap.question,
    options: pollSnap.answers.map((answer, index) => ({ id: `a${index}`, text: answer })),
    allowMultiple: pollSnap.allowMultiple,
    durationSeconds: pollSnap.durationSeconds,
    endsAt: App.pollNow() + pollSnap.durationSeconds * 1000
  };
  if (filesSnap.length) {
    msg.files = filesSnap.map(f => {
      return {
        kind: f.kind,
        fileName: f.fileName || null,
        name: f.name || "",
        displayName: f.displayName || "",
        isVoiceMessage: !!f.isVoiceMessage,
        voiceTrimStartSec: Math.max(0, Number(f.voiceTrimStartSec) || 0),
        mimeType: f.mimeType || f.type || "",
        size: f.size || 0,
        uploadPending: 1
      };
    });
  }
  if (replySnap?.key) {
    const replyTargetMsg = App.getReplyTargetMessage(replySnap.key, roomId);
    const replyPreviewText = App.getReplyTargetPreviewText(replyTargetMsg);
    msg.replyTo = {
      key: replySnap.key,
      userCode: replySnap.userCode || String(replyTargetMsg?.userCode || ""),
      username: replySnap.username || replyTargetMsg?.username || "User",
      displayName: App.normalizeReplyDisplayName(replySnap.displayName || replyTargetMsg?.displayName || replySnap.username || "User"),
      previewText: replyPreviewText === "Original message is still loading." ? "" : replyPreviewText,
      attachmentCount: App.getReplyTargetAttachmentCount(replyTargetMsg)
    };
  }
  if (shouldPinAfterSend) App.forceScrollToBottomFor(1400, {
    reason: "send-before-clear"
  });

  // Clear UI instantly (no animations / no waiting for Firebase).
  input.value = "";
  App.clearPendingPoll();
  App.lastMsgInputVal = "";
  try {
    App.closePingBar({
      quiet: true
    });
  } catch {}
  try {
    App.clearReplyState({
      quiet: true
    });
  } catch {}
  try {
    App.clearPendingFiles({
      quiet: true
    });
  } catch {}
  App.setMyTyping(false);
  try {
    App.syncComposerPreviewHeight();
  } catch {}
  try {
    input.focus();
  } catch {}

  // Optimistic paint: show the message immediately (including attachments) as a stub.
  const newRef = App.db.ref(`messages/${roomId}`).push();
  const msgKey = newRef.key;
  if (msgKey) {
    const stubCreatedAt = App.firebasePushKeyTimestamp(msgKey) || Date.now();
    const stub = {
      ...msg,
      _key: msgKey,
      createdAt: stubCreatedAt,
      __stub: 1
    };
    if (filesSnap.length) {
      stub.files = filesSnap.map(f => ({
        kind: f.kind,
        dataURL: "",
        previewURL: String(f.previewURL || ""),
        fileName: f.fileName || null,
        name: f.name || "",
        displayName: f.displayName || "",
        isVoiceMessage: !!f.isVoiceMessage,
        voiceTrimStartSec: Math.max(0, Number(f.voiceTrimStartSec) || 0),
        mimeType: f.mimeType || f.type || "",
        size: f.size || 0,
        uploadPending: 1,
        __loading: 1
      }));
    }
    App.renderedMsgKeys.add(msgKey);
    App.appendMessageRow(stub);
    if (shouldPinAfterSend) App.forceScrollToBottomFor(1400, {
      reason: "send-stub"
    });
  }
  App.enqueueSendTask(async () => {
    let sent = false;
    const k = String(newRef.key || "");
    const hasUpload = filesSnap.length;
    const removeLocalMessage = async () => {
      try {
        await newRef.remove();
      } catch {}
      try { await App.db.ref(`attachmentBlobs/${roomId}/${k}`).remove(); } catch {}
      try { await App.deleteExternalBlobPrefix(App.externalAttachmentPrefix(roomId, k)); } catch {}
      if (k && App.currentRoomId === roomId) {
        App.cancelMessageMediaRefresh(roomId, k);
        try {
          App.msgElByKey.get(k)?.remove();
        } catch {}
        try {
          App.msgElByKey.delete(k);
        } catch {}
        try {
          App.msgDataByKey.delete(k);
        } catch {}
        try {
          App.renderedMsgKeys.delete(k);
        } catch {}
      }
    };
    const attachmentUploadScope = hasUpload ? App.createFirebaseUploadScope({
      type: "chat-message",
      place: `room:${roomId}`,
      disconnectRefs: [newRef, App.db.ref(`attachmentBlobs/${roomId}/${k}`)],
      cleanup: removeLocalMessage
    }) : null;
    if (attachmentUploadScope) attachmentUploadScope.messageKey = k;
    try {
      if (!workIsCurrent()) throw App.createUploadAbortError("Chat cleared");
      if (attachmentUploadScope) await App.armFirebaseUploadDisconnect(attachmentUploadScope);
      if (!workIsCurrent()) throw App.createUploadAbortError("Chat cleared");
      await App.setRefWithRetry(newRef, msg, App.RTDB_CHUNK_UPLOAD_RETRIES, attachmentUploadScope?.signal || null);
      if (!workIsCurrent() && (await newRef.child("pinned").once("value")).val() !== true) throw App.createUploadAbortError("Chat cleared");
      sent = true;
      if (k && App.currentRoomId === roomId) {
        const prev = App.msgDataByKey.get(k) || null;
        let committedRaw = null;
        try {
          const committedSnap = await newRef.once("value");
          committedRaw = committedSnap.val() || null;
        } catch {}
        if (!workIsCurrent() && !committedRaw?.pinned) throw App.createUploadAbortError("Chat cleared");
        if (!committedRaw) throw App.createUploadAbortError("Message removed");
        const fallbackCreatedAt = App.getMessageSortTimestamp(prev, k) || App.firebasePushKeyTimestamp(k) || Date.now();
        const committedPayload = committedRaw ? {
          ...committedRaw,
          _key: k
        } : {
          ...msg,
          _key: k,
          createdAt: fallbackCreatedAt,
          attachmentsSyncedAt: hasUpload ? 0 : Date.now()
        };
        const localCommitted = App.mergeMessageMediaForDisplay(App.normalizeMessageMedia(committedPayload), prev);
        App.replaceMessageRowByKey(localCommitted);
        if (App.messageHasPendingChunkedMedia(localCommitted)) App.scheduleMessageMediaRefresh(roomId, k, 120);else App.cancelMessageMediaRefresh(roomId, k);
        if (shouldPinAfterSend && !App.chatScrollUserReading) App.forceScrollToBottomFor(1200, {
          reason: "send-commit"
        });
      }
      if (hasUpload) {
        Promise.resolve().then(async () => {
          const lastProgressPaint = new Map();
          try {
            await App.writeMessageAttachmentsToRef(newRef, filesSnap, {
              signal: attachmentUploadScope.signal,
              roomId,
              msgKey: k,
              onProgress: ({
                group,
                index,
                progress
              }) => {
                if (!workIsCurrent() || App.currentRoomId !== roomId) return;
                const now = performance.now();
                if (progress < 100 && now - (lastProgressPaint.get(index) || 0) < 100) return;
                lastProgressPaint.set(index, now);
                const liveMsg = App.msgDataByKey.get(k);
                const list = liveMsg?.files;
                if (!Array.isArray(list) || !list[index]) return;
                list[index] = {
                  ...list[index],
                  uploadProgress: progress,
                  uploadPending: 1
                };
                App.replaceMessageRowByKey({
                  ...liveMsg,
                  [group]: list
                });
              }
            });
            await App.finishFirebaseUploadScope(attachmentUploadScope);
            const committedSnap = await newRef.once("value");
            const committedRaw = committedSnap.val();
            if (committedRaw?.pinned) {
              void App.syncRetainedPinnedMessage?.(roomId, k)?.catch(error => console.warn("Pinned attachment refresh unavailable:", error));
            }
            if (!committedRaw || !workIsCurrent() && !committedRaw.pinned || App.currentRoomId !== roomId) return;
            const committedMsg = App.mergeMessageMediaForDisplay(App.normalizeMessageMedia({
              ...committedRaw,
              _key: k
            }), App.msgDataByKey.get(k) || null);
            App.replaceMessageRowByKey(committedMsg);
            if (App.messageHasPendingChunkedMedia(committedMsg)) {
              App.scheduleMessageMediaRefresh(roomId, k, 120);
            } else {
              App.cancelMessageMediaRefresh(roomId, k);
            }
          } catch (e) {
            await App.cleanupFirebaseUploadScope(attachmentUploadScope, e?.message || "chat upload failed");
            if (App.isUploadAbortError(e)) return;
            console.error("attachment upload failed:", e);
            App.showToast({
              title: "Attachment sync incomplete",
              body: "The message was removed because one or more attachments could not finish syncing.",
              duration: 3200
            });
          }
        });
      }
    } catch (e) {
      console.error("send message failed:", e);
      if (attachmentUploadScope) await App.cleanupFirebaseUploadScope(attachmentUploadScope, e?.message || "send failed");else await removeLocalMessage();
      if (App.isUploadAbortError(e) || !workIsCurrent()) return;
      const canRestore = (() => {
        const curText = String(App.$("msg-input")?.value || "").trim();
        const curHasAtt = App.getTotalPendingAttachmentCount() > 0;
        const curHasReply = !!(App.replyState && App.replyState.key);
        return !curText && !curHasAtt && !curHasReply && !App.pendingPoll && App.currentRoomId === roomId;
      })();
      if (canRestore) {
        if (pollSnap) { App.pendingPoll = pollSnap; App.renderPendingPoll(); }
        try {
          App.$("msg-input").value = raw;
        } catch {}
        try {
          App.pendingFiles = filesSnap.map(f => ({
            ...f
          }));
        } catch {}
        try {
          if (App.getTotalPendingAttachmentCount() > 0) App.renderFilesBar();
        } catch {}
        try {
          if (replySnap?.key) App.setReplyState(replySnap);
        } catch {}
        try {
          App.syncChatOverlayMetrics();
        } catch {}
      }
      App.showToast({
        title: "Send failed",
        body: "Check console / rules.",
        duration: 2600
      });
      return;
    }
    if (!sent) return;
    if (msg.poll) void App.db.ref(`activePolls/${roomId}/${k}`).set({ endsAt: msg.poll.endsAt }).catch(error => console.warn("Poll deadline index could not be saved:", error));
    await Promise.resolve().then(async () => {
      // Mention fan-out may require many user reads/writes. It must not block
      // publishing the room preview/count for every other participant.
      await Promise.allSettled([
        App.maybeSendPingsFromText({
          roomId,
          text,
          msgKey: k
        }),
        App.updateRoomLastMessage(roomId, lastPreview || "", k, msg.userCode)
      ]);
      try {
        App.scheduleLastSeenBump(roomId, {
          immediate: true
        });
      } catch {}
    });
  });
};

App.pollNow = function () { return Date.now() + (Number(App.firebaseServerTimeOffsetMs) || 0); };
App.isPollEnded = function (poll) { return !!poll?.endedAt || Number(poll?.endsAt) <= App.pollNow(); };
App.getPollResults = function (poll) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  const counts = Object.fromEntries(options.map(option => [option.id, 0]));
  const voters = Object.fromEntries(options.map(option => [option.id, []]));
  let total = 0;
  for (const [code, vote] of Object.entries(poll?.votes || {})) {
    const ids = [...new Set(Array.isArray(vote?.options) ? vote.options : [])].filter(id => Object.hasOwn(counts, id));
    if (!ids.length) continue;
    total += 1;
    for (const id of (poll.allowMultiple ? ids : ids.slice(0, 1))) { counts[id] += 1; voters[id].push({ code, ...vote }); }
  }
  const maximum = Math.max(0, ...Object.values(counts));
  return { counts, voters, total, winners: maximum ? options.filter(option => counts[option.id] === maximum).map(option => option.text) : [] };
};
App.voteInPoll = async function (roomId, key, selections) {
  const user = App.currentUser;
  if (!user || !roomId || !key || App.accountSessionRevoked) return false;
  const membership = await App.db.ref(`memberships/${user.code}/${roomId}`).once("value");
  if (!membership.val()) throw new Error("Join this room to vote.");
  const result = await App.db.ref(`messages/${roomId}/${key}`).transaction(message => {
    // Null can be the SDK's cold cache; returning it lets the server retry.
    if (!message) return null;
    const poll = message.poll;
    if (!poll || App.isPollEnded(poll)) return;
    const valid = new Set((poll.options || []).map(option => option.id));
    const ids = [...new Set(selections)].filter(id => valid.has(id));
    if (!poll.allowMultiple && ids.length > 1) return;
    const votes = { ...(poll.votes || {}) };
    if (ids.length) votes[user.code] = { options: ids, displayName: user.displayName || user.username || "User", username: user.username || "User", votedAt: App.pollNow() };
    else delete votes[user.code];
    return { ...message, poll: { ...poll, votes } };
  }, undefined, false);
  if (!result.committed || !result.snapshot.val()?.poll) throw new Error("This poll has ended or was deleted.");
  return true;
};
App.finishPoll = async function (roomId, key, { early = false } = {}) {
  if (!App.currentUser || !roomId || !key) return false;
  const userCode = App.currentUser.code;
  const result = await App.db.ref(`messages/${roomId}/${key}`).transaction(message => {
    if (!message) return null;
    if (!message.poll || message.poll.endedAt) return;
    if (early ? message.userCode !== userCode : Number(message.poll.endsAt) > App.pollNow()) return;
    return { ...message, poll: { ...message.poll, endedAt: early ? App.pollNow() : Number(message.poll.endsAt), endedBy: early ? userCode : "timer" } };
  }, undefined, false);
  const message = result.snapshot?.val();
  if (!message?.poll?.endedAt) return false;
  if (message?.poll?.endedAt) {
    const results = App.getPollResults(message.poll);
    await App.writeRoomSystemMessage(roomId, { type: "poll_ended", question: message.poll.question, winners: results.winners, total: results.total, pollMessageKey: key, createdAt: message.poll.endedAt }, `poll-ended:${key}`);
  }
  return !!result.committed;
};
App.getSystemMessageText = function (event = {}) {
  const name = App.getUserDisplayName?.(event.userCode, event) || event.displayName || event.username || "User";
  if (event.type === "member_joined") return `${name} joined the room.`;
  if (event.type === "member_left") return `${name} left the room.`;
  if (event.type === "call_started") return `${name} started a call.`;
  if (event.type === "call_ended") return "The call ended.";
  if (event.type === "poll_ended") {
    const winners = Array.isArray(event.winners) ? event.winners : [];
    return `Poll ended: “${event.question || "Poll"}”. ${!winners.length ? "No votes were cast." : winners.length === 1 ? `Winner: ${winners[0]}.` : `Tie: ${winners.join(" · ")}.`}`;
  }
  return "Room updated.";
};
App.writeRoomSystemMessage = async function (roomId, event, eventId = "") {
  // A closed poll may outlive the tab that closed it. Retry transient failures
  // here, including a failed metadata acknowledgement after the message saved.
  const stable = { ...event, createdAt: Math.min(Number(event?.createdAt) || App.pollNow(), App.pollNow()) };
  const sessionGeneration = App.accountSessionGeneration;
  const stableId = eventId || `${stable.type}:${App.db.ref(`messages/${roomId}`).push().key}`;
  for (let attempt = 0; ; attempt += 1) {
    if (sessionGeneration !== App.accountSessionGeneration) return false;
    try { return await App.commitRoomSystemMessage(roomId, stable, stableId); }
    catch (error) {
      if (attempt >= 3 || /permission|denied|invalid/i.test(String(error?.message || error))) throw error;
      await new Promise(resolve => setTimeout(resolve, [200, 600, 1800][attempt]));
    }
  }
};
App.commitRoomSystemMessage = async function (roomId, event, eventId = "") {
  const id = App.sanitizeRoomCode(roomId);
  if (!id || !event?.type) return false;
  event = { ...event, createdAt: Math.min(Number(event.createdAt) || App.pollNow(), App.pollNow()) };
  const room = (await App.db.ref(`rooms/${id}`).once("value")).val();
  if (!room || Number(event.createdAt) && Number(event.createdAt) <= Number(room.messagesClearedAt || 0)) return false;
  if (event.pollMessageKey && !(await App.db.ref(`messages/${id}/${event.pollMessageKey}`).once("value")).exists()) return false;
  const key = App.db.ref(`messages/${id}`).push().key;
  const hash = encodeURIComponent(eventId || `${event.type}:${key}`).replace(/\./g, "%2E");
  const claimRef = App.db.ref(`roomSystemEvents/${id}/${hash}`);
  const claim = await claimRef.transaction(current => current?.done ? undefined : current || { key, at: App.pollNow(), event }, undefined, false);
  const record = claim.snapshot?.val();
  if (!record || record.done) return false;
  // Every contender and retry uses the first event's immutable time/content.
  // A delayed worker must never republish an earlier log as a new message.
  event = record.event || event;
  const epoch = Number(room.messagesClearedAt) || 0;
  if (Number(event.createdAt) <= epoch) { await claimRef.update({ done: true }); return false; }
  const beforeWrite = (await App.db.ref(`rooms/${id}`).once("value")).val();
  if (!beforeWrite || (Number(beforeWrite.messagesClearedAt) || 0) !== epoch) { await claimRef.update({ done: true }); return false; }
  const payload = { t: "system", system: event, createdAt: Number(event.createdAt) || App.firebase.database.ServerValue.TIMESTAMP };
  const messageRef = App.db.ref(`messages/${id}/${record.key}`);
  const write = await messageRef.transaction(current => current ? undefined : payload, undefined, false);
  if (write.committed || write.snapshot?.val()?.t === "system") {
    const saved = write.snapshot.val();
    const savedAt = App.getMessageSortTimestamp(saved, record.key);
    if (savedAt <= epoch) { await messageRef.remove(); await claimRef.update({ done: true }); return false; }
    const latest = (await App.db.ref(`rooms/${id}`).once("value")).val();
    if (!latest || (Number(latest.messagesClearedAt) || 0) !== epoch) { await messageRef.remove(); await claimRef.update({ done: true }); return false; }
    await App.db.ref(`rooms/${id}`).transaction(current => {
      if (!current) return null;
      if ((Number(current.messagesClearedAt) || 0) !== epoch) return;
      if (current.countedSystemMessages?.[record.key]) return;
      const counted = { ...(current.countedSystemMessages || {}), [record.key]: true };
      for (const oldKey of Object.keys(counted).sort().slice(0, -256)) delete counted[oldKey];
      const next = { ...current, messageCount: (Number(current.messageCount) || 0) + 1, countedSystemMessages: counted };
      if (Number(current.lastMessageAt || 0) <= savedAt) { next.lastMessageAt = savedAt; next.lastMessageKey = record.key; next.lastMessagePreview = App.getSystemMessageText(saved.system).slice(0, 90); }
      return next;
    }, undefined, false);
  }
  await claimRef.set({ key: record.key, at: record.at || App.pollNow(), done: true });
  return !!write.committed;
};
App.register("chat/send", function initializeFeature() {
App.msgInputFocused = false;
App.MSG_INPUT_MIN_HEIGHT = 42;
App.$("msg-input").addEventListener("focus", () => {
  App.msgInputFocused = true;
  requestAnimationFrame(() => App.syncComposerPreviewHeight());
});
App.$("msg-input").addEventListener("blur", () => {
  App.msgInputFocused = false;
  App.setMyTyping(false);
  App.syncComposerPreviewHeight({
    forceCollapsed: true
  });
});
window.addEventListener("resize", () => App.syncComposerPreviewHeight(), {
  passive: true
});
window.visualViewport?.addEventListener("resize", () => App.syncComposerPreviewHeight(), {
  passive: true
});
window.addEventListener("load", () => {
  requestAnimationFrame(() => App.syncComposerPreviewHeight({
    forceCollapsed: true
  }));
}, {
  once: true
});
requestAnimationFrame(() => App.syncComposerPreviewHeight({
  forceCollapsed: true
}));
App.lastMsgInputVal = "";
App.$("msg-input").addEventListener("input", () => {
  const input = App.$("msg-input");
  if (!input) return;
  App.syncComposerPreviewHeight();
  let val = String(input.value || "");
  const placeNow = App.getStoredPlace() || "home";
  if (App.msgInputFocused && App.currentRoomId) App.bumpMyTyping();
  const canPingHere = !!(App.msgInputFocused && App.currentRoomId && placeNow.startsWith("room:") && App.views.chat.dataset.active === "true");
  if (canPingHere && App.replaceDisplayNameMentionsInComposer(input)) {
    val = String(input.value || "");
    App.syncComposerPreviewHeight();
  }
  if (!canPingHere) {
    if (App.pingBarEl && !App.pingBarEl.hidden) App.closePingBar({
      quiet: true
    });
    App.lastMsgInputVal = val;
    return;
  }
  const caret = typeof input.selectionStart === "number" ? input.selectionStart : val.length;
  const atIdx = caret - 1;
  const justTypedAt = atIdx >= 0 && val[atIdx] === "@" && val.length === App.lastMsgInputVal.length + 1;
  const okAtBoundary = atIdx === 0 || /\s/.test(val[atIdx - 1] || "");
  if (justTypedAt && okAtBoundary) {
    App.openPingBar({
      tokenStart: atIdx
    });
    App.lastMsgInputVal = val;
    return;
  }
  if (justTypedAt && !okAtBoundary) {
    if (App.pingBarEl && !App.pingBarEl.hidden) App.closePingBar({
      quiet: true
    });
  }
  if (App.pingBarEl && !App.pingBarEl.hidden) {
    if (App.pingTokenStart < 0 || App.pingTokenStart >= val.length || val[App.pingTokenStart] !== "@") {
      App.closePingBar({
        quiet: true
      });
    } else {
      App.renderPingList();
    }
  }
  App.lastMsgInputVal = val;
});
App.$("btn-upload").addEventListener("click", () => {
  const placeNow = App.getStoredPlace() || "home";
  if (!App.canChat()) {
    App.showToast({
      title: "Pick a room",
      body: "Create or join a room first.",
      duration: 2200
    });
    return;
  }
  App.$("file-input").click();
});
App.$("file-input").addEventListener("change", async () => {
  const placeNow = App.getStoredPlace() || "home";
  const picked = Array.from(App.$("file-input").files || []);
  App.$("file-input").value = "";
  if (!picked.length) return;

  // Room uploads (attachments)
  if (!App.canChat()) {
    App.showToast({
      title: "Pick a room",
      body: "Create or join a room first.",
      duration: 2200
    });
    return;
  }
  await App.addChatFiles(picked);
});
});
})(globalThis.ChatApp);
