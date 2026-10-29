import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../public/workspace-layout.js', import.meta.url), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const key = 'agent-terminal.tracking-width';
const tick = async () => { await new Promise(setImmediate); };
function page({ width = 1440, saved, hash = '', blockedStorage = false } = {}) {
  const { window, document } = parseHTML(html), values = new Map(saved === undefined ? [] : [[key, saved]]);
  window.innerWidth = width;
  window.location = { hash };
  window.history = { replaceState(_state, _title, url) { window.location.hash = url; } };
  Object.defineProperty(window, 'localStorage', { value: { getItem(name) { if (blockedStorage) throw new Error('blocked'); return values.get(name) ?? null; }, setItem(name, value) { if (blockedStorage) throw new Error('blocked'); values.set(name, value); }, removeItem(name) { if (blockedStorage) throw new Error('blocked'); values.delete(name); } }, configurable: true });
  vm.runInContext(source, vm.createContext({ window, document, console, Number, Math, MutationObserver: window.MutationObserver }));
  const $ = id => document.getElementById(id);
  function event(target, type, properties = {}) { const value = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(value, properties); target.dispatchEvent(value); return value; }
  const current = () => document.body.style.getPropertyValue('--tracking-width');
  return { window, document, values, $, event, current, separator: $('tracking-resizer') };
}

test('sidebar restores a valid width while malformed stored values leave a usable default', () => {
  assert.equal(page({ saved: '360' }).current(), '360px');
  for (const saved of ['0', '-20', '700', 'NaN', 'Infinity', '320garbage', '']) assert.equal(page({ saved }).current(), '282px');
  assert.equal(page({ blockedStorage: true }).current(), '282px');
});

test('dragging the separator clamps width, commits it on release and stops changing afterwards', () => {
  const p = page(); assert.ok(p.separator, 'the expanded rail has a keyboard and pointer separator');
  p.event(p.separator, 'pointerdown', { button: 0, clientX: 282, pointerId: 7 });
  p.event(p.document, 'pointermove', { clientX: 1000, pointerId: 7 });
  assert.equal(p.current(), '480px');
  assert.equal(p.values.has(key), false, 'drag moves do not continuously write storage');
  p.event(p.document, 'pointerup', { clientX: 1000, pointerId: 7 });
  assert.equal(p.values.get(key), '480');
  p.event(p.document, 'pointermove', { clientX: 220, pointerId: 7 });
  assert.equal(p.current(), '480px');
  p.event(p.separator, 'pointerdown', { button: 0, clientX: 480, pointerId: 8 });
  p.event(p.document, 'pointermove', { clientX: -100, pointerId: 8 });
  p.event(p.document, 'pointerup', { pointerId: 8 });
  assert.equal(p.current(), '200px');
});

test('keyboard resizing exposes current bounds and reset removes the saved preference', () => {
  const p = page({ width: 1000, saved: '360' });
  assert.equal(p.separator.getAttribute('role'), 'separator');
  assert.equal(p.separator.getAttribute('aria-orientation'), 'vertical');
  p.event(p.separator, 'keydown', { key: 'ArrowRight' });
  assert.equal(p.current(), '370px'); assert.equal(p.values.get(key), '370');
  p.event(p.separator, 'keydown', { key: 'End' });
  assert.equal(p.current(), '412px'); assert.equal(p.separator.getAttribute('aria-valuemax'), '412');
  p.event(p.separator, 'keydown', { key: 'Home' }); assert.equal(p.current(), '200px');
  p.event(p.separator, 'dblclick'); assert.equal(p.current(), '282px'); assert.equal(p.values.has(key), false);
});

test('viewport constraints do not overwrite the preferred width and mobile or collapsed rail cannot drag', async () => {
  const p = page({ saved: '450' });
  p.window.innerWidth = 1000; p.event(p.window, 'resize'); assert.equal(p.current(), '412px');
  assert.equal(p.values.get(key), '450');
  p.window.innerWidth = 1440; p.event(p.window, 'resize'); assert.equal(p.current(), '450px');
  p.document.body.classList.add('tracking-collapsed'); await tick();
  assert.equal(p.separator.hidden, true);
  p.event(p.separator, 'pointerdown', { button: 0, clientX: 450, pointerId: 1 }); p.event(p.document, 'pointermove', { clientX: 210, pointerId: 1 });
  assert.equal(p.current(), '450px');
  p.document.body.classList.remove('tracking-collapsed');
  p.window.innerWidth = 390; p.event(p.window, 'resize'); assert.equal(p.separator.hidden, true);
  p.event(p.separator, 'keydown', { key: 'End' }); assert.equal(p.values.get(key), '450');
  p.window.innerWidth = 1440; p.event(p.window, 'resize'); assert.equal(p.current(), '450px');
});

test('orders hash and navigation show an accessible view while detail and market state survive', async () => {
  const p = page({ hash: '#orders' });
  assert.equal(p.document.body.classList.contains('orders-view'), true);
  assert.equal(p.document.querySelector('.topnav a[href="#orders"]').getAttribute('aria-current'), 'page');
  assert.equal(p.$('market').hidden, false, 'view switching does not mutate token-detail lifecycle visibility');
  p.event(p.document.querySelector('.topnav a[href="#market"]'), 'click');
  assert.equal(p.document.body.classList.contains('orders-view'), false);
  p.window.location.hash = '#orders'; p.event(p.window, 'hashchange');
  assert.equal(p.document.body.classList.contains('orders-view'), true);
  p.$('token-detail').hidden = false; p.document.body.classList.add('detail-open'); await tick();
  assert.equal(p.document.body.classList.contains('orders-view'), false, 'opening a token from a wallet signal reveals its detail pane');
  assert.equal(p.window.location.hash, '#market');
});
