/* accounts/create: methods register before ordered initialization. */
(function (App) {
  "use strict";
App.generateUniqueAccountCode = async function () {
  for (let i = 0; i < 16; i++) {
    const code = App.formatCode(App.randomCode16());
    const passwordHash = await App.sha256Hex(code);
    const reservationSnap = await App.db.ref(`credentials/${passwordHash}`).once("value");
    if (!reservationSnap.exists()) return code;
  }
  throw new Error("Could not generate a unique code.");
};

// Account references never contain the sign-in password. This ID stays stable
// across password and profile edits, so existing messages and rooms stay linked.
App.generateUniqueAccountId = async function () {
  for (let i = 0; i < 16; i++) {
    const code = `uid_${App.randomCode16()}${App.randomCode16()}`;
    if (!(await App.db.ref(`users/${code}/username`).once("value")).exists()) return code;
  }
  throw new Error("Could not generate a unique account ID.");
};

App.register("accounts/create", function initializeFeature() {
App.$("btn-create-account").addEventListener("click", async () => {
  App.hideError("create");
  if (App.accountCreationEnabled === false) { App.setError("create", "Account creation is currently disabled."); return; }
  const username = App.sanitizeUsername(App.$("create-username").value);
  if (!username) {
    App.setError("create", "Username must be 1–20 chars, ASCII only, no emojis/invisible chars.");
    return;
  }
  const usernameLower = username.toLowerCase();
  const hash = await App.sha256Hex(usernameLower);
  const unameRef = App.db.ref(`usernames/${hash}`);
  let code, password;
  let usernameClaimed = false;
  let displayClaim = null;
  let credentialRef = null;
  let credentialClaimed = false;
  let accountCommitted = false;
  try {
    [code, password] = await Promise.all([App.generateUniqueAccountId(), App.generateUniqueAccountCode()]);
  } catch (e) {
    console.error("generateUniqueAccountCode failed:", e);
    App.setError("create", "Create failed. Check console / rules.");
    return;
  }
  try {
    const txResult = await new Promise((resolve, reject) => {
      unameRef.transaction(current => {
        if (current === null) {
          return {
            u: usernameLower,
            code
          };
        }
        if (current && current.u === usernameLower) return; // abort
        return;
      }, (error, committed, snapshot) => {
        if (error) return reject(error);
        resolve({
          committed,
          snapshot
        });
      }, false);
    });
    if (!txResult.committed) {
      App.setError("create", "That username is already taken.");
      return;
    }
    usernameClaimed = true;
    displayClaim = await App.claimDisplayName(username, code);
    if (!displayClaim?.ok) {
      try {
        await unameRef.remove();
      } catch {}
      App.setError("create", "That username is already taken.");
      return;
    }
    const credentialHash = await App.sha256Hex(password);
    credentialRef = App.db.ref(`credentials/${credentialHash}`);
    const credential = await credentialRef.transaction(current => current === null ? code : undefined, undefined, false);
    if (!credential.committed) throw new Error("Could not reserve a unique password. Try again.");
    credentialClaimed = true;
    const userRecord = {
      credentialHash,
      username,
      usernameLower,
      displayName: displayClaim.cleaned,
      displayNameLower: displayClaim.displayNameLower,
      ...(App.pfpState.dataURL && App.pfpState.dataURL !== App.defaultStickmanDataURL() ? { photoDataURL: App.pfpState.dataURL, photoTransform: App.packTransformForStorage() } : {}),
      createdAt: App.firebase.database.ServerValue.TIMESTAMP
    };
    const account = await App.db.ref(`users/${code}`).transaction(current => current == null ? userRecord : undefined, undefined, false);
    if (!account.committed) throw new Error("Could not reserve a unique password. Try again.");
    accountCommitted = true;
    App.showView("home");
    App.$("create-username").value = "";
    App.pfpInput.value = "";
    App.setDefaultPfp();
    App.showToast({
      title: "Account created",
      body: "Save this password. You’ll use it to log in.",
      code: password,
      showCopy: true,
      duration: 10000
    });
  } catch (err) {
    if (credentialClaimed && !accountCommitted) {
      try { await credentialRef.transaction(value => value === code ? null : undefined, undefined, false); } catch {}
    }
    if (displayClaim?.ok && !accountCommitted) {
      try {
        await App.releaseDisplayName(displayClaim.cleaned, code);
      } catch {}
    }
    if (usernameClaimed && !accountCommitted) {
      try {
        await unameRef.remove();
      } catch {}
    }
    console.error("Create account failed:", err);
    App.setError("create", "Could not create account. Check console / rules.");
  }
});
});
})(globalThis.ChatApp);
