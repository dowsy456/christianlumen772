/* accounts/login: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.loginWithCode = async function (password) {
  // Browser, desktop and cached-session callers all resolve the same canonical
  // credential. A stable account UID is never accepted as a login shortcut.
  password = App.normalizeCodeInput(password);
  if (!password) return null;
  const credentialHash = await App.sha256Hex(password);
  const account = await App.db.ref(`credentials/${credentialHash}`).once("value");
  const code = typeof account.val() === "string" ? account.val() : "";
  if (!code) return null;
  const snap = await App.db.ref(`users/${code}`).once("value");
  if (!snap.exists()) return null;
  const rec = snap.val() || {};
  if (rec.credentialHash !== credentialHash || typeof rec.username !== "string" || !rec.username.trim()) return null;
  const ownedDisplay = await App.ensureOwnedDisplayNameForUser(code, rec);

  // Normalize transforms to relative and (if legacy) write back once.
  // Legacy pfp pixels were edited in an 84px preview; legacy banners were edited in a 340px preview.
  const normalizedPhotoTransform = App.normalizeTransformToRel(rec.photoTransform, 84);
  const normalizedBannerTransform = App.normalizeTransformToRel(rec.bannerTransform, 340);

  // Fix: keep the real saved avatar on refresh (and prevent default-pfp + weird zoom)
  const defaultPfp = App.defaultStickmanDataURL();
  const photoDataURL = rec.photoDataURL || defaultPfp;
  const hasCustomPhoto = !!rec.photoDataURL && rec.photoDataURL !== defaultPfp;
  const settings = App.normalizeSettings(rec.settings || App.cloneDefaultSettings());
  App.rememberLoadedSettings?.(code, settings);
  const user = {
    code,
    password,
    credentialHash,
    username: rec.username || "User",
    usernameLower: rec.usernameLower || (rec.username || "user").toLowerCase(),
    displayName: ownedDisplay.displayName,
    displayNameLower: ownedDisplay.displayNameLower,
    bio: String(rec.bio || "").slice(0, 400),
    photoDataURL,
    photoTransform: hasCustomPhoto ? normalizedPhotoTransform : App.normalizeTransformToRel(null, 84),
    bannerDataURL: String(rec.bannerDataURL || ""),
    bannerTransform: normalizedBannerTransform,
    htmlActivity: App.getUserHtmlActivity(rec),
    htmlActivities: rec.htmlActivities || null,
    htmlActivitiesVersion: rec.htmlActivitiesVersion === 1 ? 1 : 0,
    gameActivitySessions: rec.gameActivitySessions || null,
    spotifySessions: rec.spotifySessions || null,
    notificationStatus: rec.notificationStatus === "dnd" ? "dnd" : rec.notificationStatus === "online" ? "online" : null,
    settings
  };

  // One-time migration for older accounts
  try {
    const patch = {};
    if (rec.photoDataURL && !rec.photoTransform?.unit) {
      patch.photoTransform = normalizedPhotoTransform;
    }
    if (rec.bannerTransform && !rec.bannerTransform?.unit) {
      patch.bannerTransform = normalizedBannerTransform;
    }
    if (Object.keys(patch).length) {
      await App.db.ref(`users/${code}`).update(patch);
    }
  } catch {}
  return user;
};

App.register("accounts/login", function initializeFeature() {
App.$("login-code").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.repeat) return;
  event.preventDefault();
  App.$("btn-login").click();
});
App.$("btn-login").addEventListener("click", async () => {
  App.hideError("login");
  const normalized = App.normalizeCodeInput(App.$("login-code").value);
  if (!normalized) {
    App.setError("login", "Enter your password.");
    return;
  }
  const loginGeneration = ++App.accountSessionGeneration;
  try {
    const user = await App.loginWithCode(normalized);
    if (loginGeneration !== App.accountSessionGeneration) return;
    if (!user) {
      App.setError("login", "Account not found.");
      return;
    }
    App.currentUser = user;
    App.startCalendarSession();
      App.startAppPresence();
      App.prepareStickerPicker?.();
    App.ensureLiveUserListener(user.code);
    App.startScheduleViewersListener();
    void App.migrateLegacyHtmlLibrariesToHub();
    await App.leaveStaleCallFromPreviousSession();
    if (loginGeneration !== App.accountSessionGeneration) return;
    App.setStoredAccountCode(normalized);
    App.writeCurrentUserBootstrapCache();
    App.applyResolvedSettings(user.settings);
    App.setMeHeader();
    App.applyScrollFixes();
    App.showView("chat");
    App.showLoggedInHome();
    App.syncPanelButtonVisibility();

    // Hide the tip block under rooms list (requested)
    document.querySelector(".side-foot")?.remove();
    App.attachMemberships();
    App.attachPingsInbox();
    App.startScheduleTypeListener();
    App.showToast({
      title: "Logged in",
      body: `Welcome, ${user.displayName || user.username}.`,
      duration: 2200
    });
  } catch (e) {
    if (loginGeneration !== App.accountSessionGeneration) return;
    console.error("login failed:", e);
    App.setError("login", "Login failed. Try again.");
  }
});
});
})(globalThis.ChatApp);
