/* core/start: methods register before ordered initialization. */
(function (App) {
  "use strict";


App.register("core/start", function initializeFeature() {
(function init() {
  App.setDefaultPfp();
  App.syncEye();
  App.showView("home");
  App.applyScrollFixes();
  App.startAccountCreationListener();
  const saved = App.getStoredAccountCode();
  const startupGeneration = App.accountSessionGeneration;
  if (saved) {
    App.applyResolvedSettings(App.readCachedSettings(), {
      persistCache: false
    });
    const cachedUser = App.readCachedUserBootstrap(saved);
    if (cachedUser) {
      App.currentUser = cachedUser;
      App.ensureLiveUserListener(cachedUser.code);
      App.startScheduleViewersListener();
      App.setMeHeader();
      App.applyScrollFixes();
      App.showView("chat");
      App.syncPanelButtonVisibility();
      document.querySelector(".side-foot")?.remove();
      const cachedRoomsReady = (() => {
        try {
          return App.hydrateRoomsListFromCache();
        } catch {
          return false;
        }
      })();
      const cachedPlace = App.getStoredPlace() || "home";
      let restoredCachedPlace = false;
      if (cachedPlace === "calendar" || cachedPlace.startsWith("calendar:")) {
        restoredCachedPlace = true;
        if (cachedPlace.startsWith("calendar:")) App.showCalendarDay(cachedPlace.slice(9));
        else App.showCalendarPage();
      }
      if (cachedPlace.startsWith("room:")) {
        const cachedRoomId = App.sanitizeRoomCode(cachedPlace.slice(5));
        if (cachedRoomId && (!cachedRoomsReady || App.membershipMap.has(cachedRoomId))) {
          restoredCachedPlace = true;
          App.openRoom(cachedRoomId, {
            quiet: true
          });
        }
      }
      if (!restoredCachedPlace) App.showLoggedInHome();
    }
    App.loginWithCode(saved).then(async user => {
      if (startupGeneration !== App.accountSessionGeneration) return;
      if (!user) {
        App.stopCalendarSession();
        App.resetCalendarUI();
        await App.syncMySchedulePresence(false);
        if (startupGeneration !== App.accountSessionGeneration) return;
        App.stopScheduleViewersListener();
        App.clearStoredPlace(saved);
        App.clearStoredAccountCode(saved);
        App.clearBootstrapCaches();
        App.resetVisualSettingsToDefaults();
        App.stopAppPresence();
      App.currentUser = null;
        App.showView("home");
        App.syncPanelButtonVisibility();
        return;
      }
      App.currentUser = user;
      App.startCalendarSession();
      App.startAppPresence();
      App.prepareStickerPicker?.();
      App.ensureLiveUserListener(user.code);
      App.startScheduleViewersListener();
      void App.migrateLegacyHtmlLibrariesToHub();
      App.writeCurrentUserBootstrapCache();
      await App.leaveStaleCallFromPreviousSession();
      if (startupGeneration !== App.accountSessionGeneration) return;
      App.applyResolvedSettings(user.settings);
      App.setMeHeader();
      App.applyScrollFixes();
      App.showView("chat");
      App.syncPanelButtonVisibility();
      document.querySelector(".side-foot")?.remove();
      App.attachMemberships();
      App.attachPingsInbox();
      App.startScheduleTypeListener();
      if (!cachedUser) {
        App.showToast({
          title: "Welcome back",
          body: `Signed in as ${user.username}.`,
          duration: 2200
        });
      }
    }).catch(() => {
      if (startupGeneration !== App.accountSessionGeneration) return;
      App.stopCalendarSession();
      App.resetCalendarUI();
      void App.syncMySchedulePresence(false);
      App.stopScheduleViewersListener();
      App.clearStoredPlace(saved);
      App.clearStoredAccountCode(saved);
      App.clearBootstrapCaches();
      App.resetVisualSettingsToDefaults();
      App.stopAppPresence();
      App.currentUser = null;
      App.showView("home");
      App.syncPanelButtonVisibility();
    });
    return;
  }
  App.resetVisualSettingsToDefaults();
  App.syncPanelButtonVisibility();
})();
});
})(globalThis.ChatApp);
