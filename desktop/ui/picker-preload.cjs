'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const subscribers = new Set();
let latestSources;

// Register before any document resources load so the initial payload is retained.
ipcRenderer.on('screen:sources', (_event, payload) => {
  latestSources = payload;
  for (const callback of subscribers) callback(payload);
});

contextBridge.exposeInMainWorld('screenPicker', Object.freeze({
  onSources: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
    subscribers.add(callback);
    if (latestSources !== undefined) callback(latestSources);
    return () => subscribers.delete(callback);
  },
  choose: (selection) => {
    if (!selection || typeof selection.id !== 'string') throw new TypeError('A source ID is required.');
    ipcRenderer.send('screen:choose', { id: selection.id, audio: selection.audio === true });
  },
  cancel: () => ipcRenderer.send('screen:choose', null),
}));
