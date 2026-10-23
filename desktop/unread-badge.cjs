'use strict';
const path = require('node:path');
const fs = require('node:fs');
// Source artwork lives in its own <=100-file upload folder; packaged artwork
// retains its existing internal path and native behavior.
const packagedIcons = path.join(__dirname, 'assets', 'unread');
const iconDirectory = label => fs.existsSync(packagedIcons) ? packagedIcons : path.join(__dirname, '..', label === '99+' || Number(label) > 50 ? 'unread-icons-extra' : 'unread-icons');
const CHANNEL = 'chat-unread:count';
function normalizeCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 999999999) : 0;
}
function createUnreadBadge({ ipcMain, mainWindow, nativeImage, platform = process.platform }) {
  let contents = null, count = 0, rendered = null, subscriptions = [];
  const icons = new Map();
  function update(value, force = false) {
    count = normalizeCount(value);
    if (platform !== 'win32' || mainWindow.isDestroyed() || (!force && rendered === count)) return;
    const label = count > 99 ? '99+' : String(count);
    if (count && !icons.has(label)) icons.set(label, nativeImage.createFromPath(path.join(iconDirectory(label), `${label}.png`)));
    try {
      mainWindow.setOverlayIcon(count ? icons.get(label) : null, count ? `${count} unread message${count === 1 ? '' : 's'}` : 'No unread messages');
      rendered = count;
    } catch { rendered = null; }
  }
  function publish(event, value) {
    if (!contents || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    update(value);
  }
  const refresh = () => update(count, true);
  ipcMain.on(CHANNEL, publish);
  for (const event of ['show', 'restore', 'focus']) mainWindow.on(event, refresh);
  mainWindow.once('closed', destroy);
  function bindContents(next) {
    for (const unsubscribe of subscriptions) unsubscribe(); subscriptions = [];
    contents = next; update(0, true);
    if (!next?.on) return;
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) update(0, true); };
    next.on('did-start-navigation', navigation); subscriptions.push(() => next.removeListener('did-start-navigation', navigation));
    for (const name of ['render-process-gone', 'destroyed']) {
      const reset = () => update(0, true);
      next.on(name, reset); subscriptions.push(() => next.removeListener(name, reset));
    }
  }
  function destroy() {
    ipcMain.removeListener(CHANNEL, publish);
    for (const event of ['show', 'restore', 'focus']) mainWindow.removeListener(event, refresh);
    for (const unsubscribe of subscriptions) unsubscribe(); subscriptions = [];
    contents = null; icons.clear();
  }
  return { bindContents, update, destroy };
}
module.exports = { createUnreadBadge, normalizeCount, CHANNEL };
