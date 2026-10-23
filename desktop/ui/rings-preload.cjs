'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const mode = new URLSearchParams(window.location.search).get('mode') === 'pings' ? 'pings' : 'rings';
contextBridge.exposeInMainWorld('ringPopup', Object.freeze({
  mode,
  onState(callback) { const listener = (_event, state) => callback(state); ipcRenderer.on(`chat-${mode}:state`, listener); return () => ipcRenderer.removeListener(`chat-${mode}:state`, listener); },
  command: command => ipcRenderer.invoke(mode === 'pings' ? 'chat-pings:command' : 'chat-rings:answer', command),
  layout: regions => ipcRenderer.send(`chat-${mode}:layout`, regions),
  pointer: point => ipcRenderer.send(`chat-${mode}:pointer`, point),
  onHover(callback) { const listener = (_event, value) => callback(value); ipcRenderer.on('chat-rings:hover', listener); return () => ipcRenderer.removeListener('chat-rings:hover', listener); },
}));
