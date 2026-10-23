/* Shared microphone/speaker popovers for the call panel and navigation dock. */
(function (App) {
  "use strict";
  let active = null;
  let closing = null;
  let closeTimer = 0;
  let closeSequence = 0;
  let closeAnimationHandler = null;
  let deviceList = [];
  let enumerationSequence = 0;
  let accessPending = 0;
  let discoveryError = "";
  let liveInputSignature = "";
  let selectionScope = "";
  const authorizedOutputs = new Map();
  const switching = { input: false, output: false };
  const menuFor = kind => App.$(`call-${kind}-settings-menu`);
  const selectedDevice = kind => {
    const value = String((kind === "input" ? App.callPreferredAudioInputId : App.callPreferredAudioOutputId) || "");
    return value === "default" ? "" : value;
  };
  const pending = () => !App.currentCallRoomId || !!(App.callJoinPending || App.callLeavePending);
  const selectState = kind => App.customSelectState?.get(App.$(`call-${kind}-device`));
  function withinSettings(target) {
    if (!active) return false;
    const state = selectState(active.kind);
    return active.menu.contains(target) || active.anchor.contains(target) || !!(state?.portalOpen && state.pop.contains(target));
  }

  function positionMenu() {
    if (!active) return;
    const { menu, anchor } = active;
    if (!anchor.isConnected || !anchor.getClientRects().length) return App.closeCallAudioSettings();
    App.positionContextMenu(menu, { anchor, avoidAnchor: true });
  }

  function status(kind, text) {
    const node = App.$(`call-${kind}-device-status`);
    node.textContent = text;
    node.hidden = !text;
    positionMenu();
  }

  function liveInput() {
    const track = App.callRawMicrophoneStream?.getAudioTracks?.().find(track => track.readyState === "live");
    if (!track) return null;
    return { kind: "audioinput", deviceId: String(track.getSettings?.().deviceId || selectedDevice("input") || ""), label: track.label || "Current Microphone" };
  }

  function listedDevices(kind) {
    const devices = new Map();
    for (const device of deviceList) {
      if (device.kind === `audio${kind}` && device.deviceId && device.deviceId !== "default") devices.set(device.deviceId, device);
    }
    if (kind === "output") for (const [id, device] of authorizedOutputs) if (!devices.has(id)) devices.set(id, device);
    const live = kind === "input" ? liveInput() : null;
    if (live?.deviceId && live.deviceId !== "default" && !devices.get(live.deviceId)?.label) devices.set(live.deviceId, live);
    return [...devices.values()];
  }

  const canRequestAccess = () => typeof navigator.mediaDevices?.getUserMedia === "function";
  const canPickOutput = () => App.callCanChooseAudioOutput?.() && typeof navigator.mediaDevices?.selectAudioOutput === "function";

  function accessError(error) {
    if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name)) return "Device access was blocked. Allow microphone or speaker access in your browser or app, then try again.";
    if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) return "No audio device was found. Connect a microphone or speaker and try again.";
    if (error?.name === "NotReadableError") return "The audio device is busy or unavailable. Check its connection and try again.";
    return "Could not list audio devices. Check device access in your browser or app and try again.";
  }

  async function enumerateAudioDevices() {
    if (typeof navigator.mediaDevices?.enumerateDevices === "function") return Array.from(await navigator.mediaDevices.enumerateDevices());
    // Older embedded Chromium hosts expose the original callback-based API.
    if (typeof window.MediaStreamTrack?.getSources === "function") {
      const sources = await new Promise((resolve, reject) => {
        try { window.MediaStreamTrack.getSources(resolve); } catch (error) { reject(error); }
      });
      return Array.from(sources || [], device => ({ deviceId: device.id || device.deviceId || "", label: device.label || "", kind: device.kind === "audio" ? "audioinput" : device.kind }));
    }
    throw Object.assign(new Error("Device enumeration is unavailable"), { name: "NotSupportedError" });
  }

  function renderDevices(kind) {
    const select = App.$(`call-${kind}-device`);
    const selected = selectedDevice(kind);
    const devices = listedDevices(kind);
    const systemDefault = deviceList.find(device => device.kind === `audio${kind}` && device.deviceId === "default");
    const options = [new Option(systemDefault?.label || "System default", "")];
    devices.forEach((device, index) => options.push(new Option(device.label || `${kind === "input" ? "Microphone" : "Speaker"} ${index + 1}`, device.deviceId)));
    // Preserve a selected but disconnected/permission-hidden device without silently changing it.
    if (selected && !options.some(option => option.value === selected)) options.push(new Option("Selected device (unavailable)", selected));
    const signature = JSON.stringify(options.map(option => [option.value, option.textContent]));
    const changed = select.dataset.deviceOptions !== signature;
    if (changed) {
      select.replaceChildren(...options);
      select.dataset.deviceOptions = signature;
    }
    select.value = selected;
    select.disabled = pending() || !!accessPending || switching[kind] || (kind === "output" && !App.callCanChooseAudioOutput?.());
    const state = selectState(kind);
    // The visible control is the application's enhanced select, not the hidden
    // native select. Its option list lives in a body portal above this menu.
    if (state) {
      state.pop.classList.add("call-audio-device-options");
      state.btn.setAttribute("aria-label", kind === "input" ? "Input Device" : "Output Device");
      if (changed && state.portalOpen) {
        const focusedValue = state.pop.contains(document.activeElement) ? document.activeElement.dataset.value : null;
        App.rebuildCustomSelectOptions(state);
        if (focusedValue !== null) [...state.pop.querySelectorAll("button")].find(button => button.dataset.value === focusedValue)?.focus({ preventScroll: true });
        App.positionCustomSelectPop(state);
      }
      App.syncCustomSelectControl(select);
    }
    const access = App.$(`call-${kind}-device-access`);
    if (access) {
      const hiddenDevices = !deviceList.some(device => device.kind === `audio${kind}` && device.deviceId && device.label);
      const picker = kind === "output" && canPickOutput();
      access.textContent = picker ? "Choose Output Device" : kind === "output" ? "Refresh Devices" : "Show Devices";
      access.hidden = !(picker || hiddenDevices || discoveryError);
      access.disabled = pending() || !!accessPending || switching[kind] || (kind === "input" && !canRequestAccess());
    }
  }

  App.callRefreshAudioDevices = async function ({ requestAccess = false, kind = "input" } = {}) {
    // Output discovery must never open a microphone permission prompt.
    requestAccess = requestAccess && kind === "input";
    if (accessPending) return deviceList;
    const sequence = ++enumerationSequence;
    let permissionStream = null;
    if (requestAccess) accessPending = sequence;
    try {
      if (requestAccess) {
        ["input", "output"].forEach(renderDevices);
        if (active) status(active.kind, "Waiting for device access...");
        if (!canRequestAccess()) throw Object.assign(new Error("Microphone access is unavailable"), { name: "NotSupportedError" });
        // This temporary stream reveals device names only. It never replaces,
        // unmutes or publishes the call microphone, and is always stopped below.
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      const devices = await enumerateAudioDevices();
      if (sequence !== enumerationSequence) return;
      deviceList = devices;
      discoveryError = "";
    } catch (error) {
      if (sequence !== enumerationSequence) return;
      discoveryError = error?.name === "NotSupportedError" ? "This runtime does not expose an audio device list. Your current device and system default remain available." : accessError(error);
    } finally {
      for (const track of permissionStream?.getTracks?.() || []) track.stop();
      if (accessPending === sequence) accessPending = 0;
    }
    if (sequence === enumerationSequence) {
      ["input", "output"].forEach(renderDevices);
      if (active) {
        const kind = active.kind;
        const listed = deviceList.some(device => device.kind === `audio${kind}` && device.deviceId && device.label);
        const message = kind === "output" && !App.callCanChooseAudioOutput?.() ? "This runtime uses your system's selected speaker."
          : discoveryError || (!listed ? kind === "input" ? "Allow microphone access to show connected inputs." : canPickOutput() ? "Choose an output device to allow speaker access." : "No additional outputs are exposed by this browser. System default is available." : "");
        status(kind, message);
      }
    }
    positionMenu();
    return deviceList;
  };
  const refreshDevices = () => App.callRefreshAudioDevices();

  async function requestDeviceAccess(kind) {
    if (pending() || accessPending || switching[kind]) return;
    if (kind === "input") return App.callRefreshAudioDevices({ requestAccess: true, kind });
    if (!canPickOutput()) return App.callRefreshAudioDevices({ kind: "output" });
    const room = App.currentCallRoomId, session = App.callSessionId;
    switching.output = true;
    renderDevices("output");
    try {
      // Invoke before any await so Firefox/Chromium retain user activation.
      const device = await navigator.mediaDevices.selectAudioOutput();
      if (App.currentCallRoomId !== room || App.callSessionId !== session) return;
      if (!device?.deviceId) return;
      authorizedOutputs.set(device.deviceId, { kind: "audiooutput", deviceId: device.deviceId, label: device.label || "Selected Speaker" });
      const success = await App.callSetOutputDevice(device.deviceId);
      if (App.currentCallRoomId !== room || App.callSessionId !== session) return;
      if (!success) status("output", "Could not switch to that output device. Check its connection and try again.");
      else await refreshDevices();
    } catch (error) {
      if (App.currentCallRoomId === room && App.callSessionId === session && error?.name !== "AbortError") status("output", accessError(error));
    } finally {
      if (App.currentCallRoomId === room && App.callSessionId === session) {
        switching.output = false;
        renderDevices("output");
      }
    }
  }

  App.closeCallAudioSettings = function ({ restoreFocus = false, immediate = false } = {}) {
    const current = active || closing;
    if (!current || (!active && !immediate)) return;
    const { menu, anchor } = current;
    clearTimeout(closeTimer);
    if (closeAnimationHandler) menu.removeEventListener("animationend", closeAnimationHandler);
    const sequence = ++closeSequence;
    active = null;
    closing = current;
    for (const kind of ["input", "output"]) {
      const select = App.$(`call-${kind}-device`);
      const state = App.customSelectState?.get(select);
      if (state) {
        App.closeCustomSelect?.(state);
        App.syncCustomSelectControl?.(select);
      }
    }
    document.body.classList.remove("call-audio-settings-open");
    document.querySelectorAll("[data-call-audio-settings]").forEach(button => button.setAttribute("aria-expanded", "false"));
    const finish = event => {
      if (sequence !== closeSequence || (event && (event.target !== menu || event.animationName !== "msgMenuOut"))) return;
      clearTimeout(closeTimer);
      if (closeAnimationHandler) menu.removeEventListener("animationend", closeAnimationHandler);
      closeAnimationHandler = null;
      closing = null;
      menu.hidden = true;
      menu.classList.remove("open", "closing");
    };
    if (immediate) finish();
    else {
      menu.classList.remove("open");
      menu.classList.add("closing");
      closeAnimationHandler = finish;
      menu.addEventListener("animationend", finish);
      closeTimer = setTimeout(finish, 180);
    }
    if (restoreFocus && anchor.isConnected && !anchor.disabled) anchor.focus({ preventScroll: true });
  };

  App.openCallAudioSettings = function (kind, anchor) {
    if (!["input", "output"].includes(kind) || pending() || !anchor || anchor.disabled) return;
    if (active?.kind === kind && active.anchor === anchor) return App.closeCallAudioSettings({ restoreFocus: true });
    App.closeCallAudioSettings({ immediate: true });
    App.closeCallUserContextMenu?.(true);
    App.closeCallScreenContextMenu?.(true);
    App.closeMsgMenu?.(true);
    App.closeMsgTextMenu?.(true);
    App.closeEmojiCtxMenu?.(true);
    App.closeHtmlHubContextMenu?.(true);
    const menu = menuFor(kind);
    active = { kind, menu, anchor };
    document.body.classList.add("call-audio-settings-open");
    menu.hidden = false;
    menu.classList.remove("closing");
    menu.classList.add("open");
    anchor.setAttribute("aria-expanded", "true");
    status(kind, "");
    App.callSyncAudioSettingsUI();
    renderDevices(kind);
    positionMenu();
    void refreshDevices();
    requestAnimationFrame(() => {
      if (active?.menu !== menu) return;
      const select = menu.querySelector("select:not(:disabled)");
      const deviceButton = select && App.customSelectState?.get(select)?.btn;
      (deviceButton || menu.querySelector("input:not(:disabled), button:not(:disabled), select:not(:disabled)"))?.focus({ preventScroll: true });
    });
  };

  App.callSyncAudioSettingsUI = function () {
    const scope = `${App.currentCallRoomId || ""}:${App.callSessionId || ""}`;
    if (scope !== selectionScope) {
      selectionScope = scope;
      ++enumerationSequence;
      accessPending = 0;
      switching.input = switching.output = false;
    }
    const unavailable = pending();
    document.querySelectorAll("[data-call-audio-settings]").forEach(button => {
      button.disabled = unavailable;
    });
    for (const kind of ["input", "output"]) {
      const slider = App.$(`call-${kind}-volume`);
      if (!slider) continue;
      const value = (kind === "input" ? App.callGetEffectiveInputVolumePercent?.() : App.callGetOutputVolumePercent?.()) ?? 100;
      slider.value = String(value);
      slider.disabled = unavailable;
      slider.setAttribute("aria-valuetext", `${value}%`);
      App.$(`call-${kind}-volume-value`).textContent = `${value}%`;
      App.syncPreciseRangeVisual?.(slider);
      const select = App.$(`call-${kind}-device`);
      if ([...select.options].some(option => option.value === selectedDevice(kind))) select.value = selectedDevice(kind);
    }
    const refreshLabel = App.$("btn-call-refreshmic")?.querySelector("[data-call-refresh-label]");
    if (refreshLabel) refreshLabel.textContent = App.$("btn-call-refreshmic").getAttribute("aria-label") || "Refresh Microphone";
    const live = liveInput();
    const signature = `${live?.deviceId || ""}:${live?.label || ""}`;
    if (active && signature !== liveInputSignature) {
      liveInputSignature = signature;
      void refreshDevices();
    }
    if (unavailable) App.closeCallAudioSettings({ immediate: true });
  };

  App.register("calling/audio-settings", function initializeFeature() {
    document.addEventListener("click", event => {
      const trigger = event.target.closest?.("[data-call-audio-settings]");
      if (trigger) App.openCallAudioSettings(trigger.dataset.callAudioSettings, trigger);
    });
    document.addEventListener("contextmenu", event => {
      const trigger = event.target.closest?.("[data-call-audio-context], [data-call-audio-settings]");
      if (!trigger || pending()) return;
      event.preventDefault();
      const kind = trigger.dataset.callAudioContext || trigger.dataset.callAudioSettings;
      const anchor = trigger.closest(".call-control-split")?.querySelector("[data-call-audio-settings]") || trigger;
      App.openCallAudioSettings(kind, anchor);
    });
    document.addEventListener("pointerdown", event => {
      if (active && !withinSettings(event.target)) App.closeCallAudioSettings();
    }, true);
    document.addEventListener("keydown", event => {
      if (active && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const state = selectState(active.kind);
        if (state?.portalOpen) {
          App.closeCustomSelect(state);
          state.btn.focus({ preventScroll: true });
        } else App.closeCallAudioSettings({ restoreFocus: true });
      } else if (active && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const state = selectState(active.kind);
        if (state && (event.target === state.btn || state.pop.contains(event.target))) {
          event.preventDefault();
          if (!state.portalOpen) App.openCustomSelect(state);
          const options = [...state.pop.querySelectorAll("button:not(:disabled)")];
          const current = options.indexOf(document.activeElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowUp" ? (current - 1 + options.length) % options.length : (current + 1) % options.length;
          options[index]?.focus({ preventScroll: true });
          options[index]?.scrollIntoView({ block: "nearest" });
        }
      } else if (["ArrowDown", "ArrowUp"].includes(event.key) && event.target.matches?.("[data-call-audio-settings]")) {
        event.preventDefault();
        App.openCallAudioSettings(event.target.dataset.callAudioSettings, event.target);
      }
    }, true);
    document.addEventListener("focusin", event => {
      if (active && !withinSettings(event.target)) App.closeCallAudioSettings();
    });
    document.addEventListener("scroll", event => {
      if (active && !active.menu.contains(event.target)) positionMenu();
    }, true);
    window.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("scroll", positionMenu);
    // Native device selects and permission dialogs can temporarily blur an
    // Electron/file page. Keep the settings open while that dialog is in use.
    window.addEventListener("focus", () => { if (active) void refreshDevices(); });
    document.addEventListener("visibilitychange", () => { if (active && document.visibilityState === "visible") void refreshDevices(); });
    navigator.mediaDevices?.addEventListener?.("devicechange", () => { if (active) void refreshDevices(); });
    // Permission changes and a successful call capture reveal both input and
    // output names without prompting again from the speaker menu.
    for (const name of ["microphone", "speaker-selection"]) {
      try {
        navigator.permissions?.query({ name }).then(permission => {
          permission.addEventListener?.("change", () => { void refreshDevices(); });
        }).catch(() => {});
      } catch {}
    }
    for (const kind of ["input", "output"]) {
      const menu = menuFor(kind);
      const access = document.createElement("button");
      access.id = `call-${kind}-device-access`;
      access.type = "button";
      access.className = "call-device-access";
      access.hidden = true;
      access.addEventListener("click", () => { void requestDeviceAccess(kind); });
      App.$(`call-${kind}-device`).parentElement.appendChild(access);
      App.initPreciseRangeSliders(menu);
      App.$(`call-${kind}-volume`).addEventListener("input", event => {
        if (pending()) return;
        if (kind === "input") App.callSetInputVolumePercent(event.currentTarget.value);
        else App.callSetOutputVolumePercent(event.currentTarget.value, { fromGesture: true });
        App.callSyncAudioSettingsUI();
      });
      App.$(`call-${kind}-device`).addEventListener("change", async event => {
        if (pending() || switching[kind]) return;
        const room = App.currentCallRoomId, session = App.callSessionId;
        const current = () => App.currentCallRoomId === room && App.callSessionId === session;
        const value = event.currentTarget.value;
        switching[kind] = true;
        event.currentTarget.disabled = true;
        status(kind, "Switching device...");
        let success = false;
        try {
          success = await (kind === "input" ? App.callSetInputDevice(value) : App.callSetOutputDevice(value));
        } catch {}
        if (!current()) return;
        switching[kind] = false;
        await refreshDevices();
        if (!current()) return;
        status(kind, success ? "" : "Could not switch devices. Check the device connection and browser permissions.");
      });
    }
    App.callSyncAudioSettingsUI();
  });
})(globalThis.ChatApp);
