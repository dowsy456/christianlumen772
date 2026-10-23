/* Immutable account identities; password changes update only credential lookup records. */
(function (App) {
  "use strict";
  const failure = () => new Error("Error. Try a different password");
  const identifierField = /^(?:code|c|\w*Code|createdBy|updatedBy|startedBy|endedBy|deletedBy|from|to)$/;
  function identityMap(path) {
    return /^(users|memberships|pings|appPresence|scheduleViewers|calendarReminders|stickerCollections|passwordReservations|passwordSourceLocks|accountCodeReservations|accountCodeSourceLocks)$/.test(path) ||
      /^(htmlHub|stickers)\/byOwner$/.test(path) || /^stickerSavers\/[^/]+$/.test(path) ||
      /^roomMembers\/[^/]+$/.test(path) || /^readReceipts\/[^/]+\/[^/]+$/.test(path) ||
      /^rooms\/[^/]+\/(online|typing)$/.test(path) ||
      /^calls\/[^/]+\/(members|rings|webrtc|screenViewers)$/.test(path) ||
      /^calls\/[^/]+\/audioPreferences$/.test(path) ||
      /^calls\/[^/]+\/audioPreferences\/[^/]+\/(users|screens|mutedScreens)$/.test(path) ||
      /^calls\/[^/]+\/members\/[^/]+\/viewingShares$/.test(path) ||
      /^calls\/[^/]+\/webrtc\/[^/]+\/[^/]+$/.test(path) ||
      /^calls\/[^/]+\/screenViewers\/[^/]+$/.test(path) ||
      /^activities\/roomActivityClaims$/.test(path) ||
      /^activities\/(?:boplRoyale|mergeParty)\/rooms\/[^/]+\/players$/.test(path) ||
      /^users\/[^/]+\/prefs\/(callAudio|callVolumes|userVolumes|peerVolumes)/.test(path);
  }
  App.migratePasswordData = function (root, oldPassword, nextPassword) {
    if (!root?.users?.[oldPassword]?.username || root.users[nextPassword] ||
        root.passwordReservations?.[nextPassword] || root.accountCodeReservations?.[nextPassword]) throw failure();
    function visit(value, path = "", field = "") {
      if (typeof value === "string") {
        const indexValue = /^(usernames|displayNames)\/[^/]+$/.test(path);
        const activityIdentity = path.startsWith("activities/") && /^(?:password|coordinatorId|hostId|owner|killer|winnerIds|drawIds)$/.test(field);
        return value === oldPassword && (identifierField.test(field) || indexValue || activityIdentity) ? nextPassword : value;
      }
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(item => visit(item, path, field));
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const mapped = key === oldPassword && identityMap(path) ? nextPassword : key === "accountCode" && path.startsWith("activities/") ? "password" : key;
        out[mapped] = key === "targetId" && item === oldPassword && path.startsWith("activities/") && ["player", "self"].includes(value.targetType)
          ? nextPassword : visit(item, path ? `${path}/${key}` : key, key);
      }
      return out;
    }
    const result = visit(root);
    // Leases belong to actual connections. Old tabs are signed out by their
    // account listener and must not leave immortal leases under the new key.
    for (const name of ["appPresence", "scheduleViewers"]) if (result[name]) delete result[name][nextPassword];
    if (result.activities?.roomActivityClaims) delete result.activities.roomActivityClaims[nextPassword];
    for (const room of Object.values(result.rooms || {})) {
      if (room?.online) delete room.online[nextPassword];
      if (room?.typing) delete room.typing[nextPassword];
    }
    const user = result.users[nextPassword];
    delete user.htmlActivities; delete user.gameActivitySessions; delete user.spotifySessions;
    for (const legacy of ["accountCodeReservations", "accountCodeSourceLocks"]) {
      const name = legacy === "accountCodeReservations" ? "passwordReservations" : "passwordSourceLocks";
      if (result[legacy]) result[name] = { ...result[legacy], ...result[name] };
      delete result[legacy];
    }
    return result;
  };
  // Credentials are aliases for an immutable account ID. Changing a password
  // never copies messages, attachments, memberships, or live call state.
  App.changePassword = async function (draft) {
    const next = App.normalizeCodeInput(draft), user = App.currentUser;
    const code = user?.code, oldHash = user?.credentialHash;
    const generation = App.accountSessionGeneration;
    const sameSession = () => App.currentUser === user && App.accountSessionGeneration === generation && !App.accountSessionRevoked;
    if (!next || !code || !oldHash || App.passwordChangeInFlight || App.accountSessionRevoked || Number(App.pendingSendCount) > 0) throw failure();
    if (next === user.password) return next;
    App.passwordChangeInFlight = true;
    let nextRef, nextHash, claimed = false, committed = false;
    try {
      nextHash = await App.sha256Hex(next);
      if (!sameSession()) throw failure();
      nextRef = App.db.ref(`credentials/${nextHash}`);
      const claim = await nextRef.transaction(value => value === null ? code : undefined, undefined, false);
      claimed = claim.committed;
      if (!claimed && claim.snapshot?.val() !== code) throw failure();
      if (!sameSession()) throw failure();
      const changed = await App.db.ref(`users/${code}/credentialHash`).transaction(value => {
        if (!sameSession()) return undefined;
        // A cold SDK cache can be null; compare it at the server before deciding.
        if (value === null) return null;
        return value === oldHash || value === nextHash ? nextHash : undefined;
      }, undefined, false);
      if (!changed.committed || changed.snapshot?.val() !== nextHash) throw failure();
      committed = true;
      // A sign-out/account switch may happen while Firebase confirms the write.
      // The server credential is committed, but it must not sign this tab back
      // in or replace the other account's remembered password.
      if (!sameSession()) return next;
      user.password = next;
      user.credentialHash = nextHash;
      App.setStoredAccountCode(next);
      App.writeCurrentUserBootstrapCache?.();
      // Keep this tiny alias reservation. Removing an older alias races with
      // another device switching back to it; the authoritative hash above
      // alone decides which password is valid. No user content is duplicated.
      return next;
    } catch (error) {
      if (committed) return next;
      // A reservation may already belong to a concurrent successful change.
      // It is harmless when inactive and must not be deleted by a losing tab.
      throw failure();
    } finally {
      App.passwordChangeInFlight = false;
      if (sameSession()) {
        App.stopAccountExistenceWatch?.();
        App.startAccountExistenceWatch?.();
      }
    }
  };
  App.bindPasswordEditor = function (syncEye) {
    const button = App.$("btn-settings-change-code"), editor = App.$("settings-code-editor"), input = App.$("settings-code-input");
    if (!button || !editor || !input) return;
    button.addEventListener("click", () => {
      button.hidden = true; editor.hidden = false; input.value = ""; input.focus();
    });
    const save = async () => {
      if (editor.hidden || !input.value.trim() || App.passwordChangeInFlight) return;
      const user = App.currentUser, generation = App.accountSessionGeneration;
      input.disabled = true;
      try {
        const next = await App.changePassword(input.value);
        if (App.currentUser !== user || App.accountSessionGeneration !== generation) return;
        const display = App.$("settings-code-display");
        if (display) display.value = next;
        syncEye?.(); editor.hidden = true; button.hidden = false;
        App.showToast({ title: "Password Updated", body: "Your new password is now active.", duration: 2200 });
      } catch {
        App.showToast({ title: "Password", body: "Error. Try a different password", duration: 3000 });
      } finally { input.disabled = false; }
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void save(); } });
    return save;
  };
  App.stopAccountExistenceWatch = function () {
    const watch = App.accountExistenceWatch;
    App.accountExistenceWatch = null;
    if (watch) {
      watch.ref.off("value", watch.callback);
      watch.credentialRef?.off("value", watch.credentialCallback);
    }
  };
  App.invalidateAccountSession = function (code) {
    if (String(App.currentUser?.code || "") !== code || App.passwordChangeInFlight || App.accountSessionRevoked) return;
    App.accountSessionRevoked = true;
    // Stop writers synchronously before logout waits for call/game teardown.
    // A removed credential must not produce a partial account at its old key.
    App.cancelQueuedSettingsSave?.();
    App.stopCalendarSession?.();
    App.stopAppPresence?.(); App.stopRoomPresence?.(); App.stopReadReceipts?.();
    App.stopHtmlActivityStackPresence?.({ preservePopups: true });
    App.clearRoomActivityClaimHeartbeat?.(); App.callStopHeartbeat?.();
    App.abortAllFirebaseUploads?.("Account password changed");
    App.setComposerEnabled?.(false);
    return App.logoutToLanding?.();
  };
  App.startAccountExistenceWatch = function () {
    const code = String(App.currentUser?.code || "");
    if (!code || !App.db || App.accountExistenceWatch?.code === code) return;
    App.stopAccountExistenceWatch();
    App.accountSessionRevoked = false;
    const watch = { code, ref: App.db.ref(`users/${code}/username`), callback: null };
    App.accountExistenceWatch = watch;
    watch.callback = snapshot => {
      if (App.accountExistenceWatch !== watch || String(App.currentUser?.code || "") !== code || App.passwordChangeInFlight) return;
      const username = snapshot.val();
      if (typeof username !== "string" || !username.trim()) void App.invalidateAccountSession(code);
    };
    watch.ref.on("value", watch.callback);
    if (App.currentUser?.credentialHash) {
      watch.credentialRef = App.db.ref(`users/${code}/credentialHash`);
      watch.credentialCallback = snapshot => {
        if (App.accountExistenceWatch !== watch || String(App.currentUser?.code || "") !== code || App.passwordChangeInFlight) return;
        if (snapshot.val() !== App.currentUser.credentialHash) void App.invalidateAccountSession(code);
      };
      watch.credentialRef.on("value", watch.credentialCallback);
    }
  };
  App.register("accounts/password", function () {
    // Room/profile listeners are routinely removed on Home, Calendar, and
    // Schedules. Credential validity belongs to the logged-in app session.
    const start = App.startAppPresence, stop = App.stopAppPresence;
    App.startAppPresence = function (...args) {
      const result = start.apply(this, args);
      App.startAccountExistenceWatch();
      return result;
    };
    App.stopAppPresence = function (...args) {
      App.stopAccountExistenceWatch();
      return stop.apply(this, args);
    };
  });
})(globalThis.ChatApp);
