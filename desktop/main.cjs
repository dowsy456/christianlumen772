'use strict';
const { app, BrowserWindow, WebContentsView, session, protocol, net, ipcMain, shell, dialog, desktopCapturer, Menu, Tray, screen, nativeImage, powerMonitor, safeStorage } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { resolveApp, markReady, getFallbacks } = require('./updater.cjs');
const { createContentHandler, configureB2UploadCors } = require('./content-server.cjs');
const { createCallOverlay } = require('./overlay.cjs');
const { createCallTaskbar } = require('./taskbar.cjs');
const { createRingPopups } = require('./rings.cjs');
const { createGameActivity } = require('./games.cjs');
const { createUnreadBadge } = require('./unread-badge.cjs');
const { createSpotifyConnection } = require('./spotify.cjs');
const { readClipboardFiles } = require('./clipboard-files.cjs');

app.setName('Chat App');
app.setAppUserModelId('app.chatapp.desktop');
if (process.env.CHAT_APP_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.CHAT_APP_TEST_PROFILE));
protocol.registerSchemesAsPrivileged([{ scheme: 'chatapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: true } }]);

const TITLE_HEIGHT = 40;
const ICON = path.join(__dirname, 'assets', 'chat-app.ico');
const UI = path.join(__dirname, 'ui');
const bundledDir = app.isPackaged ? path.join(process.resourcesPath, 'bundled-app') : path.join(__dirname, '..');
let mainWindow, appView, activeRoot, booting = false, lastStatus;
let appSession, callOverlay, ringPopups, gameActivity, unreadBadge, spotifyConnection;
let currentCandidate, pendingCandidate, updateTimer, checkingUpdate = false, lastUpdateCheck = 0;
let backgroundRunning = true, quitting = false, quittingForUpdate = false, tray;
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
  if (appView?.webContents && !appView.webContents.isDestroyed()) appView.webContents.focus();
}
function ensureTray() {
  if (tray && !tray.isDestroyed()) return true;
  try {
    tray = new Tray(ICON); tray.setToolTip('Chat App');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Chat App', click: showMainWindow },
      { type: 'separator' },
      { label: 'Quit Chat App', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showMainWindow); tray.on('double-click', showMainWindow);
    return true;
  } catch (error) { writeLog(`Background tray unavailable: ${error.message}`); return false; }
}
const trustedContents = new WeakSet();
let captureSources = [], captureSourcesAt = 0, captureSourcesJob = null;
let capturePreviewSources = [], capturePreviewAt = 0, capturePreviewJob = null;
const captureSelections = new WeakMap();
function refreshCaptureSources({ fresh = false, previews = false } = {}) {
  if (previews) {
    if (capturePreviewJob) return capturePreviewJob;
    if (!fresh && capturePreviewSources.length && Date.now() - capturePreviewAt < 30000) return Promise.resolve(capturePreviewSources);
    capturePreviewJob = desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 192, height: 108 }, fetchWindowIcons: false }).then(sources => {
      capturePreviewSources = sources; capturePreviewAt = Date.now();
      captureSources = sources; captureSourcesAt = Date.now();
      return sources;
    }).finally(() => { capturePreviewJob = null; });
    return capturePreviewJob;
  }
  if (captureSourcesJob) return captureSourcesJob;
  if (!fresh && captureSources.length && Date.now() - captureSourcesAt < 15000) return Promise.resolve(captureSources);
  // Names/IDs are cheap; thumbnails can wake GPUs and capture every open
  // window. Load the usable source list first, then preview only an open picker.
  captureSourcesJob = desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then(sources => {
    captureSources = sources;
    captureSourcesAt = Date.now();
    return sources;
  }).finally(() => { captureSourcesJob = null; });
  return captureSourcesJob;
}
function captureCaller(event) {
  const wc = appView?.webContents;
  return wc && !wc.isDestroyed() && event.sender === wc && event.senderFrame === wc.mainFrame && isAppURL(wc.getURL()) ? wc : null;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAppURL = url => { try { const u = new URL(url); return u.protocol === 'chatapp:' && u.host === 'app' && !u.username && !u.password; } catch { return false; } };
const isExternal = url => { try { return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } };
function status(payload) {
  lastStatus = payload;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', payload);
}
function writeLog(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
}
function external(url) { if (isExternal(url)) shell.openExternal(url).catch(() => {}); }
async function openUpdateAndQuit(event, value) {
  if (!captureCaller(event) || quittingForUpdate || typeof value !== 'string' || value.length > 4096) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
  // Exit only after the OS has accepted the browser launch. app.exit skips all
  // beforeunload/close interception, including hidden windows and the tray.
  await shell.openExternal(url.href);
  quittingForUpdate = true; quitting = true; backgroundRunning = false;
  tray?.destroy(); tray = null;
  for (const controller of [spotifyConnection, gameActivity, ringPopups, callOverlay]) { try { controller?.destroy(); } catch {} }
  app.exit(0);
  return true;
}
function fitContent() {
  if (!mainWindow || mainWindow.isDestroyed() || !appView) return;
  const [width, height] = mainWindow.getContentSize();
  const top = mainWindow.isFullScreen() ? 0 : TITLE_HEIGHT;
  appView.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

function configureWebContents(wc) {
  trustedContents.add(wc);
  wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) captureSelections.delete(wc); });
  const owner = () => BrowserWindow.fromWebContents(wc) || mainWindow;
  wc.on('will-navigate', (event, url) => {
    if (isAppURL(url) || url === 'about:blank' || url.startsWith('blob:chatapp://app/')) return;
    event.preventDefault(); external(url);
  });
  wc.setWindowOpenHandler(details => {
    if (details.url === 'about:blank' || isAppURL(details.url) || details.url.startsWith('blob:chatapp://app/')) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        backgroundColor: '#151c22', title: 'Chat App', icon: ICON, autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
      } };
    }
    external(details.url); return { action: 'deny' };
  });
  wc.on('did-create-window', child => { child.setMenu(null); configureWebContents(child.webContents); });
  wc.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (params.linkURL && isExternal(params.linkURL)) items.push({ label: 'Open link in browser', click: () => external(params.linkURL) });
    if (params.mediaType === 'image' && params.srcURL) items.push({ label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && input.key.toLowerCase() === 'r') { event.preventDefault(); wc.reload(); }
    if (input.key === 'F11') { event.preventDefault(); const win = owner(); win.setFullScreen(!win.isFullScreen()); }
    if ((input.control || input.meta) && ['+', '=', '-', '0'].includes(input.key)) {
      event.preventDefault(); wc.setZoomLevel(input.key === '0' ? 0 : wc.getZoomLevel() + (input.key === '-' ? -0.5 : 0.5));
    }
  });
  wc.on('will-prevent-unload', event => {
    if (quittingForUpdate) { event.preventDefault(); return; }
    const result = dialog.showMessageBoxSync(owner(), { type: 'question', title: 'Chat App', message: 'Leave this page?', detail: 'Chat App has accidental-close prevention enabled. Unsaved changes may be lost.', buttons: ['Stay', 'Leave'], defaultId: 0, cancelId: 0, noLink: true });
    if (result === 1) event.preventDefault(); else quitting = false;
  });
}

function configurePermissions(ses) {
  const granted = new Set();
  const known = new Set(['media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen', 'speaker-selection', 'pointerLock']);
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    // Electron checks notifications without a WebContents. Returning false here
    // makes Notification.permission "denied", so the app cannot enable them.
    // The app's saved Push Notifications setting controls the user's opt-in/out.
    if (permission === 'notifications') return isAppURL(requestingOrigin) && (!wc || trustedContents.has(wc));
    const trusted = !!wc && trustedContents.has(wc) && isAppURL(requestingOrigin);
    return trusted && (['fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission) || granted.has(permission));
  });
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    const origin = details.securityOrigin || details.requestingOrigin || details.requestingUrl || wc?.getURL();
    const inherited = wc && trustedContents.has(wc) && ['about:blank', 'about:srcdoc'].includes(details.requestingUrl) && details.isMainFrame;
    if (!wc || !trustedContents.has(wc) || (!isAppURL(origin) && !inherited) || !known.has(permission)) return callback(false);
    if (['notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture'].includes(permission) || granted.has(permission)) return callback(true);
    const labels = { media: 'your microphone and camera', notifications: 'desktop notifications', geolocation: 'your location', 'clipboard-read': 'your clipboard', 'speaker-selection': 'audio output devices', pointerLock: 'mouse capture' };
    try {
      const result = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Chat App', message: `Allow Chat App to use ${labels[permission] || permission}?`, detail: permission === 'media' ? 'Used for voice and video calls. You can change device access in Windows Settings.' : 'This permission lasts until you close the app.', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true });
      if (result.response === 0) granted.add(permission);
      callback(result.response === 0);
    } catch { callback(false); }
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const wc = appView?.webContents;
    if (!isAppURL(request.securityOrigin) || !wc || wc.isDestroyed() || request.frame !== wc.mainFrame) return callback({});
    const selected = captureSelections.get(wc);
    captureSelections.delete(wc);
    if (selected) {
      if (selected.frame !== request.frame || selected.expiresAt < Date.now()) return callback({});
      // Consume only an explicit current-document source choice, exactly once.
      return callback({ video: { id: selected.id, name: selected.name }, ...(selected.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
    }
    try {
      const sources = await refreshCaptureSources();
      const choice = await chooseScreen(sources, request.audioRequested);
      if (!choice) return callback({});
      const source = sources.find(item => item.id === choice.id);
      if (!source) return callback({});
      callback({ video: source, ...(choice.audio && request.audioRequested ? { audio: 'loopback' } : {}) });
    } catch { callback({}); }
  });
  ses.on('will-download', async (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save from Chat App', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
    item.once('done', (_event, state) => { if (state === 'interrupted') dialog.showMessageBox(mainWindow, { type: 'error', title: 'Download failed', message: 'The download could not finish. Please try again.' }).catch(() => {}); });
  });
}

async function chooseScreen(sources, audioRequested) {
  return new Promise(resolve => {
    const picker = new BrowserWindow({ width: 790, height: 610, parent: mainWindow, modal: true, show: false, title: 'Share Screen', icon: ICON, backgroundColor: '#151c22', autoHideMenuBar: true, webPreferences: { preload: path.join(UI, 'picker-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    picker.setMenu(null);
    let settled = false;
    const finish = value => { if (settled) return; settled = true; ipcMain.removeListener('screen:choose', select); resolve(value); if (!picker.isDestroyed()) picker.close(); };
    const select = (event, value) => {
      if (event.sender !== picker.webContents || event.senderFrame !== picker.webContents.mainFrame) return;
      finish(value && sources.some(s => s.id === value.id) ? { id: value.id, audio: !!value.audio } : null);
    };
    ipcMain.on('screen:choose', select);
    picker.once('closed', () => finish(null));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('screen:sources', { audioRequested, sources: sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })) });
      picker.show();
      void refreshCaptureSources({ previews: true }).then(previews => {
        if (settled || picker.isDestroyed()) return;
        const known = new Set(sources.map(source => source.id));
        picker.webContents.send('screen:sources', { audioRequested, sources: previews.filter(source => known.has(source.id)).map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) });
      }).catch(() => {});
    });
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', event => event.preventDefault());
    picker.loadFile(path.join(UI, 'picker.html')).catch(() => finish(null));
  });
}

async function waitForReady(wc) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) throw new Error('The app window was closed.');
    const state = await wc.executeJavaScript(`({ ready: document.documentElement.dataset.appReady, state: document.readyState, tracked: !!document.querySelector('meta[name="chatapp-launcher"]'), error: window.ChatAppBootError || '', styles: window.ChatAppStylesheetErrors || [], missing: [...document.querySelectorAll('link[rel="stylesheet"]')].filter(x => !x.sheet).map(x => x.getAttribute('href')) })`);
    if (state.ready === 'error' || state.styles.length) throw new Error(state.error || 'An app stylesheet could not load.');
    if (state.state === 'complete' && (state.ready === 'true' || !state.tracked) && !state.missing.length) return;
    await sleep(150);
  }
  throw new Error('Chat App took too long to start.');
}

async function loadCandidate(candidate) {
  activeRoot = candidate.dir;
  callOverlay?.bindContents(null);
  ringPopups?.bindContents(null);
  gameActivity?.bindContents(null);
  unreadBadge?.bindContents(null);
  spotifyConnection?.bindContents(null);
  if (appView) { mainWindow.contentView.removeChildView(appView); appView.webContents?.close(); }
  appView = new WebContentsView({ webPreferences: { session: appSession, preload: path.join(__dirname, 'overlay-app-preload.cjs'), additionalArguments: [`--chat-native-version=${app.getVersion()}`], nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  callOverlay?.bindContents(appView.webContents);
  ringPopups?.bindContents(appView.webContents);
  gameActivity?.bindContents(appView.webContents);
  unreadBadge?.bindContents(appView.webContents);
  spotifyConnection?.bindContents(appView.webContents);
  appView.setBackgroundColor('#151c22');
  configureWebContents(appView.webContents);
  mainWindow.contentView.addChildView(appView);
  appView.setVisible(false);
  fitContent();
  await appView.webContents.loadURL('chatapp://app/index.html');
  await waitForReady(appView.webContents);
  await markReady(candidate);
  currentCandidate = candidate;
  pendingCandidate = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update', { available: false });
  appView.setVisible(true);
  appView.webContents.focus();
  appView.webContents.on('render-process-gone', (_event, details) => {
    writeLog(`Renderer stopped: ${details.reason}`);
    appView.setVisible(false);
    status({ message: 'Chat App stopped unexpectedly', detail: 'Reopen the app to continue.', error: true });
  });
  writeLog(`Ready: ${candidate.index || 'bundled'} ${candidate.sha || ''}; ${candidate.source}; confirmedLatest=${candidate.confirmedLatest}`);
  status({ message: 'Chat App is ready', progress: 100 });
}

async function checkForUpdate() {
  if (process.env.CHAT_APP_OFFLINE === '1' || booting || checkingUpdate || !currentCandidate || !mainWindow || mainWindow.isDestroyed() || Date.now() - lastUpdateCheck < 60000) return;
  checkingUpdate = true; lastUpdateCheck = Date.now();
  try {
    const candidate = await resolveApp({ userData: app.getPath('userData'), bundledDir, fetchImpl: (url, options) => net.fetch(url, options) });
    if (candidate.source === 'downloaded' && candidate.dir !== currentCandidate.dir) {
      pendingCandidate = candidate;
      mainWindow?.webContents.send('app:update', { available: true });
    }
  } catch (error) { writeLog(`Background update check: ${error.message}`); }
  finally { checkingUpdate = false; }
}

async function applyPendingUpdate() {
  if (!pendingCandidate || booting || !appView || appView.webContents.isDestroyed()) return;
  // Reserve before awaiting the renderer so repeated clicks cannot replace
  // each other's WebContentsView or race the startup fallback.
  booting = true;
  const previous = currentCandidate, candidate = pendingCandidate;
  try {
    const busy = await appView.webContents.executeJavaScript(`!!(window.ChatApp && (ChatApp.currentCallRoomId || ChatApp.callJoinPending || ChatApp.activeFirebaseUploads?.size || ChatApp.pendingSendCount || ChatApp.pendingPoll || ChatApp.pendingFiles?.length || ChatApp.voiceRecorder || ChatApp.voiceRecorderStream || ChatApp.voicePreviewBlob || document.querySelector('#msg-input')?.value?.trim()))`).catch(() => true);
    if (busy) {
      await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Chat App update', message: 'Finish your call or recording and send or clear your draft before updating.', buttons: ['OK'] });
      return;
    }
    await loadCandidate(candidate);
  }
  catch (error) {
    writeLog(`Update could not start: ${error.message}`);
    if (previous) await loadCandidate(previous);
  } finally { booting = false; }
}

async function boot() {
  if (booting) return;
  booting = true;
  callOverlay?.clear();
  ringPopups?.clear(true);
  gameActivity?.clear();
  spotifyConnection?.clear();
  if (appView) appView.setVisible(false);
  status({ message: 'Opening Chat App', detail: 'Checking for the latest version…', progress: 5 });
  try {
    const options = { userData: app.getPath('userData'), bundledDir, onStatus: status, fetchImpl: (url, options) => net.fetch(url, options) };
    const chosen = await resolveApp(options);
    const candidates = [chosen, ...await getFallbacks(options)];
    const tried = new Set();
    let lastError;
    for (const candidate of candidates) {
      if (tried.has(candidate.dir)) continue;
      tried.add(candidate.dir);
      try {
        status({ message: 'Starting Chat App', detail: `Loading version ${candidate.index || 'bundled'}…`, progress: 90 });
        await loadCandidate(candidate);
        return;
      } catch (error) { lastError = error; writeLog(`Boot failed: ${error.message}`); }
    }
    throw lastError || new Error('No usable app version is available.');
  } catch (error) {
    writeLog(`Startup failed: ${error.message}`);
    status({ message: 'Could not open Chat App', detail: error.message, error: true, progress: 0 });
  } finally { booting = false; }
}

function createMainWindow() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8')); } catch {}
  mainWindow = new BrowserWindow({ width: Math.max(880, Math.min(saved.width || 1320, 3000)), height: Math.max(600, Math.min(saved.height || 880, 2000)), minWidth: 800, minHeight: 560, frame: false, title: 'Chat App', icon: ICON, backgroundColor: '#151c22', show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(UI, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  if (process.platform === 'win32') mainWindow.setAppDetails({
    appId: 'app.chatapp.desktop', appIconPath: ICON, appIconIndex: 0,
    relaunchCommand: `"${process.env.PORTABLE_EXECUTABLE_FILE || process.execPath}"`,
    relaunchDisplayName: 'Chat App'
  });
  mainWindow.setMenu(null);
  const callTaskbar = createCallTaskbar({ mainWindow, nativeImage, getContents: () => appView?.webContents, log: writeLog });
  callOverlay = createCallOverlay({ BrowserWindow, screen, ipcMain, mainWindow, uiDir: UI, powerMonitor, onState: callTaskbar.update, log: writeLog });
  ringPopups = createRingPopups({ BrowserWindow, screen, ipcMain, mainWindow, uiDir: UI, log: writeLog });
  gameActivity = createGameActivity({ ipcMain, mainWindow, fetchImpl: (url, options) => net.fetch(url, options), getFileIcon: (file, options) => app.getFileIcon(file, options), log: writeLog });
  unreadBadge = createUnreadBadge({ ipcMain, mainWindow, nativeImage });
  spotifyConnection = createSpotifyConnection({ ipcMain, mainWindow, shell, safeStorage, userData: app.getPath('userData'), fetchImpl: (url, options) => net.fetch(url, options) });
  mainWindow.on('focus', checkForUpdate);
  updateTimer = setInterval(checkForUpdate, 5 * 60 * 1000);
  updateTimer.unref();
  mainWindow.once('closed', () => clearInterval(updateTimer));
  mainWindow.on('resize', fitContent);
  mainWindow.on('enter-full-screen', fitContent);
  mainWindow.on('leave-full-screen', fitContent);
  for (const event of ['maximize', 'unmaximize']) mainWindow.on(event, () => mainWindow.webContents.send('window:maximized', mainWindow.isMaximized()));
  let appClosed = false;
  mainWindow.on('close', event => {
    // Keep the exact same WebContents and WebRTC tracks alive. Never navigate,
    // reload, or dispatch beforeunload when the close action means background.
    if (!quitting && backgroundRunning && ensureTray()) {
      event.preventDefault();
      try { const bounds = mainWindow.getNormalBounds(); void fsp.writeFile(path.join(app.getPath('userData'), 'window.json'), JSON.stringify({ width: bounds.width, height: bounds.height, maximized: mainWindow.isMaximized() })).catch(() => {}); } catch {}
      mainWindow.hide(); return;
    }
    if (!appClosed && appView?.webContents && !appView.webContents.isDestroyed()) {
      event.preventDefault();
      const wc = appView.webContents;
      wc.once('destroyed', () => { appClosed = true; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
      wc.close({ waitForBeforeUnload: true });
      return;
    }
    try { const bounds = mainWindow.getNormalBounds(); fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify({ width: bounds.width, height: bounds.height, maximized: mainWindow.isMaximized() })); } catch {}
  });
  mainWindow.on('closed', () => { if (appView?.webContents && !appView.webContents.isDestroyed()) appView.webContents.close(); appView = null; mainWindow = null; app.quit(); });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.once('did-finish-load', () => {
    if (saved.maximized) mainWindow.maximize();
    mainWindow.show();
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    if (lastStatus) status(lastStatus);
    boot();
  });
  mainWindow.loadFile(path.join(UI, 'shell.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', showMainWindow);
  app.on('activate', showMainWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { tray?.destroy(); });
  app.whenReady().then(async () => {
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    appSession = session.fromPartition('persist:chatapp');
    // Versioned chatapp:// content is served without caching. Keep Chromium's
    // normal image/media cache so each cold launch does not discard it again.
    if (process.env.CHAT_APP_TEST_PROFILE && process.env.CHAT_APP_OFFLINE === '1') {
      appSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    }
    appSession.protocol.handle('chatapp', createContentHandler(() => activeRoot, net));
    configureB2UploadCors(appSession, () => appView?.webContents);
    configurePermissions(appSession);
    const guard = action => event => { if (mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame) action(); };
    ipcMain.on('window:minimize', guard(() => mainWindow.minimize()));
    ipcMain.on('window:maximize', guard(() => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()));
    ipcMain.on('window:close', guard(() => mainWindow.close()));
    ipcMain.on('app:retry', guard(() => boot()));
    ipcMain.on('app:apply-update', guard(() => applyPendingUpdate()));
    ipcMain.on('chat-preferences:background-running', (event, enabled) => {
      if (!captureCaller(event)) return;
      backgroundRunning = enabled !== false;
      if (!backgroundRunning && mainWindow && !mainWindow.isVisible()) showMainWindow();
    });
    ipcMain.handle('chat-preferences:get', event => captureCaller(event) ? { backgroundRunning } : null);
    ipcMain.handle('chat-native:get-build', event => captureCaller(event) ? { nativeVersion: app.getVersion() } : null);
    ipcMain.handle('chat-native:open-update', openUpdateAndQuit);
    ipcMain.handle('chat-capture:sources', async (event, options) => {
      const wc = captureCaller(event);
      if (!wc) return [];
      const frame = event.senderFrame;
      const sources = await refreshCaptureSources({ fresh: options?.fresh === true, previews: options?.previews === true });
      if (wc.isDestroyed() || wc !== appView?.webContents || wc.mainFrame !== frame || !isAppURL(wc.getURL())) return [];
      return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL() }));
    });
    ipcMain.handle('chat-capture:select', async (event, id, options) => {
      const wc = captureCaller(event);
      if (!wc || !mainWindow?.isFocused()) return false;
      captureSelections.delete(wc);
      if (typeof id !== 'string') return false;
      const frame = event.senderFrame;
      // A compatibility retry may follow a long operating-system permission
      // prompt. Refresh stale choices but never substitute a different source.
      if (Date.now() - captureSourcesAt >= 30000) { try { await refreshCaptureSources({ fresh: true }); } catch { return false; } }
      if (wc.isDestroyed() || wc !== appView?.webContents || wc.mainFrame !== frame || !isAppURL(wc.getURL()) || !mainWindow?.isFocused()) return false;
      const source = captureSources.find(item => item.id === id);
      if (!source) return false;
      captureSelections.set(wc, { id: source.id, name: source.name, audio: options?.audio === true, requestId: String(options?.requestId || ''), frame, expiresAt: Date.now() + 120000 });
      return true;
    });
    ipcMain.on('chat-capture:cancel', (event, requestId) => {
      const wc = captureCaller(event);
      if (wc && requestId && captureSelections.get(wc)?.requestId === requestId) captureSelections.delete(wc);
    });
    ipcMain.handle('chat-clipboard:files', (event, limit, maxFileBytes) => {
      const wc = appView?.webContents;
      if (!wc || wc.isDestroyed() || event.sender !== wc || event.senderFrame !== wc.mainFrame || !isAppURL(wc.getURL()) || !mainWindow?.isFocused()) return [];
      return readClipboardFiles(limit, { maxFileBytes: Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : undefined });
    });
    createMainWindow();
  }).catch(error => { dialog.showErrorBox('Chat App could not start', error.message); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
