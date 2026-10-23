/* accounts/logout: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.logoutToLanding = async function () {
  const logoutGeneration = ++App.accountSessionGeneration;
  App.clearPendingRoomReads?.();
  App.clearPendingPoll?.();
  App.pollSelectionDrafts?.clear();
  const signedOutCode = String(App.currentUser?.password || App.getStoredAccountCode() || "");
  App.stopCalendarSession();
  App.resetCalendarUI();
  document.body.dataset.calendarPage = "0";
  try {
    App.leaveCall({
      roomId: App.currentCallRoomId,
      quiet: true
    });
  } catch {}
  if (App.selectedGame) await App.closeGamesStage({
    preserve: false
  });
  App.discardPausedMergeParty?.();
  await App.syncMySchedulePresence(false);
  if (logoutGeneration !== App.accountSessionGeneration) return;
  App.stopScheduleViewersListener();
  App.teardownHtmlHubModal();
  App.stopHtmlActivityStackPresence?.();
  App.cancelQueuedSettingsSave();
  App.stopAppPresence();
  App.stopRoomPresence();
  App.detachOnlineIndicator();
  App.detachMessages();
  App.clearRecentRoomMessages();
  App.teardownStickerRuntime();
  App.stopSchedulesHighlightTimer();
  App.stopSchedulesPeopleListener();
  App.stopScheduleTypeListener();
  if (App.membershipsRef) App.membershipsRef.off();
  App.detachPingsInbox();
  App.detachRoomMessageNotifications?.();
  App.stopNotificationAudio?.({ preserveCallCues: true });
  App.membershipsRef = null;
  App.stopPinnedRoomsSync();
  App.stopRoomMetaListeners();
  App.roomsMetaCache.clear();
  App.membershipMap.clear();
  App.currentRoomId = null;
  App.currentUser = null;
  App.clearStoredPlace(signedOutCode);
  App.clearStoredAccountCode(signedOutCode);
  App.clearBootstrapCaches();
  App.resetVisualSettingsToDefaults();
  App.$("login-code").value = "";
  App.showView("home");
  App.syncPanelButtonVisibility();
  App.syncCallButton();
  App.showToast({
    title: "Signed out",
    body: "You’re back on the start screen.",
    duration: 2000
  });
};

App.register("accounts/logout", function initializeFeature() {

});
})(globalThis.ChatApp);
