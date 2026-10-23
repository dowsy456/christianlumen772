'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatOverlayDisplay', Object.freeze({
  painted(generation) {
    if (Number.isSafeInteger(generation)) ipcRenderer.send('chat-overlay:painted', generation);
  },
  onState(callback) {
    if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('chat-overlay:state', listener);
    return () => ipcRenderer.removeListener('chat-overlay:state', listener);
  },
}));
