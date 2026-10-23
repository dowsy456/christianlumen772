'use strict';

(() => {
  const list = document.getElementById('members');
  const rows = new Map();
  let presentation = null;
  let scheduledGeneration = -1;
  let acknowledgedGeneration = -1;
  const defaultPhoto = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 84"><rect width="84" height="84" fill="#0e1319"/><g fill="none" stroke="#a0acbb" stroke-width="3.5" stroke-linecap="round"><circle cx="42" cy="29" r="11"/><path d="M20 67c1-15 9-23 22-23s21 8 22 23"/></g></svg>');
  const icons = {
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 0 0-6 0v4a3 3 0 0 0 3 3ZM5 11a7 7 0 0 0 11 5.7M12 18v3M8.5 21h7M4 4l16 16"/></svg>',
    deafened: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13v-1a8 8 0 0 1 13.5-5.8M4 13v5h4v-7H6.5A2.5 2.5 0 0 0 4 13.5ZM20 13.5A2.5 2.5 0 0 0 17.5 11H16v7h2.2M4 4l16 16"/></svg>',
    sharing: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="3"/><path d="M9 21h6M12 17v4"/></svg>',
    cameraSharing: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.5 10 4h4l1.5 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.5Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    watchingYourCamera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6S2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>',
    watchingYourScreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6S2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.7"/></svg>',
  };

  function fitRoster() {
    // Keep every participant on screen when a call has a long roster. This is
    // a visual scale only: profile crop coordinates remain relative to avatars.
    const height = Math.max(1, list.offsetHeight);
    const width = Math.max(1, list.offsetWidth);
    const scale = Math.min(presentation?.scale || .7, Math.max(1, window.innerHeight - 8) / height, Math.max(1, window.innerWidth - 8) / width);
    document.documentElement.style.setProperty('--overlay-scale', String(scale));
  }

  function createRow(code) {
    const row = document.createElement('li');
    row.className = 'overlay-member';
    row.dataset.code = code;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = defaultPhoto;
    avatar.appendChild(img);
    const pill = document.createElement('div');
    pill.className = 'name-pill';
    const name = document.createElement('span');
    name.className = 'display-name';
    const status = document.createElement('span');
    status.className = 'member-state';
    pill.append(name, status);
    row.append(avatar, pill);
    return { row, avatar, img, name, status, statusKey: '', source: '', imageVersion: 0 };
  }

  function setPhoto(item, source) {
    if (item.source === source) return;
    item.source = source;
    const version = ++item.imageVersion;
    // Decode off-DOM so a large/animated or broken profile never blanks the
    // roster or blocks showing it. Keep the last avatar until the new one is
    // ready, with the local fallback present from the first paint.
    const pending = new Image();
    pending.src = source;
    pending.decode().then(() => {
      if (version === item.imageVersion) item.img.src = source;
    }).catch(() => {
      if (version === item.imageVersion) item.img.src = defaultPhoto;
    });
  }

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

  function preparePresentation() {
    const target = presentation;
    if (!target || !Number.isSafeInteger(target.generation) || scheduledGeneration === target.generation || acknowledgedGeneration === target.generation) return;
    const generation = target.generation;
    scheduledGeneration = generation;
    const current = () => presentation?.generation === generation;
    (async () => {
      await nextFrame();
      if (!current()) return;
      fitRoster();
      // A second frame follows the roster's first paint. Fit the actual CSS
      // viewport instead of waiting indefinitely for Windows DIP rounding to
      // equal a requested native size, or for every avatar decode to finish.
      await nextFrame();
      if (!current()) return;
      acknowledgedGeneration = generation;
      window.chatOverlayDisplay.painted(generation);
    })().finally(() => {
      if (scheduledGeneration === generation) scheduledGeneration = -1;
    });
  }

  window.chatOverlayDisplay.onState(state => {
    const members = state?.active && state?.enabled ? state.members || [] : [];
    presentation = state?.presentation || null;
    const retained = new Set();
    let insertionPoint = list.firstElementChild;
    for (const member of members) {
      retained.add(member.code);
      let item = rows.get(member.code);
      if (!item) { item = createRow(member.code); rows.set(member.code, item); }
      if (item.name.textContent !== member.displayName) item.name.textContent = member.displayName;
      item.row.classList.toggle('speaking', member.speaking);
      item.avatar.classList.toggle('speaking', member.speaking);
      const source = (member.reusePhoto ? item.source : member.photoDataURL) || defaultPhoto;
      setPhoto(item, source);
      const crop = member.photoTransform;
      const x = Math.round((-50 + crop.x * 100) * 10000) / 10000;
      const y = Math.round((-50 + crop.y * 100) * 10000) / 10000;
      const transform = `translate(${x}%, ${y}%) scale(${crop.scale})`;
      if (item.img.style.transform !== transform) item.img.style.transform = transform;
      const flags = ['muted', 'deafened', 'sharing', 'cameraSharing', 'watchingYourScreen', 'watchingYourCamera'].filter(key => member[key]);
      const statusKey = flags.join(' ');
      if (item.statusKey !== statusKey) {
        item.status.innerHTML = flags.map(key => `<span class="state-${key}">${icons[key]}</span>`).join('');
        item.statusKey = statusKey;
      }
      item.row.setAttribute('aria-label', `${member.displayName}${member.speaking ? ', speaking' : ''}${flags.length ? ', ' + flags.map(key => key === 'watchingYourScreen' ? 'watching your screen' : key === 'watchingYourCamera' ? 'watching your camera' : key === 'cameraSharing' ? 'sharing camera' : key).join(', ') : ''}`);
      // Leave already ordered rows in place during speech updates. Only real
      // joins/name changes reorder nodes, preserving decoded GIF surfaces.
      if (item.row !== insertionPoint) list.insertBefore(item.row, insertionPoint);
      insertionPoint = item.row.nextElementSibling;
    }
    for (const [code, item] of rows) {
      if (retained.has(code)) continue;
      item.row.remove();
      rows.delete(code);
    }
    fitRoster();
    preparePresentation();
  });
  window.addEventListener('resize', () => { fitRoster(); preparePresentation(); });
})();
