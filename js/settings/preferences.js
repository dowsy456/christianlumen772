/* settings/preferences: methods register before ordered initialization. */
(function (App) {
  "use strict";

// Reuse the actual controls so their save handlers and drafts survive tab changes.
App.enhanceSettingsContent = function (body) {
  const shell = body?.querySelector(".settings-shell");
  if (!shell) return;
  const panels = Array.from(shell.querySelectorAll(".settings-panel"));
  const groups = [
    { id: "profile", label: "Profile", titles: ["Profile Preview", "Identity", "Profile Picture", "Banner"] },
    { id: "appearance", label: "Appearance", titles: ["Background"] },
    { id: "preferences", label: "Preferences", titles: ["Interface", "Behavior", "Sound Effects"] },
    { id: "account", label: "Account", titles: ["Password", "Spotify"] }
  ];
  shell.classList.add("settings-refresh");
  const tabs = document.createElement("div");
  tabs.className = "settings-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Settings categories");
  const content = document.createElement("div");
  content.className = "settings-content";
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-tab";
    button.id = `settings-tab-${group.id}`;
    button.textContent = group.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `settings-pane-${group.id}`);
    const pane = document.createElement("div");
    pane.className = `settings-pane settings-pane-${group.id}`;
    pane.id = `settings-pane-${group.id}`;
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", button.id);
    pane.tabIndex = 0;
    group.button = button;
    group.pane = pane;
    for (const title of group.titles) {
      const panel = panels.find(item => item.querySelector(".settings-panel-title")?.textContent.trim() === title);
      if (!panel) continue;
      panel.dataset.settingsKind = title.toLowerCase().replace(/\s+/g, "-");
      pane.appendChild(panel);
    }
    tabs.appendChild(button);
    content.appendChild(pane);
  }
  shell.replaceChildren(tabs, content);
  const empty = document.createElement("div");
  empty.className = "settings-search-empty";
  empty.textContent = "No matching settings.";
  empty.setAttribute("role", "status");
  empty.hidden = true;
  content.appendChild(empty);

  // Explicit labels also make the touch targets and screen reader names consistent.
  shell.querySelectorAll(".settings-field, .settings-slider-row").forEach(field => {
    const label = field.querySelector(".label, .settings-slider-label");
    const input = field.querySelector("input[id], textarea[id]");
    if (!label || !input) return;
    const next = document.createElement("label");
    next.className = label.className;
    next.htmlFor = input.id;
    next.textContent = label.textContent;
    label.replaceWith(next);
  });
  shell.querySelectorAll(".settings-toggle-card").forEach(card => {
    const input = card.querySelector("input[id]");
    const title = card.querySelector(".settings-toggle-title");
    const desc = card.querySelector(".settings-toggle-desc");
    if (!input || !title) return;
    title.id = `${input.id}-label`;
    input.setAttribute("aria-labelledby", title.id);
    if (desc) {
      desc.id = `${input.id}-description`;
      input.setAttribute("aria-describedby", desc.id);
    }
  });
  let selected = "profile";
  let query = "";
  const render = () => {
    const q = query.trim().toLowerCase();
    shell.classList.toggle("is-searching", !!q);
    let visibleCount = 0;
    for (const group of groups) {
      const active = !q && selected === group.id;
      group.button.setAttribute("aria-selected", String(active));
      group.button.tabIndex = selected === group.id ? 0 : -1;
      let matches = 0;
      group.pane.querySelectorAll(".settings-panel").forEach(panel => {
        // Profile prose isn't a preference and should not add unrelated results.
        const copy = panel.dataset.settingsKind === "profile-preview" ? "profile preview" : panel.textContent;
        const text = `${panel.dataset.settingsSearch || ""} ${copy || ""}`.replace(/\s+/g, " ").toLowerCase();
        const match = !q || text.includes(q);
        panel.hidden = !match;
        if (match) matches++;
      });
      group.pane.hidden = q ? !matches : !active;
      if (!group.pane.hidden) visibleCount += matches;
    }
    empty.hidden = !q || visibleCount > 0;
  };
  const select = group => {
    selected = group.id;
    query = "";
    const search = App.$("settings-search-input");
    if (search) search.value = "";
    render();
    body.scrollTop = 0;
    // Editors may have been hidden during a viewport resize.
    window.dispatchEvent(new Event("resize"));
  };
  groups.forEach((group, index) => {
    group.button.addEventListener("click", () => select(group));
    group.button.addEventListener("keydown", event => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % groups.length;
      if (event.key === "ArrowLeft") next = (index + groups.length - 1) % groups.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = groups.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(groups[next]);
      groups[next].button.focus();
    });
  });
  App.$("settings-search-input")?.addEventListener("input", event => {
    query = String(event.target.value || "");
    render();
  });
  render();
};


App.register("settings/preferences", function initializeFeature() {
App.$("btn-side-settings").addEventListener("click", () => {
  if (!App.currentUser) return;
  const checked = App.autoScrollEnabled ? "checked" : "";
  const checkedAccClose = App.accidentalClosePreventionEnabled ? "checked" : "";
  const checkedPush = App.pushNotifsEnabled && (!App.mobileNativeAvailable || App.mobileNativeInfo?.notificationsPermission === "granted") ? "checked" : "";
  const pushSupported = App.supportsDesktopNotifications();
  const pushDisabledAttr = pushSupported ? "" : "disabled";
  const pushHint = App.mobileNativeAvailable
    ? (App.mobileNativeInfo?.backgroundPush ? "Message and mention notifications on this phone." : "Message alerts while Chat App is running. Delivery when the app is closed is not configured.")
    : pushSupported ? "If enabled, pings will show a desktop notification." : "Desktop notifications are not supported in this browser.";
  const savedTabName = String(App.currentSettings?.tab?.name ?? App.APP_TAB_TITLE_DEFAULT);
  const savedTabIcon = String(App.currentSettings?.tab?.icon ?? "");
  const tabNameDefault = savedTabName;
  const tabIconDefault = savedTabIcon;
  const desktopSettings = globalThis.chatDesktopRings?.version === 1 || globalThis.chatDesktopOverlay?.version === 1;
  let cloakKeysCommitted = App.normalizeCloakKeysSetting(App.currentSettings?.blackoutCloakKeys);
  let cloakEditing = false;
  let cloakDraftKeys = [...cloakKeysCommitted];
  let cloakKeydownHandler = null;
  let syncCloakUI = () => {};
  function formatCloakKeys(arr) {
    return Array.isArray(arr) && arr.length ? arr.join(" + ") : "";
  }
  function cloakKeysContainReservedMembersHotkey(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return false;
    const keys = arr.map(x => String(x || "").trim().toUpperCase()).filter(Boolean);
    for (let i = 0; i < keys.length - 1; i++) {
      const isCtrl = keys[i] === "CONTROL" || keys[i] === "CTRL";
      if (isCtrl && keys[i + 1] === "U") return true;
    }
    return false;
  }
  function stopCloakEditing({
    save = false
  } = {}) {
    if (cloakKeydownHandler) {
      window.removeEventListener("keydown", cloakKeydownHandler, true);
      cloakKeydownHandler = null;
    }
    const shouldSave = save && Array.isArray(cloakDraftKeys) && cloakDraftKeys.length;
    if (shouldSave) {
      if (cloakKeysContainReservedMembersHotkey(cloakDraftKeys)) {
        App.showToast({
          title: "Cloak",
          body: "Ctrl + U is reserved for the members list in chat rooms.",
          duration: 2600
        });
      } else {
        cloakKeysCommitted = [...cloakDraftKeys];
        App.updateSettingsState({
          blackoutCloakKeys: cloakKeysCommitted
        });
      }
    }
    cloakEditing = false;
    App.cloakHotkeyEditing = false;
    window.dispatchEvent(new Event("chatapp-cloak-reset"));
    cloakDraftKeys = [...cloakKeysCommitted];
    syncCloakUI();
  }
  function normalizeCloakKeyFromEvent(e) {
    return App.normalizeCloakKeyName(e.key);
  }
  App.openModal({
    title: "Settings",
    size: "settings",
    bodyHTML: `
      <div class="settings-shell">
        <div class="settings-layout">
          <section class="settings-panel settings-panel-preview">
            <div class="settings-panel-head">
              <div>
                <div class="settings-panel-title">Profile Preview</div>
              </div>
            </div>
            <button class="settings-profile-preview" id="settings-profile-preview" type="button" aria-label="User profile preview"></button>
          </section>

          <section class="settings-panel">
            <div class="settings-panel-head">
              <div>
                <div class="settings-panel-title">Identity</div>
                <div class="settings-panel-sub">Display information shown to other users</div>
              </div>
            </div>

            <div class="settings-field-grid">
              <div class="settings-field">
                <div class="label">Display Name</div>
                <input class="input" id="settings-display-name" type="text" maxlength="20" value="${App.escapeHtml(App.currentUser.displayName || App.currentUser.username)}" />
              </div>

              <div class="settings-field">
                <div class="label">Username</div>
                <div class="input" style="pointer-events:none; opacity:.9">${App.escapeHtml(App.currentUser.username)}</div>
              </div>
            </div>

            <div class="settings-field">
              <div class="label">Bio</div>
              <textarea class="input settings-bio-input" id="settings-bio" maxlength="400" rows="6" placeholder="Tell people about yourself...">${App.escapeHtml(String(App.currentUser.bio || ""))}</textarea>
              <div class="muted small" style="margin-top:8px">Maximum 400 characters.</div>
            </div>
          </section>
        </div>

        <section class="settings-panel">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Password</div>
              <div class="settings-panel-sub">Sign-in password</div>
            </div>
          </div>

          <div class="input-wrap settings-code-row">
            <input class="input mono-input" id="settings-code-display" type="password" value="${App.escapeHtml(App.currentUser.password || "")}" readonly style="opacity:.9" />
            <button class="icon-btn eye" id="btn-settings-toggle-eye" type="button" aria-label="Show / hide">
              <span id="settings-eye-icon"></span>
            </button>
          </div>

          <button class="btn tiny" id="btn-settings-change-code" type="button" style="margin-top:10px">Change Password</button>

          <div class="settings-code-editor" id="settings-code-editor" hidden>
            <input class="input mono-input" id="settings-code-input"
              type="password" maxlength="20" autocomplete="new-password" spellcheck="false"
              placeholder="New password" />
            <div class="muted small" style="margin-top:8px">max 20 chars.</div>
          </div>
        </section>

        <section class="settings-panel">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Profile Picture</div>
              <div class="settings-panel-sub">PNG, JPG, or GIF. Drag and zoom.</div>
            </div>
          </div>

          <input id="settings-pfp" type="file" accept="image/png,image/jpeg,image/jpg,image/gif" hidden />

          <div class="upload settings-media-upload">
            <div class="upload-ui">
              <div class="upload-left">
                <div class="avatar-wrap">
                  <div class="avatar-ring">
                    <div class="avatar-clip" id="settings-pfp-clip">
                      <img id="settings-pfp-img" alt="Profile Picture" draggable="false" />
                    </div>
                  </div>
                </div>
                <div class="upload-text">
                  <div class="strong">Avatar</div>
                  <div class="muted small">Drag inside the circle to reposition.</div>
                </div>
              </div>

              <div class="upload-actions-stack">
                <div class="upload-actions-row">
                  <button class="btn tiny" id="btn-settings-choose-pfp" type="button">Choose</button>
                  <button class="btn tiny" id="btn-settings-use-default" type="button">Use Default</button>
                </div>
                <div class="upload-actions-row">
                  <button class="btn tiny" id="btn-settings-download-pfp" type="button" hidden>Download PFP</button>
                  <button class="btn tiny" id="btn-settings-copy-pfp-address" type="button" hidden>Copy PFP Address</button>
                </div>
              </div>
            </div>
          </div>

          <div class="crop-controls settings-control-card" id="settings-crop-controls">
            <div class="settings-control-note">Drag the picture in the circle.</div>
            <div class="settings-slider-row">
              <div class="settings-slider-label">Zoom</div>
              <input id="settings-zoom" type="range" min="1.0" max="3.0" step="0.01" value="1.0" />
            </div>
            <div class="settings-action-row">
              <button class="btn tiny" id="btn-settings-center" type="button">Center</button>
              <button class="btn tiny" id="btn-settings-reset" type="button">Reset</button>
            </div>
          </div>
        </section>

        <section class="settings-panel">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Banner</div>
              <div class="settings-panel-sub">PNG, JPG, or GIF. Drag and zoom.</div>
            </div>
          </div>

          <input id="settings-banner" type="file" accept="image/png,image/jpeg,image/jpg,image/gif" hidden />
          <div class="settings-banner-editor">
            <div class="settings-banner-clip" id="settings-banner-clip">
              <img id="settings-banner-img" alt="Profile Banner" draggable="false" hidden />
            </div>
          </div>

          <div class="settings-action-row">
            <button class="btn tiny" id="btn-settings-choose-banner" type="button">Choose</button>
            <button class="btn tiny" id="btn-settings-download-banner" type="button" hidden>Download Banner</button>
            <button class="btn tiny" id="btn-settings-copy-banner-address" type="button" hidden>Copy Banner Address</button>
            <button class="btn tiny danger" id="btn-settings-remove-banner" type="button" hidden>Remove Banner</button>
          </div>

          <div class="settings-control-card">
            <div class="settings-slider-row">
              <div class="settings-slider-label">Zoom</div>
              <input id="settings-banner-zoom" type="range" min="0.2" max="4.0" step="0.01" value="1.0" />
            </div>
            <div class="settings-action-row">
              <button class="btn tiny" id="btn-settings-center-banner" type="button">Center</button>
              <button class="btn tiny" id="btn-settings-reset-banner" type="button">Reset</button>
            </div>
          </div>
        </section>

        ${App.spotifyAccountSettingsHTML?.() || ""}
        <section class="settings-panel" data-settings-search="sounds notifications message ping ring call screen watching audio">
          <div class="settings-panel-head"><div>
            <div class="settings-panel-title">Sound Effects</div>
            <div class="settings-panel-sub">Choose the Chat App sounds you hear.</div>
          </div></div>
          <div class="settings-toggle-card">
            <div class="settings-toggle-copy"><div class="settings-toggle-title">Sound Effects</div><div class="settings-toggle-desc">Enable Chat App notification and call sounds.</div></div>
            <label class="toggle settings-modern-toggle"><input type="checkbox" id="settings-sound-effects" ${App.currentSettings?.soundEffectsEnabled !== false ? "checked" : ""} /><span class="toggle-track" aria-hidden="true"></span></label>
          </div>
          <button class="btn tiny settings-inline-button" id="settings-sound-effects-details" type="button" aria-expanded="false" aria-controls="settings-sound-effects-list">Show All Sounds</button>
          <div id="settings-sound-effects-list" class="settings-toggle-grid" hidden>
            ${Object.entries(App.soundEffectCatalog || {}).map(([key, label]) => `<div class="settings-toggle-card settings-sound-card" data-sound-card="${key}">
              <div class="settings-toggle-copy"><div class="settings-toggle-title">${App.escapeHtml(label)}</div><div class="settings-toggle-desc settings-sound-filename" data-sound-filename="${key}">Default Sound</div></div>
              <label class="toggle settings-modern-toggle"><input type="checkbox" id="settings-sound-${key}" data-sound-effect="${key}" ${App.isSoundEffectEnabled?.(key) ? "checked" : ""} /><span class="toggle-track" aria-hidden="true"></span></label>
              <div class="settings-sound-actions"><input type="file" id="settings-sound-upload-${key}" data-sound-upload="${key}" accept="audio/*" hidden />
                <button class="btn tiny" type="button" data-sound-choose="${key}" aria-label="Upload ${App.escapeHtml(label)} Audio">Upload Audio</button>
                <button class="btn tiny" type="button" data-sound-remove="${key}" aria-label="Reset ${App.escapeHtml(label)} to Default" hidden>Use Default</button>
                <span class="settings-sound-status muted small" data-sound-status="${key}" role="status" aria-live="polite"></span>
              </div>
            </div>`).join("")}
          </div>
        </section>
        <section class="settings-panel settings-panel-wide">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Background</div>
            </div>
          </div>

          <div class="settings-background-preview" id="settings-bg-preview" data-has-image="0" aria-label="Background preview">
            <div class="settings-background-preview-layer" id="settings-bg-preview-layer"></div>
            <div class="settings-background-preview-empty">No background image selected</div>
          </div>

          <div class="settings-action-row">
            <button class="btn tiny" id="btn-bg-upload" type="button">Upload Image</button>
            <button class="btn tiny" id="btn-bg-download" type="button" hidden>Download Image</button>
            <button class="btn tiny" id="btn-bg-copy-address" type="button" hidden>Copy Image Address</button>
            <button class="btn tiny danger" id="btn-bg-remove" type="button" hidden>Remove Image</button>
            <input id="settings-bg-file" type="file" accept="image/*" hidden />
          </div>

          <div class="settings-control-card">
            <div class="settings-slider-row">
              <div class="settings-slider-label">Blur Intensity</div>
              <input id="settings-bg-blur" type="range" min="0" max="30" step="0.1" value="${Number(App.appBgCommitted?.blur ?? 0)}" />
              <div class="settings-slider-val" id="settings-bg-blur-val">${Number(App.appBgCommitted?.blur ?? 0)}</div>
            </div>

            <div class="settings-slider-row">
              <div class="settings-slider-label">Zoom</div>
              <input id="settings-bg-zoom" type="range" min="0.5" max="5" step="0.01" value="${Number(App.appBgCommitted?.zoom ?? 1)}" />
              <div class="settings-slider-val" id="settings-bg-zoom-val">${Math.round(Number(App.appBgCommitted?.zoom ?? 1) * 100)}%</div>
            </div>
          </div>
        </section>

        <section class="settings-panel">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Interface</div>
              <div class="settings-panel-sub">Navigation, typing, tab, and cloak preferences</div>
            </div>
          </div>

          <div class="settings-field-grid">
            <div class="settings-field">
              <div class="label">Sidebar Position</div>
              <div class="settings-choice-row">
                <button class="btn tiny settings-choice is-active" id="btn-sidebar-left" type="button" aria-pressed="false">Left</button>
                <button class="btn tiny settings-choice is-active" id="btn-sidebar-right" type="button" aria-pressed="true">Right</button>
              </div>
            </div>

            <div class="settings-field">
              <div class="label">Typing Indicator Style</div>
              <div class="settings-choice-row">
                <button class="btn tiny settings-choice is-active" id="btn-typing-indicator-bar" type="button" aria-pressed="true">Bar</button>
                <button class="btn tiny settings-choice" id="btn-typing-indicator-members" type="button" aria-pressed="false">Members List</button>
              </div>
            </div>
          </div>

          ${desktopSettings ? "" : `<div class="settings-field-grid">
            <div class="settings-field">
              <div class="label">Tab Name</div>
              <input class="input" id="settings-tab-name" type="text" value="${App.escapeHtml(tabNameDefault)}" />
            </div>
            <div class="settings-field">
              <div class="label">Tab Icon</div>
              <input class="input" id="settings-tab-icon" type="text" value="${App.escapeHtml(tabIconDefault)}" placeholder="Image address..." />
            </div>
          </div>

          <div class="settings-field">
            <div class="label">Tab Presets</div>
            <div class="settings-action-row">
              <button class="btn tiny" id="btn-tab-preset-clever" type="button">Clever</button>
              <button class="btn tiny" id="btn-tab-preset-schoology" type="button">Schoology</button>
              <button class="btn tiny" id="btn-tab-preset-ixl" type="button">IXL</button>
            </div>
          </div>`}

          <div class="settings-field">
            <div class="label">Blackout Cloak</div>
            <input class="input mono-input cloak-input" id="settings-cloak-display" type="text" value="${App.escapeHtml(formatCloakKeys(cloakKeysCommitted))}" readonly style="opacity:.9" />
            <button class="btn tiny settings-inline-button" id="btn-settings-cloak-edit" type="button">Edit</button>
          </div>
        </section>

        <section class="settings-panel settings-panel-wide">
          <div class="settings-panel-head">
            <div>
              <div class="settings-panel-title">Behavior</div>
              <div class="settings-panel-sub">Toggle app behavior</div>
            </div>
          </div>

          <div class="settings-toggle-grid">
            ${globalThis.chatDesktopPreferences?.version === 1 ? `<div class="settings-toggle-card"><div class="settings-toggle-copy"><div class="settings-toggle-title">Background Running</div><div class="settings-toggle-desc">Keep Chat App ready to reopen and stay connected to calls when you close its window. Use Quit in the tray to exit.</div></div><label class="toggle settings-modern-toggle"><input type="checkbox" id="settings-background-running" ${App.currentSettings?.backgroundRunning !== false ? "checked" : ""} /><span class="toggle-track" aria-hidden="true"></span></label></div>` : ""}
            <div class="settings-toggle-card">
              <div class="settings-toggle-copy">
                <div class="settings-toggle-title">Push Notifications</div>
                <div class="settings-toggle-desc">${pushHint}</div>
              </div>
              <label class="toggle settings-modern-toggle" data-tooltip="Push Notifications">
                <input type="checkbox" id="settings-pushnotifs" ${checkedPush} ${pushDisabledAttr} />
                <span class="toggle-track" aria-hidden="true"></span>
              </label>
            </div>

            <div class="settings-toggle-card">
              <div class="settings-toggle-copy">
                <div class="settings-toggle-title">Auto Scroll</div>
                <div class="settings-toggle-desc">If enabled, your chat automatically scrolls to the latest message when you are near the bottom.</div>
              </div>
              <label class="toggle settings-modern-toggle" data-tooltip="Auto Scroll">
                <input type="checkbox" id="settings-autoscroll" ${checked} />
                <span class="toggle-track" aria-hidden="true"></span>
              </label>
            </div>

            <div class="settings-toggle-card">
              <div class="settings-toggle-copy">
                <div class="settings-toggle-title">Close Prevention</div>
                <div class="settings-toggle-desc">If enabled, your browser shows a confirmation prompt before this tab closes.</div>
              </div>
              <label class="toggle settings-modern-toggle" data-tooltip="Close Prevention">
                <input type="checkbox" id="settings-acc-close" ${checkedAccClose} />
                <span class="toggle-track" aria-hidden="true"></span>
              </label>
            </div>
          </div>
        </section>
      </div>
    `,
    actionsHTML: `
      <button class="btn" id="btn-settings-copy" type="button">Copy Password</button>
      <button class="btn danger" id="btn-logout" type="button">Log Out</button>
    `,
    onBeforeClose: () => {
      stopCloakEditing({
        save: false
      });
      commitTabNameChange({
        force: true
      });
      commitTabIconChange({
        force: true
      });
      void savePassword?.();
    }
  });
  const settingsTitleEl = App.$("modal-title");
  const settingsBodyEl = App.$("modal-body");
  if (settingsTitleEl) {
    settingsTitleEl.innerHTML = `
      <div class="html-hub-titlebar">
        <span class="html-hub-title-text">Settings</span>
        <input
          class="html-hub-search-input"
          id="settings-search-input"
          type="search"
          placeholder="Search"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search settings"
        />
      </div>
    `;
  }
  App.enhanceSettingsContent(settingsBodyEl);
  App.bindSpotifyAccountSettings?.();
  const syncSoundControls = () => {
    const master = App.$("settings-sound-effects");
    if (master) master.checked = App.currentSettings?.soundEffectsEnabled !== false;
    settingsBodyEl?.querySelectorAll("[data-sound-effect]").forEach(input => {
      const key = input.dataset.soundEffect;
      input.checked = App.isSoundEffectEnabled(key);
      const custom = App.currentSettings?.customSoundEffects?.[key];
      const card = input.closest("[data-sound-card]");
      card.querySelector("[data-sound-filename]").textContent = custom?.name || "Default Sound";
      card.querySelector("[data-sound-choose]").textContent = custom ? "Change Audio" : "Upload Audio";
      card.querySelector("[data-sound-remove]").hidden = !custom;
    });
  };
  App.$("settings-sound-effects")?.addEventListener("change", event => {
    App.updateSettingsState({ soundEffectsEnabled: event.target.checked });
    syncSoundControls();
  });
  App.$("settings-sound-effects-details")?.addEventListener("click", event => {
    const list = App.$("settings-sound-effects-list");
    list.hidden = !list.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!list.hidden));
    event.currentTarget.textContent = list.hidden ? "Show All Sounds" : "Hide All Sounds";
  });
  settingsBodyEl?.querySelectorAll("[data-sound-effect]").forEach(input => input.addEventListener("change", () => {
    App.updateSettingsState({ soundEffects: { [input.dataset.soundEffect]: input.checked } });
    syncSoundControls();
  }));
  const saveCustomSound = async (key, file) => {
    const code = String(App.currentUser?.code || "");
    if (!code || App.passwordChangeInFlight) return;
    App.customSoundSaves ||= new Set();
    App.customSoundSaveTokens ||= new Map();
    const operationKey = `${code}/${key}`;
    const token = {};
    App.customSoundSaveTokens.set(operationKey, token);
    const isCurrent = () => String(App.currentUser?.code || "") === code && App.customSoundSaveTokens.get(operationKey) === token;
    let finishSave;
    const pending = new Promise(resolve => { finishSave = resolve; });
    App.customSoundSaves.add(pending);
    const card = settingsBodyEl.querySelector(`[data-sound-card="${key}"]`);
    const status = card.querySelector("[data-sound-status]");
    const buttons = card.querySelectorAll("button");
    buttons.forEach(button => { button.disabled = true; });
    status.textContent = file ? "Uploading…" : "Restoring…";
    try {
      const custom = file ? await App.readCustomSoundEffect(file) : null;
      if (!isCurrent()) return;
      const previous = App.currentSettings?.customSoundEffects?.[key] || null;
      // Use the serialized settings writer once. A direct set followed by a
      // queued save would upload the same audio bytes a second time.
      App.updateSettingsState({ customSoundEffects: { [key]: custom } }, { queueRemote: false });
      if (!await App.flushCurrentSettingsSave(code)) {
        if (isCurrent()) App.updateSettingsState({ customSoundEffects: { [key]: previous } }, { queueRemote: false });
        throw new Error("Audio could not be saved. Try again.");
      }
      if (!isCurrent()) return;
      syncSoundControls();
      status.textContent = "";
    } catch (error) {
      status.textContent = error?.message || "Audio could not be saved. Try again.";
    } finally {
      buttons.forEach(button => { button.disabled = false; });
      if (App.customSoundSaveTokens.get(operationKey) === token) App.customSoundSaveTokens.delete(operationKey);
      App.customSoundSaves.delete(pending);
      finishSave();
    }
  };
  settingsBodyEl?.querySelectorAll("[data-sound-choose]").forEach(button => button.addEventListener("click", () => App.$(`settings-sound-upload-${button.dataset.soundChoose}`)?.click()));
  settingsBodyEl?.querySelectorAll("[data-sound-upload]").forEach(input => input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void saveCustomSound(input.dataset.soundUpload, file);
  }));
  settingsBodyEl?.querySelectorAll("[data-sound-remove]").forEach(button => button.addEventListener("click", () => void saveCustomSound(button.dataset.soundRemove, null)));
  syncSoundControls();

  // ----- Background image (Settings) -----
  const btnBgUpload = App.$("btn-bg-upload");
  const btnBgDownload = App.$("btn-bg-download");
  const btnBgCopy = App.$("btn-bg-copy-address");
  const btnBgRemove = App.$("btn-bg-remove");
  const bgFile = App.$("settings-bg-file");
  const bgBlur = App.$("settings-bg-blur");
  const bgBlurVal = App.$("settings-bg-blur-val");
  const bgZoom = App.$("settings-bg-zoom");
  const bgZoomVal = App.$("settings-bg-zoom-val");
  const bgPreview = App.$("settings-bg-preview");
  const bgPreviewLayer = App.$("settings-bg-preview-layer");
  const syncBgUI = () => {
    const has = !!(App.appBgCommitted && App.appBgCommitted.dataURL);
    if (btnBgDownload) btnBgDownload.hidden = !has;
    if (btnBgCopy) btnBgCopy.hidden = !has;
    if (btnBgRemove) btnBgRemove.hidden = !has;
    const blurNow = Number(App.appBgCommitted?.blur ?? 0);
    const zoomNow = Number(App.appBgCommitted?.zoom ?? 1);
    if (bgBlur) bgBlur.value = String(blurNow);
    if (bgZoom) bgZoom.value = String(zoomNow);
    if (bgBlurVal) bgBlurVal.textContent = String(Math.round(blurNow * 10) / 10);
    if (bgZoomVal) bgZoomVal.textContent = `${Math.round(zoomNow * 100)}%`;
    if (bgPreview) bgPreview.dataset.hasImage = has ? "1" : "0";
    if (bgPreviewLayer) {
      if (has) {
        bgPreviewLayer.style.backgroundImage = `url("${App.cssUrlEscape(App.appBgCommitted.dataURL)}")`;
        bgPreviewLayer.style.backgroundRepeat = "no-repeat";
        bgPreviewLayer.style.backgroundPosition = "center";
        bgPreviewLayer.style.backgroundSize = "cover";
        bgPreviewLayer.style.transform = `scale(${zoomNow})`;
        bgPreviewLayer.style.filter = `blur(${blurNow}px)`;
      } else {
        bgPreviewLayer.style.removeProperty("background-image");
        bgPreviewLayer.style.removeProperty("background-repeat");
        bgPreviewLayer.style.removeProperty("background-position");
        bgPreviewLayer.style.removeProperty("background-size");
        bgPreviewLayer.style.removeProperty("transform");
        bgPreviewLayer.style.removeProperty("filter");
      }
    }
  };
  syncBgUI();
  if (btnBgUpload && bgFile) {
    btnBgUpload.addEventListener("click", () => bgFile.click());
  }
  if (bgFile) {
    bgFile.addEventListener("change", () => {
      const f = bgFile.files && bgFile.files[0];
      if (!f) return;
      if (!String(f.type || "").startsWith("image/")) {
        App.showToast({
          title: "Background",
          body: "Please select an image file.",
          duration: 2200
        });
        bgFile.value = "";
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        const dataURL = String(r.result || "");
        App.applyAppBackground({
          ...App.appBgCommitted,
          dataURL,
          zoom: 1
        }, {
          persist: true
        });
        syncBgUI();
      };
      r.onerror = () => {
        App.showToast({
          title: "Background",
          body: "Could not read that file.",
          duration: 2200
        });
      };
      r.readAsDataURL(f);
      bgFile.value = "";
    });
  }
  if (btnBgDownload) {
    btnBgDownload.addEventListener("click", async () => {
      const dataURL = String(App.appBgCommitted?.dataURL || "").trim();
      if (!dataURL) return;
      await App.downloadFileViaObjectURL(dataURL, `background.${App.inferImageExt(dataURL)}`);
    });
  }
  if (btnBgCopy) {
    btnBgCopy.addEventListener("click", async () => {
      const dataURL = String(App.appBgCommitted?.dataURL || "").trim();
      if (!dataURL) return;
      await App.copyImageAddress(dataURL);
    });
  }
  if (btnBgRemove) {
    btnBgRemove.addEventListener("click", () => {
      App.clearAppBackground({
        persist: true
      });
      syncBgUI();
    });
  }
  if (bgBlur) {
    bgBlur.addEventListener("input", () => {
      const blur = Math.max(0, Math.min(30, Number(bgBlur.value)));
      App.applyAppBackground({
        ...App.appBgCommitted,
        blur
      }, {
        persist: true
      });
      syncBgUI();
    });
  }
  if (bgZoom) {
    bgZoom.addEventListener("input", () => {
      const zoom = Math.max(0.5, Math.min(5, Number(bgZoom.value)));
      App.applyAppBackground({
        ...App.appBgCommitted,
        zoom
      }, {
        persist: true
      });
      syncBgUI();
    });
  }

  // ----- Sidebar position (Settings) -----
  const btnSidebarLeft = App.$("btn-sidebar-left");
  const btnSidebarRight = App.$("btn-sidebar-right");
  const syncSidebarPositionUI = () => {
    const pos = App.getSavedSidebarPosition();
    if (btnSidebarLeft) {
      btnSidebarLeft.classList.toggle("is-active", pos === "left");
      btnSidebarLeft.setAttribute("aria-pressed", pos === "left" ? "true" : "false");
    }
    if (btnSidebarRight) {
      btnSidebarRight.classList.toggle("is-active", pos !== "left");
      btnSidebarRight.setAttribute("aria-pressed", pos !== "left" ? "true" : "false");
    }
  };
  syncSidebarPositionUI();
  if (btnSidebarLeft) {
    btnSidebarLeft.addEventListener("click", () => {
      App.applySidebarPosition("left", {
        persist: true
      });
      syncSidebarPositionUI();
    });
  }
  if (btnSidebarRight) {
    btnSidebarRight.addEventListener("click", () => {
      App.applySidebarPosition("right", {
        persist: true
      });
      syncSidebarPositionUI();
    });
  }

  // ----- Typing indicator mode (Settings) -----
  const btnTypingIndicatorBar = App.$("btn-typing-indicator-bar");
  const btnTypingIndicatorMembers = App.$("btn-typing-indicator-members");
  const syncTypingIndicatorUI = () => {
    const mode = App.getSavedTypingIndicatorMode();
    if (btnTypingIndicatorBar) {
      btnTypingIndicatorBar.classList.toggle("is-active", mode === "bar");
      btnTypingIndicatorBar.setAttribute("aria-pressed", mode === "bar" ? "true" : "false");
    }
    if (btnTypingIndicatorMembers) {
      btnTypingIndicatorMembers.classList.toggle("is-active", mode === "member-list");
      btnTypingIndicatorMembers.setAttribute("aria-pressed", mode === "member-list" ? "true" : "false");
    }
  };
  syncTypingIndicatorUI();
  if (btnTypingIndicatorBar) {
    btnTypingIndicatorBar.addEventListener("click", () => {
      App.applyTypingIndicatorMode("bar", {
        persist: true
      });
      syncTypingIndicatorUI();
    });
  }
  if (btnTypingIndicatorMembers) {
    btnTypingIndicatorMembers.addEventListener("click", () => {
      App.applyTypingIndicatorMode("member-list", {
        persist: true
      });
      syncTypingIndicatorUI();
    });
  }

  // ----- Cloak keybind (Settings) -----
  const cloakInput = App.$("settings-cloak-display");
  const cloakBtn = App.$("btn-settings-cloak-edit");
  syncCloakUI = () => {
    if (cloakInput) cloakInput.value = formatCloakKeys(cloakEditing ? cloakDraftKeys : cloakKeysCommitted);
    if (cloakBtn) cloakBtn.textContent = cloakEditing ? "Stop Editing" : "Edit";
  };
  syncCloakUI();
  function startCloakEditing() {
    cloakEditing = true;
    App.cloakHotkeyEditing = true;
    window.dispatchEvent(new Event("chatapp-cloak-reset"));
    cloakDraftKeys = [];
    syncCloakUI();
    cloakKeydownHandler = e => {
      if (!cloakEditing) return;
      // Capture before document-level shortcuts and the modal focus handler.
      // Escape, Tab and the current cloak binding are all valid draft keys.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || e.isComposing) return;
      const k = normalizeCloakKeyFromEvent(e);
      if (!k) return;

      // If user tries to enter more than 4 keys: toast + auto-stop (saves current)
      if (cloakDraftKeys.length >= 4) {
        App.showToast({
          title: "Cloak",
          body: "Max 4 keys.",
          duration: 2200
        });
        stopCloakEditing({
          save: true
        });
        return;
      }
      cloakDraftKeys.push(k);
      syncCloakUI();
    };
    window.addEventListener("keydown", cloakKeydownHandler, true);
  }
  if (cloakBtn) {
    cloakBtn.addEventListener("click", () => {
      if (!cloakEditing) startCloakEditing();else stopCloakEditing({
        save: true
      });
    });
  }

  // Password eye toggle (Settings)
  let settingsHidden = true;
  const syncSettingsEye = () => {
    const icon = App.$("settings-eye-icon");
    const input = App.$("settings-code-display");
    if (!icon || !input) return;
    // Account IDs identify profiles and messages; only the credential used to
    // sign in is a password. Never reveal a UID as a fallback credential.
    const real = String(App.currentUser?.password ?? "");
    icon.innerHTML = App.eyeSVG(settingsHidden);
    if (settingsHidden) {
      input.type = "password";
      input.value = "•".repeat(20);
    } else {
      input.type = "text";
      input.value = real;
    }
  };
  syncSettingsEye();
  const btnSettingsEye = App.$("btn-settings-toggle-eye");
  if (btnSettingsEye) {
    btnSettingsEye.addEventListener("click", () => {
      settingsHidden = !settingsHidden;
      syncSettingsEye();
    });
  }
  App.$("settings-background-running")?.addEventListener("change", event => {
    App.updateSettingsState({ backgroundRunning: event.target.checked });
  });
  const pushEl = App.$("settings-pushnotifs");
  if (pushEl) pushEl.addEventListener("change", async e => {
    const want = !!e.target.checked;
    if (!want) {
      App.pushNotifsEnabled = false;
      App.syncDesktopNotificationPolicy?.();
      App.updateSettingsState({
        pushNotifications: false
      });
      return;
    }
    const ok = await App.ensureDesktopNotificationPermission();
    if (!ok) {
      App.pushNotifsEnabled = false;
      App.syncDesktopNotificationPolicy?.();
      e.target.checked = false;
      App.updateSettingsState({
        pushNotifications: false
      });
      App.showToast({
        title: "Notifications blocked",
        body: App.mobileNativeAvailable ? "Allow notifications for Chat App in your phone's Settings." : "Allow notifications in your browser settings to enable push notifications.",
        duration: 4200
      });
      return;
    }
    App.pushNotifsEnabled = true;
    App.syncDesktopNotificationPolicy?.();
    App.updateSettingsState({
      pushNotifications: true
    });
    App.showToast({
      title: "Notifications enabled",
      body: App.mobileNativeAvailable ? "Phone alerts are enabled while Chat App is running." : "You'll get a desktop notification when someone pings you.",
      duration: 2400
    });
  });
  const autoEl = App.$("settings-autoscroll");
  if (autoEl) autoEl.addEventListener("change", e => {
    App.autoScrollEnabled = !!e.target.checked;
    App.updateSettingsState({
      autoScroll: App.autoScrollEnabled
    });
    if (App.autoScrollEnabled) App.smoothScrollToBottom();
  });
  const accCloseEl = App.$("settings-acc-close");
  if (accCloseEl) accCloseEl.addEventListener("change", e => {
    App.accidentalClosePreventionEnabled = !!e.target.checked;
    App.syncAccidentalClosePrevention();
    App.updateSettingsState({
      accidentalClosePrevention: App.accidentalClosePreventionEnabled
    });
  });
  const copyBtn = App.$("btn-settings-copy");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    const password = String(App.currentUser?.password || "");
    if (!password) return;
    try {
      await App.copyTextToClipboard(password);
      App.showToast({ title: "Copied", body: "Password copied.", duration: 1600 });
    } catch {
      App.showToast({ title: "Copy failed", body: "Reveal and select your password to copy it.", duration: 2200 });
    }
  });
  const logoutBtn = App.$("btn-logout");
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await App.logoutToLanding();
    App.closeModal();
  }, {
    once: true
  });

  // ----- Display name + Tab title + icon -----
  let displayNameLastCommitted = String(App.currentUser?.displayName || App.currentUser?.username || "");
  let tabNameLastCommitted = String(tabNameDefault ?? "");
  let tabIconLastCommitted = String(tabIconDefault ?? "");
  let tabIconInFlight = false;
  let tabIconPending = null;
  async function commitDisplayNameChange({
    force = false
  } = {}) {
    const el = App.$("settings-display-name");
    if (!el) return;
    const next = App.sanitizeUsername(el.value);
    if (!next) {
      if (force) el.value = displayNameLastCommitted || App.currentUser?.displayName || App.currentUser?.username || "";
      return;
    }
    if (el.value !== next) el.value = next;
    if (!force && next === displayNameLastCommitted) return;
    const saved = await App.updateMyDisplayName(next);
    if (saved) {
      displayNameLastCommitted = String(App.currentUser?.displayName || next);
    } else if (force) {
      el.value = displayNameLastCommitted || App.currentUser?.displayName || App.currentUser?.username || "";
    }
  }
  function commitTabNameChange({
    force = false
  } = {}) {
    const el = App.$("settings-tab-name");
    if (!el) return;
    const next = String(el.value ?? "");
    if (!force && next === tabNameLastCommitted) return;
    tabNameLastCommitted = next;
    document.title = next || App.APP_TAB_TITLE_DEFAULT;
    App.updateSettingsState({
      tab: {
        name: next
      }
    });
  }
  function validateTabIconSrc(src) {
    return new Promise(resolve => {
      const url = String(src || "").trim();
      if (!url) {
        resolve(true);
        return;
      }

      // Fast accept for data:image/*
      if (/^data:image\//i.test(url)) {
        resolve(true);
        return;
      }
      let done = false;
      const img = new Image();
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(t);
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      };
      const t = setTimeout(() => finish(false), 6000);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = url;
    });
  }
  async function commitTabIconChange({
    force = false
  } = {}) {
    const el = App.$("settings-tab-icon");
    if (!el) return;
    const nextRaw = String(el.value ?? "").trim();
    if (!force && nextRaw === tabIconLastCommitted) return;

    // Clearing icon => restore default (no favicon set)
    if (!nextRaw) {
      tabIconLastCommitted = "";
      App.clearDynamicFavicon();
      App.updateSettingsState({
        tab: {
          icon: ""
        }
      });
      return;
    }
    if (tabIconInFlight) {
      tabIconPending = nextRaw;
      return;
    }
    tabIconInFlight = true;
    try {
      const ok = await validateTabIconSrc(nextRaw);
      if (!ok) {
        App.showToast({
          title: "Tab Icon",
          body: "Tab Icon must be an image address.",
          duration: 2600
        });
        if (force) el.value = tabIconLastCommitted || "";
        return;
      }
      tabIconLastCommitted = nextRaw;
      App.setDynamicFavicon(nextRaw);
      App.updateSettingsState({
        tab: {
          icon: nextRaw
        }
      });
    } finally {
      tabIconInFlight = false;
      if (tabIconPending && tabIconPending !== tabIconLastCommitted) {
        tabIconPending = null;
        commitTabIconChange({
          force: false
        });
      } else {
        tabIconPending = null;
      }
    }
  }
  const displayNameInputEl = App.$("settings-display-name");
  const tabNameEl = App.$("settings-tab-name");
  const tabIconEl = App.$("settings-tab-icon");
  if (displayNameInputEl) {
    displayNameInputEl.addEventListener("blur", () => {
      void commitDisplayNameChange({
        force: false
      });
    });
    displayNameInputEl.addEventListener("keydown", e => {
      if (e.key === "Enter") displayNameInputEl.blur();
    });
  }
  if (tabNameEl) {
    tabNameEl.addEventListener("blur", () => {
      commitTabNameChange({
        force: false
      });
    });
    tabNameEl.addEventListener("keydown", e => {
      if (e.key === "Enter") tabNameEl.blur();
    });
  }
  if (tabIconEl) {
    tabIconEl.addEventListener("blur", () => {
      commitTabIconChange({
        force: false
      });
    });
    tabIconEl.addEventListener("keydown", e => {
      if (e.key === "Enter") tabIconEl.blur();
    });
  }
  function applyTabPreset(tabTitle, tabIconHref) {
    if (tabNameEl) tabNameEl.value = String(tabTitle || "");
    if (tabIconEl) tabIconEl.value = String(tabIconHref || "");

    // Apply instantly (and keep Firebase + runtime cache in sync)
    commitTabNameChange({
      force: true
    });
    const iconClean = String(tabIconHref || "").trim();
    tabIconLastCommitted = iconClean;
    App.setDynamicFavicon(iconClean);
    App.updateSettingsState({
      tab: {
        icon: iconClean
      }
    });
  }
  const presetClever = App.$("btn-tab-preset-clever");
  if (presetClever) presetClever.addEventListener("click", () => {
    applyTabPreset("Clever | Portal", "https://resources.finalsite.net/images/f_auto,q_auto/v1689877141/mooreschoolscom/emadd6nvplrnh1vsswjf/Clever-Logo.jpg");
  });
  const presetSchoology = App.$("btn-tab-preset-schoology");
  if (presetSchoology) presetSchoology.addEventListener("click", () => {
    applyTabPreset("Home | Schoology", "https://cmsv2-assets.apptegy.net/uploads/15799/file/1820214/54a64606-f802-430e-843e-21195e1f090b.png");
  });
  const presetIXL = App.$("btn-tab-preset-ixl");
  if (presetIXL) presetIXL.addEventListener("click", () => {
    applyTabPreset("IXL | Math, Language Arts, Science, Social Studies, and Spanish", "https://upload.wikimedia.org/wikipedia/commons/7/7d/IXL_Learning.png");
  });

  const savePassword = App.bindPasswordEditor(syncSettingsEye);

  // ----- Settings profile editor (preview + pfp + banner + bio) -----
  const sClip = App.$("settings-pfp-clip");
  const sImg = App.$("settings-pfp-img");
  const sInput = App.$("settings-pfp");
  const sControls = App.$("settings-crop-controls");
  const sZoom = App.$("settings-zoom");
  const sBannerClip = App.$("settings-banner-clip");
  const sBannerImg = App.$("settings-banner-img");
  const sBannerInput = App.$("settings-banner");
  const sBannerZoom = App.$("settings-banner-zoom");
  const sBannerDownload = App.$("btn-settings-download-banner");
  const sBannerCopy = App.$("btn-settings-copy-banner-address");
  const sBannerRemove = App.$("btn-settings-remove-banner");
  const sBannerCenter = App.$("btn-settings-center-banner");
  const sBannerReset = App.$("btn-settings-reset-banner");
  const btnChoose = App.$("btn-settings-choose-pfp");
  const btnUseDefault = App.$("btn-settings-use-default");
  const btnDownload = App.$("btn-settings-download-pfp");
  const btnCopyPfp = App.$("btn-settings-copy-pfp-address");
  const btnCenter = App.$("btn-settings-center");
  const btnReset = App.$("btn-settings-reset");
  const displayNameEl = App.$("settings-display-name");
  const bioEl = App.$("settings-bio");
  const previewHost = App.$("settings-profile-preview");
  if (displayNameEl) {
    displayNameEl.addEventListener("blur", async () => {
      await App.updateMyDisplayName(displayNameEl.value);
      renderSettingsProfilePreview();
    });
    displayNameEl.addEventListener("input", () => {
      renderSettingsProfilePreview();
    });
    displayNameEl.addEventListener("keydown", e => {
      if (e.key === "Enter") displayNameEl.blur();
    });
  }
  if (bioEl) {
    bioEl.addEventListener("input", () => {
      bioEl.value = String(bioEl.value || "").slice(0, 400);
      queueBioSave();
      renderSettingsProfilePreview();
    });
  }
  if (!sClip || !sImg || !sInput || !sControls || !sZoom || !btnChoose || !btnUseDefault || !btnCenter || !btnReset) return;
  sImg.addEventListener("dragstart", e => e.preventDefault());
  sBannerImg?.addEventListener("dragstart", e => e.preventDefault());
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const sState = {
    usingDefault: false,
    dataURL: App.currentUser.photoDataURL || App.defaultStickmanDataURL(),
    scale: 1.0,
    x: 0,
    y: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
    pointerId: null
  };
  const sBannerState = {
    dataURL: String(App.currentUser.bannerDataURL || ""),
    scale: 1.0,
    x: 0,
    y: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    startX: 0,
    startY: 0,
    pointerId: null
  };
  // A delayed save may finish after the user switches categories. Preserve the
  // last measured frame instead of normalizing their crop against a hidden box.
  let lastAvatarClipSize = 84;
  let lastBannerClipSize = 340;
  function clipSize() {
    const r = sClip.getBoundingClientRect();
    const w = Math.round(r.width || 0);
    if (w > 0) lastAvatarClipSize = w;
    return lastAvatarClipSize;
  }
  function bannerClipSize() {
    const r = sBannerClip?.getBoundingClientRect?.() || null;
    const w = Math.round(r?.width || 0);
    if (w > 0) lastBannerClipSize = w;
    return lastBannerClipSize;
  }
  function applyPreview() {
    App.applyCroppedImage(sImg, sState.dataURL, packTransform(), clipSize());
  }
  function applyBannerPreview() {
    if (!sBannerImg) return;
    App.applyCroppedImage(sBannerImg, sBannerState.dataURL, packBannerTransform(), bannerClipSize(), 340);
  }
  function packTransform() {
    const size = clipSize();
    return {
      unit: "rel",
      scale: sState.scale,
      x: (sState.x || 0) / size,
      y: (sState.y || 0) / size
    };
  }
  function packBannerTransform() {
    const size = bannerClipSize();
    return {
      unit: "rel",
      scale: sBannerState.scale,
      x: (sBannerState.x || 0) / size,
      y: (sBannerState.y || 0) / size
    };
  }
  function getSettingsPreviewUser() {
    return {
      code: String(App.currentUser?.code || ""),
      username: String(App.currentUser?.username || "User"),
      displayName: String(displayNameEl?.value || App.currentUser?.displayName || App.currentUser?.username || "User"),
      bio: String(bioEl?.value ?? App.currentUser?.bio ?? "").slice(0, 400),
      photoDataURL: String(sState.dataURL || App.defaultStickmanDataURL()),
      photoTransform: packTransform(),
      bannerDataURL: String(sBannerState.dataURL || ""),
      bannerTransform: packBannerTransform()
    };
  }
  function renderSettingsProfilePreview() {
    if (!previewHost) return;
    previewHost.dataset.mediaPreview = "true";
    App.patchUserProfileCard(previewHost, getSettingsPreviewUser(), { preview: true });
  }
  let pfpSaveTimer = null;
  let pfpSaveInFlight = false;
  let pfpSaveAgain = false;
  function queuePfpSave(delay = 250) {
    if (pfpSaveTimer) clearTimeout(pfpSaveTimer);
    pfpSaveTimer = setTimeout(savePfpNow, delay);
  }
  async function savePfpNow() {
    if (pfpSaveInFlight) {
      pfpSaveAgain = true;
      return;
    }
    pfpSaveInFlight = true;
    try {
      await App.updateMyProfilePicture(sState.dataURL, packTransform());
      renderSettingsProfilePreview();
    } catch (e) {
      console.error("settings pfp save failed:", e);
    } finally {
      pfpSaveInFlight = false;
      if (pfpSaveAgain) {
        pfpSaveAgain = false;
        queuePfpSave(0);
      }
    }
  }
  let bannerSaveTimer = null;
  let bannerSaveInFlight = false;
  let bannerSaveAgain = false;
  function queueBannerSave(delay = 250) {
    if (bannerSaveTimer) clearTimeout(bannerSaveTimer);
    bannerSaveTimer = setTimeout(saveBannerNow, delay);
  }
  async function saveBannerNow() {
    if (bannerSaveInFlight) {
      bannerSaveAgain = true;
      return;
    }
    bannerSaveInFlight = true;
    try {
      await App.updateMyProfileBanner(sBannerState.dataURL, packBannerTransform());
      renderSettingsProfilePreview();
    } catch (e) {
      console.error("settings banner save failed:", e);
    } finally {
      bannerSaveInFlight = false;
      if (bannerSaveAgain) {
        bannerSaveAgain = false;
        queueBannerSave(0);
      }
    }
  }
  let bioSaveTimer = null;
  function queueBioSave(delay = 250) {
    if (bioSaveTimer) clearTimeout(bioSaveTimer);
    bioSaveTimer = setTimeout(async () => {
      await App.updateMyProfileBio(String(bioEl?.value || "").slice(0, 400));
      renderSettingsProfilePreview();
    }, delay);
  }
  function setDefault() {
    sState.usingDefault = true;
    sState.dataURL = App.defaultStickmanDataURL();
    sState.scale = 1;
    sState.x = 0;
    sState.y = 0;
    sZoom.value = "1";
    sControls.hidden = false;
    if (btnDownload) btnDownload.hidden = true;
    if (btnCopyPfp) btnCopyPfp.hidden = true;
    sImg.src = sState.dataURL;
    applyPreview();
    renderSettingsProfilePreview();
    sInput.value = "";
    queuePfpSave(0);
  }
  function setUploaded(dataURL) {
    sState.usingDefault = false;
    sState.dataURL = dataURL;
    sState.scale = 1;
    sState.x = 0;
    sState.y = 0;
    sZoom.value = "1";
    sControls.hidden = false;
    if (btnDownload) btnDownload.hidden = false;
    if (btnCopyPfp) btnCopyPfp.hidden = false;
    sImg.src = sState.dataURL;
    applyPreview();
    renderSettingsProfilePreview();
    queuePfpSave(0);
  }
  function setBanner(dataURL) {
    sBannerState.dataURL = String(dataURL || "");
    sBannerState.scale = 1;
    sBannerState.x = 0;
    sBannerState.y = 0;
    if (sBannerImg) {
      sBannerImg.src = sBannerState.dataURL || App.defaultStickmanDataURL();
      sBannerImg.hidden = !sBannerState.dataURL;
    }
    if (sBannerDownload) sBannerDownload.hidden = !sBannerState.dataURL;
    if (sBannerCopy) sBannerCopy.hidden = !sBannerState.dataURL;
    if (sBannerRemove) sBannerRemove.hidden = !sBannerState.dataURL;
    if (sBannerZoom) sBannerZoom.value = "1";
    applyBannerPreview();
    renderSettingsProfilePreview();
    queueBannerSave(0);
  }
  function initFromUser() {
    sState.dataURL = App.currentUser.photoDataURL || App.defaultStickmanDataURL();
    sImg.src = sState.dataURL;
    sState.usingDefault = sState.dataURL === App.defaultStickmanDataURL();
    sControls.hidden = false;
    if (btnDownload) btnDownload.hidden = sState.usingDefault;
    if (btnCopyPfp) btnCopyPfp.hidden = sState.usingDefault;
    const tpx = App.transformToPixels(App.currentUser.photoTransform, clipSize());
    sState.scale = clamp(Number(tpx.scale) || 1, 0.2, 3.0);
    sState.x = Number(tpx.x) || 0;
    sState.y = Number(tpx.y) || 0;
    sZoom.value = String(sState.scale);
    applyPreview();
    sBannerState.dataURL = String(App.currentUser.bannerDataURL || "");
    if (sBannerImg) {
      sBannerImg.src = sBannerState.dataURL || App.defaultStickmanDataURL();
      sBannerImg.hidden = !sBannerState.dataURL;
    }
    const bpx = App.transformToPixels(App.currentUser.bannerTransform, bannerClipSize(), 340);
    sBannerState.scale = clamp(Number(bpx.scale) || 1, 0.2, 4.0);
    sBannerState.x = Number(bpx.x) || 0;
    sBannerState.y = Number(bpx.y) || 0;
    if (sBannerZoom) sBannerZoom.value = String(sBannerState.scale);
    if (sBannerDownload) sBannerDownload.hidden = !sBannerState.dataURL;
    if (sBannerCopy) sBannerCopy.hidden = !sBannerState.dataURL;
    if (sBannerRemove) sBannerRemove.hidden = !sBannerState.dataURL;
    applyBannerPreview();
    renderSettingsProfilePreview();
  }
  initFromUser();
  requestAnimationFrame(() => requestAnimationFrame(initFromUser));
  btnChoose.addEventListener("click", () => sInput.click());
  btnUseDefault.addEventListener("click", e => {
    e.preventDefault();
    setDefault();
  });
  btnDownload?.addEventListener("click", async () => {
    if (!sState.dataURL || sState.usingDefault) return;
    await App.downloadFileViaObjectURL(sState.dataURL, `profile-picture.${App.inferImageExt(sState.dataURL)}`);
  });
  btnCopyPfp?.addEventListener("click", async () => {
    if (!sState.dataURL || sState.usingDefault) return;
    await App.copyImageAddress(sState.dataURL);
  });
  function endDrag() {
    if (!sState.dragging) return;
    sState.dragging = false;
    sState.pointerId = null;
    queuePfpSave(0);
    renderSettingsProfilePreview();
  }
  sClip.addEventListener("pointerdown", e => {
    sState.dragging = true;
    sState.pointerId = e.pointerId;
    sState.dragStartX = e.clientX;
    sState.dragStartY = e.clientY;
    sState.startX = sState.x;
    sState.startY = sState.y;
    try {
      sClip.setPointerCapture(e.pointerId);
    } catch {}
  });
  sClip.addEventListener("pointermove", e => {
    if (!sState.dragging) return;
    if (sState.pointerId !== null && e.pointerId !== sState.pointerId) return;
    const dx = e.clientX - sState.dragStartX;
    const dy = e.clientY - sState.dragStartY;
    sState.x = sState.startX + dx;
    sState.y = sState.startY + dy;
    applyPreview();
    renderSettingsProfilePreview();
  });
  sClip.addEventListener("pointerup", () => endDrag());
  sClip.addEventListener("pointercancel", () => endDrag());
  sZoom.addEventListener("input", () => {
    sState.scale = clamp(Number(sZoom.value) || 1, 0.2, 3.0);
    applyPreview();
    renderSettingsProfilePreview();
    queuePfpSave(250);
  });
  btnCenter.addEventListener("click", () => {
    sState.x = 0;
    sState.y = 0;
    applyPreview();
    renderSettingsProfilePreview();
    queuePfpSave(0);
  });
  btnReset.addEventListener("click", () => {
    sState.scale = 1;
    sState.x = 0;
    sState.y = 0;
    sZoom.value = "1";
    applyPreview();
    renderSettingsProfilePreview();
    queuePfpSave(0);
  });
  sInput.addEventListener("change", () => {
    const file = sInput.files && sInput.files[0] ? sInput.files[0] : null;
    if (!file) return;
    if (!App.fileTypeOk(file)) {
      App.showToast({
        title: "Invalid file",
        body: "Profile picture must be PNG, JPG/JPEG, or GIF.",
        duration: 2600
      });
      sInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setUploaded(String(reader.result));
      sInput.value = "";
    };
    reader.onerror = () => {
      App.showToast({
        title: "Read failed",
        body: "Could not read that file.",
        duration: 2600
      });
      sInput.value = "";
    };
    reader.readAsDataURL(file);
  });
  sBannerInput?.addEventListener("change", () => {
    const file = sBannerInput.files && sBannerInput.files[0] ? sBannerInput.files[0] : null;
    if (!file) return;
    if (!App.fileTypeOk(file)) {
      App.showToast({
        title: "Invalid file",
        body: "Banner must be PNG, JPG/JPEG, or GIF.",
        duration: 2600
      });
      sBannerInput.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBanner(String(reader.result));
      sBannerInput.value = "";
    };
    reader.onerror = () => {
      App.showToast({
        title: "Read failed",
        body: "Could not read that file.",
        duration: 2600
      });
      sBannerInput.value = "";
    };
    reader.readAsDataURL(file);
  });
  sBannerClip?.addEventListener("pointerdown", e => {
    sBannerState.dragging = true;
    sBannerState.pointerId = e.pointerId;
    sBannerState.dragStartX = e.clientX;
    sBannerState.dragStartY = e.clientY;
    sBannerState.startX = sBannerState.x;
    sBannerState.startY = sBannerState.y;
    try {
      sBannerClip.setPointerCapture(e.pointerId);
    } catch {}
  });
  sBannerClip?.addEventListener("pointermove", e => {
    if (!sBannerState.dragging) return;
    if (sBannerState.pointerId !== null && e.pointerId !== sBannerState.pointerId) return;
    const dx = e.clientX - sBannerState.dragStartX;
    const dy = e.clientY - sBannerState.dragStartY;
    sBannerState.x = sBannerState.startX + dx;
    sBannerState.y = sBannerState.startY + dy;
    applyBannerPreview();
    renderSettingsProfilePreview();
  });
  const endBannerDrag = () => {
    if (!sBannerState.dragging) return;
    sBannerState.dragging = false;
    sBannerState.pointerId = null;
    queueBannerSave(0);
    renderSettingsProfilePreview();
  };
  sBannerClip?.addEventListener("pointerup", endBannerDrag);
  sBannerClip?.addEventListener("pointercancel", endBannerDrag);
  sBannerZoom?.addEventListener("input", () => {
    sBannerState.scale = clamp(Number(sBannerZoom.value) || 1, 0.2, 4.0);
    applyBannerPreview();
    renderSettingsProfilePreview();
    queueBannerSave(250);
  });
  sBannerCenter?.addEventListener("click", () => {
    sBannerState.x = 0;
    sBannerState.y = 0;
    applyBannerPreview();
    renderSettingsProfilePreview();
    queueBannerSave(0);
  });
  sBannerReset?.addEventListener("click", () => {
    sBannerState.scale = 1;
    sBannerState.x = 0;
    sBannerState.y = 0;
    if (sBannerZoom) sBannerZoom.value = "1";
    applyBannerPreview();
    renderSettingsProfilePreview();
    queueBannerSave(0);
  });
  sBannerRemove?.addEventListener("click", async () => {
    setBanner("");
  });
  sBannerDownload?.addEventListener("click", async () => {
    if (!sBannerState.dataURL) return;
    await App.downloadFileViaObjectURL(sBannerState.dataURL, `profile-banner.${App.inferImageExt(sBannerState.dataURL)}`);
  });
  sBannerCopy?.addEventListener("click", async () => {
    if (!sBannerState.dataURL) return;
    await App.copyImageAddress(sBannerState.dataURL);
  });
  App.$("btn-settings-choose-banner")?.addEventListener("click", () => {
    try {
      sBannerInput?.click();
    } catch {}
  });
});
});
})(globalThis.ChatApp);
