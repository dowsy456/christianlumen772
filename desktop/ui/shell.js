'use strict';

(() => {
const desktop = window.desktop;
const minimizeButton = document.getElementById('minimize');
const maximizeButton = document.getElementById('maximize');
const closeButton = document.getElementById('close');
const retryButton = document.getElementById('retry');
const loadingScreen = document.getElementById('loading-screen');
const statusMessage = document.getElementById('status-message');
const statusDetail = document.getElementById('status-detail');
const statusAnnouncement = document.getElementById('status-announcement');
const progressTrack = document.getElementById('progress-track');
const progressFill = document.getElementById('progress-fill');
const applyUpdate = document.getElementById('apply-update');
applyUpdate.addEventListener('click', () => desktop.applyUpdate());
desktop.onUpdate(value => { applyUpdate.hidden = !value?.available; });

minimizeButton.addEventListener('click', () => desktop.minimize());
maximizeButton.addEventListener('click', () => desktop.maximize());
closeButton.addEventListener('click', () => desktop.close());
retryButton.addEventListener('click', () => {
  updateStatus({ message: 'Opening Chat App', detail: 'Getting the latest version ready.' });
  desktop.retry();
});

function updateStatus(status) {
  if (!status || typeof status !== 'object') return;
  const error = status.error === true;
  const message = typeof status.message === 'string' && status.message.trim()
    ? status.message
    : error ? 'Unable to open Chat App' : 'Opening Chat App';
  const detail = typeof status.detail === 'string' ? status.detail : '';
  statusMessage.textContent = message;
  statusDetail.textContent = detail;
  statusDetail.hidden = !detail;
  loadingScreen.classList.toggle('has-error', error);
  retryButton.hidden = !error;
  const hasProgress = !error && typeof status.progress === 'number' && Number.isFinite(status.progress);
  progressTrack.hidden = !hasProgress;
  if (hasProgress) {
    const progress = Math.round(Math.max(0, Math.min(100, status.progress)));
    progressFill.style.width = `${progress}%`;
    progressTrack.setAttribute('aria-valuenow', String(progress));
  }
  statusAnnouncement.textContent = detail ? `${message}. ${detail}` : message;
}

desktop.onStatus(updateStatus);
desktop.onMaximized((isMaximized) => {
  const label = isMaximized ? 'Restore down' : 'Maximize';
  maximizeButton.title = label;
  maximizeButton.setAttribute('aria-label', label);
});
})();
