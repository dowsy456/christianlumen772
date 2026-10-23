'use strict';

const sourcesElement = document.getElementById('sources');
const shareButton = document.getElementById('share');
const audioOption = document.getElementById('audio-option');
const shareAudio = document.getElementById('share-audio');
let selectedId = null;
let audioRequested = false;
let completed = false;

function finish(selection) {
  if (completed) return;
  completed = true;
  shareButton.disabled = true;
  if (selection) window.screenPicker.choose(selection);
  else window.screenPicker.cancel();
}

shareButton.addEventListener('click', () => {
  if (selectedId) finish({ id: selectedId, audio: audioRequested && shareAudio.checked });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    finish(null);
  }
});

// This subscription is installed by the deferred script before did-finish-load.
// The preload also buffers a source payload until its first subscriber is ready.
window.screenPicker.onSources((payload) => {
  if (completed) return;
  const previousSelection = selectedId;
  const audioWasChecked = shareAudio.checked;
  audioRequested = payload?.audioRequested === true;
  audioOption.hidden = !audioRequested;
  shareAudio.checked = audioWasChecked;
  sourcesElement.replaceChildren();
  const sources = Array.isArray(payload?.sources) ? payload.sources : [];
  selectedId = sources.some(source => source.id === previousSelection) ? previousSelection : null;
  shareButton.disabled = !selectedId;
  for (const source of sources) {
    if (!source || typeof source.id !== 'string') continue;
    const sourceName = typeof source.name === 'string' ? source.name : 'Screen or window';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'source';
    button.setAttribute('aria-pressed', String(source.id === selectedId));
    button.setAttribute('aria-label', sourceName);
    button.title = sourceName;
    const thumbnail = document.createElement('span');
    thumbnail.className = 'thumbnail';
    if (typeof source.thumbnail === 'string' && source.thumbnail.startsWith('data:image/')) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async'; image.loading = 'lazy';
      image.src = source.thumbnail;
      thumbnail.append(image);
    }
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = sourceName;
    button.append(thumbnail, name);
    button.addEventListener('click', () => {
      if (completed) return;
      selectedId = source.id;
      sourcesElement.querySelectorAll('.source').forEach((item) => item.setAttribute('aria-pressed', 'false'));
      button.setAttribute('aria-pressed', 'true');
      shareButton.disabled = false;
    });
    sourcesElement.append(button);
  }
  if (!sourcesElement.children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.setAttribute('role', 'status');
    empty.textContent = 'No screens or windows are available to share.';
    sourcesElement.append(empty);
  }
});
