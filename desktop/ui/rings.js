'use strict';
const cards = new Map(), host = document.getElementById('rings');
const isPing = window.ringPopup.mode === 'pings';
if (isPing) { document.body.classList.add('ping-mode'); host.setAttribute('aria-label', 'Mentions'); document.title = 'Chat App Pings'; }
let layoutFrame = 0;
const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; };
function scheduleLayout() {
  if (isPing) return;
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    window.ringPopup.layout([...cards].filter(([, card]) => !card.leaving).map(([id, card]) => ({ id, bounds: rect(card.root), buttons: [...card.root.querySelectorAll('button')].map(rect) })));
  });
}
window.ringPopup.onHover(({ id, button }) => {
  if (isPing) return;
  for (const [key, card] of cards) card.root.classList.toggle('pointer-through', key === id && !button);
});
if (!isPing) window.addEventListener('mousemove', event => window.ringPopup.pointer({ x: event.clientX, y: event.clientY }));
window.addEventListener('resize', scheduleLayout);
host.addEventListener('scroll', scheduleLayout, { passive: true });
host.addEventListener('animationend', scheduleLayout);
new ResizeObserver(scheduleLayout).observe(host);
const PHONE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.2 12.2c5.4-5.2 14.2-5.2 19.6 0a1.3 1.3 0 0 1 0 1.8l-2 2a1.2 1.2 0 0 1-1.7 0l-2.5-2.3a1.2 1.2 0 0 1-.3-1.2l.3-1a12.2 12.2 0 0 0-7.2 0l.3 1a1.2 1.2 0 0 1-.3 1.2L5.9 16a1.2 1.2 0 0 1-1.7 0l-2-2a1.3 1.3 0 0 1 0-1.8Z"/></svg>';
const JOIN_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.79a2 2 0 0 1-.45 2.11L8.09 9.88a16 16 0 0 0 6 6l1.26-1.26a2 2 0 0 1 2.11-.45c.9.33 1.83.56 2.79.69A2 2 0 0 1 22 16.92Z"/></svg>';
window.ringPopup.onState(state => {
  const rings = (isPing ? state.pings : state.rings) || [];
  const wanted = new Set(rings.map(ring => ring.id));
  for (const [id, card] of cards) if (!wanted.has(id) && !card.leaving) {
    card.leaving = true; card.root.classList.add('leaving');
    card.timer = setTimeout(() => { if (card.leaving) { card.root.remove(); cards.delete(id); scheduleLayout(); } }, 200);
  }
  for (const ring of rings) {
    let card = cards.get(ring.id);
    if (!card) {
      const root = document.createElement('section'); root.className = isPing ? 'ring ping' : 'ring';
      const name = document.createElement('div'); name.className = 'name';
      const icon = document.createElement('div'); icon.className = 'room-icon';
      const controls = document.createElement('div'); controls.className = 'controls';
      const copy = document.createElement('div'); copy.className = 'ping-copy';
      const username = document.createElement('div'); username.className = 'ping-user';
      const preview = document.createElement('div'); preview.className = 'ping-preview';
      const answer = async action => {
        if (card?.leaving || root.dataset.answering) return;
        root.dataset.answering = action;
        try { await window.ringPopup.command({ action, id: ring.id, roomId: ring.roomId, messageKey: ring.messageKey }); }
        finally { delete root.dataset.answering; }
      };
      if (isPing) {
        root.tabIndex = 0; root.setAttribute('role', 'button');
        root.addEventListener('click', () => { void answer('open').catch(() => {}); });
        root.addEventListener('keydown', event => { if (event.target === root && ['Enter', ' '].includes(event.key)) { event.preventDefault(); void answer('open').catch(() => {}); } });
        const close = document.createElement('button'); close.type = 'button'; close.className = 'ping-close'; close.setAttribute('aria-label', 'Dismiss notification'); close.title = 'Dismiss notification'; close.textContent = '×';
        close.addEventListener('click', event => { event.stopPropagation(); void answer('dismiss').catch(() => {}); });
        copy.append(name, username, preview); root.append(icon, copy, close);
      }
      for (const [action, title] of (isPing ? [] : [['decline', 'Decline Call'], ['join', 'Join Call']])) {
        const button = document.createElement('button'); button.className = `control ${action}`; button.type = 'button'; button.title = title; button.setAttribute('aria-label', title); button.innerHTML = action === 'join' ? JOIN_PHONE : PHONE;
        button.addEventListener('click', async () => {
          if (card?.leaving || root.dataset.answering) return;
          root.dataset.answering = action;
          try {
            const accepted = await window.ringPopup.command({ action, id: ring.id, roomId: ring.roomId });
            if (!accepted) button.title = 'This call is no longer available.';
          }
          catch { button.title = 'Unable to answer. Please try again.'; }
          finally { delete root.dataset.answering; }
        }); controls.appendChild(button);
      }
      if (!isPing) root.append(name, icon, controls); host.appendChild(root); card = { root, name, icon, username, preview }; cards.set(ring.id, card);
    }
    clearTimeout(card.timer); card.leaving = false; card.root.classList.remove('leaving');
    card.name.textContent = ring.roomName; card.name.title = ring.roomName;
    if (isPing) { card.username.textContent = `${ring.username} pinged you`; card.preview.textContent = ring.doNotDisturb ? '' : ring.preview; card.preview.hidden = !card.preview.textContent; card.root.setAttribute('aria-label', `${ring.roomName}: ${ring.username} pinged you`); }
    if (card.image !== ring.roomIcon) {
      card.image = ring.roomIcon; card.icon.replaceChildren();
      if (ring.roomIcon) { const image = document.createElement('img'); image.alt = ''; image.src = ring.roomIcon; card.icon.appendChild(image); } else card.icon.textContent = ring.roomName.slice(0, 1).toUpperCase();
    }
    const image = card.icon.querySelector('img'), transform = ring.roomIconTransform || {};
    if (image) image.style.transform = `translate(${(transform.x || 0) * 100}%, ${(transform.y || 0) * 100}%) scale(${transform.scale || 1})`;
  }
  scheduleLayout();
});
