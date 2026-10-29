'use strict';

// Layout only: no wallet, quote or execution requests originate here.
(() => {
  const body = document.body, rail = document.getElementById('wallet-tracking');
  if (!body || !rail) return;
  const storageKey = 'agent-terminal.tracking-width';
  const defaultWidth = 282, minimumWidth = 200, maximumWidth = 480;
  let preferredWidth = defaultWidth, appliedWidth = defaultWidth, drag = null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (/^\d+$/.test(stored || '') && Number(stored) >= minimumWidth && Number(stored) <= maximumWidth) preferredWidth = Number(stored);
  } catch { /* Layout remains usable when local persistence is unavailable. */ }

  const separator = document.createElement('div');
  separator.id = 'tracking-resizer'; separator.className = 'tracking-resizer'; separator.tabIndex = 0;
  separator.setAttribute('role', 'separator'); separator.setAttribute('aria-orientation', 'vertical');
  separator.setAttribute('aria-controls', 'wallet-tracking'); separator.setAttribute('aria-label', '调整钱包信号宽度');
  separator.title = '拖动调整宽度 · ← → 调整 · Home / End 最小 / 最大 · 双击或 Enter 重置';
  rail.append(separator);
  body.classList.add('workspace-layout');

  const mobile = () => window.innerWidth <= 800;
  const resizable = () => !mobile() && !body.classList.contains('tracking-collapsed');
  const widthLimit = () => Math.max(minimumWidth, Math.min(maximumWidth, window.innerWidth - 540 - 48 - (body.classList.contains('drawer-open') ? 390 : 0)));
  const bounded = width => Math.round(Math.max(minimumWidth, Math.min(widthLimit(), width)));
  function applyWidth() {
    appliedWidth = mobile() ? preferredWidth : bounded(preferredWidth);
    body.style.setProperty('--tracking-width', `${appliedWidth}px`);
    separator.hidden = !resizable();
    separator.setAttribute('aria-valuemin', String(minimumWidth));
    separator.setAttribute('aria-valuemax', String(widthLimit()));
    separator.setAttribute('aria-valuenow', String(appliedWidth));
    separator.setAttribute('aria-valuetext', `${appliedWidth} 像素`);
  }
  function persist() { try { window.localStorage.setItem(storageKey, String(preferredWidth)); } catch {} }
  function reset() {
    preferredWidth = defaultWidth;
    try { window.localStorage.removeItem(storageKey); } catch {}
    applyWidth();
  }
  function endDrag(event, cancelled = false) {
    if (!drag || event.pointerId !== drag.id) return;
    const previous = drag; drag = null;
    body.classList.remove('tracking-resizing');
    if (cancelled) preferredWidth = previous.preferred;
    else { preferredWidth = appliedWidth; persist(); }
    try { separator.releasePointerCapture?.(previous.id); } catch {}
    applyWidth();
  }
  separator.addEventListener('pointerdown', event => {
    if (!resizable() || event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width: appliedWidth, preferred: preferredWidth };
    body.classList.add('tracking-resizing');
    try { separator.setPointerCapture?.(event.pointerId); } catch {}
  });
  document.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!resizable()) { endDrag(event, true); return; }
    preferredWidth = bounded(drag.width + event.clientX - drag.x); applyWidth();
  });
  document.addEventListener('pointerup', event => endDrag(event));
  document.addEventListener('pointercancel', event => endDrag(event, true));
  separator.addEventListener('lostpointercapture', event => endDrag(event, true));
  separator.addEventListener('dblclick', () => { if (resizable()) reset(); });
  separator.addEventListener('keydown', event => {
    if (!resizable()) return;
    const step = event.shiftKey ? 30 : 10;
    let width;
    if (event.key === 'ArrowLeft') width = appliedWidth - step;
    else if (event.key === 'ArrowRight') width = appliedWidth + step;
    else if (event.key === 'Home') width = minimumWidth;
    else if (event.key === 'End') width = widthLimit();
    else if (event.key === 'Enter') { event.preventDefault(); reset(); return; }
    else return;
    event.preventDefault(); preferredWidth = bounded(width); applyWidth(); persist();
  });

  const links = [...document.querySelectorAll('.topnav a[href="#market"], .topnav a[href="#orders"], .topnav a[href="#profiles"]')];
  function showView(orders) {
    const profiles=window.location.hash==='#profiles';
    body.classList.toggle('orders-view', orders&&!profiles);body.classList.toggle('profiles-view',profiles);
    for (const link of links) {
      const active=link.getAttribute('href')===(profiles?'#profiles':orders?'#orders':'#market');
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
  }
  function revealMarket() {
    showView(false);
    body.classList.remove('profiles-view');
    if (['#orders','#profiles'].includes(window.location.hash)) window.history.replaceState(null, '', '#market');
  }
  for (const link of links) link.addEventListener('click', () => showView(link.getAttribute('href') === '#orders'));
  window.addEventListener('hashchange', () => showView(window.location.hash === '#orders'));
  document.getElementById('tracking-signals')?.addEventListener('click', event => {
    if (event.target.closest('.tracking-signal-open')) revealMarket();
  });
  const detail = document.getElementById('token-detail');
  if (window.MutationObserver) {
    new window.MutationObserver(applyWidth).observe(body, { attributes: true, attributeFilter: ['class'] });
    if (detail) new window.MutationObserver(() => { if (!detail.hidden) revealMarket(); }).observe(detail, { attributes: true, attributeFilter: ['hidden'] });
  }
  window.addEventListener('resize', () => {
    if (drag && !resizable()) endDrag({ pointerId: drag.id }, true);
    applyWidth();
  });
  applyWidth(); showView(window.location.hash === '#orders');
})();
