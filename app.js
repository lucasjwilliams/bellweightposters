'use strict';

const CHANGELOG = [
  {
    version: '0.8', date: '2026-10-02', changes: [
      'Towers with chime bells, old bells or planned new bells (e.g. Manchester Town Hall) now name their bells properly and start with just the ringing bells ticked',
      'This list of changes',
    ],
  },
  {
    version: '0.7', date: '2026-10-01', changes: [
      'Anonymous counts of which towers are picked and how posters are exported (no cookies)',
    ],
  },
  {
    version: '0.6', date: '2026-09-30', changes: [
      'Sharper item pictures in downloaded images, without stray lines around them',
      'Clicking outside the item picker closes it',
    ],
  },
  {
    version: '0.4', date: '2026-09-30', changes: [
      'New bank vault door picture',
      'The poster preview shows a small picture straight away while the full-size one loads',
    ],
  },
  {
    version: '0.3', date: '2026-09-30', changes: [
      'Bigger posters when printing from an iPhone or iPad',
      'New contact email',
    ],
  },
  {
    version: '0.2', date: '2026-09-30', changes: [
      'Printing from an iPhone or iPad fits the poster on one page',
    ],
  },
  {
    version: '0.1', date: '2026-09-30', changes: [
      'First version: find a tower, match each bell to something that weighs about the same, style the poster, then print, download or share it',
    ],
  },
];
const VERSION = CHANGELOG[0].version;

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;

// Item matching. Scores are |log(item kg / bell kg)|, so 0.15 is roughly 16% off.
const GOOD_MATCH = 1.3; // within 30% counts as a good match
const OK_MATCH = 1.6;
const CATEGORY_PENALTY = 0.15; // per item of the same category already on the poster
const CATEGORY_BIAS = { animal: 0.1 }; // there are a lot of animals, so nudge them down
const SHUFFLE_JITTER = 0.3; // randomness added by "Re-suggest"

const THEMES = [
  { name: 'Green', main: '#4a7a35', light: '#e3efd9' },
  { name: 'Navy', main: '#1f3a68', light: '#dfe7f3' },
  { name: 'Burgundy', main: '#7a1f35', light: '#f3dfe4' },
  { name: 'Bronze', main: '#8a5a1c', light: '#f4e8d6' },
  { name: 'Slate', main: '#333a42', light: '#e6e8eb' },
];

const COLUMNS = [
  { key: 'note', head: 'Note', width: 0.8, cell: (b) => escapeHtml(b.note || '—') },
  { key: 'weight', head: 'Weight', width: 1.7, cell: (b) => fmtWeight(b.kg) },
  { key: 'diam', head: 'Diameter', width: 1.5, cell: (b) => fmtDiam(b.diamIn) },
  {
    key: 'item', head: 'What weighs that?', width: 3.4, cls: 'p-what',
    cell: (b) => {
      const item = itemById(b.itemId);
      return item ? `<span class="p-caption">${escapeHtml(item.name)}</span>${posterImage(item)}` : '';
    },
  },
];
const DEFAULT_COLS = '0101'; 

const CUSTOM_KEY = 'bellposters.customItems';
const CUSTOM_IMG_SIZE = 240;
const SUBMIT_EMAIL = 'contact@lucasw.uk';

function track(path, title = '') {
  const send = () => window.goatcounter.count({ path, title, event: true });
  if (window.goatcounter?.count) send();
  else document.querySelector('script[data-goatcounter]')?.addEventListener('load', send, { once: true });
}

const state = {
  rings: [],
  items: [],
  customItems: [],    // { id, name, image (data URL), custom: true, fromLink? }
  ring: null,
  bells: [],          // { role, name, kg, diamIn, included, itemId }
  title: '',
  subtitle: '',
  units: 'kg',
  diamUnits: 'cm',
  orientation: 'portrait',
  pages: 1,
  show: { note: false, weight: true, diam: false, item: true },
  titleAll: false,
  headAll: false,
  theme: THEMES[0],
  pickingBell: null,
};

const $ = (id) => document.getElementById(id);

const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

const IS_WEBKIT_PRINT = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPad in desktop mode
  || (/Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|Android/.test(navigator.userAgent));
if (IS_WEBKIT_PRINT) document.documentElement.classList.add('safari-print');

function fmtKg(kg) {
  if (kg == null) return '—';
  if (kg < 10) return `${kg.toFixed(2)} kg`;
  if (kg < 1000) return `${kg.toFixed(1)} kg`;
  return `${Math.round(kg).toLocaleString()} kg`;
}

function fmtCwt(kg) {
  if (kg == null) return '—';
  const lbs = Math.round(kg / LB_TO_KG);
  const cwt = Math.floor(lbs / 112);
  const qr = Math.floor((lbs % 112) / 28);
  const lb = lbs % 28;
  return `${cwt}–${qr}–${lb}`;
}

function fmtWeight(kg) {
  if (state.units === 'cwt') return fmtCwt(kg);
  if (state.units === 'both') return `${fmtKg(kg)}<span class="sub">${fmtCwt(kg)}</span>`;
  return fmtKg(kg);
}

function fmtDiam(inches) {
  if (inches == null) return '—';
  return state.diamUnits === 'in' ? `${+inches.toFixed(1)}″` : `${(inches * IN_TO_CM).toFixed(1)} cm`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function parseRole(role) {
  let m = role.match(/^(\d+)([b#]?)(?:[co]\d+)?$/);
  if (m) return { kind: 'ring', n: +m[1], mod: m[2] };
  m = role.match(/^(c|o|new)(\d+)([b#]?)$/);
  if (m) return { kind: m[1], n: +m[2], mod: m[3] };
  return { kind: 'other', n: 0, mod: '' };
}

const ROLE_PREFIX = { c: 'Chime', o: 'Old', new: 'New' };

function defaultBellName(role, ringSize) {
  const { kind, n, mod } = parseRole(role);
  const flatSharp = mod === 'b' ? 'flat ' : mod === '#' ? 'sharp ' : '';
  if (kind === 'ring') {
    if (mod) return `${mod === 'b' ? 'Flat' : 'Sharp'} ${ordinal(n)}`;
    if (n === 1) return '1 (Treble)';
    if (n === ringSize) return `${n} (Tenor)`;
    return String(n);
  }
  if (kind === 'other') return role;
  if (n === 0) return `${ROLE_PREFIX[kind]} extra treble`;
  return `${ROLE_PREFIX[kind]} ${flatSharp}${kind === 'c' ? n : ordinal(n)}`;
}

// Bells 1..n  ticked, extras (e.g #2)
function isMainBell(role, ringSize) {
  const { kind, n, mod } = parseRole(role);
  return kind === 'ring' && !mod && n >= 1 && n <= ringSize;
}

function sortRingBells(bells) {
  const rung = bells.filter((b) => parseRole(b[0]).kind === 'ring');
  const rest = bells.filter((b) => parseRole(b[0]).kind !== 'ring');
  rest.sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity));
  return [...rung, ...rest];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function itemById(id) {
  return state.items.find((i) => i.id === id) || state.customItems.find((i) => i.id === id);
}

function rankedItems(kg) {
  return state.items
    .map((item) => ({ item, score: Math.abs(Math.log(kg / item.kg)) }))
    .sort((a, b) => a.score - b.score);
}

function suggestAll(shuffle = false, only = null) {
  const usedKinds = new Set();
  const categoryCount = {};
  const keep = (b) => itemById(b.itemId)?.custom;
  const included = only ? [only] : state.bells.filter((b) => b.included && b.kg && !keep(b));
  if (only) {
    for (const b of state.bells) {
      const item = b !== only && b.included && itemById(b.itemId);
      if (!item) continue;
      usedKinds.add(item.kind);
      categoryCount[item.category] = (categoryCount[item.category] || 0) + 1;
    }
  }
  const current = new Set(shuffle ? included.map((b) => b.itemId) : []);
  const jitter = new Map(state.items.map((i) => [i.id, shuffle ? Math.random() * SHUFFLE_JITTER : 0]));
  for (const bell of [...included].sort((a, b) => b.kg - a.kg)) {
    const all = rankedItems(bell.kg);
    const ranked = all.filter((r) => !current.has(r.item.id)).length ? all.filter((r) => !current.has(r.item.id)) : all;
    const fresh = ranked.filter((r) => !usedKinds.has(r.item.kind));
    const cost = (r) => r.score + CATEGORY_PENALTY * (categoryCount[r.item.category] || 0)
      + (CATEGORY_BIAS[r.item.category] || 0)
      + jitter.get(r.item.id) + (current.has(r.item.id) ? SHUFFLE_JITTER : 0);
    const best = (list) => list.reduce((a, b) => (cost(b) < cost(a) ? b : a), list[0]);
    const pick = best(fresh.filter((r) => r.score <= Math.log(GOOD_MATCH)))
      || best(fresh.filter((r) => r.score <= Math.log(OK_MATCH)))
      || fresh[0]
      || ranked[0];
    bell.itemId = pick ? pick.item.id : null;
    if (pick) {
      usedKinds.add(pick.item.kind);
      categoryCount[pick.item.category] = (categoryCount[pick.item.category] || 0) + 1;
    }
  }
  if (!only) {
    const dealt = included.filter((b) => b.itemId);
    const itemsByKg = dealt.map((b) => itemById(b.itemId)).sort((a, b) => b.kg - a.kg);
    [...dealt].sort((a, b) => b.kg - a.kg).forEach((bell, i) => { bell.itemId = itemsByKg[i].id; });
  }
}

function towerLabel(r) {
  return `${r[1]}, ${r[2]}`;
}

function placeRank(place, q) {
  if (place === q) return 0;
  if (place.startsWith(q)) return 1;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(place)) return 2;
  return 3;
}

function searchTowers(q) {
  const query = q.toLowerCase().trim();
  const terms = query.split(/[\s,]+/).filter(Boolean);
  if (!terms.length) return [];
  const matches = [];
  for (const r of state.rings) {
    const hay = `${r[1]} ${r[2]} ${r[3]}`.toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      const place = r[1].toLowerCase();
      matches.push({ r, rank: Math.min(placeRank(place, query), placeRank(place, terms[0]) + 0.5) });
    }
  }
  return matches.sort((a, b) => a.rank - b.rank).slice(0, 50).map((m) => m.r);
}

function renderResults(list) {
  const ul = $('tower-results');
  ul.innerHTML = list.map((r, i) => `
    <li role="option" data-i="${i}" tabindex="-1">
      <strong>${escapeHtml(r[1])}</strong>, ${escapeHtml(r[2])}
      <span class="muted">${escapeHtml(r[3])} · ${r[5]} bells</span>
    </li>`).join('') || '<li class="muted none">No towers found</li>';
  ul.hidden = false;
  ul.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectRing(list[+li.dataset.i]);
    });
  });
}

const CUSTOM_RING = [0, 'Our Tower', '', '', '', 1, null, [['1', 220.462, 0, 'A', 100 / 2.54]]];

function defaultTitle(r) {
  return r === CUSTOM_RING ? 'The Bells of Our Tower' : `The ${r[5]} Bells of ${r[1]}`;
}

function selectRing(r, fromShare = false) {
  state.ring = r;
  if (!fromShare) track(r === CUSTOM_RING ? 'tower: custom' : `tower: ${towerLabel(r)} · ${r[3]}`, `Dove ${r[0]}`);
  history.replaceState(null, '', `?ring=${r === CUSTOM_RING ? 'custom' : r[0]}`);
  $('tower-results').hidden = true;
  $('tower-search').value = r === CUSTOM_RING ? '' : towerLabel(r);
  const ringSize = r[5];
  state.bells = r[7].map(([role, lbs, approx, note, diam]) => ({
    role,
    name: defaultBellName(role, ringSize),
    kg: lbs ? lbs * LB_TO_KG : null,
    approx: !!approx,
    note,
    diamIn: diam,
    included: isMainBell(role, ringSize),
    itemId: null,
    added: r === CUSTOM_RING,
  }));
  state.title = defaultTitle(r);
  state.subtitle = '';
  $('title').value = state.title;
  $('subtitle').value = state.subtitle;
  $('tower-status').textContent = r === CUSTOM_RING
    ? 'Custom tower: the example bell below is yours to change. Add as many bells as you need.'
    : `${r[3]}, ${r[4]} · tenor ${fmtCwt(r[6] * LB_TO_KG)} (${fmtKg(r[6] * LB_TO_KG)})`;
  ['step-bells', 'step-style', 'step-export'].forEach((id) => { $(id).hidden = false; });
  suggestAll();
  renderBellList();
  renderPoster();
}

function updateTitleCount() {
  const n = state.bells.filter((b) => b.included).length;
  state.title = state.title.replace(/^The (\d+ )?Bells/, n > 1 ? `The ${n} Bells` : 'The Bells');
  $('title').value = state.title;
}

function syncColumnChecks() {
  COLUMNS.forEach((c) => { $(`col-${c.key}`).checked = state.show[c.key]; });
}

function diamValue(inches) {
  if (inches == null) return '';
  return state.diamUnits === 'in' ? +inches.toFixed(1) : (inches * IN_TO_CM).toFixed(1);
}

function renderBellList() {
  const el = $('bell-list');
  $('h-diam').textContent = state.diamUnits === 'in' ? 'in' : 'cm';
  el.innerHTML = state.bells.map((b, i) => {
    const item = itemById(b.itemId);
    const label = escapeHtml(b.name || `bell ${i + 1}`);
    return `
    <div class="bell-row ${b.included ? '' : 'off'}" data-i="${i}">
      <input type="checkbox" class="inc" ${b.included ? 'checked' : ''} aria-label="Include ${label}" title="Show this bell on the poster">
      <input type="text" class="name" value="${escapeHtml(b.name)}" placeholder="Name" aria-label="Name of ${label}">
      <label class="note-cell"><span class="mini">Note</span>
        <input type="text" class="note-in" value="${escapeHtml(b.note || '')}" placeholder="Note" maxlength="4" aria-label="Note of ${label}" title="Note">
      </label>
      <label class="kg" title="Weight in kg${b.approx ? ' (approximate in Dove)' : ''}"><span class="mini">kg</span>
        <input type="number" class="kg-in" min="0" step="0.1" value="${b.kg != null ? b.kg.toFixed(1) : ''}" placeholder="?" aria-label="Weight of ${label} in kg">
      </label>
      <label class="diam" title="Diameter in ${state.diamUnits === 'in' ? 'inches' : 'cm'}"><span class="mini">${state.diamUnits === 'in' ? 'in' : 'cm'}</span>
        <input type="number" class="diam-in" min="0" step="0.1" value="${diamValue(b.diamIn)}" placeholder="?" aria-label="Diameter of ${label} in ${state.diamUnits === 'in' ? 'inches' : 'cm'}">
      </label>
      <button type="button" class="item-btn" ${b.included && b.kg ? '' : 'disabled'} title="Change item">
        ${item ? itemThumb(item) : ''}<span>${item ? escapeHtml(item.name) : b.kg ? 'Pick…' : 'Add a weight first'}</span>
      </button>
      <div class="row-end">
        ${b.added ? `<button type="button" class="remove" aria-label="Remove ${label}" title="Remove this bell">✕</button>` : ''}
        <button type="button" class="drag" aria-label="Move ${label} (drag, or use the arrow keys)" title="Drag to reorder">⠿</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.bell-row').forEach((row) => {
    const bell = state.bells[+row.dataset.i];
    row.querySelector('.inc').addEventListener('change', (e) => {
      bell.included = e.target.checked;
      if (bell.included && bell.kg && !bell.itemId) suggestAll(false, bell);
      updateTitleCount();
      renderBellList();
      renderPoster();
    });
    row.querySelector('.name').addEventListener('input', (e) => {
      bell.name = e.target.value;
      renderPoster();
    });
    row.querySelector('.note-in').addEventListener('input', (e) => {
      bell.note = e.target.value.trim();
      renderPoster();
    });
    row.querySelector('.kg-in').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      bell.kg = v > 0 ? v : null;
      if (bell.included && bell.kg && !bell.itemId) suggestAll(false, bell);
      renderBellList();
      renderPoster();
    });
    row.querySelector('.diam-in').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      bell.diamIn = v > 0 ? (state.diamUnits === 'in' ? v : v / IN_TO_CM) : null;
      renderPoster();
    });
    row.querySelector('.item-btn').addEventListener('click', () => openPicker(bell));
    row.querySelector('.remove')?.addEventListener('click', () => {
      state.bells.splice(state.bells.indexOf(bell), 1);
      updateTitleCount();
      renderBellList();
      renderPoster();
    });
    const handle = row.querySelector('.drag');
    handle.addEventListener('pointerdown', (e) => startDrag(e, row));
    handle.addEventListener('keydown', (e) => {
      const i = state.bells.indexOf(bell);
      const j = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : -1;
      if (j < 0 || j >= state.bells.length) return;
      e.preventDefault();
      [state.bells[i], state.bells[j]] = [state.bells[j], state.bells[i]];
      renderBellList();
      renderPoster();
      $('bell-list').children[j].querySelector('.drag').focus();
    });
  });
}

function startDrag(e, row) {
  if (e.button !== 0) return;
  e.preventDefault();
  const list = $('bell-list');
  row.classList.add('dragging');
  list.classList.add('is-dragging');
  const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
  const move = (ev) => {
    const next = row.nextElementSibling;
    const prev = row.previousElementSibling;
    if (next && ev.clientY > mid(next)) row.before(next);
    else if (prev && ev.clientY < mid(prev)) row.after(prev);
  };
  const end = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    list.classList.remove('is-dragging');
    const order = [...list.children].map((r) => state.bells[+r.dataset.i]);
    const changed = order.some((b, i) => b !== state.bells[i]);
    state.bells = order;
    renderBellList();
    if (changed) renderPoster();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
}

function addBell() {
  state.bells.push({
    role: `added-${Date.now().toString(36)}`,
    name: String(state.bells.length + 1),
    kg: null,
    note: '',
    diamIn: null,
    included: true,
    itemId: null,
    added: true,
  });
  updateTitleCount();
  renderBellList();
  renderPoster();
  $('bell-list').lastElementChild.querySelector('.kg-in').focus();
}

function startCustom() {
  selectRing(CUSTOM_RING);
}

function thumbSrc(item) {
  return item.custom ? item.image : item.image.replace(/^images\/(.*)\.\w+$/, 'images/thumbs/$1.webp');
}

function itemThumb(item, cls = 'thumb') {
  return item.image
    ? `<img class="${cls}" src="${escapeHtml(thumbSrc(item))}" alt="" loading="lazy">`
    : `<span class="${cls}"></span>`;
}

const fullLoaded = new Set();
const fullLoading = new Set();

function loadFullImage(src) {
  if (fullLoading.has(src)) return;
  fullLoading.add(src);
  const img = new Image();
  img.onload = () => {
    fullLoaded.add(src);
    for (const el of document.querySelectorAll('.p-img[data-full]')) {
      if (el.dataset.full === src) el.style.backgroundImage = `url('${src}')`;
    }
  };
  img.src = src;
}

function posterImage(item) {
  if (!item.image) return '';
  const ready = item.custom || fullLoaded.has(item.image);
  if (!ready) loadFullImage(item.image);
  const src = ready ? item.image : thumbSrc(item);
  return `<div class="p-img" data-full="${escapeHtml(item.image)}" style="background-image:url('${escapeHtml(src)}')" role="img" aria-label="${escapeHtml(item.name)}"></div>`;
}

function openPicker(bell) {
  state.pickingBell = bell;
  $('picker-title').textContent = `${bell.name} · ${fmtKg(bell.kg)}`;
  $('picker-filter').value = '';
  $('custom-form').hidden = true;
  $('custom-form').reset();
  renderPicker();
  $('picker').showModal();
  $('picker-grid').querySelector('.pick.current')?.scrollIntoView({ block: 'center' });
}

function renderPicker() {
  const bell = state.pickingBell;
  const q = $('picker-filter').value.trim().toLowerCase();
  const usedOn = {};
  state.bells.forEach((b, i) => {
    if (b !== bell && b.included && b.itemId) usedOn[b.itemId] = b.name.replace(/\s*\(.*\)\s*$/, '') || String(i + 1);
  });
  const matches = (item) => !q || item.name.toLowerCase().includes(q);
  const list = [
    ...state.customItems.filter(matches).map((item) => ({ item })),
    ...rankedItems(bell.kg).filter((r) => matches(r.item)).sort((a, b) => b.item.kg - a.item.kg),
  ];
  $('picker-grid').innerHTML = `
    <button type="button" class="pick add-own" id="add-own">
      <span class="pick-img plus">+</span>
      <span class="pick-name">Add your own item</span>
    </button>` + list.map(({ item }) => {
    const pct = Math.round((item.kg / bell.kg - 1) * 100);
    const diff = item.custom ? '' : `<span class="diff ${Math.abs(pct) <= 30 ? 'close' : ''}">${pct > 0 ? '+' : ''}${pct}%</span>`;
    return `
    <button type="button" class="pick ${item.id === bell.itemId ? 'current' : item.id in usedOn ? 'used' : ''}" data-id="${item.id}">
      ${itemThumb(item, 'pick-img')}
      <span class="pick-name">${escapeHtml(item.name)}</span>
      <span class="pick-meta">${item.custom ? 'Your item' : fmtKg(item.kg)} ${diff}</span>
      ${item.id === bell.itemId ? '<span class="tag">Current choice</span>'
        : item.id in usedOn ? `<span class="tag">Already used (${escapeHtml(usedOn[item.id])})</span>` : ''}
    </button>`;
  }).join('');
  $('add-own').addEventListener('click', () => {
    $('custom-form').hidden = false;
    $('custom-name').focus();
  });
  $('picker-grid').querySelectorAll('.pick[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      bell.itemId = btn.dataset.id;
      $('picker').close();
      renderBellList();
      renderPoster();
    });
  });
}

function loadCustomItems() {
  try {
    state.customItems = JSON.parse(localStorage.getItem(CUSTOM_KEY)) || [];
  } catch {
    state.customItems = [];
  }
}

function saveCustomItems() {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(state.customItems.filter((i) => !i.fromLink)));
  } catch {
  }
}

// Shrink an uploaded picture so it fits in browser storage and share links
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, CUSTOM_IMG_SIZE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/webp', 0.8));
    };
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = URL.createObjectURL(file);
  });
}

async function addCustomItem(e) {
  e.preventDefault();
  const name = $('custom-name').value.trim();
  const file = $('custom-image').files[0];
  if (!name || !file) return;
  try {
    const item = { id: `custom-${Date.now().toString(36)}`, name, image: await readImageFile(file), custom: true };
    state.customItems.unshift(item);
    saveCustomItems();
    state.pickingBell.itemId = item.id;
    $('picker').close();
    renderBellList();
    renderPoster();
  } catch (err) {
    alert(err.message);
  }
}

// The poster is stored in the URL hash as #p=<base64url(deflate(bytes))>, where
// bytes = 4-byte JSON length + JSON + any custom pictures as raw WebP.
// Only settings that differ from a freshly picked tower are stored:
//   r      Dove ring id (0 = custom tower)
//   i      item id per bell
//   t s    title, subtitle
//   u d c  weight units, diameter units, colour index
//   o n    'l' for landscape, number of pages
//   cl     shown columns in COLUMNS order, e.g. "0101"
//   ta ha  1 = repeat title / headings on every page
//   b      { index: [included, name, kg, note] } edits to the towers own bells
//   B      [[doveRole or '', included, name, kg, note, diameter]] the whole list,
//          once bells have been reordered, added or removed
//   x      [[id, name, byteLength]] custom pictures that follow the JSON

const SHARE_IMG_SIZE = 128;

function toBase64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipeThrough(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// A freshly selected tower's bells and title, to compare against
function ringDefaults(r) {
  const ringSize = r[5];
  return {
    title: defaultTitle(r),
    bells: r[7].map(([role, lbs, , note]) => ({
      role,
      name: defaultBellName(role, ringSize),
      kg: lbs ? +(lbs * LB_TO_KG).toFixed(2) : null,
      note: note || '',
      included: isMainBell(role, ringSize),
    })),
  };
}

// Re-encode a picture small enough for a link
function shrinkDataUrl(dataUrl, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, size / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => blob.arrayBuffer().then((b) => resolve(new Uint8Array(b))), 'image/webp', 0.6);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function bytesToDataUrl(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  // WebP, or PNG from browsers that can't write WebP
  const type = bytes[0] === 0x89 ? 'image/png' : 'image/webp';
  return `data:${type};base64,${btoa(bin)}`;
}

async function encodeState() {
  const def = ringDefaults(state.ring);
  const data = { r: state.ring[0], i: state.bells.map((b) => (b.included ? b.itemId : 0)) };
  if (state.title !== def.title) data.t = state.title;
  if (state.subtitle) data.s = state.subtitle;
  if (state.units !== 'kg') data.u = state.units;
  if (state.diamUnits !== 'cm') data.d = state.diamUnits;
  if (state.theme !== THEMES[0]) data.c = THEMES.indexOf(state.theme);
  if (state.orientation !== 'portrait') data.o = 'l';
  if (state.pages > 1) data.n = state.pages;
  const cols = COLUMNS.map((c) => (state.show[c.key] ? 1 : 0)).join('');
  if (cols !== DEFAULT_COLS) data.cl = cols;
  if (state.titleAll) data.ta = 1;
  if (state.headAll) data.ha = 1;
  const kgOf = (b) => (b.kg == null ? null : +b.kg.toFixed(2));
  const sameBells = state.bells.length === def.bells.length && state.bells.every((b, i) => b.role === def.bells[i].role);
  if (sameBells) {
    // Only the edits to the tower's own bells
    state.bells.forEach((b, i) => {
      const d = def.bells[i];
      if (b.included !== d.included || b.name !== d.name || kgOf(b) !== d.kg || (b.note || '') !== d.note) {
        (data.b ||= {})[i] = [b.included ? 1 : 0, b.name, kgOf(b), b.note || ''];
      }
    });
  } else {
    // Reordered, added or removed bells: store the whole list.
    // A tower bell keeps its Dove role (so its diameter comes back); an added one sends ''.
    data.B = state.bells.map((b) => [b.added ? '' : b.role, b.included ? 1 : 0, b.name, kgOf(b), b.note || '', b.added ? b.diamIn ?? null : null]);
  }
  const pictures = [];
  const usedIds = new Set(data.i);
  for (const item of state.customItems.filter((c) => usedIds.has(c.id))) {
    const bytes = await shrinkDataUrl(item.image, SHARE_IMG_SIZE);
    pictures.push(bytes);
    (data.x ||= []).push([item.id, item.name, bytes.length]);
  }
  const json = new TextEncoder().encode(JSON.stringify(data));
  const out = new Uint8Array(4 + json.length + pictures.reduce((n, p) => n + p.length, 0));
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let at = 4 + json.length;
  for (const p of pictures) { out.set(p, at); at += p.length; }
  return toBase64Url(await pipeThrough(out, new CompressionStream('deflate-raw')));
}

async function decodeState(s) {
  const bytes = await pipeThrough(fromBase64Url(s), new DecompressionStream('deflate-raw'));
  const len = new DataView(bytes.buffer).getUint32(0);
  const data = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
  let at = 4 + len;
  data.x = (data.x || []).map(([id, name, size]) => {
    const image = bytesToDataUrl(bytes.subarray(at, at + size));
    at += size;
    return { id, name, image };
  });
  return data;
}

function applyState(data) {
  const ring = data.r === 0 ? CUSTOM_RING : state.rings.find((r) => r[0] === data.r);
  if (!ring) return false;
  for (const item of data.x) {
    if (!itemById(item.id)) state.customItems.push({ ...item, custom: true, fromLink: true });
  }
  selectRing(ring, true);
  Object.entries(data.b || {}).forEach(([i, [included, name, kg, note]]) => {
    if (state.bells[i]) Object.assign(state.bells[i], { included: !!included, name, kg, ...(note !== undefined && { note }) });
  });
  if (data.B) {
    const towerBells = new Map(state.bells.map((b) => [b.role, b]));
    state.bells = data.B.map(([role, included, name, kg, note, diamIn], i) => {
      const own = role && ring !== CUSTOM_RING && towerBells.get(role);
      return own
        ? { ...own, included: !!included, name, kg, note, itemId: null }
        : { role: `added-${i}`, name, kg, note, diamIn: diamIn ?? null, included: !!included, itemId: null, added: true };
    });
  }
  (data.i || []).forEach((itemId, i) => {
    if (state.bells[i] && itemId && itemById(itemId)) state.bells[i].itemId = itemId;
  });
  state.title = data.t ?? state.title;
  state.subtitle = data.s ?? '';
  state.units = data.u || 'kg';
  state.diamUnits = data.d === 'in' ? 'in' : 'cm';
  state.theme = THEMES[data.c] || THEMES[0];
  state.orientation = data.o === 'l' ? 'landscape' : 'portrait';
  state.pages = data.n || 1;
  const cl = data.cl || DEFAULT_COLS;
  COLUMNS.forEach((c, i) => { state.show[c.key] = cl[i] === '1'; });
  syncColumnChecks();
  state.titleAll = data.ta === 1;
  state.headAll = data.ha === 1;
  $('orientation').value = state.orientation;
  $('pages').value = String(state.pages);
  $('page-options').hidden = state.pages < 2;
  $('title-all').checked = state.titleAll;
  $('head-all').checked = state.headAll;
  $('title').value = state.title;
  $('subtitle').value = state.subtitle;
  $('units').value = state.units;
  $('diam-units').value = state.diamUnits;
  $('swatches').querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', THEMES[+s.dataset.i] === state.theme));
  renderBellList();
  renderPoster();
  return true;
}

async function share() {
  track('share link made');
  const btn = $('share');
  try {
    const url = `${location.href.split(/[?#]/)[0]}?ring=${state.ring === CUSTOM_RING ? 'custom' : state.ring[0]}#p=${await encodeState()}`;
    history.replaceState(null, '', url);
    $('share-url').value = url;
    $('share-box').hidden = false;
    $('share-url').select();
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Link copied!';
    } catch {
      btn.textContent = 'Copy the link below';
    }
  } catch (err) {
    alert(`Sorry, the link couldn't be made: ${err.message}`);
  }
  setTimeout(() => { btn.textContent = 'Copy share link'; }, 2500);
}

// Split the bells into `pages` groups as evenly as possible, keeping bell order
function splitBells(bells, pages) {
  const n = Math.max(1, Math.min(pages, bells.length));
  const groups = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.ceil((bells.length - start) / (n - i));
    groups.push(bells.slice(start, start + size));
    start += size;
  }
  return groups;
}

function posterPage(bells, first, startIndex = 0) {
  const title = first || state.titleAll;
  const head = first || state.headAll;
  const cols = COLUMNS.filter((c) => state.show[c.key]);
  const widths = ['1.3fr', ...cols.map((c) => `${c.width}fr`)].join(' ');
  return `
    <div class="poster ${state.orientation} ${title ? '' : 'no-title'} ${head ? '' : 'no-head'}" style="--rows:${bells.length}; --cols:${widths}; --main:${state.theme.main}; --light:${state.theme.light}">
      ${title ? `<h1 class="p-title">${escapeHtml(state.title)}</h1>
      ${state.subtitle ? `<p class="p-subtitle">${escapeHtml(state.subtitle)}</p>` : ''}` : ''}
      <div class="p-table">
        ${head ? `<div class="p-row p-head">
          <div>Bell</div>${cols.map((c) => `<div class="${c.cls || ''}">${c.head}</div>`).join('')}
        </div>` : ''}
        ${bells.map((b, i) => `
          <div class="p-row ${(startIndex + i) % 2 ? 'band' : ''}">
            <div class="p-bell">${escapeHtml(b.name).replace(/ \(/, '<br>(')}</div>
            ${cols.map((c) => `<div class="${c.cls || ''}">${c.cell(b)}</div>`).join('')}
          </div>`).join('')}
      </div>
      <p class="p-credit">Bell Weight Posters | weights.lucasw.uk | Data: Dove's Guide</p>
    </div>`;
}

// Shrink any cell text that doesn't fit its row. "1 (Treble)" is normally split
// over two lines; if the row is too short for that it goes back on one.
function fitPosterText() {
  document.querySelectorAll('#posters .p-row:not(.p-head)').forEach((row) => {
    const h = row.clientHeight;
    row.querySelectorAll(':scope > div').forEach((cell) => {
      if (cell.classList.contains('p-bell') && cell.scrollHeight > h) {
        cell.innerHTML = cell.innerHTML.replace('<br>', ' ');
        cell.style.whiteSpace = 'nowrap';
      }
      let size = parseFloat(getComputedStyle(cell).fontSize);
      for (let i = 0; i < 30 && size > 8 && (cell.scrollHeight > h || cell.scrollWidth > cell.clientWidth + 1); i++) {
        size -= 1;
        cell.style.fontSize = `${size}px`;
      }
    });
  });
}

function renderPoster() {
  const posters = $('posters');
  // The printed page size has to be set with @page, which can't be done per element
  $('page-size').textContent = `@page { size: A4 ${state.orientation}; margin: 0; }`;
  const bells = state.bells.filter((b) => b.included);
  if (!state.ring || !bells.length) {
    posters.innerHTML = `<div class="poster ${state.orientation}"><div class="poster-empty">${state.ring ? 'Tick at least one bell.' : 'Select a tower to start your poster.'}</div></div>`;
  } else {
    let start = 0;
    posters.innerHTML = splitBells(bells, state.pages).map((group, i) => {
      const html = posterPage(group, i === 0, start);
      start += group.length;
      return html;
    }).join('');
    fitPosterText();
  }
  fitPreview();
}

// Scale the A4 pages down to fit the preview column
function fitPreview() {
  const frame = $('poster-frame');
  const posters = $('posters');
  frame.style.maxWidth = '';
  const scale = Math.min(1, frame.clientWidth / posters.offsetWidth);
  posters.style.transform = `scale(${scale})`;
  frame.style.height = `${posters.offsetHeight * scale}px`;
  // Centre the pages when there's room to spare
  frame.style.maxWidth = `${posters.offsetWidth * scale}px`;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('it took too long')), ms)),
  ]);
}

// html2canvas draws CSS background pictures at 1x and then enlarges the whole
// canvas, so they come out blocky with stray lines at their edges. For the
// export, each poster picture becomes an <img>, which it draws at full
// resolution, sized by hand since it also ignores object-fit.
async function exportPictures(page) {
  return Promise.all([...page.querySelectorAll('.p-img')].map(async (el) => {
    const img = new Image();
    img.src = el.dataset.full;
    await img.decode();
    const s = Math.min(el.clientWidth / img.naturalWidth, el.clientHeight / img.naturalHeight);
    return { src: img.src, w: img.naturalWidth * s, h: img.naturalHeight * s };
  }));
}

function swapInPictures(doc, pageIndex, pictures) {
  const els = doc.querySelectorAll('#posters .poster')[pageIndex].querySelectorAll('.p-img');
  els.forEach((el, i) => {
    const { src, w, h } = pictures[i];
    Object.assign(el.style, { backgroundImage: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' });
    const img = doc.createElement('img');
    img.src = src;
    Object.assign(img.style, { width: `${w}px`, height: `${h}px`, maxWidth: 'none', flex: 'none' });
    el.append(img);
  });
}

async function downloadImage() {
  const btn = $('download');
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const pages = [...$('posters').querySelectorAll('.poster')];
    const base = state.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'bell-poster';
    const files = [];
    for (const [i, page] of pages.entries()) {
      // iOS Safari runs out of canvas memory on big images, so phones get ~4 MP
      const maxPixels = IS_TOUCH ? 4e6 : 12e6;
      const scale = Math.min(3, Math.sqrt(maxPixels / (page.offsetWidth * page.offsetHeight)));
      const pictures = await exportPictures(page);
      const canvas = await withTimeout(html2canvas(page, {
        scale,
        backgroundColor: '#ffffff',
        // Only clone this page; otherwise html2canvas waits on every lazy picker thumbnail
        ignoreElements: (el) => !el.closest('head') && !(el.contains(page) || page.contains(el)),
        imageTimeout: 8000,
        onclone: (doc) => {
          doc.getElementById('posters').style.transform = 'none';
          swapInPictures(doc, i, pictures);
        },
      }), 30000);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('the image was too big for this browser');
      const name = pages.length > 1 ? `${base}-${i + 1}-of-${pages.length}.png` : `${base}.png`;
      files.push(new File([blob], name, { type: 'image/png' }));
    }
    // iOS ignores download links, so use the share sheet ("Save Image") there
    if (IS_TOUCH && navigator.canShare?.({ files })) {
      await navigator.share({ files }).catch((e) => { if (e.name !== 'AbortError') throw e; });
    } else {
      for (const file of files) {
        const a = document.createElement('a');
        a.download = file.name;
        a.href = URL.createObjectURL(file);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      }
    }
  } catch (err) {
    // Browsers won't export a canvas containing local files when the page is opened from disk
    alert(location.protocol === 'file:'
      ? 'Downloading an image only works once the site is online (e.g. on GitHub Pages). For now, use "Print / Save as PDF".'
      : `Sorry, the image couldn't be made (${err.message}). "Print / Save as PDF" should still work.`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download as image';
  }
}

function initControls() {
  const search = $('tower-search');
  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (q.length < 2) { $('tower-results').hidden = true; return; }
    renderResults(searchTowers(q));
  });
  search.addEventListener('focus', () => { if (search.value.trim().length >= 2) renderResults(searchTowers(search.value)); });
  search.addEventListener('blur', () => { $('tower-results').hidden = true; });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = searchTowers(search.value)[0];
      if (first) selectRing(first);
    }
  });

  $('title').addEventListener('input', (e) => { state.title = e.target.value; renderPoster(); });
  $('subtitle').addEventListener('input', (e) => { state.subtitle = e.target.value; renderPoster(); });
  $('units').addEventListener('change', (e) => { state.units = e.target.value; renderPoster(); });
  $('diam-units').addEventListener('change', (e) => { state.diamUnits = e.target.value; renderBellList(); renderPoster(); });
  COLUMNS.forEach((c) => {
    $(`col-${c.key}`).addEventListener('change', (e) => { state.show[c.key] = e.target.checked; renderPoster(); });
  });
  syncColumnChecks();
  $('orientation').addEventListener('change', (e) => { state.orientation = e.target.value; renderPoster(); });
  $('pages').addEventListener('change', (e) => {
    state.pages = +e.target.value;
    $('page-options').hidden = state.pages < 2;
    renderPoster();
  });
  $('title-all').addEventListener('change', (e) => { state.titleAll = e.target.checked; renderPoster(); });
  $('head-all').addEventListener('change', (e) => { state.headAll = e.target.checked; renderPoster(); });
  $('add-bell').addEventListener('click', addBell);
  $('reshuffle').addEventListener('click', () => { suggestAll(true); renderBellList(); renderPoster(); });
  closeOnBackdrop($('picker'));
  closeOnBackdrop($('changelog'));
  $('version').addEventListener('click', showChangelog);
  $('picker-filter').addEventListener('input', renderPicker);
  $('custom-form').addEventListener('submit', addCustomItem);
  $('custom-cancel').addEventListener('click', () => {
    $('custom-form').reset();
    $('custom-form').hidden = true;
  });
  $('custom-email').textContent = SUBMIT_EMAIL;
  $('custom-email').href = `mailto:${SUBMIT_EMAIL}?subject=${encodeURIComponent('Bell Weight Posters image')}`;
  $('share').addEventListener('click', share);
  $('print').addEventListener('click', () => { track('export: print'); window.print(); });
  $('download').addEventListener('click', () => { track('export: image'); downloadImage(); });
  window.addEventListener('resize', fitPreview);
  const setFull = (on) => {
    $('preview').classList.toggle('full', on);
    document.body.classList.toggle('no-scroll', on);
    fitPreview();
  };
  $('preview-full').addEventListener('click', () => setFull(true));
  $('preview-close').addEventListener('click', () => setFull(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setFull(false); });

  $('swatches').innerHTML = THEMES.map((t, i) => `
    <button type="button" class="swatch ${i === 0 ? 'on' : ''}" data-i="${i}" style="background:${t.main}" aria-label="${t.name}" title="${t.name}"></button>`).join('');
  $('swatches').querySelectorAll('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.theme = THEMES[+btn.dataset.i];
      $('swatches').querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s === btn));
      renderPoster();
    });
  });
}

// Clicking the dimmed area outside a dialog closes it. Both the press and the
// release must be outside, so dragging out of a text box doesn't.
function closeOnBackdrop(dialog) {
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
  dialog.addEventListener('click', (e) => {
    if (pressedOutside && outside(e)) dialog.close();
  });
}

function showChangelog() {
  const fmt = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('changelog-list').innerHTML = CHANGELOG.map((v) => `
    <section>
      <h3>v${v.version}<time datetime="${v.date}">${fmt(v.date)}</time></h3>
      <ul>${v.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
    </section>`).join('');
  $('changelog').showModal();
}

async function init() {
  // document.lastModified is when the page was last deployed
  $('version').textContent = `v${VERSION} ${new Date(document.lastModified).getFullYear()}`;
  initControls();
  fitPreview();
  if (!window.RINGS || !window.ITEMS) {
    $('tower-status').textContent = "Couldn't load the tower or item data. Check data/rings.js and data/items.js.";
    return;
  }
  state.rings = window.RINGS;
  for (const r of state.rings) {
    if (r[7].some((b) => parseRole(b[0]).kind !== 'ring')) r[7] = sortRingBells(r[7]);
  }
  state.items = window.ITEMS;
  loadCustomItems();
  $('tower-status').innerHTML = `${state.rings.length.toLocaleString()} rings to choose from or <button type="button" class="link inline" id="go-custom">go custom</button>.`;
  $('go-custom').addEventListener('click', startCustom);

  // A share link (#p=...) restores the whole poster; ?ring=... just picks the tower
  const shared = location.hash.match(/^#p=([\w-]+)/);
  if (shared) {
    track('share link opened');
    const href = location.href;
    try {
      if (applyState(await decodeState(shared[1]))) {
        history.replaceState(null, '', href);
        return;
      }
    } catch {
      alert("Sorry, that share link looks damaged, so it couldn't be opened.");
    }
  }
  const ringParam = new URLSearchParams(location.search).get('ring');
  if (ringParam === 'custom') return startCustom();
  const linked = state.rings.find((r) => String(r[0]) === ringParam);
  if (linked) selectRing(linked);
}

init();
