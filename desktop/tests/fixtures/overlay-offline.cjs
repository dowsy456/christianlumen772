'use strict';

// Exercise the real desktop entry point without contacting any app backend.
// Register before main.cjs creates either its default or persistent session.
const { app } = require('electron');
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
require('../../main.cjs');
