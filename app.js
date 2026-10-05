import { db, uid, exportAll, importAll, STORES } from './db.js';
import { recognizeLabel } from './label.js';
import { cloud, SYNC_STORES } from './sync.js';

// ---------- Konstanten ----------

const TYPES = {
  rot: { label: 'Rotwein', color: '#8b1e3f' },
  weiss: { label: 'Weisswein', color: '#d4bc4a' },
  rose: { label: 'Rosé', color: '#e98aa0' },
  schaum: { label: 'Schaumwein', color: '#bfa95e' },
  suess: { label: 'Süsswein', color: '#d08a2e' },
  likoer: { label: 'Likörwein', color: '#5e2418' },
};

const COUNTRIES = ['Schweiz', 'Deutschland', 'Österreich', 'Frankreich', 'Italien', 'Spanien', 'Portugal',
  'USA', 'Argentinien', 'Chile', 'Südafrika', 'Australien', 'Neuseeland', 'Griechenland', 'Ungarn'];
const GRAPES = ['Pinot Noir', 'Chasselas', 'Merlot', 'Cabernet Sauvignon', 'Syrah', 'Nebbiolo', 'Sangiovese',
  'Tempranillo', 'Grenache', 'Riesling', 'Chardonnay', 'Sauvignon Blanc', 'Grüner Veltliner', 'Gamay',
  'Petite Arvine', 'Cornalin', 'Humagne Rouge', 'Müller-Thurgau', 'Blaufränkisch', 'Zweigelt', 'Malbec'];

const TEXT_FIELDS = ['name', 'producer', 'type', 'country', 'region', 'grapes', 'purchaseDate', 'purchasePlace',
  'description', 'foodPairing', 'notes'];
const NUM_FIELDS = ['vintage', 'alcohol', 'quantity', 'price', 'drinkFrom', 'drinkUntil', 'rating'];

const SORTS = {
  neu: ['Zuletzt hinzugefügt', (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')],
  name: ['Name', (a, b) => (a.name || '').localeCompare(b.name || '', 'de')],
  jahrgang: ['Jahrgang', (a, b) => (a.vintage || 9999) - (b.vintage || 9999)],
  bewertung: ['Bewertung', (a, b) => (b.rating || 0) - (a.rating || 0)],
  trinkreife: ['Trinkreife', (a, b) => (a.drinkUntil || 9999) - (b.drinkUntil || 9999)],
  preis: ['Preis', (a, b) => (b.price || 0) - (a.price || 0)],
  bestand: ['Bestand', (a, b) => (b.quantity || 0) - (a.quantity || 0)],
};

// ---------- Zustand ----------

const state = {
  wines: [], racks: [], tastings: [], shopping: [],
  settings: { currency: 'CHF', apiKey: '' },
  filter: { q: '', type: 'alle', sort: 'neu', showEmpty: false },
  placing: null,   // Wein-ID, die gerade im Regal platziert wird
  draft: null,     // neues Foto im Formular
  prefill: null,   // Vorbelegung des Formulars (z.B. aus Einkaufsliste)
  lastHash: null,
  user: null,      // angemeldeter Benutzer (nur im Cloud-Modus)
  authMode: 'login',
  authInfo: '',
};

async function load() {
  const [wines, racks, tastings, shopping, settings] = await Promise.all(STORES.map(s => db.all(s)));
  Object.assign(state, { wines, racks, tastings, shopping });
  for (const s of settings) state.settings[s.id] = s.value;
}

function putState(store, item) {
  const list = state[store];
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}

async function save(store, item) {
  item.updatedAt = new Date().toISOString();
  await db.put(store, item);
  putState(store, item);
  if (state.user) await cloud.enqueue(store, item.id);
  return item;
}

async function remove(store, id) {
  await db.delete(store, id);
  state[store] = state[store].filter(x => x.id !== id);
  if (state.user) await cloud.enqueue(store, id, true);
}

async function setSetting(id, value) {
  state.settings[id] = value;
  await db.put('settings', { id, value });
}

// ---------- Hilfsfunktionen ----------

const $ = sel => document.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
const today = () => new Date().toISOString().slice(0, 10);
const thisYear = () => new Date().getFullYear();
const wineById = id => state.wines.find(w => w.id === id);

function fmtMoney(v) {
  if (v == null) return '–';
  try {
    return new Intl.NumberFormat('de-CH', { style: 'currency', currency: state.settings.currency || 'CHF' }).format(v);
  } catch {
    return `${v.toFixed(2)} ${state.settings.currency}`;
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function drinkStatus(w) {
  const y = thisYear();
  const from = w.drinkFrom, until = w.drinkUntil;
  if (!from && !until) return null;
  if (until && y > until) return { key: 'over', label: 'Überfällig' };
  if (from && y < from) return { key: 'wait', label: `Ab ${from}` };
  if (until && y >= until - 1) return { key: 'soon', label: 'Bald trinken' };
  return { key: 'ready', label: 'Trinkreif' };
}

function slotsOf(wineId) {
  const out = [];
  for (const r of state.racks) {
    for (const [key, id] of Object.entries(r.slots || {})) if (id === wineId) out.push({ rack: r, key });
  }
  return out;
}

const unplaced = w => Math.max(0, (w.quantity || 0) - slotsOf(w.id).length);
const slotLabel = key => { const [r, c] = key.split('-').map(Number); return `${String.fromCharCode(65 + r)}${c + 1}`; };

// Entfernt Fächer, wenn mehr Flaschen platziert sind als vorhanden.
async function trimSlots(w, preferKey) {
  let slots = slotsOf(w.id);
  let excess = slots.length - (w.quantity || 0);
  if (preferKey && excess > 0) {
    const [rackId, key] = preferKey.split('|');
    slots.sort((a, b) => (b.rack.id === rackId && b.key === key) - (a.rack.id === rackId && a.key === key));
  }
  const touched = new Set();
  for (const s of slots) {
    if (excess-- <= 0) break;
    delete s.rack.slots[s.key];
    touched.add(s.rack);
  }
  for (const r of touched) await save('racks', r);
}

function stars(value, { size = '', action = '' } = {}) {
  const v = value || 0;
  let html = `<span class="stars ${size}">`;
  for (let i = 1; i <= 5; i++) {
    const cls = v >= i ? 'full' : v >= i - 0.5 ? 'half' : '';
    html += action
      ? `<button type="button" class="star ${cls}" data-action="${action}" data-value="${i}" aria-label="${i} Sterne">★</button>`
      : `<span class="star ${cls}">★</span>`;
  }
  return html + '</span>';
}

function starInput(name, value) {
  return `<div class="star-input" data-name="${name}">
    <input type="hidden" name="${name}" value="${value ?? ''}">
    ${stars(value, { size: 'lg', action: 'star-input' })}
  </div>`;
}

function bottleSvg(type) {
  const color = TYPES[type]?.color || '#888';
  return `<svg viewBox="0 0 40 100" class="bottle" aria-hidden="true">
    <path d="M16 2h8v22c0 4 9 8 9 20v50a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V44c0-12 9-16 9-20z" fill="${color}"/>
    <rect x="9" y="52" width="22" height="22" rx="2" fill="#fff" opacity=".85"/>
    <rect x="15" y="2" width="10" height="7" rx="1" fill="#2b1a12" opacity=".7"/>
  </svg>`;
}

const thumb = w => (w.thumb ? `<img src="${w.thumb}" alt="">` : bottleSvg(w.type));

function typeChip(type) {
  const t = TYPES[type];
  return t ? `<span class="type-chip"><i style="background:${t.color}"></i>${t.label}</span>` : '';
}

function statusChip(w) {
  const s = drinkStatus(w);
  return s ? `<span class="status status-${s.key}">${s.label}</span>` : '';
}

async function compressImage(file, maxSize, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Bild konnte nicht geladen werden.'));
      i.src = url;
    });
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Fotos liegen im Cloud-Speicher und werden erst bei Bedarf geladen
const loadingPhotos = new Set();
async function loadPhoto(id) {
  const w = wineById(id);
  if (!w?.photoId || w.photo || loadingPhotos.has(id)) return;
  loadingPhotos.add(id);
  try {
    const photo = await cloud.downloadPhoto(w.photoId);
    const fresh = await db.get('wines', id);
    if (!fresh || fresh.photoId !== w.photoId) return;
    Object.assign(fresh, { photo, photoUploaded: true });
    await db.put('wines', fresh);
    putState('wines', fresh);
    const r = route();
    if (r.view === 'wein' && r.id === id) render();
    if (r.view === 'bearbeiten' && r.id === id && !state.draft?.photo && !state.draft?.removePhoto) {
      const img = $('#photo-preview img');
      if (img) img.src = photo;
    }
  } catch (err) {
    console.warn('Foto konnte nicht geladen werden', err);
  } finally {
    loadingPhotos.delete(id);
  }
}

// ---------- Overlay: Sheet, Bestätigung, Toast ----------

let confirmResolve = null;

function openSheet(html) {
  const root = $('#sheet');
  root.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet-panel" role="dialog" aria-modal="true"><div class="sheet-handle"></div>${html}</div>`;
  root.classList.add('open');
  document.body.classList.add('no-scroll');
}

function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').innerHTML = '';
  document.body.classList.remove('no-scroll');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
}

function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    openSheet(`<p class="confirm-text">${message}</p>
      <div class="actions">
        <button class="btn" data-action="confirm-no">Abbrechen</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-yes">${esc(okLabel)}</button>
      </div>`);
    confirmResolve = resolve;
  });
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

// ---------- Router ----------

function route() {
  const [, view = 'keller', id] = location.hash.split('/');
  return { view: view || 'keller', id: id && decodeURIComponent(id) };
}

const TITLES = {
  keller: 'Mein Keller', wein: 'Wein', neu: 'Neuer Wein', bearbeiten: 'Wein bearbeiten',
  regale: 'Regale', regal: 'Regal', statistik: 'Statistik', einkauf: 'Einkaufsliste', einstellungen: 'Einstellungen',
};
const TAB_OF = { wein: 'keller', neu: 'neu', bearbeiten: 'keller', regal: 'regale', einstellungen: '' };
const SUBVIEWS = ['wein', 'neu', 'bearbeiten', 'regal', 'einstellungen'];

function render() {
  const needsLogin = cloud.enabled && !state.user;
  document.body.classList.toggle('auth-mode', needsLogin);
  if (needsLogin) {
    $('#view').innerHTML = views.login();
    $('#title').textContent = 'Weinkeller';
    $('#back').hidden = true;
    return;
  }
  const { view, id } = route();
  const changed = state.lastHash !== location.hash;
  if (changed && (view === 'neu' || view === 'bearbeiten')) state.draft = {};
  if (changed && view !== 'neu') state.prefill = null;
  state.lastHash = location.hash;

  const fn = views[view] || views.keller;
  $('#view').innerHTML = fn(id);
  $('#title').textContent = view === 'regal' ? (state.racks.find(r => r.id === id)?.name || 'Regal') : (TITLES[view] || TITLES.keller);
  $('#back').hidden = !SUBVIEWS.includes(view);
  const tab = TAB_OF[view] ?? view;
  document.querySelectorAll('.tabbar a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (changed) window.scrollTo(0, 0);
}

// ---------- Ansichten ----------

const views = {};

views.keller = () => {
  const f = state.filter;
  const chips = [['alle', 'Alle'], ['ready', 'Trinkreif'], ...Object.entries(TYPES).map(([k, t]) => [k, t.label])];
  return `
    <div class="toolbar">
      <input type="search" class="search" placeholder="Suche nach Wein, Weingut, Region, Rebsorte …" value="${esc(f.q)}" data-filter="q">
      <div class="chips">${chips.map(([k, l]) =>
        `<button class="chip ${f.type === k ? 'active' : ''}" data-action="filter-type" data-value="${k}">${l}</button>`).join('')}</div>
      <div class="row-between">
        <select data-filter="sort" aria-label="Sortierung">${Object.entries(SORTS).map(([k, [l]]) =>
          `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="toggle"><input type="checkbox" data-filter="showEmpty" ${f.showEmpty ? 'checked' : ''}> Ausgetrunkene zeigen</label>
      </div>
    </div>
    <div id="wine-list">${renderWineList()}</div>`;
};

function filteredWines() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  return state.wines
    .filter(w => f.showEmpty || (w.quantity || 0) > 0)
    .filter(w => f.type === 'alle' || (f.type === 'ready' ? ['ready', 'soon', 'over'].includes(drinkStatus(w)?.key) : w.type === f.type))
    .filter(w => !q || [w.name, w.producer, w.region, w.country, w.grapes, w.vintage, w.notes, w.purchasePlace]
      .some(v => String(v ?? '').toLowerCase().includes(q)))
    .sort(SORTS[f.sort]?.[1] || SORTS.neu[1]);
}

function renderWineList() {
  if (!state.wines.length) {
    return `<div class="empty">
      <div class="empty-icon">${bottleSvg('rot')}</div>
      <h2>Dein Keller ist noch leer</h2>
      <p>Fotografiere ein Etikett oder erfasse deinen ersten Wein von Hand.</p>
      <a class="btn btn-primary" href="#/neu">Ersten Wein hinzufügen</a>
      <button class="btn btn-link" data-action="load-demo">Beispieldaten laden</button>
    </div>`;
  }
  const list = filteredWines();
  const bottles = list.reduce((s, w) => s + (w.quantity || 0), 0);
  const value = list.reduce((s, w) => s + (w.quantity || 0) * (w.price || 0), 0);
  if (!list.length) return `<div class="empty small"><p>Keine Weine gefunden.</p></div>`;
  return `<div class="summary">${bottles} Flaschen · ${list.length} Weine · ${fmtMoney(value)}</div>
    <div class="wine-list">${list.map(wineCard).join('')}</div>`;
}

function wineCard(w) {
  const where = [w.region, w.country].filter(Boolean).join(', ');
  return `<a class="wine-card ${(w.quantity || 0) === 0 ? 'empty-stock' : ''}" href="#/wein/${encodeURIComponent(w.id)}">
    <div class="thumb">${thumb(w)}</div>
    <div class="info">
      ${w.producer ? `<div class="producer">${esc(w.producer)}</div>` : ''}
      <div class="name">${esc(w.name)} <span class="vintage">${w.vintage || 'NV'}</span></div>
      ${where ? `<div class="meta"><i class="dot" style="background:${TYPES[w.type]?.color || '#888'}"></i>${esc(where)}</div>` : ''}
      <div class="badges">${w.rating ? stars(w.rating, { size: 'sm' }) : ''}${statusChip(w)}</div>
    </div>
    <div class="qty"><b>${w.quantity || 0}</b><small>Fl.</small></div>
  </a>`;
}

views.wein = id => {
  const w = wineById(id);
  if (!w) return `<div class="empty"><p>Wein nicht gefunden.</p><a class="btn" href="#/keller">Zum Keller</a></div>`;
  const slots = slotsOf(w.id);
  const tastings = state.tastings.filter(t => t.wineId === w.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const info = [
    ['Land', w.country], ['Region', w.region], ['Rebsorte', w.grapes],
    ['Alkohol', w.alcohol ? `${w.alcohol} % vol.` : ''], ['Preis', w.price != null ? fmtMoney(w.price) : ''],
    ['Gekauft', fmtDate(w.purchaseDate)], ['Bezugsquelle', w.purchasePlace],
  ].filter(([, v]) => v);
  const free = unplaced(w);
  if (!w.photo && w.photoId && state.user) queueMicrotask(() => loadPhoto(w.id));

  return `<article class="detail">
    <div class="hero">
      <div class="hero-img">${w.photo || w.thumb ? `<img src="${w.photo || w.thumb}" alt="Etikett">` : bottleSvg(w.type)}</div>
      <div class="hero-info">
        ${w.producer ? `<div class="producer">${esc(w.producer)}</div>` : ''}
        <h1>${esc(w.name)} <span class="vintage">${w.vintage || 'NV'}</span></h1>
        <div class="chip-row">${typeChip(w.type)}${statusChip(w)}</div>
        <div class="my-rating">${stars(w.rating, { size: 'lg', action: 'rate' })}<small>Meine Bewertung</small></div>
      </div>
    </div>

    <div class="stock card">
      <div>
        <div class="stock-label">Bestand</div>
        <div class="stock-row">
          <button class="round" data-action="qty" data-delta="-1" aria-label="Eine Flasche weniger">−</button>
          <b class="stock-num">${w.quantity || 0}</b>
          <button class="round" data-action="qty" data-delta="1" aria-label="Eine Flasche mehr">+</button>
        </div>
      </div>
      <button class="btn btn-primary" data-action="drink" ${(w.quantity || 0) ? '' : 'disabled'}>🍷 Flasche öffnen</button>
    </div>

    <div class="card">
      <div class="row-between"><h3>Lagerplatz</h3>
        ${free ? `<button class="btn btn-small" data-action="place">Im Regal platzieren (${free})</button>` : ''}</div>
      ${slots.length
        ? `<div class="slot-tags">${slots.map(s => `<a class="slot-tag" href="#/regal/${encodeURIComponent(s.rack.id)}">${esc(s.rack.name)} · ${slotLabel(s.key)}</a>`).join('')}</div>`
        : '<p class="muted">Noch keinem Regalfach zugeordnet.</p>'}
      ${free && slots.length ? `<p class="muted small">${free} Flasche(n) ohne Fach.</p>` : ''}
    </div>

    ${w.drinkFrom || w.drinkUntil ? `<div class="card"><h3>Trinkfenster</h3>${drinkWindow(w)}</div>` : ''}

    ${info.length ? `<div class="card"><dl class="info-grid">${info.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : ''}

    ${w.description || w.foodPairing || w.notes ? `<div class="card text-block">
      ${w.description ? `<h3>Beschreibung</h3><p>${esc(w.description)}</p>` : ''}
      ${w.foodPairing ? `<h3>Passt zu</h3><p>${esc(w.foodPairing)}</p>` : ''}
      ${w.notes ? `<h3>Notizen</h3><p>${esc(w.notes)}</p>` : ''}
    </div>` : ''}

    <div class="card">
      <div class="row-between"><h3>Verkostungen</h3><button class="btn btn-small" data-action="tasting">+ Notiz</button></div>
      ${tastings.length ? `<ul class="tastings">${tastings.map(t => `<li>
        <div class="row-between"><span><b>${fmtDate(t.date)}</b>${t.consumed ? ' · Flasche geöffnet' : ''}${t.occasion ? ` · ${esc(t.occasion)}` : ''}</span>
          <button class="icon-btn" data-action="delete-tasting" data-id="${t.id}" aria-label="Löschen">×</button></div>
        ${t.rating ? stars(t.rating, { size: 'sm' }) : ''}
        ${t.notes ? `<p>${esc(t.notes)}</p>` : ''}
      </li>`).join('')}</ul>` : '<p class="muted">Noch keine Verkostungsnotizen.</p>'}
    </div>

    <div class="detail-actions">
      <a class="btn" href="#/bearbeiten/${encodeURIComponent(w.id)}">Bearbeiten</a>
      <button class="btn" data-action="to-shopping">Nachkaufen</button>
      <button class="btn btn-danger-outline" data-action="delete-wine">Löschen</button>
    </div>
  </article>`;
};

function drinkWindow(w) {
  const y = thisYear();
  const from = w.drinkFrom || w.drinkUntil, until = w.drinkUntil || w.drinkFrom;
  const start = Math.min(from, y) - 1, end = Math.max(until, y) + 1;
  const pct = v => ((v - start) / (end - start)) * 100;
  const s = drinkStatus(w);
  return `<div class="window">
    <div class="window-track">
      <div class="window-range status-bg-${s?.key}" style="left:${pct(from)}%;width:${Math.max(2, pct(until + 1) - pct(from))}%"></div>
      <div class="window-now" style="left:${pct(y + 0.5)}%"><span>${y}</span></div>
    </div>
    <div class="window-labels"><span>${w.drinkFrom || '?'}</span><span>${w.drinkUntil || '?'}</span></div>
  </div>`;
}

function wineForm(w, extra = {}) {
  const v = k => esc(w[k] ?? '');
  const countries = [...new Set([...COUNTRIES, ...state.wines.map(x => x.country).filter(Boolean)])];
  const grapes = [...new Set([...GRAPES, ...state.wines.map(x => x.grapes).filter(Boolean)])];
  const photo = state.draft?.photo || (!state.draft?.removePhoto && (w.photo || w.thumb));
  if (w.id && !w.photo && w.photoId && state.user) queueMicrotask(() => loadPhoto(w.id));
  return `<form class="wine-form" data-form="wine" ${w.id ? `data-id="${w.id}"` : ''} ${extra.shopId ? `data-shop-id="${extra.shopId}"` : ''}>
    <div class="photo-box card">
      <div id="photo-preview" class="photo-preview">${photo ? `<img src="${photo}" alt="Etikett">` : bottleSvg(w.type || 'rot')}</div>
      <div class="photo-actions">
        <label class="btn btn-primary">📷 Etikett fotografieren<input type="file" accept="image/*" capture="environment" data-photo hidden></label>
        <label class="btn">Aus Fotos wählen<input type="file" accept="image/*" data-photo hidden></label>
        <button type="button" class="btn btn-accent" data-action="recognize" ${photo ? '' : 'hidden'} id="recognize-btn">✨ Etikett erkennen</button>
        ${photo ? '<button type="button" class="btn btn-link" data-action="remove-photo">Foto entfernen</button>' : ''}
      </div>
    </div>

    <div class="card form-grid">
      <label class="full">Name *<input name="name" required value="${v('name')}" placeholder="z.B. Barolo Cannubi"></label>
      <label class="full">Weingut / Produzent<input name="producer" value="${v('producer')}"></label>
      <label>Jahrgang<input name="vintage" type="number" inputmode="numeric" min="1800" max="2100" value="${v('vintage')}" placeholder="NV"></label>
      <label>Typ<select name="type">${Object.entries(TYPES).map(([k, t]) =>
        `<option value="${k}" ${(w.type || 'rot') === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
      <label>Land<input name="country" list="dl-countries" value="${v('country')}"></label>
      <label>Region<input name="region" value="${v('region')}"></label>
      <label class="full">Rebsorte(n)<input name="grapes" list="dl-grapes" value="${v('grapes')}"></label>
      <label>Alkohol %<input name="alcohol" type="number" step="0.1" inputmode="decimal" value="${v('alcohol')}"></label>
      <label>Anzahl Flaschen<input name="quantity" type="number" min="0" inputmode="numeric" value="${w.quantity ?? 1}"></label>
    </div>

    <div class="card form-grid">
      <h3 class="full">Kauf</h3>
      <label>Preis pro Flasche (${esc(state.settings.currency)})<input name="price" type="number" step="0.05" inputmode="decimal" value="${v('price')}"></label>
      <label>Kaufdatum<input name="purchaseDate" type="date" value="${v('purchaseDate') || (w.id ? '' : today())}"></label>
      <label class="full">Bezugsquelle<input name="purchasePlace" value="${v('purchasePlace')}" placeholder="Händler, Weingut, Auktion …"></label>
    </div>

    <div class="card form-grid">
      <h3 class="full">Trinkreife & Bewertung</h3>
      <label>Trinken ab<input name="drinkFrom" type="number" inputmode="numeric" value="${v('drinkFrom')}" placeholder="${thisYear()}"></label>
      <label>Trinken bis<input name="drinkUntil" type="number" inputmode="numeric" value="${v('drinkUntil')}"></label>
      <div class="full"><span class="label">Meine Bewertung</span>${starInput('rating', w.rating)}</div>
      <label class="full">Beschreibung<textarea name="description" rows="2">${v('description')}</textarea></label>
      <label class="full">Passt zu<input name="foodPairing" value="${v('foodPairing')}"></label>
      <label class="full">Notizen<textarea name="notes" rows="3">${v('notes')}</textarea></label>
    </div>

    <datalist id="dl-countries">${countries.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl-grapes">${grapes.map(c => `<option value="${esc(c)}">`).join('')}</datalist>

    <div class="form-actions">
      <button type="button" class="btn" data-action="back">Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>`;
}

views.neu = () => wineForm(state.prefill?.wine || {}, { shopId: state.prefill?.shopId });
views.bearbeiten = id => {
  const w = wineById(id);
  return w ? wineForm(w) : views.wein(id);
};

views.regale = () => {
  const placing = state.placing && wineById(state.placing);
  return `
    ${placing ? placingBanner(placing, 'Wähle ein Regal, um die Flaschen zu platzieren.') : ''}
    <div class="rack-list">
      ${state.racks.map(r => {
        const filled = Object.keys(r.slots || {}).length;
        return `<a class="rack-card card" href="#/regal/${encodeURIComponent(r.id)}">
          <div class="rack-mini" style="grid-template-columns:repeat(${r.cols},1fr)">
            ${Array.from({ length: r.rows * r.cols }, (_, i) => {
              const key = `${Math.floor(i / r.cols)}-${i % r.cols}`;
              const w = wineById(r.slots?.[key]);
              return `<i style="${w ? `background:${TYPES[w.type]?.color}` : ''}"></i>`;
            }).join('')}
          </div>
          <div><b>${esc(r.name)}</b><div class="muted small">${filled} / ${r.rows * r.cols} Fächer belegt</div></div>
        </a>`;
      }).join('')}
    </div>
    ${state.racks.length ? '' : `<div class="empty small"><p>Lege dein erstes Regal an, um Flaschen einem Fach zuzuordnen.</p></div>`}
    <button class="btn btn-primary block" data-action="new-rack">+ Neues Regal</button>`;
};

function placingBanner(w, hint) {
  return `<div class="banner">
    <div><b>${esc(w.name)} ${w.vintage || ''}</b><div class="small">${hint} Noch ${unplaced(w)} Flasche(n).</div></div>
    <button class="btn btn-small" data-action="stop-placing">Fertig</button>
  </div>`;
}

views.regal = id => {
  const r = state.racks.find(x => x.id === id);
  if (!r) return `<div class="empty"><p>Regal nicht gefunden.</p><a class="btn" href="#/regale">Zu den Regalen</a></div>`;
  const placing = state.placing && wineById(state.placing);
  const winesHere = [...new Set(Object.values(r.slots || {}))].map(wineById).filter(Boolean);
  let grid = `<div class="rack-grid" style="grid-template-columns:1.6rem repeat(${r.cols},minmax(0,1fr))"><span></span>`;
  for (let c = 0; c < r.cols; c++) grid += `<span class="axis">${c + 1}</span>`;
  for (let row = 0; row < r.rows; row++) {
    grid += `<span class="axis">${String.fromCharCode(65 + row)}</span>`;
    for (let c = 0; c < r.cols; c++) {
      const key = `${row}-${c}`;
      const w = wineById(r.slots?.[key]);
      grid += w
        ? `<button class="slot filled" style="--c:${TYPES[w.type]?.color}" data-action="slot" data-key="${key}" title="${esc(w.name)}"><span>${w.vintage ? `'${String(w.vintage).slice(-2)}` : 'NV'}</span></button>`
        : `<button class="slot ${placing ? 'target' : ''}" data-action="slot" data-key="${key}" aria-label="Fach ${slotLabel(key)} frei"></button>`;
    }
  }
  grid += '</div>';
  return `
    ${placing ? placingBanner(placing, 'Tippe auf ein freies Fach.') : ''}
    <div class="card rack-wrap" data-rack="${r.id}">${grid}</div>
    ${winesHere.length ? `<h3 class="section-title">In diesem Regal</h3><div class="wine-list">${winesHere.map(wineCard).join('')}</div>` : ''}
    <div class="detail-actions">
      <button class="btn" data-action="edit-rack" data-id="${r.id}">Regal bearbeiten</button>
      <button class="btn btn-danger-outline" data-action="delete-rack" data-id="${r.id}">Regal löschen</button>
    </div>`;
};

views.statistik = () => {
  const inStock = state.wines.filter(w => (w.quantity || 0) > 0);
  const bottles = inStock.reduce((s, w) => s + w.quantity, 0);
  const value = inStock.reduce((s, w) => s + w.quantity * (w.price || 0), 0);
  const rated = state.wines.filter(w => w.rating);
  const avg = rated.length ? rated.reduce((s, w) => s + w.rating, 0) / rated.length : 0;
  const consumed = state.tastings.filter(t => t.consumed);
  const consumedYear = consumed.filter(t => (t.date || '').startsWith(String(thisYear()))).length;

  const groupBy = (keyFn, labelFn = k => k) => {
    const m = new Map();
    for (const w of inStock) {
      for (const k of [].concat(keyFn(w))) if (k) m.set(k, (m.get(k) || 0) + w.quantity);
    }
    return [...m.entries()].map(([k, n]) => ({ key: k, label: labelFn(k), n }));
  };

  const status = { ready: 0, soon: 0, over: 0, wait: 0, none: 0 };
  for (const w of inStock) status[drinkStatus(w)?.key || 'none'] += w.quantity;

  const drinkNow = inStock
    .filter(w => ['over', 'soon', 'ready'].includes(drinkStatus(w)?.key))
    .sort((a, b) => (a.drinkUntil || 9999) - (b.drinkUntil || 9999))
    .slice(0, 8);

  const recent = consumed.sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 6);

  const byType = groupBy(w => w.type, k => TYPES[k]?.label || k).sort((a, b) => b.n - a.n);
  const byCountry = groupBy(w => w.country).sort((a, b) => b.n - a.n).slice(0, 8);
  const byGrape = groupBy(w => (w.grapes || '').split(/[,/]/).map(s => s.trim())).sort((a, b) => b.n - a.n).slice(0, 8);
  const byVintage = groupBy(w => w.vintage).sort((a, b) => a.key - b.key);

  if (!state.wines.length) return `<div class="empty"><p>Sobald Weine im Keller sind, siehst du hier deine Statistik.</p></div>`;

  return `
    <div class="kpis">
      <div class="kpi"><b>${bottles}</b><span>Flaschen</span></div>
      <div class="kpi"><b>${inStock.length}</b><span>Weine</span></div>
      <div class="kpi"><b>${fmtMoney(value)}</b><span>Kellerwert</span></div>
      <div class="kpi"><b>${avg ? avg.toFixed(1) : '–'}</b><span>Ø Bewertung</span></div>
      <div class="kpi"><b>${consumedYear}</b><span>Getrunken ${thisYear()}</span></div>
      <div class="kpi"><b>${consumed.length}</b><span>Getrunken total</span></div>
    </div>

    <div class="card">
      <h3>Trinkreife</h3>
      <div class="status-row">
        <div class="status-box status-bg-over"><b>${status.over}</b><span>Überfällig</span></div>
        <div class="status-box status-bg-soon"><b>${status.soon}</b><span>Bald trinken</span></div>
        <div class="status-box status-bg-ready"><b>${status.ready}</b><span>Trinkreif</span></div>
        <div class="status-box status-bg-wait"><b>${status.wait}</b><span>Lagern</span></div>
      </div>
      ${status.none ? `<p class="muted small">${status.none} Flasche(n) ohne Trinkfenster.</p>` : ''}
    </div>

    ${drinkNow.length ? `<h3 class="section-title">Jetzt trinken</h3><div class="wine-list">${drinkNow.map(wineCard).join('')}</div>` : ''}

    <div class="card"><h3>Nach Typ</h3>${bars(byType, b => TYPES[b.key]?.color)}</div>
    ${byCountry.length ? `<div class="card"><h3>Nach Land</h3>${bars(byCountry)}</div>` : ''}
    ${byGrape.length ? `<div class="card"><h3>Nach Rebsorte</h3>${bars(byGrape)}</div>` : ''}
    ${byVintage.length ? `<div class="card"><h3>Nach Jahrgang</h3>${bars(byVintage)}</div>` : ''}

    ${recent.length ? `<div class="card"><h3>Zuletzt getrunken</h3><ul class="recent">${recent.map(t => {
      const w = wineById(t.wineId);
      return `<li><a href="${w ? `#/wein/${encodeURIComponent(w.id)}` : '#/statistik'}">
        <span>${esc(w ? `${w.name} ${w.vintage || ''}` : 'Gelöschter Wein')}</span>
        <span class="muted small">${fmtDate(t.date)} ${t.rating ? stars(t.rating, { size: 'sm' }) : ''}</span></a></li>`;
    }).join('')}</ul></div>` : ''}`;
};

function bars(items, colorFn) {
  const max = Math.max(1, ...items.map(i => i.n));
  return `<div class="bars">${items.map(i => `<div class="bar-row">
    <span class="bar-label">${esc(i.label)}</span>
    <span class="bar"><i style="width:${(i.n / max) * 100}%;${colorFn?.(i) ? `background:${colorFn(i)}` : ''}"></i></span>
    <span class="bar-val">${i.n}</span>
  </div>`).join('')}</div>`;
}

views.einkauf = () => {
  const items = [...state.shopping].sort((a, b) => (a.done - b.done) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const done = items.filter(i => i.done).length;
  return `
    <form class="shop-add" data-form="shop-add">
      <input name="name" placeholder="Wein auf die Liste setzen …" required autocomplete="off">
      <button class="btn btn-primary" type="submit" aria-label="Hinzufügen">+</button>
    </form>
    ${items.length ? `<ul class="shop-list">${items.map(i => `<li class="${i.done ? 'done' : ''}">
      <button class="check ${i.done ? 'on' : ''}" data-action="shop-toggle" data-id="${i.id}" aria-label="Erledigt">${i.done ? '✓' : ''}</button>
      <button class="shop-text" data-action="shop-edit" data-id="${i.id}">
        <b>${esc(i.name)}${i.vintage ? ` ${i.vintage}` : ''}</b>
        <span class="muted small">${[i.producer, i.quantity > 1 ? `${i.quantity} Fl.` : '', i.price ? fmtMoney(i.price) : '', i.where, i.notes].filter(Boolean).map(esc).join(' · ')}</span>
      </button>
      <button class="btn btn-small" data-action="shop-to-cellar" data-id="${i.id}" title="Gekauft – in den Keller">In Keller</button>
    </li>`).join('')}</ul>` : `<div class="empty small"><p>Deine Einkaufsliste ist leer. Über „Nachkaufen“ bei einem Wein kannst du ihn direkt hinzufügen.</p></div>`}
    ${done ? `<button class="btn btn-link block" data-action="shop-clear-done">${done} erledigte entfernen</button>` : ''}`;
};

views.login = () => {
  const mode = state.authMode;
  const titles = { login: 'Anmelden', register: 'Konto erstellen', reset: 'Passwort zurücksetzen' };
  return `<div class="auth">
    <img class="auth-logo" src="icons/icon.svg" alt="">
    <h2>${titles[mode]}</h2>
    <p class="muted">${mode === 'reset'
      ? 'Gib deine E-Mail-Adresse ein. Du erhältst einen Link, um ein neues Passwort zu setzen.'
      : 'Dein Weinkeller – sicher in der Cloud und auf all deinen Geräten.'}</p>
    ${state.authInfo ? `<div class="auth-info">${esc(state.authInfo)}</div>` : ''}
    <form class="card form-grid" data-form="auth" data-mode="${mode}">
      <label class="full">E-Mail<input name="email" type="email" autocomplete="email" required></label>
      ${mode !== 'reset' ? `<label class="full">Passwort<input name="password" type="password" minlength="8" required
        autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}"></label>` : ''}
      ${mode === 'register' ? `<label class="full">Passwort wiederholen<input name="password2" type="password" minlength="8" required autocomplete="new-password"></label>` : ''}
      <button class="btn btn-primary full" type="submit">${titles[mode]}</button>
    </form>
    <div class="auth-links">
      ${mode === 'login' ? `<button class="btn btn-link" data-action="auth-mode" data-value="register">Neues Konto erstellen</button>
        <button class="btn btn-link" data-action="auth-mode" data-value="reset">Passwort vergessen?</button>`
        : '<button class="btn btn-link" data-action="auth-mode" data-value="login">Zurück zur Anmeldung</button>'}
    </div>
  </div>`;
};

function accountCard() {
  if (!cloud.enabled || !state.user) return '';
  const st = cloud.status;
  const line = st.busy ? 'Synchronisiere …'
    : st.error ? `⚠️ ${st.error}`
    : st.lastSync ? `Zuletzt synchronisiert: ${new Date(st.lastSync).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' })}`
    : 'Noch nicht synchronisiert';
  return `<div class="card" id="account-card">
    <h3>Konto</h3>
    <p><b>${esc(state.user.email || '')}</b></p>
    <p class="muted small">☁️ ${esc(line)}${st.pending ? ` · ${st.pending} Änderung(en) ausstehend` : ''}</p>
    <div class="stack">
      <button class="btn" data-action="sync-now" ${st.busy ? 'disabled' : ''}>Jetzt synchronisieren</button>
      <button class="btn" data-action="change-password">Passwort ändern</button>
      <button class="btn btn-danger-outline" data-action="sign-out">Abmelden</button>
    </div>
  </div>`;
}

views.einstellungen = () => `
  ${accountCard()}
  <div class="card form-grid">
    <h3 class="full">Allgemein</h3>
    <label>Währung<select data-setting="currency">${['CHF', 'EUR', 'USD', 'GBP'].map(c =>
      `<option ${state.settings.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
  </div>

  <div class="card form-grid">
    <h3 class="full">Etikett-Erkennung (Claude)</h3>
    <p class="full muted small">Für „✨ Etikett erkennen“ wird ein eigener API-Key von
      <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> benötigt.
      Der Key wird nur auf diesem Gerät gespeichert, nicht exportiert und ausschliesslich an api.anthropic.com gesendet.</p>
    <label class="full">API-Key<input type="password" data-setting="apiKey" value="${esc(state.settings.apiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
  </div>

  <div class="card">
    <h3>Daten</h3>
    <p class="muted small">${state.user
      ? 'Deine Daten werden in deinem Konto gespeichert und auf allen Geräten synchronisiert. Eine Sicherung als Datei schadet trotzdem nicht.'
      : 'Alle Daten liegen lokal in diesem Browser. Erstelle regelmässig eine Sicherung, z.B. in iCloud Drive.'}</p>
    <div class="stack">
      <button class="btn" data-action="export">Sicherung exportieren (JSON)</button>
      <label class="btn">Sicherung importieren<input type="file" accept="application/json,.json" data-import hidden></label>
      ${state.wines.length ? '' : '<button class="btn" data-action="load-demo">Beispieldaten laden</button>'}
      <button class="btn btn-danger-outline" data-action="wipe">Alle ${state.user ? 'Kellerdaten (auf allen Geräten)' : 'Daten'} löschen</button>
    </div>
  </div>
  <p class="muted small center">Weinkeller · ${state.wines.length} Weine · ${state.tastings.length} Verkostungen</p>`;

// ---------- Sheets ----------

function drinkSheet(w, { consumed = true, slot = '' } = {}) {
  openSheet(`<form data-form="tasting" data-id="${w.id}" data-consumed="${consumed ? 1 : ''}" data-slot="${slot}">
    <h3>${consumed ? '🍷 Flasche öffnen' : 'Verkostungsnotiz'}</h3>
    <p class="muted">${esc(w.name)} ${w.vintage || ''}</p>
    <div class="form-grid">
      <label>Datum<input type="date" name="date" value="${today()}" required></label>
      <label>Anlass<input name="occasion" placeholder="z.B. Abendessen mit Freunden"></label>
      <div class="full"><span class="label">Bewertung</span>${starInput('rating', null)}</div>
      <label class="full">Notizen<textarea name="notes" rows="3" placeholder="Nase, Gaumen, Abgang …"></textarea></label>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>`);
}

function passwordSheet(title) {
  openSheet(`<form data-form="password">
    <h3>${esc(title)}</h3>
    <div class="form-grid">
      <label class="full">Neues Passwort<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label class="full">Passwort wiederholen<input name="password2" type="password" minlength="8" required autocomplete="new-password"></label>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>`);
}

function rackSheet(r = {}) {
  openSheet(`<form data-form="rack" ${r.id ? `data-id="${r.id}"` : ''}>
    <h3>${r.id ? 'Regal bearbeiten' : 'Neues Regal'}</h3>
    <div class="form-grid">
      <label class="full">Name<input name="name" required value="${esc(r.name || '')}" placeholder="z.B. Klimaschrank, Regal links"></label>
      <label>Reihen<input name="rows" type="number" min="1" max="26" required value="${r.rows || 6}"></label>
      <label>Spalten<input name="cols" type="number" min="1" max="30" required value="${r.cols || 8}"></label>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Abbrechen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>`);
}

function shopSheet(i) {
  openSheet(`<form data-form="shop-edit" data-id="${i.id}">
    <h3>Eintrag bearbeiten</h3>
    <div class="form-grid">
      <label class="full">Wein<input name="name" required value="${esc(i.name)}"></label>
      <label class="full">Produzent<input name="producer" value="${esc(i.producer || '')}"></label>
      <label>Jahrgang<input name="vintage" type="number" value="${i.vintage || ''}"></label>
      <label>Anzahl<input name="quantity" type="number" min="1" value="${i.quantity || 1}"></label>
      <label>Preis (${esc(state.settings.currency)})<input name="price" type="number" step="0.05" value="${i.price ?? ''}"></label>
      <label>Wo kaufen<input name="where" value="${esc(i.where || '')}"></label>
      <label class="full">Notiz<input name="notes" value="${esc(i.notes || '')}"></label>
    </div>
    <div class="actions">
      <button type="button" class="btn btn-danger-outline" data-action="shop-delete" data-id="${i.id}">Löschen</button>
      <button type="submit" class="btn btn-primary">Speichern</button>
    </div>
  </form>`);
}

function slotSheet(r, key) {
  const w = wineById(r.slots[key]);
  openSheet(`<div class="slot-sheet">
    <div class="muted small">${esc(r.name)} · Fach ${slotLabel(key)}</div>
    <a class="wine-card plain" href="#/wein/${encodeURIComponent(w.id)}" data-action="close-sheet-nav">
      <div class="thumb">${thumb(w)}</div>
      <div class="info"><div class="producer">${esc(w.producer || '')}</div>
        <div class="name">${esc(w.name)} <span class="vintage">${w.vintage || 'NV'}</span></div>
        <div class="badges">${statusChip(w)}</div></div>
    </a>
    <div class="stack">
      <button class="btn btn-primary" data-action="drink-slot" data-rack="${r.id}" data-key="${key}">🍷 Diese Flasche öffnen</button>
      <button class="btn" data-action="unassign-slot" data-rack="${r.id}" data-key="${key}">Aus Fach entfernen</button>
    </div>
  </div>`);
}

function pickWineSheet(r, key) {
  const candidates = state.wines.filter(w => unplaced(w) > 0).sort(SORTS.name[1]);
  openSheet(`<h3>Fach ${slotLabel(key)} belegen</h3>
    ${candidates.length ? `<div class="pick-list">${candidates.map(w => `
      <button class="wine-card plain" data-action="assign-slot" data-rack="${r.id}" data-key="${key}" data-wine="${w.id}">
        <div class="thumb">${thumb(w)}</div>
        <div class="info"><div class="producer">${esc(w.producer || '')}</div>
          <div class="name">${esc(w.name)} <span class="vintage">${w.vintage || 'NV'}</span></div>
          <div class="muted small">${unplaced(w)} ohne Fach</div></div>
      </button>`).join('')}</div>`
      : '<p class="muted">Alle Flaschen haben bereits ein Fach. Erhöhe den Bestand eines Weins oder füge einen neuen hinzu.</p>'}
    <div class="actions"><a class="btn" href="#/neu" data-action="close-sheet-nav">Neuer Wein</a>
      <button class="btn" data-action="close-sheet">Schliessen</button></div>`);
}

// ---------- Aktionen ----------

const currentWine = () => wineById(route().id);

const actions = {
  back: () => (history.length > 1 ? history.back() : (location.hash = '#/keller')),
  'close-sheet': closeSheet,
  'close-sheet-nav': el => { closeSheet(); location.hash = el.getAttribute('href'); },
  'confirm-yes': () => { const r = confirmResolve; confirmResolve = null; closeSheet(); r?.(true); },
  'confirm-no': closeSheet,

  'filter-type': el => { state.filter.type = el.dataset.value; render(); },

  'star-input': el => {
    const box = el.closest('.star-input');
    const input = box.querySelector('input');
    const v = Number(el.dataset.value);
    input.value = Number(input.value) === v ? '' : v;
    box.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('full', i < Number(input.value || 0)));
  },

  rate: async el => {
    const w = currentWine();
    const v = Number(el.dataset.value);
    w.rating = w.rating === v ? null : v;
    await save('wines', w);
    render();
  },

  qty: async el => {
    const w = currentWine();
    w.quantity = Math.max(0, (w.quantity || 0) + Number(el.dataset.delta));
    await save('wines', w);
    await trimSlots(w);
    render();
  },

  drink: () => drinkSheet(currentWine()),
  tasting: () => drinkSheet(currentWine(), { consumed: false }),

  'delete-tasting': async el => {
    if (!(await confirmDialog('Diese Verkostungsnotiz löschen?', 'Löschen', true))) return;
    await remove('tastings', el.dataset.id);
    render();
  },

  place: () => {
    const w = currentWine();
    state.placing = w.id;
    if (state.racks.length === 1) location.hash = `#/regal/${encodeURIComponent(state.racks[0].id)}`;
    else {
      location.hash = '#/regale';
      if (!state.racks.length) toast('Lege zuerst ein Regal an.');
    }
  },
  'stop-placing': () => { state.placing = null; render(); },

  'to-shopping': async () => {
    const w = currentWine();
    await save('shopping', {
      id: uid(), name: w.name, producer: w.producer, vintage: w.vintage, price: w.price,
      where: w.purchasePlace, quantity: 1, wineId: w.id, done: false, createdAt: new Date().toISOString(),
    });
    toast('Auf die Einkaufsliste gesetzt.');
  },

  'delete-wine': async () => {
    const w = currentWine();
    if (!(await confirmDialog(`„${esc(w.name)}“ mit allen Verkostungen löschen?`, 'Löschen', true))) return;
    for (const s of slotsOf(w.id)) { delete s.rack.slots[s.key]; await save('racks', s.rack); }
    for (const t of state.tastings.filter(t => t.wineId === w.id)) await remove('tastings', t.id);
    await remove('wines', w.id);
    cloud.deletePhoto(w.photoId);
    if (state.placing === w.id) state.placing = null;
    location.replace('#/keller');
    toast('Wein gelöscht.');
  },

  'remove-photo': () => {
    state.draft = { removePhoto: true };
    $('#photo-preview').innerHTML = bottleSvg($('[name=type]').value);
    $('#recognize-btn').hidden = true;
    document.querySelector('[data-action=remove-photo]')?.remove();
  },

  recognize: async el => {
    const form = el.closest('form');
    const w = form.dataset.id ? wineById(form.dataset.id) : null;
    const photo = state.draft?.photo || (!state.draft?.removePhoto && w?.photo);
    if (!photo) return toast('Bitte zuerst ein Foto aufnehmen.');
    if (!state.settings.apiKey) {
      toast('Bitte zuerst den API-Key in den Einstellungen hinterlegen.', 'error');
      return;
    }
    el.disabled = true;
    el.textContent = '⏳ Erkenne Etikett …';
    try {
      const r = await recognizeLabel(state.settings.apiKey, photo);
      const map = {
        name: r.name, producer: r.producer, vintage: r.vintage, type: r.type, country: r.country, region: r.region,
        grapes: r.grapes, alcohol: r.alcohol, drinkFrom: r.drink_from, drinkUntil: r.drink_until,
        description: r.description, foodPairing: r.food_pairing,
      };
      for (const [k, v] of Object.entries(map)) {
        if (v === null || v === undefined || v === '') continue;
        const field = form.elements[k];
        if (field) field.value = v;
      }
      toast('Etikett erkannt – bitte Angaben prüfen.');
    } catch (err) {
      console.error(err);
      toast(err?.status === 401 ? 'API-Key ungültig.' : `Erkennung fehlgeschlagen: ${err.message}`, 'error');
    } finally {
      el.disabled = false;
      el.textContent = '✨ Etikett erkennen';
    }
  },

  'new-rack': () => rackSheet(),
  'edit-rack': el => rackSheet(state.racks.find(r => r.id === el.dataset.id)),
  'delete-rack': async el => {
    const r = state.racks.find(x => x.id === el.dataset.id);
    if (!(await confirmDialog(`Regal „${esc(r.name)}“ löschen? Die Weine bleiben im Keller, verlieren aber ihr Fach.`, 'Löschen', true))) return;
    await remove('racks', r.id);
    location.replace('#/regale');
  },

  slot: async el => {
    const r = state.racks.find(x => x.id === el.closest('[data-rack]').dataset.rack);
    const key = el.dataset.key;
    r.slots ||= {};
    if (r.slots[key]) return slotSheet(r, key);
    const w = state.placing && wineById(state.placing);
    if (w && unplaced(w) > 0) {
      r.slots[key] = w.id;
      await save('racks', r);
      if (!unplaced(w)) { state.placing = null; toast('Alle Flaschen platziert.'); }
      render();
    } else {
      state.placing = null;
      pickWineSheet(r, key);
    }
  },

  'assign-slot': async el => {
    const r = state.racks.find(x => x.id === el.dataset.rack);
    r.slots[el.dataset.key] = el.dataset.wine;
    await save('racks', r);
    closeSheet();
    render();
  },

  'unassign-slot': async el => {
    const r = state.racks.find(x => x.id === el.dataset.rack);
    delete r.slots[el.dataset.key];
    await save('racks', r);
    closeSheet();
    render();
  },

  'drink-slot': el => {
    const r = state.racks.find(x => x.id === el.dataset.rack);
    const w = wineById(r.slots[el.dataset.key]);
    drinkSheet(w, { slot: `${r.id}|${el.dataset.key}` });
  },

  'shop-toggle': async el => {
    const i = state.shopping.find(x => x.id === el.dataset.id);
    i.done = !i.done;
    await save('shopping', i);
    render();
  },
  'shop-edit': el => shopSheet(state.shopping.find(x => x.id === el.dataset.id)),
  'shop-delete': async el => { await remove('shopping', el.dataset.id); closeSheet(); render(); },
  'shop-clear-done': async () => {
    for (const i of state.shopping.filter(i => i.done)) await remove('shopping', i.id);
    render();
  },
  'shop-to-cellar': async el => {
    const i = state.shopping.find(x => x.id === el.dataset.id);
    const linked = i.wineId && wineById(i.wineId);
    if (linked) {
      linked.quantity = (linked.quantity || 0) + (i.quantity || 1);
      if (i.price) linked.price = i.price;
      linked.purchaseDate = today();
      await save('wines', linked);
      i.done = true;
      await save('shopping', i);
      toast(`${i.quantity || 1} Flasche(n) „${linked.name}“ zum Keller hinzugefügt.`);
      render();
    } else {
      state.prefill = {
        shopId: i.id,
        wine: { name: i.name, producer: i.producer, vintage: i.vintage, quantity: i.quantity || 1, price: i.price, purchasePlace: i.where, notes: i.notes },
      };
      location.hash = '#/neu';
    }
  },

  export: async () => {
    const data = await exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `weinkeller-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },

  wipe: async () => {
    if (!(await confirmDialog('Wirklich alle Weine, Regale, Verkostungen und die Einkaufsliste löschen? Das kann nicht rückgängig gemacht werden.', 'Alles löschen', true))) return;
    for (const s of SYNC_STORES) {
      for (const item of [...state[s]]) await remove(s, item.id);
    }
    for (const w of await db.all('wines')) cloud.deletePhoto(w.photoId);
    location.hash = '#/keller';
    render();
    toast('Alle Daten gelöscht.');
  },

  'auth-mode': el => { state.authMode = el.dataset.value; state.authInfo = ''; render(); },

  'sync-now': async () => {
    await syncAndRefresh(true);
    if (!cloud.status.error) toast('Synchronisiert.');
  },

  'change-password': () => passwordSheet('Passwort ändern'),

  'sign-out': async () => {
    const pending = cloud.status.pending;
    const msg = pending
      ? `Es gibt noch ${pending} nicht synchronisierte Änderung(en), die beim Abmelden verloren gehen. Trotzdem abmelden?`
      : 'Abmelden? Die Daten bleiben in deinem Konto und werden von diesem Gerät entfernt.';
    if (!(await confirmDialog(msg, 'Abmelden', !!pending))) return;
    await cloud.signOut();
    await handleSignedOut();
  },

  'load-demo': async () => {
    await loadDemo();
    render();
    toast('Beispieldaten geladen.');
  },
};

// ---------- Formulare ----------

const forms = {
  auth: async (form, fd) => {
    const mode = form.dataset.mode;
    const email = String(fd.get('email')).trim();
    const password = String(fd.get('password') ?? '');
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (mode === 'login') {
        await cloud.signIn(email, password);
      } else if (mode === 'register') {
        if (password !== fd.get('password2')) throw new Error('Die Passwörter stimmen nicht überein.');
        const { needsConfirmation } = await cloud.signUp(email, password);
        if (needsConfirmation) {
          state.authMode = 'login';
          state.authInfo = `Fast geschafft! Wir haben eine Bestätigungsmail an ${email} geschickt. Klicke auf den Link darin und melde dich danach hier an.`;
          render();
        }
      } else {
        await cloud.resetPassword(email);
        state.authMode = 'login';
        state.authInfo = `Falls ein Konto für ${email} existiert, ist eine E-Mail mit einem Link zum Zurücksetzen unterwegs.`;
        render();
      }
    } finally {
      btn.disabled = false;
    }
  },

  password: async (form, fd) => {
    const password = String(fd.get('password'));
    if (password !== fd.get('password2')) throw new Error('Die Passwörter stimmen nicht überein.');
    await cloud.updatePassword(password);
    closeSheet();
    toast('Passwort geändert.');
  },

  wine: async (form, fd) => {
    const existing = form.dataset.id && wineById(form.dataset.id);
    const w = existing ? { ...existing } : { id: uid(), createdAt: new Date().toISOString() };
    for (const k of TEXT_FIELDS) w[k] = String(fd.get(k) ?? '').trim();
    for (const k of NUM_FIELDS) w[k] = num(fd.get(k));
    w.quantity = Math.max(0, Math.round(w.quantity ?? 0));
    if (state.draft?.photo) {
      cloud.deletePhoto(w.photoId);
      Object.assign(w, { photo: state.draft.photo, thumb: state.draft.thumb, photoId: uid(), photoUploaded: false });
    } else if (state.draft?.removePhoto) {
      cloud.deletePhoto(w.photoId);
      for (const k of ['photo', 'thumb', 'photoId', 'photoUploaded']) delete w[k];
    }
    await save('wines', w);
    await trimSlots(w);
    if (form.dataset.shopId) {
      const i = state.shopping.find(x => x.id === form.dataset.shopId);
      if (i) { i.done = true; i.wineId = w.id; await save('shopping', i); }
    }
    state.draft = null;
    state.prefill = null;
    location.replace(`#/wein/${encodeURIComponent(w.id)}`);
    toast(existing ? 'Gespeichert.' : 'Wein hinzugefügt.');
  },

  tasting: async (form, fd) => {
    const w = wineById(form.dataset.id);
    const consumed = !!form.dataset.consumed;
    const rating = num(fd.get('rating'));
    await save('tastings', {
      id: uid(), wineId: w.id, date: fd.get('date'), rating, notes: String(fd.get('notes')).trim(),
      occasion: String(fd.get('occasion')).trim(), consumed, createdAt: new Date().toISOString(),
    });
    if (rating) w.rating = rating;
    if (consumed) w.quantity = Math.max(0, (w.quantity || 0) - 1);
    await save('wines', w);
    if (consumed) await trimSlots(w, form.dataset.slot);
    closeSheet();
    render();
    if (consumed) {
      toast('Zum Wohl! 🍷');
      if (w.quantity === 0 && !state.shopping.some(i => i.wineId === w.id && !i.done)
        && await confirmDialog(`Das war die letzte Flasche „${esc(w.name)}“. Auf die Einkaufsliste setzen?`, 'Ja, nachkaufen')) {
        await save('shopping', {
          id: uid(), name: w.name, producer: w.producer, vintage: w.vintage, price: w.price, where: w.purchasePlace,
          quantity: 1, wineId: w.id, done: false, createdAt: new Date().toISOString(),
        });
        toast('Auf die Einkaufsliste gesetzt.');
      }
    }
  },

  rack: async (form, fd) => {
    const existing = form.dataset.id && state.racks.find(r => r.id === form.dataset.id);
    const r = existing || { id: uid(), slots: {}, createdAt: new Date().toISOString() };
    r.name = String(fd.get('name')).trim();
    r.rows = Math.min(26, Math.max(1, num(fd.get('rows')) || 1));
    r.cols = Math.min(30, Math.max(1, num(fd.get('cols')) || 1));
    for (const key of Object.keys(r.slots)) {
      const [row, col] = key.split('-').map(Number);
      if (row >= r.rows || col >= r.cols) delete r.slots[key];
    }
    await save('racks', r);
    closeSheet();
    if (existing) render(); else location.hash = `#/regal/${encodeURIComponent(r.id)}`;
  },

  'shop-add': async (form, fd) => {
    const name = String(fd.get('name')).trim();
    if (!name) return;
    await save('shopping', { id: uid(), name, quantity: 1, done: false, createdAt: new Date().toISOString() });
    render();
    $('.shop-add input')?.focus();
  },

  'shop-edit': async (form, fd) => {
    const i = state.shopping.find(x => x.id === form.dataset.id);
    Object.assign(i, {
      name: String(fd.get('name')).trim(), producer: String(fd.get('producer')).trim(), vintage: num(fd.get('vintage')),
      quantity: num(fd.get('quantity')) || 1, price: num(fd.get('price')), where: String(fd.get('where')).trim(),
      notes: String(fd.get('notes')).trim(),
    });
    await save('shopping', i);
    closeSheet();
    render();
  },
};

// ---------- Ereignisse ----------

async function run(fn) {
  try { await fn(); } catch (err) { console.error(err); toast(err.message || String(err), 'error'); }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  const fn = el && actions[el.dataset.action];
  if (!fn || el.disabled) return;
  e.preventDefault();
  run(() => fn(el, e));
});

document.addEventListener('submit', e => {
  const form = e.target.closest('form[data-form]');
  const fn = form && forms[form.dataset.form];
  if (!fn) return;
  e.preventDefault();
  run(() => fn(form, new FormData(form)));
});

document.addEventListener('input', e => {
  if (e.target.dataset.filter === 'q') {
    state.filter.q = e.target.value;
    $('#wine-list').innerHTML = renderWineList();
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.filter === 'sort') { state.filter.sort = t.value; $('#wine-list').innerHTML = renderWineList(); }
  if (t.dataset.filter === 'showEmpty') { state.filter.showEmpty = t.checked; $('#wine-list').innerHTML = renderWineList(); }
  if (t.dataset.setting) run(async () => { await setSetting(t.dataset.setting, t.value.trim()); toast('Gespeichert.'); });
  if (t.matches('[data-photo]') && t.files[0]) run(async () => {
    const file = t.files[0];
    const [photo, thumbImg] = await Promise.all([compressImage(file, 1400), compressImage(file, 240, 0.75)]);
    state.draft = { photo, thumb: thumbImg };
    $('#photo-preview').innerHTML = `<img src="${photo}" alt="Etikett">`;
    $('#recognize-btn').hidden = false;
    if (state.settings.apiKey && !t.form.elements.name.value) actions.recognize($('#recognize-btn'));
  });
  if (t.matches('[data-import]') && t.files[0]) run(async () => {
    const data = JSON.parse(await t.files[0].text());
    if (!(await confirmDialog('Die aktuelle Kellerliste wird durch die Sicherung ersetzt. Fortfahren?', 'Importieren'))) return;
    const before = Object.fromEntries(SYNC_STORES.map(s => [s, state[s].map(x => x.id)]));
    await importAll(data);
    await load();
    if (state.user) {
      for (const s of SYNC_STORES) {
        for (const id of before[s]) if (!state[s].some(x => x.id === id)) await cloud.enqueue(s, id, true);
      }
      await cloud.enqueueAll();
      cloud.sync().catch(() => {});
    }
    render();
    toast('Sicherung importiert.');
  });
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheet').classList.contains('open')) closeSheet(); });
window.addEventListener('hashchange', () => { closeSheet(); render(); });

// ---------- Beispieldaten ----------

async function loadDemo() {
  const y = thisYear();
  const now = Date.now();
  const demo = [
    { name: 'Barolo Cannubi', producer: 'Brezza', vintage: 2017, type: 'rot', country: 'Italien', region: 'Piemont', grapes: 'Nebbiolo', alcohol: 14.5, quantity: 4, price: 58, drinkFrom: 2024, drinkUntil: 2035, rating: 5, foodPairing: 'Trüffelrisotto, Brasato', purchasePlace: 'Weinhandlung am Markt' },
    { name: 'Dôle Blanche', producer: 'Domaine du Mont d’Or', vintage: y - 2, type: 'rose', country: 'Schweiz', region: 'Wallis', grapes: 'Pinot Noir, Gamay', alcohol: 12.5, quantity: 3, price: 19.5, drinkFrom: y - 1, drinkUntil: y, rating: 3 },
    { name: 'Riesling Smaragd Achleiten', producer: 'Prager', vintage: 2020, type: 'weiss', country: 'Österreich', region: 'Wachau', grapes: 'Riesling', alcohol: 13.5, quantity: 6, price: 42, drinkFrom: 2023, drinkUntil: 2032, rating: 4 },
    { name: 'Château Musar', producer: 'Château Musar', vintage: 2015, type: 'rot', country: 'Libanon', region: 'Bekaa', grapes: 'Cabernet Sauvignon, Cinsault, Carignan', alcohol: 14, quantity: 2, price: 55, drinkFrom: 2022, drinkUntil: 2040, rating: 4 },
    { name: 'Brut Réserve', producer: 'Billecart-Salmon', vintage: null, type: 'schaum', country: 'Frankreich', region: 'Champagne', grapes: 'Pinot Noir, Chardonnay, Pinot Meunier', alcohol: 12, quantity: 3, price: 49, drinkFrom: y - 1, drinkUntil: y + 2, rating: 4 },
    { name: 'Cornalin', producer: 'Cave Caloz', vintage: 2021, type: 'rot', country: 'Schweiz', region: 'Wallis', grapes: 'Cornalin', alcohol: 13.5, quantity: 5, price: 32, drinkFrom: y + 1, drinkUntil: y + 6 },
    { name: 'Sauternes', producer: 'Château Suduiraut', vintage: 2016, type: 'suess', country: 'Frankreich', region: 'Bordeaux', grapes: 'Sémillon, Sauvignon Blanc', alcohol: 13.5, quantity: 1, price: 65, drinkFrom: 2022, drinkUntil: 2045, rating: 5 },
    { name: 'Rioja Reserva', producer: 'La Rioja Alta', vintage: 2012, type: 'rot', country: 'Spanien', region: 'Rioja', grapes: 'Tempranillo', alcohol: 13.5, quantity: 2, price: 29, drinkFrom: 2018, drinkUntil: y - 1, rating: 4 },
  ];
  const wines = [];
  for (const [i, d] of demo.entries()) {
    wines.push(await save('wines', { id: uid(), createdAt: new Date(now - i * 86400000).toISOString(), purchaseDate: today(), ...d }));
  }
  const rack = { id: uid(), name: 'Klimaschrank', rows: 5, cols: 6, slots: {}, createdAt: new Date().toISOString() };
  let n = 0;
  for (const w of wines.slice(0, 5)) {
    for (let k = 0; k < Math.min(w.quantity, 3); k++, n++) rack.slots[`${Math.floor(n / 6)}-${n % 6}`] = w.id;
  }
  await save('racks', rack);
  await save('tastings', { id: uid(), wineId: wines[0].id, date: `${y}-03-14`, rating: 5, consumed: true, occasion: 'Geburtstag', notes: 'Rosen, Teer, Kirsche. Noch jung, aber schon herrlich.', createdAt: new Date().toISOString() });
  await save('tastings', { id: uid(), wineId: wines[2].id, date: `${y}-06-02`, rating: 4, consumed: true, notes: 'Steinobst, Mineralik, lebendige Säure.', createdAt: new Date().toISOString() });
  await save('shopping', { id: uid(), name: 'Brunello di Montalcino', producer: 'Il Poggione', vintage: 2019, quantity: 3, done: false, createdAt: new Date().toISOString() });
}

// ---------- Cloud-Anmeldung & Synchronisation ----------

const safeToRerender = () => !['neu', 'bearbeiten'].includes(route().view) && !$('#sheet').classList.contains('open');

async function syncAndRefresh(showErrors = false) {
  if (!state.user) return;
  try {
    const changed = await cloud.sync();
    if (changed) {
      await load();
      if (safeToRerender()) render();
    }
  } catch (err) {
    console.warn('Synchronisation fehlgeschlagen', err);
    if (showErrors) toast(cloud.status.error || err.message, 'error');
  }
}

let signingInFor = null;
async function handleSignedIn(user) {
  if (signingInFor === user.id) return;
  signingInFor = user.id;
  try {
    const meta = await cloud.getMeta();
    let adopted = 0;
    if (meta.userId && meta.userId !== user.id) {
      // Anderer Benutzer als zuletzt: lokale Kopie verwerfen
      await cloud.clearLocal();
      await load();
    } else if (!meta.userId && SYNC_STORES.some(s => state[s].length)) {
      // Erste Anmeldung auf diesem Gerät: bisher nur lokal gespeicherte Daten ins Konto übernehmen
      adopted = state.wines.length;
      await cloud.enqueueAll();
    }
    await cloud.setMeta({ userId: user.id, email: user.email });
    state.user = user;
    state.authInfo = '';
    render();
    if (adopted) toast(`${adopted} Weine dieses Geräts wurden in dein Konto übernommen.`);
    await syncAndRefresh(true);
  } finally {
    signingInFor = null;
  }
}

async function handleSignedOut() {
  state.user = null;
  state.placing = null;
  state.authMode = 'login';
  await cloud.clearLocal();
  await load();
  history.replaceState(null, '', '#/keller');
  render();
}

async function onAuth(event, user) {
  if (event === 'SIGNED_OUT') {
    if (state.user) await handleSignedOut();
    return;
  }
  if (!user) {
    // Sitzung abgelaufen: Anmeldung verlangen, lokale Daten und Outbox aber behalten
    if (event === 'INITIAL_SESSION' && state.user && navigator.onLine) { state.user = null; render(); }
    return;
  }
  if (state.user?.id !== user.id) await handleSignedIn(user);
  else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { state.user = user; syncAndRefresh(); }
  if (event === 'PASSWORD_RECOVERY') passwordSheet('Neues Passwort festlegen');
}

async function startCloud() {
  // Fehler aus E-Mail-Links (z.B. abgelaufener Bestätigungslink) anzeigen
  const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  if (hashParams.get('error_description')) {
    state.authInfo = hashParams.get('error_description').replace(/\+/g, ' ');
    history.replaceState(null, '', location.pathname);
  }
  // Zuletzt angemeldeten Benutzer vorläufig übernehmen, damit die App auch offline sofort startet
  const meta = await cloud.getMeta();
  if (meta.userId) state.user = { id: meta.userId, email: meta.email };
  render();
  try {
    await cloud.init({
      onAuth: (event, user) => run(() => onAuth(event, user)),
      onStatus: () => { const card = $('#account-card'); if (card) card.outerHTML = accountCard(); },
      onPatched: (store, item) => putState(store, item),
    });
  } catch (err) {
    console.error(err);
    if (!state.user) {
      state.authInfo = 'Keine Verbindung zum Server. Bitte prüfe deine Internetverbindung.';
      render();
    }
    return;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAndRefresh(); });
  window.addEventListener('online', () => syncAndRefresh());
  setInterval(() => { if (document.visibilityState === 'visible') syncAndRefresh(); }, 60000);
}

// ---------- Start ----------

await load();
if (cloud.enabled) await startCloud();
else render();
navigator.storage?.persist?.();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
