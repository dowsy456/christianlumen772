/* chat/message-surface: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.syncRoomEmptyState = function () {
  const emptyState = App.$("room-empty-state");
  if (!emptyState || !App.messagesListEl) return;
  const place = App.getStoredPlace() || "";
  const inRoom = !!App.currentRoomId && place === `room:${App.currentRoomId}` && App.views.chat.dataset.active === "true";
  const loadingNode = App.messagesListEl.querySelector("#room-loading-state, .room-loading-state");
  const loading = !!App.roomLoadingActive || !!(loadingNode && !loadingNode.hidden && loadingNode.dataset.roomLoading === "1");
  const hasMessages = !!App.messagesListEl.querySelector(".msg-row");
  emptyState.hidden = !(inRoom && !loading && !hasMessages);
};
App.scheduleRoomEmptyStateSync = function () {
  if (App.roomEmptyStateRaf) return;
  App.roomEmptyStateRaf = requestAnimationFrame(() => {
    App.roomEmptyStateRaf = 0;
    App.syncRoomEmptyState();
  });
};
App.bindNoDragSelectHomeSchedules = function () {
  if (App.noDragSelectHomeSchedulesBound || !App.messagesListEl) return;
  App.noDragSelectHomeSchedulesBound = true;
  const shouldBlock = e => {
    const place = App.getStoredPlace() || "";
    if (place !== "home" && place !== "schedules") return false;
    const t = e.target;
    if (t instanceof HTMLElement) {
      // Allow normal text selection/caret in inputs/textareas/contenteditable only.
      if (t.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return false;
    }
    return true;
  };
  App.messagesListEl.addEventListener("pointerdown", e => {
    if (shouldBlock(e)) e.preventDefault();
  }, {
    passive: false
  });
  App.messagesListEl.addEventListener("selectstart", e => {
    if (shouldBlock(e)) e.preventDefault();
  }, {
    passive: false
  });
};

App.register("chat/message-surface", function initializeFeature() {
App.messagesEl = App.$("messages");
App.messagesListEl = App.$("messages-inner");
if (!App.messagesListEl && App.messagesEl) {
  App.messagesListEl = document.createElement("div");
  App.messagesListEl.id = "messages-inner";
  App.messagesListEl.className = "messages-inner";
  while (App.messagesEl.firstChild) App.messagesListEl.appendChild(App.messagesEl.firstChild);
  App.messagesEl.appendChild(App.messagesListEl);
}
App.messagesListEl = App.messagesListEl || App.messagesEl;
if (App.messagesListEl && App.messagesListEl !== App.messagesEl) {
  App.messagesListEl.style.display = "flex";
  App.messagesListEl.style.flexDirection = "column";
  App.messagesListEl.style.gap = "6px";
  App.messagesListEl.style.minHeight = "100%";
  App.messagesListEl.style.willChange = "auto";
  App.messagesListEl.style.transform = "";
  App.messagesListEl.style.transition = "";
}
App.roomEmptyStateRaf = 0;
if (App.messagesListEl && typeof MutationObserver !== "undefined") {
  new MutationObserver(App.scheduleRoomEmptyStateSync).observe(App.messagesListEl, {
    childList: true,
    subtree: true
  });
}
App.scheduleRoomEmptyStateSync();
App.noDragSelectHomeSchedulesBound = false;
App.bindNoDragSelectHomeSchedules();
});
})(globalThis.ChatApp);
