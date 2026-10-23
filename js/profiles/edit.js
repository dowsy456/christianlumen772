/* profiles/edit: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.updateMyDisplayName = async function (displayName) {
  if (!App.currentUser) return false;
  const cleaned = App.sanitizeUsername(displayName);
  if (!cleaned) return false;
  const code = App.currentUser.code;
  let lock, claim, oldDisplayName = "", saved = false;
  try {
    lock = await App.acquireUserIdentityLock(code);
    const [displaySnap, usernameSnap] = await Promise.all([App.db.ref(`users/${code}/displayName`).once("value"), App.db.ref(`users/${code}/username`).once("value")]);
    if (!usernameSnap.val() || !lock.valid() || App.currentUser?.code !== code) throw new Error("The account changed. Try again.");
    oldDisplayName = String(displaySnap.val() || usernameSnap.val());
    claim = await App.claimDisplayName(cleaned, code);
    if (!claim?.ok) {
      App.showToast({ title: claim?.reason === "taken" ? "Display name taken" : "Update failed", body: claim?.reason === "taken" ? "That display name is already in use." : "Could not check display name availability.", duration: 2600 });
      return false;
    }
    if (!lock.valid() || App.currentUser?.code !== code) throw new Error("The connection was lost. Try again.");
    await App.saveUserDisplayName(code, displaySnap.val(), claim.cleaned, () => lock.valid() && App.currentUser?.code === code);
    saved = true;
    // Keep the old name reserved until the new profile has actually saved.
    if (oldDisplayName.toLowerCase() !== claim.displayNameLower && lock.valid()) await App.releaseDisplayName(oldDisplayName, code).catch(() => {});
    if (!lock.valid() || App.currentUser?.code !== code) return false;
    App.currentUser.displayName = claim.cleaned;
    App.currentUser.displayNameLower = claim.displayNameLower;
  } catch (error) {
    if (!saved && claim?.ok && lock?.valid() && oldDisplayName.toLowerCase() !== claim.displayNameLower) {
      try { await App.releaseDisplayName(claim.cleaned, code); } catch {}
    }
    App.showToast({ title: "Update failed", body: error?.message || "Could not save display name.", duration: 2600 });
    return false;
  } finally { await lock?.release(); }
  const selfCode = String(App.currentUser.code || "");
  if (selfCode) {
    App.liveUserCache.set(selfCode, {
      ...(App.liveUserCache.get(selfCode) || {}),
      code: selfCode,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: App.currentUser.displayName,
      displayNameLower: App.currentUser.displayNameLower,
      bio: String(App.currentUser.bio || "").slice(0, 400),
      photoDataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.currentUser.photoTransform || null,
      bannerDataURL: String(App.currentUser.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340)
    });
    document.querySelectorAll(`[data-display-name-usercode="${selfCode}"]`).forEach(el => {
      el.textContent = App.currentUser.displayName;
    });
    document.querySelectorAll(`.reply-preview-author[data-reply-usercode="${selfCode}"]`).forEach(el => {
      el.textContent = App.normalizeReplyDisplayName(App.currentUser.displayName || App.currentUser.username || "User");
    });
    if (App.replyState && String(App.replyState.userCode || "") === selfCode) {
      App.replyState.displayName = App.currentUser.displayName;
      App.updateReplyBarPreview();
    }
    App.refreshUserIdentityReferences?.(selfCode);
    App.refreshMentionFormattingForRenderedMessages();
  }
  App.writeCurrentUserBootstrapCache();
  App.setMeHeader();
  return true;
};
App.updateMyProfilePicture = async function (photoDataURL, photoTransform) {
  if (!App.currentUser) return;
  const patch = {
    photoDataURL: photoDataURL && photoDataURL !== App.defaultStickmanDataURL() ? photoDataURL : null,
    photoTransform: photoDataURL && photoDataURL !== App.defaultStickmanDataURL() ? App.normalizeTransformToRel(photoTransform, 84) : null
  };
  try {
    await App.db.ref(`users/${App.currentUser.code}`).update(patch);
  } catch (e) {
    App.showToast({
      title: "Update failed",
      body: "Could not save profile picture.",
      duration: 2600
    });
    return;
  }
  App.currentUser.photoDataURL = patch.photoDataURL || App.defaultStickmanDataURL();
  App.currentUser.photoTransform = patch.photoTransform;
  const selfCode = String(App.currentUser.code || "");
  if (selfCode) {
    App.liveUserCache.set(selfCode, {
      ...(App.liveUserCache.get(selfCode) || {}),
      code: selfCode,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
      bio: String(App.currentUser.bio || "").slice(0, 400),
      photoDataURL: patch.photoDataURL,
      photoTransform: patch.photoTransform,
      bannerDataURL: String(App.currentUser.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340),
      htmlActivity: App.getUserHtmlActivity(App.currentUser)
    });
  }
  App.writeCurrentUserBootstrapCache();
  App.setMeHeader();
  App.refreshRenderedAvatarForUser(App.liveUserCache.get(selfCode) || App.currentUser);
  if (App.userProfileOpen && App.userProfilePinnedCode === selfCode) {
    App.refreshOpenUserProfileCard();
  }
};
App.updateMyProfileBio = async function (bio) {
  if (!App.currentUser) return false;
  const cleaned = String(bio || "").slice(0, 400);
  try {
    await App.db.ref(`users/${App.currentUser.code}`).update({
      bio: cleaned
    });
  } catch (e) {
    App.showToast({
      title: "Update failed",
      body: "Could not save bio.",
      duration: 2600
    });
    return false;
  }
  App.currentUser.bio = cleaned;
  const selfCode = String(App.currentUser.code || "");
  if (selfCode) {
    App.liveUserCache.set(selfCode, {
      ...(App.liveUserCache.get(selfCode) || {}),
      code: selfCode,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
      bio: cleaned,
      photoDataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.currentUser.photoTransform || null,
      bannerDataURL: App.currentUser.bannerDataURL || "",
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340)
    });
  }
  App.writeCurrentUserBootstrapCache();
  return true;
};
App.updateMyProfileBanner = async function (bannerDataURL, bannerTransform) {
  if (!App.currentUser) return false;
  const patch = {
    bannerDataURL: String(bannerDataURL || ""),
    bannerTransform: App.normalizeTransformToRel(bannerTransform, 340)
  };
  try {
    await App.db.ref(`users/${App.currentUser.code}`).update(patch);
  } catch (e) {
    App.showToast({
      title: "Update failed",
      body: "Could not save banner.",
      duration: 2600
    });
    return false;
  }
  App.currentUser.bannerDataURL = patch.bannerDataURL;
  App.currentUser.bannerTransform = patch.bannerTransform;
  const selfCode = String(App.currentUser.code || "");
  if (selfCode) {
    App.liveUserCache.set(selfCode, {
      ...(App.liveUserCache.get(selfCode) || {}),
      code: selfCode,
      username: App.currentUser.username || "User",
      usernameLower: String(App.currentUser.usernameLower || App.currentUser.username || "user").toLowerCase(),
      displayName: App.currentUser.displayName || App.currentUser.username || "User",
      displayNameLower: String(App.currentUser.displayNameLower || App.currentUser.displayName || App.currentUser.username || "user").toLowerCase(),
      bio: String(App.currentUser.bio || "").slice(0, 400),
      photoDataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
      photoTransform: App.normalizeTransformToRel(App.currentUser.photoTransform, 84),
      bannerDataURL: String(App.currentUser.bannerDataURL || ""),
      bannerTransform: App.normalizeTransformToRel(App.currentUser.bannerTransform, 340),
      htmlActivity: App.getUserHtmlActivity(App.currentUser)
    });
  }
  App.writeCurrentUserBootstrapCache();
  App.refreshRenderedAvatarForUser(App.liveUserCache.get(selfCode) || App.currentUser);
  if (App.userProfileOpen && App.userProfilePinnedCode === selfCode) {
    App.refreshOpenUserProfileCard();
  }
  return true;
};

App.register("profiles/edit", function initializeFeature() {
App.$("btn-side-home").addEventListener("click", e => {
  e.preventDefault();
  e.stopPropagation();
  if (!App.currentUser) return;

  // Ensure Home always works even if an overlay/modal is partially open
  try {
    App.closeGamesStage();
  } catch {}
  try {
    App.closeModal();
  } catch {}
  App.showLoggedInHome();
});
});
})(globalThis.ChatApp);
