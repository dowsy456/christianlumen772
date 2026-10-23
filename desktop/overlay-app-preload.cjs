'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This preload belongs only to the application WebContentsView. Popouts and
// arbitrary pages do not receive native overlay capabilities.
if (process.isMainFrame && window.location.protocol === 'chatapp:' && window.location.host === 'app') {
  // This immutable value comes from the installed EXE, never its cached web UI.
  const nativeVersion = process.argv.find(value => value.startsWith('--chat-native-version='))?.slice('--chat-native-version='.length) || '0.0.0';
  contextBridge.exposeInMainWorld('chatDesktopBuild', Object.freeze({
    nativeVersion,
    getInfo: () => ipcRenderer.invoke('chat-native:get-build'),
    openUpdateAndQuit: url => ipcRenderer.invoke('chat-native:open-update', String(url || '')),
  }));
  contextBridge.exposeInMainWorld('chatDesktopPreferences', Object.freeze({
    version: 1,
    setBackgroundRunning: enabled => ipcRenderer.send('chat-preferences:background-running', enabled !== false),
    getState: () => ipcRenderer.invoke('chat-preferences:get'),
  }));
  contextBridge.exposeInMainWorld('chatDesktopCapture', Object.freeze({
    version: 1,
    listSources: options => ipcRenderer.invoke('chat-capture:sources', { fresh: options?.fresh === true, previews: options?.previews === true }),
    selectSource: (id, options) => ipcRenderer.invoke('chat-capture:select', String(id || ''), { audio: options?.audio === true, requestId: String(options?.requestId || '') }),
    cancelSelection: requestId => ipcRenderer.send('chat-capture:cancel', String(requestId || '')),
  }));
  contextBridge.exposeInMainWorld('chatDesktopNotifications', Object.freeze({
    version: 2,
    setUnreadCount: count => ipcRenderer.send('chat-unread:count', count),
    setPolicy: policy => ipcRenderer.send('chat-notifications:policy', policy),
    showPing: value => ipcRenderer.invoke('chat-pings:show', value),
    onPingCommand(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, value) => { if (value) callback({ id: String(value.id || ''), roomId: String(value.roomId || ''), messageKey: String(value.messageKey || '') }); };
      ipcRenderer.on('chat-pings:command', listener); return () => ipcRenderer.removeListener('chat-pings:command', listener);
    },
  }));
  contextBridge.exposeInMainWorld('chatDesktopClipboard', Object.freeze({
    version: 2,
    readFiles: (limit, maxFileBytes) => ipcRenderer.invoke('chat-clipboard:files', limit, maxFileBytes),
  }));
  contextBridge.exposeInMainWorld('chatDesktopSpotify', Object.freeze({
    version: 2,
    setUser: code => ipcRenderer.invoke('chat-spotify:user', String(code || '')),
    rekeyUser: (from, to) => ipcRenderer.invoke('chat-spotify:rekey', { from: String(from || ''), to: String(to || '') }),
    getState: () => ipcRenderer.invoke('chat-spotify:get'),
    connect: () => ipcRenderer.invoke('chat-spotify:connect'),
    disconnect: () => ipcRenderer.invoke('chat-spotify:disconnect'),
    control: (action, position) => ipcRenderer.invoke('chat-spotify:control', { action: String(action || ''), position: Number(position) }),
    refresh: () => ipcRenderer.invoke('chat-spotify:refresh'),
    openTrack: id => ipcRenderer.invoke('chat-spotify:open', String(id || '')),
    onChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('chat-spotify:state', listener);
      return () => ipcRenderer.removeListener('chat-spotify:state', listener);
    },
  }));
  contextBridge.exposeInMainWorld('chatDesktopOverlay', Object.freeze({
    version: 1,
    cameraIndicators: true,
    deltaPhotos: true,
    publish: snapshot => ipcRenderer.send('chat-overlay:publish', snapshot),
    onCommand(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, command) => {
        if (!command || !['mute', 'deafen', 'share', 'camera', 'overlay', 'leave'].includes(command.action)) return;
        callback({ action: command.action, roomId: String(command.roomId || ''), sessionId: String(command.sessionId || '') });
      };
      ipcRenderer.on('chat-call:command', listener);
      return () => ipcRenderer.removeListener('chat-call:command', listener);
    },
  }));
  contextBridge.exposeInMainWorld('chatDesktopRings', Object.freeze({
    version: 2,
    publish: snapshot => ipcRenderer.send('chat-rings:publish', snapshot),
    getVisibility: () => ipcRenderer.invoke('chat-rings:get-visibility'),
    onVisibility(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, value) => callback({ focused: value?.focused === true });
      ipcRenderer.on('chat-rings:visibility', listener); return () => ipcRenderer.removeListener('chat-rings:visibility', listener);
    },
    onCommand(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, value) => { if (value && ['join', 'decline'].includes(value.action)) callback({ action: value.action, id: String(value.id || ''), roomId: String(value.roomId || '') }); };
      ipcRenderer.on('chat-rings:command', listener); return () => ipcRenderer.removeListener('chat-rings:command', listener);
    },
  }));
  contextBridge.exposeInMainWorld('chatDesktopGames', Object.freeze({
    version: 1,
    setEnabled: value => ipcRenderer.send('chat-games:enabled', value === true),
    getSnapshot: () => ipcRenderer.invoke('chat-games:get'),
    onChange(callback) {
      if (typeof callback !== 'function') throw new TypeError('A listener function is required.');
      const listener = (_event, value) => callback({ games: Array.isArray(value?.games) ? value.games : [] });
      ipcRenderer.on('chat-games:state', listener); return () => ipcRenderer.removeListener('chat-games:state', listener);
    },
  }));
}
