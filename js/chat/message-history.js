/* chat/message-history: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.detachMessages = function () {
  App.messageAvatarObserver?.disconnect();
  App.messageAvatarRows?.clear();
  App.cleanupRoomMessageLoad?.();
  App.cleanupRoomMessageLoad = null;
  App.watchMessageHistoryPage = null;
  App.releaseMessageWindowKeys = null;
  App.resetMessageWindowToTail = null;
  App.cancelRoomEntryScroll?.();
  clearTimeout(App.historyEdgeRetryTimer);
  App.historyEdgeRetryTimer = null;
  App.historyEdgeRetryCount = 0;
  App.stopChatBottomFollowing?.();
  App.stopReadReceipts?.();
  App.stopPinnedMessages?.();
  try {
    document.querySelectorAll(".msg-row").forEach(row => row.__stickerUnsubscribe?.());
  } catch {}
  try {
    App.stopLiveUserListeners();
  } catch {}
  App.cancelMessageMediaRefreshesForRoom();
  App.roomLoadingSeq += 1;
  App.roomLoadingActive = false;
  try {
    App.$("room-loading-state")?.remove();
  } catch {}
  App.scheduleRoomEmptyStateSync();
  if (App.msgAddedRef && App.msgCb) App.msgAddedRef.off("child_added", App.msgCb);
  if (App.msgRef && App.msgChangedCb) App.msgRef.off("child_changed", App.msgChangedCb);
  if (App.msgRef && App.msgRemovedCb) App.msgRef.off("child_removed", App.msgRemovedCb);
  if (App.msgRef && App.msgValCb) App.msgRef.off("value", App.msgValCb);
  App.msgAddedRef = null;
  App.msgRef = null;
  App.msgCb = null;
  App.msgChangedCb = null;
  App.msgRemovedCb = null;
  App.msgValCb = null;
  App.renderedMsgKeys.clear();
  App.msgElByKey.clear();
  App.msgDataByKey.clear();
  App.replyTargetPreviewCache.clear();
  App.replyTargetHydratePending.clear();
  App.closeMsgMenu(true);
  App.cancelEditMessage({
    quiet: true
  });
  App.clearReplyState({
    quiet: true
  });
  App.unlockChatScroll();

  // reset history/prefetch state (prevents cross-room leakage)
  App.msgHistoryRoomId = null;
  App.msgInitialTailPending = false;
  App.msgOldestKey = null;
  App.msgLoadingOlder = false;
  App.msgLoadingNewer = false;
  App.msgHasNewerHistory = false;
  App.msgAllHistoryLoaded = false;
  App.messagePageCache?.clear();
  App.msgPrefetchLeft = 0;

  // reset bulk batching
  App.bulkLoading = true;
  App.bulkMsgFrag = document.createDocumentFragment();
  if (App.bulkMsgFlushRaf) {
    try {
      cancelAnimationFrame(App.bulkMsgFlushRaf);
    } catch {}
    App.bulkMsgFlushRaf = 0;
  }
};
App.firebasePushKeyTimestamp = function (key) {
  const raw = String(key || "");
  if (!/^[\w-]{20}$/.test(raw)) return 0;
  let timestamp = 0;
  for (let i = 0; i < 8; i++) {
    const digit = App.FIREBASE_PUSH_KEY_CHARS.indexOf(raw[i]);
    if (digit < 0) return 0;
    timestamp = timestamp * 64 + digit;
  }
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : 0;
};
App.getMessageSortTimestamp = function (msg, key = msg?._key || msg?.key || "") {
  const keyTimestamp = App.firebasePushKeyTimestamp(key);
  const createdAt = Number(msg?.createdAt) || Number(msg?.system?.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt <= 8640000000000000) {
    // Older call-end logs used the sender's wall clock. An event cannot happen
    // after its server-adjusted push key was allocated; repair that display
    // order without rewriting or deleting the historical record.
    return msg?.t === "system" && keyTimestamp ? Math.min(createdAt, keyTimestamp) : createdAt;
  }
  return keyTimestamp;
};
App.compareMessageKeys = function (a, b) {
  const ak = String(a || "");
  const bk = String(b || "");
  if (ak === bk) return 0;
  return ak < bk ? -1 : 1;
};
App.compareMessageSortValues = function (aTimestamp, aKey, bTimestamp, bKey) {
  const at = Number(aTimestamp) || 0;
  const bt = Number(bTimestamp) || 0;
  if (at !== bt) return at < bt ? -1 : 1;
  return App.compareMessageKeys(aKey, bKey);
};
App.compareMessagesChronologically = function (a, b) {
  const ak = String(a?._key || a?.key || "");
  const bk = String(b?._key || b?.key || "");
  return App.compareMessageSortValues(App.getMessageSortTimestamp(a, ak), ak, App.getMessageSortTimestamp(b, bk), bk);
};
App.insertMessageRowChronologically = function (target, row) {
  if (!target?.appendChild || !row) return row;
  const msgKey = String(row.dataset?.msgkey || "");
  const sortTs = Number(row.dataset?.sortts) || 0;
  const last = target.lastElementChild;
  if (!last || last !== row && last.dataset?.msgkey && App.compareMessageSortValues(sortTs, msgKey, Number(last.dataset.sortts) || 0, last.dataset.msgkey) >= 0) {
    target.appendChild(row);
    return row;
  }
  let before = null;
  let node = target.firstChild;
  while (node) {
    if (node !== row) {
      const nodeKey = String(node.dataset?.msgkey || "");
      const nodeTs = Number(node.dataset?.sortts) || 0;
      if (nodeKey && App.compareMessageSortValues(sortTs, msgKey, nodeTs, nodeKey) < 0) {
        before = node;
        break;
      }
    }
    node = node.nextSibling;
  }
  if (before && before.parentNode === target) target.insertBefore(row, before);else target.appendChild(row);
  return row;
};
App.flushBulkMessageRowsToList = function () {
  if (!App.bulkMsgFrag || !App.messagesListEl) return;
  for (const row of Array.from(App.bulkMsgFrag.childNodes)) {
    App.insertMessageRowChronologically(App.messagesListEl, row);
  }
};
App.replaceMessageRowByKey = function (msg) {
  const key = String(msg?._key || "");
  if (!key) return;
  App.syncMessagePinMenu?.(msg);
  const old = App.msgElByKey.get(key);
  if (!old) return;
  const parent = old.parentNode;
  try {
    old.__stickerUnsubscribe?.();
  } catch {}
  try {
    App.messageAvatarObserver?.unobserve(old);
    old.remove();
  } catch {}
  App.msgElByKey.delete(key);
  App.msgDataByKey.delete(key);

  // Reinsert through the canonical timestamp/key sorter. Server timestamp
  // resolution can legitimately move an optimistic row after acknowledgement.
  App.appendMessageRow(msg, {
    target: parent || App.messagesListEl,
    suppressScroll: true
  });
  if (App.replyState && String(App.replyState.key || "") === key) App.updateReplyBarPreview();
};
App.scheduleBulkMessageFlush = function () {
  if (!App.bulkLoading || !App.bulkMsgFrag || !App.messagesListEl) return;
  if (App.msgInitialTailPending) return;
  if (App.roomLoadingActive && App.$("room-loading-state")) return;
  if (App.bulkMsgFlushRaf) return;
  App.bulkMsgFlushRaf = requestAnimationFrame(() => {
    App.bulkMsgFlushRaf = 0;
    if (!App.bulkLoading || !App.bulkMsgFrag || !App.messagesListEl) return;
    if (App.msgInitialTailPending) return;
    if (App.roomLoadingActive && App.$("room-loading-state")) return;
    if (App.bulkMsgFrag.childNodes.length) App.flushBulkMessageRowsToList();
    App.bulkMsgFrag = document.createDocumentFragment();
  });
};
App.readMessagePage = function (room, direction, cursor) {
  const cache = App.messagePageCache ||= new Map();
  const key = `${room}:${direction}:${cursor}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 20000) return cached.promise;
  let query = App.db.ref(`messages/${room}`).orderByKey();
  query = direction === "older" ? query.endAt(cursor).limitToLast(App.MSG_PAGE_SIZE + 1) : query.startAt(cursor).limitToFirst(App.MSG_PAGE_SIZE + 1);
  const entry = { at: Date.now(), promise: null };
  entry.promise = query.once("value").then(snapshot => {
    // Large inline attachments must not turn prefetch into an unbounded cache.
    if (JSON.stringify(snapshot.val()).length > 512000) cache.delete(key);
    return snapshot;
  }).catch(error => { cache.delete(key); throw error; });
  cache.set(key, entry);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return entry.promise;
};
App.invalidateMessageHistory = function (room, { resetTail = true } = {}) {
  if (room !== App.msgHistoryRoomId) return;
  App.messagePageCache?.clear();
  App.msgHistoryRevision = (App.msgHistoryRevision || 0) + 1;
  App.msgLoadingOlder = false;
  App.msgLoadingNewer = false;
  if (resetTail) {
    App.msgHasNewerHistory = false;
    App.msgAllHistoryLoaded = false;
    App.resetMessageWindowToTail?.();
  }
};
App.schedulePrefetchOlderMessages = function () {
  if (!App.msgHistoryRoomId || App.msgInitialTailPending || App.msgLoadingOlder || App.msgLoadingNewer) return;
  const keys = Array.from(App.renderedMsgKeys).sort(App.compareMessageKeys);
  if (!keys.length) return;
  // Fetch a neighboring page only when the reader approaches that edge.
  // Opening a room must not download history that has never been requested.
  if (!App.msgAllHistoryLoaded && App.messagesEl?.scrollTop <= 140) void App.readMessagePage(App.msgHistoryRoomId, "older", keys[0]).catch(() => {});
  if (App.msgHasNewerHistory && App.isNearBottom(220)) void App.readMessagePage(App.msgHistoryRoomId, "newer", keys.at(-1)).catch(() => {});
};
App.getMessageWindowAnchor = function () {
  if (!App.messagesEl || !App.messagesListEl) return null;
  const top = App.messagesEl.getBoundingClientRect().top;
  for (const row of App.messagesListEl.children) {
    if (row.dataset.msgkey && row.getBoundingClientRect().bottom > top) return { row, offset: row.getBoundingClientRect().top - top };
  }
  return null;
};
App.restoreMessageWindowAnchor = function (anchor) {
  if (anchor?.row.isConnected && App.messagesEl) App.messagesEl.scrollTop += anchor.row.getBoundingClientRect().top - App.messagesEl.getBoundingClientRect().top - anchor.offset;
};
App.trimMessageWindow = function (side = "oldest", reserve = 0) {
  const limit = Math.max(0, App.MSG_WINDOW_LIMIT - reserve);
  if (App.msgElByKey.size <= limit) return;
  const keys = Array.from(App.msgElByKey.keys()).sort(App.compareMessageKeys);
  const remove = side === "newest" ? keys.slice(limit) : keys.slice(0, keys.length - limit);
  for (const key of remove) {
    const row = App.msgElByKey.get(key);
    row?.querySelectorAll("audio,video").forEach(media => { try { media.pause(); media.removeAttribute("src"); media.load(); } catch {} });
    try { row?.__stickerUnsubscribe?.(); } catch {}
    App.messageAvatarObserver?.unobserve(row);
    App.messageAvatarRows?.delete(row);
    App.cancelMessageMediaRefresh(App.currentRoomId, key);
    row?.remove();
    App.msgElByKey.delete(key); App.msgDataByKey.delete(key); App.renderedMsgKeys.delete(key);
    App.replyTargetPreviewCache.delete(`${App.currentRoomId}:${key}`);
  }
  if (side === "newest") App.msgHasNewerHistory = true;
  else App.msgAllHistoryLoaded = false;
  App.msgOldestKey = Array.from(App.renderedMsgKeys).sort(App.compareMessageKeys)[0] || null;
  App.releaseMessageWindowKeys?.(remove);
};
App.maintainLiveMessageWindow = function () {
  if (App.bulkLoading || App.msgLoadingOlder || App.msgLoadingNewer || App.msgHasNewerHistory || App.msgElByKey.size <= App.MSG_WINDOW_LIMIT) return;
  const anchor = App.getMessageWindowAnchor();
  const rows = Array.from(App.messagesListEl.children).filter(row => row.dataset.msgkey);
  // If the reader is near the oldest edge, keep their position and let newer
  // pages become available below; otherwise retire the oldest offscreen rows.
  const anchorIndex = anchor ? rows.indexOf(anchor.row) : rows.length;
  App.trimMessageWindow(anchorIndex >= 0 && anchorIndex < rows.length - App.MSG_WINDOW_LIMIT ? "newest" : "oldest");
  App.restoreMessageWindowAnchor(anchor);
};
App.loadNewerMessagesPage = async function () {
  if (!App.currentUser || !App.msgHasNewerHistory || App.msgLoadingNewer || App.msgLoadingOlder || App.msgInitialTailPending) return;
  const roomId = App.msgHistoryRoomId, loadSeq = App.roomLoadingSeq, revision = App.msgHistoryRevision;
  if (!roomId || roomId !== App.currentRoomId || App.getStoredPlace() !== `room:${roomId}`) return;
  const newest = Array.from(App.renderedMsgKeys).sort(App.compareMessageKeys).at(-1);
  if (!newest) return;
  const liveRevision = App.msgLiveRevision || 0;
  const isCurrent = () => App.currentRoomId === roomId && App.roomLoadingSeq === loadSeq && App.msgHistoryRevision === revision;
  App.msgLoadingNewer = true;
  let shouldContinue = false;
  try {
    const snap = await App.readMessagePage(roomId, "newer", newest);
    if (!isCurrent()) return;
    const items = [];
    snap.forEach(child => { if (child.key !== newest && !App.renderedMsgKeys.has(child.key) && child.val()) items.push({ ...child.val(), _key: child.key }); });
    const anchor = App.getMessageWindowAnchor();
    App.trimMessageWindow("oldest", items.length);
    const fragment = document.createDocumentFragment();
    items.sort(App.compareMessagesChronologically);
    for (let index = 0; index < items.length; index++) {
      const item = items[index]; App.renderedMsgKeys.add(item._key);
      App.appendMessageRow(item, { target: fragment, suppressScroll: true });
      if ((index + 1) % 12 === 0) { await App.nextPaint(); if (!isCurrent()) return; }
    }
    for (const row of Array.from(fragment.childNodes)) { App.insertMessageRowChronologically(App.messagesListEl, row); App.messageAvatarObserver?.observe(row); App.queueMessageAvatarAlignment?.(row); }
    App.watchMessageHistoryPage?.(items);
    // A live child can arrive while the snapshot/fragment is being processed.
    // Keep paging until a short page also spans a quiet live revision; otherwise
    // an arrival suppressed during history mode could fall between the pages.
    App.msgHasNewerHistory = snap.numChildren() >= App.MSG_PAGE_SIZE + 1 || liveRevision !== App.msgLiveRevision;
    shouldContinue = App.msgHasNewerHistory;
    App.restoreMessageWindowAnchor(anchor);
    App.queueReadReceiptSync?.();
  } catch (error) { console.warn("Newer history unavailable", error?.code); }
  finally {
    if (isCurrent()) {
      App.msgLoadingNewer = false;
      App.schedulePrefetchOlderMessages();
      if (shouldContinue && App.isNearBottom(220)) App.maybeLoadOlderMessages();
    }
  }
};
App.loadOlderMessagesPage = async function ({
  prefetch = false
} = {}) {
  if (!App.currentUser) return;
  if (!App.msgHistoryRoomId || App.msgInitialTailPending || App.msgAllHistoryLoaded || App.msgLoadingOlder || App.msgLoadingNewer) return;
  const placeNow = App.getStoredPlace() || "";
  if (!placeNow.startsWith("room:") || App.currentRoomId !== App.msgHistoryRoomId) return;
  if (!App.msgOldestKey) {
    App.msgOldestKey = Array.from(App.renderedMsgKeys).sort(App.compareMessageKeys)[0] || null;
    if (!App.msgOldestKey) return;
  }
  if (prefetch) {
    if (App.msgPrefetchLeft <= 0) return;
    App.msgPrefetchLeft -= 1;
  }
  App.msgLoadingOlder = true;
  const roomId = App.msgHistoryRoomId;
  const loadSeq = App.roomLoadingSeq;
  const historyRevision = App.msgHistoryRevision;
  const beforeKey = App.msgOldestKey;
  const isCurrent = () => App.currentRoomId === roomId && App.msgHistoryRoomId === roomId && App.roomLoadingSeq === loadSeq && App.msgHistoryRevision === historyRevision;
  try {
    const snap = await App.readMessagePage(roomId, "older", beforeKey);
    if (!isCurrent()) return;
    App.historyEdgeRetryCount = 0;
    if (!snap.exists()) {
      App.msgAllHistoryLoaded = true;
      return;
    }
    const items = [];
    snap.forEach(child => {
      if (!child?.key) return;
      if (child.key === beforeKey) return;
      if (App.renderedMsgKeys.has(child.key)) return;
      const v = child.val();
      if (!v) return;
      v._key = child.key;
      items.push(v);
    });
    if (!items.length) {
      App.msgAllHistoryLoaded = true;
      return;
    }

    // Pagination remains key-anchored, while visible order is always
    // authoritative createdAt followed by key.
    const anchor = App.getMessageWindowAnchor();
    App.trimMessageWindow("newest", items.length);
    const fragment = document.createDocumentFragment();
    App.msgOldestKey = items.reduce((oldest, item) => !oldest || App.compareMessageKeys(item?._key, oldest) < 0 ? String(item?._key || "") : oldest, "");
    items.sort(App.compareMessagesChronologically);
    for (let i = 0; i < items.length; i++) {
      const v = items[i];
      App.renderedMsgKeys.add(v._key);
      App.appendMessageRow(v, {
        target: fragment,
        suppressScroll: true
      });
      const displayed = App.msgDataByKey.get(v._key) || v;
      if (App.messageHasPendingChunkedMedia(displayed)) App.scheduleMessageMediaRefresh(roomId, v._key, 120);else App.cancelMessageMediaRefresh(roomId, v._key);
      if ((i + 1) % 10 === 0) {
        await App.nextPaint();
        if (!isCurrent()) return;
      }
    }
    for (const row of Array.from(fragment.childNodes)) { App.insertMessageRowChronologically(App.messagesListEl, row); App.messageAvatarObserver?.observe(row); App.queueMessageAvatarAlignment?.(row); }
    App.watchMessageHistoryPage?.(items);
    if (snap.numChildren() < App.MSG_PAGE_SIZE + 1) App.msgAllHistoryLoaded = true;
    App.restoreMessageWindowAnchor(anchor);
  } catch (error) {
    // A failed query must not leave the reader stuck against an edge with no
    // further scroll event available. Retry once there; further input retries.
    console.warn("Older history unavailable", error?.code);
    if (isCurrent() && !App.historyEdgeRetryTimer && !App.historyEdgeRetryCount) {
      App.historyEdgeRetryCount = 1;
      App.historyEdgeRetryTimer = setTimeout(() => {
        App.historyEdgeRetryTimer = null;
        if (isCurrent() && App.messagesEl?.scrollTop <= 140) App.maybeLoadOlderMessages();
      }, 1200);
    }
  } finally {
    if (isCurrent()) {
      App.msgLoadingOlder = false;
      App.schedulePrefetchOlderMessages();
    }
  }
};
App.maybeLoadOlderMessages = function () {
  if (!App.messagesEl) return;
  if (Date.now() < (App.suppressHistoryAutoLoadUntil || 0)) return;
  // A short viewport can be both near the top and the bottom. Give an explicit
  // upward read priority or newer paging can permanently starve older history.
  if (App.msgHasNewerHistory && App.isNearBottom(220) && !(App.chatScrollUserReading && App.messagesEl.scrollTop <= 140 && !App.msgAllHistoryLoaded)) { void App.loadNewerMessagesPage(); return; }
  if ((App.getStoredPlace() || "").startsWith("room:") && App.currentRoomId && App.currentRoomId === App.msgHistoryRoomId) {
    if (!App.msgAllHistoryLoaded && !App.msgLoadingOlder && App.messagesEl.scrollTop <= 140) {
      void App.loadOlderMessagesPage();
    }
  }
};
App.isNearBottom = function (thresholdPx = 160) {
  if (!App.messagesEl) return true;
  const dist = App.messagesEl.scrollHeight - (App.messagesEl.scrollTop + App.messagesEl.clientHeight);
  return dist <= thresholdPx;
};
App.isAutoScrollSuspended = function () {
  return Date.now() < (App.suspendAutoScrollUntil || 0);
};
App.canAutoScrollInCurrentRoom = function ({
  ignoreSuspension = false
} = {}) {
  if (!App.autoScrollEnabled) return false;
  if (!ignoreSuspension && App.isAutoScrollSuspended()) return false;
  const placeNow = App.getStoredPlace() || "";
  return !!(placeNow.startsWith("room:") && App.currentRoomId && App.messagesEl);
};
App.shouldAutoScrollNow = function (wasNearBottom) {
  if (!App.canAutoScrollInCurrentRoom()) return false;
  return !App.chatScrollUserReading && !!(App.chatScrollFollowing || wasNearBottom);
};
App.captureChatReadingAnchor = function () {
  const list = App.messagesEl;
  if (!list?.clientHeight || App.chatScrollFollowing) return;
  const top = list.getBoundingClientRect().top;
  const row = Array.from(App.messagesListEl?.querySelectorAll(".msg-row") || []).find(node => node.getBoundingClientRect().bottom > top + 1);
  if (row) App.chatScrollReadingAnchor = { row, key: row.dataset.msgkey, offset: row.getBoundingClientRect().top - top };
};
App.stopChatBottomFollowing = function () {
  if (App.roomEntryScroll?.ready) App.cancelRoomEntryScroll?.();
  App.chatScrollFollowing = false;
  App.chatScrollUserReading = true;
  App.stickyBottomPinUntil = 0;
  if (App.stickyBottomPinRaf) cancelAnimationFrame(App.stickyBottomPinRaf);
  App.stickyBottomPinRaf = 0;
  App.captureChatReadingAnchor();
};
App.canFollowChatBottom = function (threshold = 220) {
  return App.canAutoScrollInCurrentRoom() && !App.chatScrollUserReading && (App.chatScrollFollowing || App.isNearBottom(threshold));
};
App.setMessagesScrollBottom = function () {
  if (!App.messagesEl?.clientHeight || !App.messagesEl.clientWidth) return;
  try {
    App.messagesEl.scrollTop = App.messagesEl.scrollHeight;
    App.chatScrollLastMetrics = { top: App.messagesEl.scrollTop, height: App.messagesEl.clientHeight, width: App.messagesEl.clientWidth, content: App.messagesEl.scrollHeight };
  } catch {}
};
// Room entry always reveals the latest message. Auto Scroll controls subsequent
// reading, so this short settling anchor has its own room/generation boundary.
App.cancelRoomEntryScroll = function () {
  if (App.roomEntryScrollRaf) cancelAnimationFrame(App.roomEntryScrollRaf);
  App.roomEntryScrollRaf = 0;
  App.roomEntryScroll = null;
};
App.beginRoomEntryScroll = function (seq, roomId) {
  App.cancelRoomEntryScroll();
  App.roomEntryScroll = { seq, roomId, ready:false, quietUntil:0, limit:0, metrics:"" };
};
App.scheduleRoomEntryScroll = function () {
  const entry = App.roomEntryScroll;
  if (!entry?.ready || App.roomEntryScrollRaf) return;
  App.roomEntryScrollRaf = requestAnimationFrame(() => {
    App.roomEntryScrollRaf = 0;
    if (entry !== App.roomEntryScroll) return;
    if (entry.seq !== App.roomLoadingSeq || entry.roomId !== App.currentRoomId || App.getStoredPlace() !== `room:${entry.roomId}`) {
      App.cancelRoomEntryScroll(); return;
    }
    const list = App.messagesEl;
    if (App.bulkLoading || !list?.clientHeight || !list.clientWidth) return;
    const now = Date.now();
    const metrics = `${list.clientWidth}:${list.clientHeight}:${list.scrollHeight}`;
    if (metrics !== entry.metrics) { entry.metrics = metrics; entry.quietUntil = now + 250; }
    App.setMessagesScrollBottom();
    if (now >= entry.quietUntil || now >= entry.limit) {
      App.cancelRoomEntryScroll();
      App.chatScrollFollowing = !!App.autoScrollEnabled;
      return;
    }
    App.scheduleRoomEntryScroll();
  });
};
App.touchRoomEntryScroll = function (seq) {
  const entry = App.roomEntryScroll;
  if (!entry || entry.seq !== seq) return;
  if (entry.ready) entry.quietUntil = Date.now() + 250;
  App.scheduleRoomEntryScroll();
};
App.finishRoomEntryScroll = function (seq) {
  const entry = App.roomEntryScroll;
  if (!entry || entry.seq !== seq) return;
  entry.ready = true;
  entry.quietUntil = Date.now() + 250;
  entry.limit = Date.now() + 2500;
  App.setMessagesScrollBottom();
  App.scheduleRoomEntryScroll();
};
// Public layout hook for normal, activity, call and time-display companions.
// Following persists across hidden/revealed views and asynchronous media sizes;
// deliberately reading history keeps a visible message anchored instead.
App.syncChatScrollAfterLayout = function () {
  if (App.chatScrollLayoutRaf) return;
  App.chatScrollLayoutRaf = requestAnimationFrame(() => {
    App.chatScrollLayoutRaf = 0;
    const list = App.messagesEl;
    if (App.roomEntryScroll) { App.scheduleRoomEntryScroll(); return; }
    if (!App.canAutoScrollInCurrentRoom() || !list?.clientHeight || !list.clientWidth || App.msgLoadingOlder || App.bulkLoading) return;
    if (App.chatScrollFollowing && !App.chatScrollUserReading) {
      App.setMessagesScrollBottom();
    } else if (App.chatScrollReadingAnchor) {
      const anchor = App.chatScrollReadingAnchor;
      const row = anchor.row?.isConnected ? anchor.row : App.msgElByKey?.get(anchor.key);
      if (row?.isConnected) {
        const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 0.5) list.scrollTop += delta;
      }
    }
    App.chatScrollLastMetrics = { top: list.scrollTop, height: list.clientHeight, width: list.clientWidth, content: list.scrollHeight };
  });
};
App.clearLiveUnreadForCurrentRoom = function () {
  if (App.isNearBottom(220)) {
    const activeId = App.sanitizeRoomCode(App.currentRoomId);
    if (activeId && App.isRoomActivelyRead(activeId)) App.scheduleLastSeenBump(activeId);
  }
};
App.scheduleStickyBottomFrame = function () {
  if (App.stickyBottomPinRaf) return;
  App.stickyBottomPinRaf = requestAnimationFrame(() => {
    App.stickyBottomPinRaf = 0;
    if (!App.canAutoScrollInCurrentRoom()) return;
    if (!App.chatScrollFollowing || App.chatScrollUserReading) return;
    App.setMessagesScrollBottom();
    App.clearLiveUnreadForCurrentRoom();
    App.syncChatScrollAfterLayout();
  });
};
App.forceScrollToBottomFor = function (durationMs = 900, {
  reason = ""
} = {}) {
  if (!App.canAutoScrollInCurrentRoom()) return;
  App.chatScrollFollowing = true;
  App.chatScrollUserReading = false;
  App.chatScrollReadingAnchor = null;
  const dur = Math.max(80, Number(durationMs) || 900);
  App.stickyBottomPinUntil = Math.max(App.stickyBottomPinUntil || 0, Date.now() + dur);
  App.setMessagesScrollBottom();
  App.clearLiveUnreadForCurrentRoom();
  App.scheduleStickyBottomFrame();
  window.setTimeout(() => {
    if (!App.canAutoScrollInCurrentRoom()) return;
    if (Date.now() <= (App.stickyBottomPinUntil || 0)) {
      App.setMessagesScrollBottom();
      App.clearLiveUnreadForCurrentRoom();
    }
  }, 60);
  window.setTimeout(() => {
    if (!App.canAutoScrollInCurrentRoom()) return;
    if (Date.now() <= (App.stickyBottomPinUntil || 0)) {
      App.setMessagesScrollBottom();
      App.clearLiveUnreadForCurrentRoom();
    }
  }, 180);
};
App.snapScrollToBottom = function () {
  App.forceScrollToBottomFor(220, {
    reason: "snap"
  });
};
App.keepBottomPinnedOnMedia = function (el) {
  if (!el) return;
  const roomId = App.currentRoomId;
  const cb = () => {
    if (App.currentRoomId !== roomId || !el.isConnected) return;
    App.syncChatScrollAfterLayout({ reason: "media-load" });
  };
  try {
    el.addEventListener("load", cb, {
      once: true
    });
    el.addEventListener("loadedmetadata", cb, {
      once: true
    });
    el.addEventListener("canplay", cb, {
      once: true
    });
  } catch {}
};
App.smoothScrollToBottom = function () {
  App.forceScrollToBottomFor(900, {
    reason: "smooth"
  });
};

App.register("chat/message-history", function initializeFeature() {
App.chatScrollFollowing = false;
App.chatScrollUserReading = false;
App.chatScrollReadingAnchor = null;
App.chatScrollLayoutRaf = 0;
App.chatScrollLastMetrics = null;
const scrollHost = App.messagesEl;
if (scrollHost) {
  scrollHost.addEventListener("wheel", event => { if (event.deltaY < 0) App.stopChatBottomFollowing(); }, { passive: true });
  let touchY = null;
  scrollHost.addEventListener("touchstart", event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
  scrollHost.addEventListener("touchmove", event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y > touchY + 2) App.stopChatBottomFollowing();
    touchY = y ?? null;
  }, { passive: true });
  scrollHost.addEventListener("pointerdown", event => {
    // Native scrollbar dragging is deliberate navigation, even during a pin.
    const rect = scrollHost.getBoundingClientRect();
    if (event.pointerType === "mouse" && event.clientX >= rect.right - Math.max(12, scrollHost.offsetWidth - scrollHost.clientWidth)) App.stopChatBottomFollowing();
  }, { passive: true });
  document.addEventListener("keydown", event => {
    if (event.target?.closest?.("input,textarea,[contenteditable='true']")) return;
    if (event.target !== document.body && !scrollHost.contains(event.target)) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) App.stopChatBottomFollowing();
  }, { passive: true });
  scrollHost.addEventListener("scroll", () => {
    if (!scrollHost.clientHeight || !scrollHost.clientWidth || !App.currentRoomId || App.bulkLoading || App.msgLoadingOlder) return;
    // Entry pinning and mobile layout clamping can report a small backwards
    // scroll. Genuine wheel/touch/keyboard/scrollbar input already cancels the
    // entry anchor above; do not misclassify our settling frames as reading.
    if (App.roomEntryScroll?.ready) { App.scheduleRoomEntryScroll(); return; }
    const last = App.chatScrollLastMetrics;
    const unchangedLayout = last && last.height === scrollHost.clientHeight && last.width === scrollHost.clientWidth && last.content === scrollHost.scrollHeight;
    if (Date.now() >= (App.composerLayoutUntil || 0) && unchangedLayout && scrollHost.scrollTop < last.top - 1) App.stopChatBottomFollowing();
    if (App.isNearBottom(2) && !App.isAutoScrollSuspended() && (!App.chatScrollUserReading || unchangedLayout)) {
      App.chatScrollFollowing = true;
      App.chatScrollUserReading = false;
      App.chatScrollReadingAnchor = null;
    } else if (!App.chatScrollFollowing && unchangedLayout) App.captureChatReadingAnchor();
    if (!unchangedLayout) App.syncChatScrollAfterLayout({ reason: "scroll-layout-change" });
    App.chatScrollLastMetrics = { top: scrollHost.scrollTop, height: scrollHost.clientHeight, width: scrollHost.clientWidth, content: scrollHost.scrollHeight };
  }, { passive: true });
  const composerInput = App.$("msg-input");
  const preserveTypingPosition = () => {
    App.composerLayoutUntil = Date.now() + 600;
    App.suppressHistoryAutoLoadUntil = App.composerLayoutUntil;
    if (!App.chatScrollFollowing) App.captureChatReadingAnchor();
    App.syncChatScrollAfterLayout({ reason: "composer-input" });
  };
  composerInput?.addEventListener("beforeinput", preserveTypingPosition);
  composerInput?.addEventListener("input", preserveTypingPosition);
  composerInput?.addEventListener("focus", preserveTypingPosition);
  const resumeManualHistory = () => {
    App.historyEdgeRetryCount = 0;
    App.composerLayoutUntil = 0;
    App.suppressHistoryAutoLoadUntil = 0;
    // Wheel/touch at scrollTop=0 does not produce a scroll event. This also
    // retries a page after initial loading/keyboard layout has settled.
    App.maybeLoadOlderMessages();
  };
  scrollHost.addEventListener("wheel", resumeManualHistory, { passive:true });
  scrollHost.addEventListener("touchmove", resumeManualHistory, { passive:true });
  scrollHost.addEventListener("scroll", () => App.maybeLoadOlderMessages(), { passive:true });
  document.addEventListener("keydown", event => {
    if (event.target?.closest?.("input,textarea,[contenteditable='true']")) return;
    if (event.target !== document.body && !scrollHost.contains(event.target)) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) resumeManualHistory();
  }, { passive:true });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => App.syncChatScrollAfterLayout({ reason: "chat-resize" }));
    for (const node of [scrollHost, App.messagesListEl, document.querySelector(".composer"), document.querySelector(".chat-main")]) if (node) observer.observe(node);
  }
  scrollHost.addEventListener("load", () => App.syncChatScrollAfterLayout({ reason: "loaded-media" }), true);
  window.addEventListener("resize", () => App.syncChatScrollAfterLayout({ reason: "viewport" }), { passive: true });
  window.visualViewport?.addEventListener("resize", () => App.syncChatScrollAfterLayout({ reason: "visual-viewport" }), { passive: true });
}
App.scrollQueued = false;
App.bulkLoading = false;
App.bulkMsgFrag = null;
App.bulkMsgFlushRaf = 0;
App.MSG_LIVE_TAIL = 50;
App.MSG_PAGE_SIZE = 50;
// Constant DOM/media/listener residency even after hours of conversation or
// scrolling through a room with many thousands of messages.
App.MSG_WINDOW_LIMIT = 150;
App.msgLoadingNewer = false;
App.msgHasNewerHistory = false;
App.FIREBASE_PUSH_KEY_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
App.msgHistoryRoomId = null;
App.msgOldestKey = null;
App.msgLoadingOlder = false;
App.msgAllHistoryLoaded = false;
App.msgPrefetchLeft = 0;
});
})(globalThis.ChatApp);
