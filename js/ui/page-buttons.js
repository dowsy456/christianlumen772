/* ui/page-buttons: methods register before ordered initialization. */
(function (App) {
  "use strict";

App.prepareCalendarPage = function (requestedPlace = "calendar") {
  if (!App.currentUser) return;
  const place = /^calendar:\d{4}-\d{2}-\d{2}$/.test(requestedPlace) ? requestedPlace : "calendar";
  App.closeUserProfile?.(true);
  App.closeCallMenu();
  App.collapseTimeDisplay?.({ silent: true });
  App.closeModal();
  if (App.selectedGame) void App.closeGamesStage({ preserve: false });
  App.closeMobileDrawers?.();
  App.stopAllChatAudio();
  App.stopRoomPresence();
  App.detachOnlineIndicator();
  App.detachMessages();
  App.stopSchedulesHighlightTimer();
  App.stopSchedulesPeopleListener();
  App.cancelEditMessage({ quiet: true });
  App.clearReplyState({ quiet: true });
  App.clearPendingFiles({ quiet: true });
  App.closePingBar({ quiet: true });
  App.currentRoomId = null;
  App.membersListVisible = false;
  App.scheduleRoomEmptyStateSync?.();
  App.abortFirebaseUploadsForPlaceChange(place);
  App.setStoredPlace(place);
  App.setComposerEnabled(false);
  App.syncSidebarNavActive();
  App.syncSidebarRoomActiveStates();
  App.syncCallButton();
  App.syncEmojiButtonVisibility();
  if (App.messagesEl) App.messagesEl.scrollTop = 0;
};


App.register("ui/page-buttons", function initializeFeature() {
App.$("btn-side-calendar")?.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  if (App.currentUser) App.showCalendarPage();
});
App.btnSidePanel = App.$("btn-side-panel");
if (App.btnSidePanel) App.btnSidePanel.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  if (!App.isVinny()) return;
  App.openAdminPanel();
});
App.btnSideSchedules = App.$("btn-side-schedules");
if (App.btnSideSchedules) App.btnSideSchedules.addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  if (!App.currentUser) return;

  // Make sure this navigation always works even if an overlay/modal is partially open
  try {
    App.closeGamesStage();
  } catch {}
  try {
    App.closeModal();
  } catch {}
  App.showSchedulesPage();
});
});
})(globalThis.ChatApp);
