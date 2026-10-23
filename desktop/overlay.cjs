'use strict';

const path = require('node:path');

const PUBLISH_CHANNEL = 'chat-overlay:publish';
const STATE_CHANNEL = 'chat-overlay:state';
const PAINTED_CHANNEL = 'chat-overlay:painted';
const EMPTY_STATE = Object.freeze({ active: false, enabled: true, roomId: '', members: [] });
const nameOrder = new Intl.Collator(undefined, { sensitivity: 'base' });

function isAppURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'chatapp:' && url.host === 'app' && !url.username && !url.password;
  } catch { return false; }
}

function finite(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

// Use a small native surface around the roster. A monitor-sized transparent
// topmost window can alter taskbar composition on Windows even where it paints
// no pixels. Work-area bounds also keep this surface away from every taskbar.
function rosterLayout(display, memberCount) {
  const area = display.workArea || display.bounds;
  const naturalHeight = Math.max(1, memberCount) * 50 - 2; // 40px rows, 10px gap, 8px list padding
  const naturalWidth = 397; // avatar + gap + maximum name pill + list padding
  const scale = Math.max(.01, Math.min(.7, (area.height - 48) / naturalHeight, (area.width - 44) / naturalWidth));
  const width = Math.min(area.width, Math.ceil(naturalWidth * scale) + 8);
  const height = Math.min(area.height, Math.ceil(naturalHeight * scale) + 8);
  return { bounds: { x: area.x, y: area.y + Math.floor((area.height - height) / 2), width, height }, scale };
}

// Only plain roster data crosses this bridge. Images are local data URIs, so
// the overlay never loads a profile-controlled network URL or HTML document.
function normalizeSnapshot(value, previous = null) {
  if (!value || typeof value !== 'object' || value.active !== true || typeof value.roomId !== 'string' || !value.roomId || !Array.isArray(value.members)) return { ...EMPTY_STATE, members: [] };
  const seen = new Set();
  const previousMembers = previous?.roomId === value.roomId && previous?.sessionId === value.sessionId
    ? new Map((previous.members || []).map(member => [member.code, member])) : new Map();
  const members = [];
  let imageBytes = 0;
  for (const item of value.members.slice(0, 512)) {
    if (!item || typeof item !== 'object' || typeof item.code !== 'string' || !item.code || seen.has(item.code)) continue;
    const code = item.code.slice(0, 256);
    if (seen.has(code)) continue;
    seen.add(code);
    const displayName = typeof item.displayName === 'string' ? item.displayName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    let photoDataURL = item.reusePhoto === true ? previousMembers.get(code)?.photoDataURL || '' : typeof item.photoDataURL === 'string' ? item.photoDataURL : '';
    // Match Firebase's 10 MB string allowance so larger saved GIF avatars are
    // not silently dropped. Bound the whole roster at its read-response limit.
    if (photoDataURL.length > 10 * 1024 * 1024 || imageBytes + photoDataURL.length > 256 * 1024 * 1024 || !/^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)(?:;[a-z0-9=._-]+)*,/i.test(photoDataURL)) photoDataURL = '';
    imageBytes += photoDataURL.length;
    const transform = item.photoTransform || {};
    members.push({
      code, displayName: displayName || code, photoDataURL,
      photoTransform: { unit: 'rel', x: finite(transform.x, 0, -100, 100), y: finite(transform.y, 0, -100, 100), scale: finite(transform.scale, 1, 0.2, 100) },
      speaking: item.speaking === true && item.muted !== true && item.deafened !== true, muted: item.muted === true, deafened: item.deafened === true,
      sharing: item.sharing === true, cameraSharing: item.cameraSharing === true, watchingYourScreen: item.watchingYourScreen === true, watchingYourCamera: item.watchingYourCamera === true,
    });
  }
  members.sort((a, b) => nameOrder.compare(a.displayName, b.displayName) || nameOrder.compare(a.code, b.code));
  return { active: members.length > 0, enabled: value.enabled !== false, roomId: value.roomId.slice(0, 512),
    sessionId: typeof value.sessionId === 'string' ? value.sessionId.slice(0, 512) : '',
    controls: { muted: value.controls?.muted === true, deafened: value.controls?.deafened === true, listenOnly: value.controls?.listenOnly === true,
      sharing: value.controls?.sharing === true, cameraSharing: value.controls?.cameraSharing === true,
      screenPending: value.controls?.screenPending === true, cameraPending: value.controls?.cameraPending === true }, members };
}

function createCallOverlay({ BrowserWindow, screen, ipcMain, mainWindow, uiDir, powerMonitor, onState = () => {}, log = () => {}, timers = globalThis }) {
  let overlayWindow = null;
  let contents = null;
  let state = { ...EMPTY_STATE, members: [] };
  let ready = false;
  let nativeReady = false;
  let disposed = false;
  let navigating = false;
  let minimized = mainWindow.isMinimized();
  let wantsVisible = false;
  let presentationGeneration = 0;
  let acknowledgedGeneration = -1;
  let requestedBounds = null;
  let lastEnabled = false;
  let lastRoomId = '';
  let recoveryAttempts = 0;
  let selectedDisplayId;
  let lastMainBounds = mainWindow.getBounds();
  const subscriptions = [];
  let contentSubscriptions = [];
  let visibilityWatchdog = null;
  let sentPhotos = new Map();

  const listen = (target, event, callback, list = subscriptions) => {
    target.on(event, callback);
    list.push(() => target.removeListener(event, callback));
  };
  const rememberDisplay = () => {
    if (mainWindow.isDestroyed() || minimized || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    // Windows can report its offscreen minimized coordinates during the move
    // events that precede "minimize". Never replace the last actual monitor
    // with that transitional rectangle.
    const onScreen = screen.getAllDisplays().some(({ bounds: display }) => bounds.x < display.x + display.width && bounds.x + bounds.width > display.x && bounds.y < display.y + display.height && bounds.y + bounds.height > display.y);
    if (!onScreen) return;
    lastMainBounds = bounds;
    selectedDisplayId = screen.getDisplayMatching(lastMainBounds).id;
  };
  const selectedDisplay = () => {
    const display = screen.getAllDisplays().find(item => item.id === selectedDisplayId) || screen.getDisplayMatching(lastMainBounds);
    selectedDisplayId = display.id;
    return display;
  };
  const isEnabled = () => !disposed && !mainWindow.isDestroyed() && state.active && state.enabled && state.members.length > 0;
  // Only the main Chat App view replaces the desktop roster. In particular,
  // opening a screen-share popout must not hide it on the rest of the desktop.
  const isAppForeground = () => !minimized && !mainWindow.isMinimized() && mainWindow.isFocused();
  const canShow = () => isEnabled() && !isAppForeground();

  function keepAboveApps() {
    if (!overlayWindow || overlayWindow.isDestroyed() || !isEnabled()) return;
    if (wantsVisible !== canShow()) sync();
    if (!canShow()) {
      if (overlayWindow.isVisible()) overlayWindow.hide();
      return;
    }
    maybeShow();
    if (!overlayWindow.isVisible()) return;
    // Reapplying the topmost style on a timer makes Windows rebuild a layered
    // transparent surface, which flashes. Its native topmost flag persists
    // across ordinary app switches; repair it only if it was actually lost.
    if (!overlayWindow.isAlwaysOnTop()) {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.moveTop();
    }
  }

  function syncWatchdog() {
    if (isEnabled() && !visibilityWatchdog) {
      visibilityWatchdog = timers.setInterval(keepAboveApps, 750);
      visibilityWatchdog.unref?.();
    } else if (!isEnabled() && visibilityWatchdog) {
      timers.clearInterval(visibilityWatchdog);
      visibilityWatchdog = null;
    }
  }

  function maybeShow() {
    if (!overlayWindow || overlayWindow.isDestroyed() || !ready || !nativeReady || !wantsVisible || !canShow() || acknowledgedGeneration !== presentationGeneration) return;
    if (!overlayWindow.isVisible()) {
      overlayWindow.showInactive();
      overlayWindow.moveTop();
    }
  }

  function recoverWindow(win, message) {
    if (disposed || overlayWindow !== win) return;
    log(message);
    ready = false;
    nativeReady = false;
    ++presentationGeneration;
    if (!win.isDestroyed()) win.destroy();
    // The app renderer still owns a valid call snapshot. Recover once without
    // waiting for another speaking/profile change to bypass web deduplication.
    // Repeated failures stop here until a fresh app document or call arrives.
    if (recoveryAttempts++ < 1) createWindow();
  }

  function createWindow() {
    sentPhotos.clear();
    const { bounds } = rosterLayout(selectedDisplay(), state.members.length);
    const win = new BrowserWindow({
      ...bounds, title: 'Chat App Call Overlay', show: false, frame: false, paintWhenInitiallyHidden: true,
      transparent: true, backgroundColor: '#00000000', hasShadow: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, roundedCorners: false, enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(uiDir, 'overlay-preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        webSecurity: true, backgroundThrottling: false, spellcheck: false,
      },
    });
    overlayWindow = win;
    requestedBounds = bounds;
    ready = false;
    nativeReady = false;
    acknowledgedGeneration = -1;
    ++presentationGeneration;
    win.setMenu(null);
    // Electron's native hit-test exclusion, in addition to CSS, passes both
    // avatar/name clicks and transparent-area clicks to the application below.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.once('ready-to-show', () => {
      if (disposed || overlayWindow !== win || win.isDestroyed()) return;
      nativeReady = true;
      maybeShow();
    });
    win.webContents.once('did-finish-load', () => {
      if (disposed || overlayWindow !== win || win.isDestroyed()) return;
      ready = true;
      sync({ forcePaint: true });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      recoverWindow(win, `Call overlay renderer stopped: ${details.reason}`);
    });
    win.once('closed', () => {
      if (overlayWindow === win) { overlayWindow = null; ready = false; nativeReady = false; }
    });
    win.loadFile(path.join(uiDir, 'overlay.html')).catch(error => {
      recoverWindow(win, `Call overlay could not load: ${error.message}`);
    });
  }

  function sync({ forcePaint = false } = {}) {
    if (disposed) return;
    syncWatchdog();
    const visible = canShow();
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      if (recoveryAttempts <= 1) createWindow();
      return;
    }
    const { bounds: target, scale } = rosterLayout(selectedDisplay(), state.members.length);
    // Compare requested geometry, not the native rectangle: Windows may clamp
    // small surfaces or round DIPs. Retrying that mismatch on every speaking
    // update continually resizes/repaints an otherwise unchanged roster.
    const boundsChanged = !requestedBounds || ['x', 'y', 'width', 'height'].some(key => requestedBounds[key] !== target[key]);
    const enabled = isEnabled();
    const newPresentation = forcePaint || boundsChanged || lastEnabled !== enabled || lastRoomId !== state.roomId;
    if (newPresentation) ++presentationGeneration;
    wantsVisible = visible;
    lastEnabled = enabled;
    lastRoomId = state.roomId;
    // Keep the existing compositor surface visible during joins, layout and
    // display changes. Hide only for the actual user-visible visibility rule.
    if (!visible && overlayWindow.isVisible()) overlayWindow.hide();
    if (boundsChanged) {
      requestedBounds = target;
      overlayWindow.setBounds(target, false);
    }
    if (!ready) return;
    const viewport = overlayWindow.getContentBounds?.() || overlayWindow.getBounds();
    const members = state.members.map(member => {
      if (sentPhotos.get(member.code) !== member.photoDataURL) return member;
      const { photoDataURL, ...rest } = member;
      return { ...rest, reusePhoto: true };
    });
    overlayWindow.webContents.send(STATE_CHANNEL, { ...state, members, presentation: { generation: presentationGeneration, width: viewport.width, height: viewport.height, scale } });
    sentPhotos = new Map((state.active && state.enabled ? state.members : []).map(member => [member.code, member.photoDataURL]));
    maybeShow();
  }

  function clear() {
    state = { ...EMPTY_STATE, members: [] };
    onState(state);
    sync();
  }

  function bindContents(nextContents) {
    for (const unsubscribe of contentSubscriptions) unsubscribe();
    contentSubscriptions = [];
    contents = nextContents;
    navigating = false;
    recoveryAttempts = 0;
    clear();
    if (!contents) return;
    listen(contents, 'did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { navigating = true; clear(); }
    }, contentSubscriptions);
    listen(contents, 'did-navigate', () => { navigating = false; }, contentSubscriptions);
    listen(contents, 'render-process-gone', clear, contentSubscriptions);
    listen(contents, 'destroyed', () => { clear(); contents = null; }, contentSubscriptions);
  }

  listen(ipcMain, PUBLISH_CHANNEL, (event, snapshot) => {
    if (disposed || navigating || !contents || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame || !isAppURL(event.senderFrame?.url) || !isAppURL(contents.getURL())) return;
    const nextState = normalizeSnapshot(snapshot, state);
    if (nextState.active && (!state.active || nextState.roomId !== state.roomId)) recoveryAttempts = 0;
    state = nextState;
    onState(state);
    sync();
  });
  listen(ipcMain, PAINTED_CHANNEL, (event, generation) => {
    if (disposed || !overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents || event.senderFrame !== overlayWindow.webContents.mainFrame || !Number.isSafeInteger(generation) || generation !== presentationGeneration) return;
    acknowledgedGeneration = generation;
    maybeShow();
  });
  for (const event of ['move', 'resize', 'enter-full-screen', 'leave-full-screen']) listen(mainWindow, event, () => { rememberDisplay(); sync(); });
  listen(mainWindow, 'minimize', () => { minimized = true; sync(); });
  for (const event of ['restore', 'show']) listen(mainWindow, event, () => { minimized = false; rememberDisplay(); sync(); });
  for (const event of ['focus', 'blur']) listen(mainWindow, event, () => { sync(); keepAboveApps(); });
  if (powerMonitor) for (const event of ['resume', 'unlock-screen']) listen(powerMonitor, event, keepAboveApps);
  for (const event of ['display-added', 'display-removed']) listen(screen, event, () => { rememberDisplay(); sync(); });
  listen(screen, 'display-metrics-changed', (_event, display) => { rememberDisplay(); sync({ forcePaint: !display || display.id === selectedDisplayId }); });
  listen(mainWindow, 'closed', destroy);
  rememberDisplay();
  // Load the transparent surface once while Chat App is open. Subsequent
  // minimizes reuse its already decoded avatars and compositor surface.
  createWindow();

  function destroy() {
    if (disposed) return;
    disposed = true;
    if (visibilityWatchdog) timers.clearInterval(visibilityWatchdog);
    visibilityWatchdog = null;
    state = { ...EMPTY_STATE, members: [] };
    contents = null;
    for (const unsubscribe of [...contentSubscriptions, ...subscriptions]) unsubscribe();
    contentSubscriptions = [];
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
  }

  return { bindContents, clear, destroy };
}

module.exports = { createCallOverlay, normalizeSnapshot, rosterLayout, isAppURL, PUBLISH_CHANNEL, STATE_CHANNEL, PAINTED_CHANNEL };
