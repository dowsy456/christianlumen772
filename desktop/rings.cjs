'use strict';
const path = require('node:path');
const { isAppURL } = require('./overlay.cjs');
const FADE_MS = 200;
function normalizeRings(value, now = Date.now()) {
  const rooms = new Set();
  return (Array.isArray(value?.rings) ? value.rings : []).slice(0, 64).flatMap(ring => {
    if (!ring || typeof ring.id !== 'string' || !ring.id || ring.id.length > 256 || typeof ring.roomId !== 'string' || !ring.roomId || ring.roomId.length > 256 || rooms.has(ring.roomId)) return [];
    const expiresAt = Number(ring.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 31000) return [];
    rooms.add(ring.roomId);
    const image = typeof ring.roomIcon === 'string' ? ring.roomIcon : '';
    const finite = (number, fallback, low, high) => Number.isFinite(Number(number)) ? Math.min(high, Math.max(low, Number(number))) : fallback;
    return [{ id: ring.id, roomId: ring.roomId, roomName: String(ring.roomName || 'Room').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180),
      roomIcon: image.length <= 10 * 1024 * 1024 && /^data:image\/(?:png|jpe?g|webp|gif|avif|svg\+xml)(?:;[a-z0-9=._-]+)*,/i.test(image) ? image : '',
      roomIconTransform: { x: finite(ring.roomIconTransform?.x, 0, -100, 100), y: finite(ring.roomIconTransform?.y, 0, -100, 100), scale: finite(ring.roomIconTransform?.scale, 1, .2, 100) }, expiresAt }];
  });
}
function ringBounds(display, count) {
  const area = display.workArea || display.bounds;
  // Reserve disjoint halves of the work area for incoming calls and pings.
  const width = Math.min(276, area.width), height = Math.max(1, Math.min(Math.max(1, count) * 180 + 12, 552, Math.floor((area.height - 36) / 2)));
  return { x: area.x + area.width - width - Math.min(12, Math.max(0, area.width - width)), y: area.y + 12, width, height };
}
function createRingPopups({ BrowserWindow, screen, ipcMain, mainWindow, uiDir, timers = globalThis, now = Date.now, log = () => {} }) {
  let contents = null, win = null, ready = false, disposed = false, navigating = false, rings = [], expiryTimer, hideTimer, geometryTimer, layoutCount = 0, requestedBounds, paintedRings;
  let contentSubscriptions = [], hitRegions = [], pointerTimer = null, ignored = null, hoverKey = '';
  let statusReady = false, doNotDisturb = false;
  const pings = createPingPopups({ BrowserWindow, screen, ipcMain, mainWindow, uiDir, timers, now, log });
  const subscriptions = [];
  let lastBounds = mainWindow.getBounds();
  const listen = (emitter, event, callback, list = subscriptions) => { emitter.on(event, callback); list.push(() => emitter.removeListener(event, callback)); };
  const validApp = event => !disposed && !navigating && contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && isAppURL(event.senderFrame?.url) && isAppURL(contents.getURL());
  const focused = () => !mainWindow.isDestroyed() && !mainWindow.isMinimized() && mainWindow.isFocused();
  const validPopup = event => !disposed && win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  const visibility = () => { if (contents && !contents.isDestroyed()) contents.send('chat-rings:visibility', { focused: focused() }); };
  function setPointer(point) {
    if (!win || win.isDestroyed()) return;
    const contains = box => point && point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
    const region = hitRegions.find(item => rings.some(ring => ring.id === item.id) && contains(item.bounds));
    const button = !!region?.buttons.some(contains);
    const ignore = !button;
    if (ignored !== ignore) { ignored = ignore; win.setIgnoreMouseEvents(ignore, { forward: true }); }
    const key = `${region?.id || ''}:${button}`;
    if (ready && key !== hoverKey) { hoverKey = key; win.webContents.send('chat-rings:hover', { id: region?.id || '', button }); }
  }
  function pollPointer() {
    timers.clearTimeout(pointerTimer); pointerTimer = null;
    if (disposed || !win || win.isDestroyed() || !win.isVisible() || !rings.length) return;
    const cursor = screen.getCursorScreenPoint(), bounds = win.getBounds();
    setPointer({ x: cursor.x - bounds.x, y: cursor.y - bounds.y });
    // Mouse forwarding wakes the buttons immediately; polling also restores
    // opacity after crossing the click-through window's outside edge.
    pointerTimer = timers.setTimeout(pollPointer, 16); pointerTimer?.unref?.();
  }
  function createWindow() {
    layoutCount = rings.length;
    const bounds = ringBounds(screen.getDisplayMatching(lastBounds), layoutCount);
    requestedBounds = bounds; paintedRings = null;
    win = new BrowserWindow({ ...bounds, title: 'Chat App Incoming Calls', show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, acceptFirstMouse: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(uiDir, 'rings-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
    const created = win;
    created.setMenu(null);
    created.setAlwaysOnTop(true, 'screen-saver');
    hitRegions = []; ignored = true; hoverKey = '';
    created.setIgnoreMouseEvents(true, { forward: true });
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', event => event.preventDefault());
    created.webContents.on('will-attach-webview', event => event.preventDefault());
    created.webContents.once('did-finish-load', () => { if (win === created) { ready = true; sync(); } });
    created.webContents.on('render-process-gone', () => { if (win === created) { clear(true); created.destroy(); } });
    created.once('closed', () => { if (win === created) { win = null; ready = false; } });
    created.loadFile(path.join(uiDir, 'rings.html')).catch(error => { log(`Incoming calls UI failed: ${error.message}`); if (!created.isDestroyed()) created.destroy(); });
  }
  function fitWindow() {
    if (!win || win.isDestroyed()) return;
    const target = ringBounds(screen.getDisplayMatching(lastBounds), layoutCount);
    if (!requestedBounds || ['x', 'y', 'width', 'height'].some(key => requestedBounds[key] !== target[key])) {
      requestedBounds = target; win.setBounds(target, false);
    }
  }
  function sync() {
    if (disposed) return;
    timers.clearTimeout(expiryTimer);
    const remaining = rings.filter(ring => ring.expiresAt > now());
    if (remaining.length !== rings.length) rings = remaining;
    if (rings.length) {
      expiryTimer = timers.setTimeout(sync, Math.max(1, Math.min(...rings.map(ring => ring.expiresAt)) - now()));
      expiryTimer?.unref?.();
    }
    if (!win || win.isDestroyed()) { if (rings.length) createWindow(); return; }
    timers.clearTimeout(hideTimer);
    // Native move/resize events only affect geometry; retransmitting large room
    // icons on every such event needlessly serializes them into the renderer.
    if (ready && paintedRings !== rings) { paintedRings = rings; win.webContents.send('chat-rings:state', { rings }); }
    if (rings.length) {
      if (rings.length >= layoutCount) {
        timers.clearTimeout(geometryTimer); geometryTimer = null; layoutCount = rings.length;
      } else if (!geometryTimer) {
        // A removed bottom card still occupies its old row while fading out.
        // Delay shrinking the native surface so its last frame is not clipped.
        geometryTimer = timers.setTimeout(() => {
          geometryTimer = null; layoutCount = rings.length;
          if (rings.length) fitWindow();
        }, FADE_MS + 30);
      }
      fitWindow();
      if (ready && !win.isVisible()) win.showInactive();
      if (ready) pollPointer();
    } else {
      timers.clearTimeout(pointerTimer); pointerTimer = null; setPointer(null);
      // Keep the surface alive long enough for each removed card's fade-out.
      hideTimer = timers.setTimeout(() => { if (!rings.length && win && !win.isDestroyed()) win.hide(); }, FADE_MS + 30);
    }
  }
  function clear(immediate = false) {
    rings = []; sync();
    if (immediate && win && !win.isDestroyed()) { timers.clearTimeout(hideTimer); timers.clearTimeout(geometryTimer); geometryTimer = null; layoutCount = 0; win.hide(); }
  }
  listen(ipcMain, 'chat-rings:layout', (event, regions) => {
    if (!validPopup(event) || !Array.isArray(regions)) return;
    const validRect = box => box && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) && box.width > 0 && box.height > 0 && box.width <= 1000 && box.height <= 1000;
    hitRegions = regions.slice(0, 64).filter(item => typeof item?.id === 'string' && validRect(item.bounds) && Array.isArray(item.buttons)).map(item => ({ id: item.id, bounds: item.bounds, buttons: item.buttons.slice(0, 2).filter(validRect) }));
    pollPointer();
  });
  listen(ipcMain, 'chat-rings:pointer', (event, point) => {
    if (!validPopup(event) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    setPointer(point);
  });
  function bindContents(next) {
    for (const unsubscribe of contentSubscriptions) unsubscribe(); contentSubscriptions = [];
    contents = next; navigating = false; statusReady = false; doNotDisturb = false; clear(true);
    if (!contents) { pings.bindContents(null); return; }
    // Warm the hidden renderer during app startup. A new invitation now only
    // updates an existing nonactivating surface, without starting Chromium.
    if (!win || win.isDestroyed()) createWindow();
    pings.bindContents(next);
    listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { navigating = true; clear(true); } }, contentSubscriptions);
    listen(contents, 'did-navigate', () => { navigating = false; visibility(); }, contentSubscriptions);
    listen(contents, 'render-process-gone', () => clear(true), contentSubscriptions);
    listen(contents, 'destroyed', () => { contents = null; clear(true); }, contentSubscriptions);
  }
  function applyPolicy(snapshot) {
    statusReady = snapshot?.statusReady === true; doNotDisturb = snapshot?.doNotDisturb === true;
    if (!statusReady || doNotDisturb) clear(true);
  }
  listen(ipcMain, 'chat-notifications:policy', (event, snapshot) => { if (validApp(event)) applyPolicy(snapshot); });
  listen(ipcMain, 'chat-rings:publish', (event, snapshot) => { if (validApp(event)) {
    applyPolicy(snapshot);
    rings = statusReady && !doNotDisturb ? normalizeRings(snapshot, now()) : []; sync();
  } });
  ipcMain.handle('chat-rings:get-visibility', event => validApp(event) ? { focused: focused() } : { focused: false });
  function handleCommand(event, command) {
    if (!validPopup(event) || !contents || contents.isDestroyed() || navigating || !statusReady || doNotDisturb) return false;
    if (!['join', 'decline'].includes(command?.action)) return false;
    const ring = rings.find(ring => ring.id === command.id && ring.roomId === command.roomId && ring.expiresAt > now());
    if (!ring) return false;
    contents.send('chat-rings:command', { action: command.action, id: ring.id, roomId: ring.roomId });
    // The app publishes the accepted dismissal immediately. Do not remove a
    // card merely because IPC was sent: a busy join or stale account must leave
    // a live invitation available to answer again.
    if (command.action === 'join') { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); contents.focus(); }
    return true;
  }
  listen(ipcMain, 'chat-rings:command', handleCommand);
  ipcMain.handle('chat-rings:answer', handleCommand);
  for (const event of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) listen(mainWindow, event, visibility);
  for (const event of ['move', 'resize']) listen(mainWindow, event, () => { if (!mainWindow.isMinimized()) { lastBounds = mainWindow.getBounds(); sync(); } });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) listen(screen, event, sync);
  listen(mainWindow, 'closed', destroy);
  function destroy() {
    if (disposed) return; disposed = true; pings.destroy();
    timers.clearTimeout(expiryTimer); timers.clearTimeout(hideTimer); timers.clearTimeout(geometryTimer); timers.clearTimeout(pointerTimer);
    for (const unsubscribe of [...subscriptions, ...contentSubscriptions]) unsubscribe();
    ipcMain.removeHandler('chat-rings:get-visibility');
    ipcMain.removeHandler('chat-rings:answer');
    contents = null; rings = [];
    if (win && !win.isDestroyed()) win.destroy(); win = null;
  }
  return { bindContents, clear, destroy };
}
function normalizePing(value) {
  if (!value || ['id', 'roomId', 'messageKey'].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)) return null;
  const clean = (value, length) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, length);
  const metadata = normalizeRings({ rings: [{ ...value, expiresAt: 1000 }] }, 0)[0];
  if (!metadata) return null;
  return { id: value.id, roomId: value.roomId, messageKey: value.messageKey, roomName: metadata.roomName,
    roomIcon: metadata.roomIcon, roomIconTransform: metadata.roomIconTransform,
    username: clean(value.username || 'Someone', 180), preview: value.doNotDisturb === true ? '' : clean(value.preview, 500),
    doNotDisturb: value.doNotDisturb === true };
}
function pingBounds(display, count) {
  const area = display.workArea || display.bounds;
  const width = Math.min(350, area.width), height = Math.max(1, Math.min(Math.max(1, count) * 108 + 12, Math.floor((area.height - 36) / 2)));
  return { x: area.x + area.width - width - Math.min(12, Math.max(0, area.width - width)), y: area.y + Math.max(0, area.height - height - 12), width, height };
}
function createPingPopups({ BrowserWindow, screen, ipcMain, mainWindow, uiDir, timers, now, log }) {
  let contents = null, win = null, ready = false, disposed = false, navigating = false, items = [];
  let statusReady = false, pushEnabled = false, doNotDisturb = false, activeRoomId = '', timer, hideTimer, geometryTimer;
  let lastBounds = mainWindow.getBounds(), requestedBounds, paintedItems, layoutCount = 0;
  let contentSubscriptions = []; const subscriptions = [];
  const listen = (emitter, event, callback, list = subscriptions) => { emitter.on(event, callback); list.push(() => emitter.removeListener(event, callback)); };
  const validApp = event => !disposed && !navigating && contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && isAppURL(contents.getURL()) && isAppURL(event.senderFrame?.url);
  const validPopup = event => !disposed && win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  const viewingRoom = roomId => !!roomId && roomId === activeRoomId && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
  function dismissViewedRoom() {
    const remaining = items.filter(item => !viewingRoom(item.roomId));
    if (remaining.length !== items.length) { items = remaining; sync(); }
  }
  function fit() {
    if (!win || win.isDestroyed()) return;
    const target = pingBounds(screen.getDisplayMatching(lastBounds), layoutCount);
    if (!requestedBounds || ['x', 'y', 'width', 'height'].some(key => requestedBounds[key] !== target[key])) { requestedBounds = target; win.setBounds(target, false); }
  }
  function createWindow() {
    requestedBounds = pingBounds(screen.getDisplayMatching(lastBounds), items.length); paintedItems = null;
    win = new BrowserWindow({ ...requestedBounds, title: 'Chat App Pings', show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, skipTaskbar: true, alwaysOnTop: true, focusable: true, acceptFirstMouse: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(uiDir, 'rings-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, spellcheck: false } });
    const created = win; created.setMenu(null); created.setAlwaysOnTop(true, 'screen-saver');
    // Every part of a ping is clickable. Keep its small surface interactive
    // from the first frame; polling a click-through window can lose the first
    // press before Windows delivers a forwarded mousemove or layout update.
    // Chromium on Windows eats WM_MOUSEACTIVATE's initiating click when its
    // TYPE_WINDOW cannot activate. Allow user activation, while showInactive
    // prevents arrival itself from stealing focus from a game or another app.
    created.setIgnoreMouseEvents(false);
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); created.webContents.on('will-navigate', event => event.preventDefault()); created.webContents.on('will-attach-webview', event => event.preventDefault());
    created.webContents.once('did-finish-load', () => { if (win === created) { ready = true; sync(); } });
    created.webContents.on('render-process-gone', () => { if (win === created) { clear(true); created.destroy(); } });
    created.once('closed', () => { if (win === created) { win = null; ready = false; } });
    created.loadFile(path.join(uiDir, 'rings.html'), { query: { mode: 'pings' } }).catch(error => { log(`Ping UI failed: ${error.message}`); if (!created.isDestroyed()) created.destroy(); });
  }
  function sync() {
    if (disposed) return;
    timers.clearTimeout(timer); timers.clearTimeout(hideTimer);
    const remaining = items.filter(item => (!item.expiresAt || item.expiresAt > now()) && !viewingRoom(item.roomId));
    if (remaining.length !== items.length) items = remaining;
    if (!win || win.isDestroyed()) { if (items.length) createWindow(); return; }
    if (ready) {
      // Start the lifetime only when the card can actually be displayed.
      if (items.some(item => !item.expiresAt)) items = items.map(item => item.expiresAt ? item : { ...item, expiresAt: now() + 3000 });
      if (paintedItems !== items) { paintedItems = items; win.webContents.send('chat-pings:state', { pings: items }); }
    }
    if (items.length) {
      if (ready) { timer = timers.setTimeout(sync, Math.max(1, Math.min(...items.map(item => item.expiresAt)) - now())); timer?.unref?.(); }
      if (items.length >= layoutCount) { timers.clearTimeout(geometryTimer); geometryTimer = null; layoutCount = items.length; }
      else if (!geometryTimer) geometryTimer = timers.setTimeout(() => { geometryTimer = null; layoutCount = items.length; if (items.length) fit(); }, FADE_MS + 30);
      fit(); if (ready && !win.isVisible()) win.showInactive();
    } else {
      hideTimer = timers.setTimeout(() => { if (!items.length && win && !win.isDestroyed()) win.hide(); }, FADE_MS + 30);
    }
  }
  function clear(immediate = false) {
    items = []; sync();
    if (immediate && win && !win.isDestroyed()) { timers.clearTimeout(hideTimer); timers.clearTimeout(geometryTimer); geometryTimer = null; layoutCount = 0; win.hide(); }
  }
  function bindContents(next) {
    for (const off of contentSubscriptions) off(); contentSubscriptions = [];
    contents = next; navigating = false; statusReady = false; pushEnabled = false; doNotDisturb = false; activeRoomId = ''; clear(true);
    if (!contents) return;
    if (!win || win.isDestroyed()) createWindow();
    listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) { navigating = true; clear(true); } }, contentSubscriptions);
    listen(contents, 'did-navigate', () => { navigating = false; }, contentSubscriptions);
    listen(contents, 'render-process-gone', () => clear(true), contentSubscriptions);
    listen(contents, 'destroyed', () => { contents = null; clear(true); }, contentSubscriptions);
  }
  listen(ipcMain, 'chat-notifications:policy', (event, policy) => {
    if (!validApp(event)) return;
    statusReady = policy?.statusReady === true; pushEnabled = policy?.pushEnabled === true; doNotDisturb = policy?.doNotDisturb === true;
    activeRoomId = typeof policy?.activeRoomId === 'string' && policy.activeRoomId.length <= 256 ? policy.activeRoomId : '';
    if (!statusReady || !pushEnabled) clear(true);
    else {
      if (doNotDisturb && items.some(item => !item.doNotDisturb || item.preview)) { items = items.map(item => ({ ...item, doNotDisturb: true, preview: '' })); sync(); }
      dismissViewedRoom();
    }
  });
  ipcMain.handle('chat-pings:show', (event, value) => {
    if (!validApp(event) || !statusReady || !pushEnabled) return false;
    const ping = normalizePing({ ...value, doNotDisturb: doNotDisturb || value?.doNotDisturb === true });
    if (!ping) return false;
    // Consumed without a popup: the user can already read this exact room.
    if (viewingRoom(ping.roomId)) return true;
    // A retransmitted event never extends its three-second lifetime.
    if (items.some(item => item.id === ping.id)) return true;
    items = [...items.slice(-63), ping]; sync(); return true;
  });
  ipcMain.handle('chat-pings:command', (event, command) => {
    if (!validPopup(event) || !contents || contents.isDestroyed() || navigating || !['open', 'dismiss'].includes(command?.action)) return false;
    const ping = items.find(item => item.id === command.id && item.roomId === command.roomId && item.messageKey === command.messageKey && (!item.expiresAt || item.expiresAt > now()));
    if (!ping) return false;
    items = items.filter(item => item !== ping); sync();
    if (command.action === 'open') {
      contents.send('chat-pings:command', { id: ping.id, roomId: ping.roomId, messageKey: ping.messageKey });
      if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.moveTop(); mainWindow.focus(); contents.focus();
    }
    return true;
  });
  for (const event of ['focus', 'show', 'restore']) listen(mainWindow, event, dismissViewedRoom);
  for (const event of ['move', 'resize']) listen(mainWindow, event, () => { if (!mainWindow.isMinimized()) { lastBounds = mainWindow.getBounds(); fit(); } });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) listen(screen, event, fit);
  function destroy() {
    if (disposed) return; disposed = true;
    for (const id of [timer, hideTimer, geometryTimer]) timers.clearTimeout(id);
    for (const off of [...subscriptions, ...contentSubscriptions]) off();
    ipcMain.removeHandler('chat-pings:show'); ipcMain.removeHandler('chat-pings:command'); contents = null; items = [];
    if (win && !win.isDestroyed()) win.destroy(); win = null;
  }
  return { bindContents, clear, destroy };
}
module.exports = { createRingPopups, normalizeRings, ringBounds, normalizePing, pingBounds };
