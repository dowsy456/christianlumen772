'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  retry: () => ipcRenderer.send('app:retry'),
  applyUpdate: () => ipcRenderer.send('app:apply-update'),
  onUpdate: callback => listen('app:update', callback),
  onStatus: (callback) => listen('app:status', callback),
  onMaximized: (callback) => listen('window:maximized', callback),
}));
