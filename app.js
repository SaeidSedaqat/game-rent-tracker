// Game Rent Tracker — reads the rental Google Sheet live and tracks the user's favorites.

const SHEET_ID = '1QCstsxKLrEu1VzF70V3_5DpJgHCc9kRckWvVQBjT6fw';
const SHEET_GID = '0';
const REFRESH_MS = 5 * 60 * 1000;

// Sheet column indexes
const COL = { name: 1, rent: 2, level: 3, ps4: 4, ps5: 5, z3: 6, queue: 7, price: 8 };

const CONSOLES = [
  { key: 'ps4', label: 'Z2 (PS4)', short: 'Z2 PS4', queueKey: 'Z2PS4', priceKey: 'Z2' },
  { key: 'ps5', label: 'Z2 (PS5)', short: 'Z2 PS5', queueKey: 'Z2PS5', priceKey: 'Z2' },
  { key: 'z3',  label: 'Z3',       short: 'Z3',     queueKey: 'Z3',    priceKey: 'Z3' },
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = 86400000;

// ---------- storage ----------

const STORE_KEY = 'grt-state-v1';
const CACHE_KEY = 'grt-games-cache-v1';
const IMG_CACHE_KEY = 'grt-images-cache-v1';

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return s;
  } catch {}
  return null;
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

// favorites: [{ name, consoles }] — each game has its own account types;
// known: every game name seen so far; snapshot: last status shown per favorite, used to flag changes.
let state = loadState() || { favorites: [], known: null, snapshot: {} };
state.favorites = state.favorites.map(f => typeof f === 'string' ? { name: f, consoles: [] } : f);

let games = [];           // parsed sheet rows
let images = {};          // game name -> picture URL (from images.json)
let newGames = new Set(); // names added since the last visit

const favNames = () => state.favorites.map(f => f.name);
const findFav = name => state.favorites.find(f => f.name === name);

// ---------- sheet loading ----------

function fetchSheet() {
  // JSONP: works from any static host without CORS issues.
  return new Promise((resolve, reject) => {
    const cb = '__sheet_' + Date.now();
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out')); }, 12000);
    // A late response must not hit an undefined callback, so leave a no-op behind.
    function cleanup() { clearTimeout(timer); window[cb] = () => {}; script.remove(); }
    window[cb] = data => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('Network error')); };
    script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
      `?tqx=out:json;responseHandler:${cb}&gid=${SHEET_GID}&_=${Date.now()}`;
    document.head.appendChild(script);
  });
}

// The sheet's HTML view holds each game's picture link (the data feed doesn't include images).
let imageLinksLoading = null;
function loadImageLinks() {
  imageLinksLoading ||= fetchImageLinks().finally(() => { imageLinksLoading = null; });
  return imageLinksLoading;
}

async function fetchImageLinks() {
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview/sheet?headers=true&gid=${SHEET_GID}`);
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const map = {};
    for (const tr of doc.querySelectorAll('tr')) {
      const tds = tr.querySelectorAll('td');
      const img = tds[0] && tds[0].querySelector('img');
      if (!img || !tds[1]) continue;
      tds[1].querySelectorAll('br').forEach(br => br.replaceWith(' ')); // multi-line names
      const name = tds[1].textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (name && !map[name]) map[name] = img.getAttribute('src');
    }
    if (!Object.keys(map).length) return;
    images = map;
    try { localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(map)); } catch {}
    hydrateImages();
  } catch {}
}

// Google refuses to let other sites embed the sheet's pictures, and rate-limits direct requests, so pictures
// go through the wsrv.nl image CDN: it fetches each one once, caches it for every visitor, and shrinks it.
function pictureUrl(src, width) {
  return `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=${width}&output=webp`;
}

// Swap placeholders for pictures once the links are known.
function hydrateImages() {
  document.querySelectorAll('.ph[data-name]').forEach(ph => {
    if (images[ph.dataset.name]) ph.outerHTML = cover(ph.dataset.name, ph.className.replace(/\s*ph\b/, ''));
  });
}

// A picture that fails to load falls back to the game's initials (without data-name, so it isn't retried).
document.addEventListener('error', e => {
  const el = e.target;
  if (el.tagName !== 'IMG' || !el.dataset.name) return;
  const div = document.createElement('div');
  div.className = el.className + ' ph';
  div.textContent = initials(el.dataset.name);
  el.replaceWith(div);
}, true);

function cellText(row, i) {
  const c = row.c[i];
  if (!c) return '';
  return String(c.v ?? c.f ?? '').replace(/ /g, ' ').trim();
}

function parseSheet(data) {
  const out = [];
  const seen = new Set();
  for (const row of data.table.rows) {
    const name = cellText(row, COL.name).replace(/\s+/g, ' ');
    if (!name || /^game names?$/i.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      rent: cellText(row, COL.rent),
      rentDays: parseInt(cellText(row, COL.rent), 10) || 0,
      level: cellText(row, COL.level),
      cells: { ps4: cellText(row, COL.ps4), ps5: cellText(row, COL.ps5), z3: cellText(row, COL.z3) },
      queues: parseQueues(cellText(row, COL.queue)),
      prices: parsePrices(cellText(row, COL.price)),
    });
  }
  return out;
}

function parseQueues(text) {
  const q = {};
  for (const m of text.matchAll(/(Z2\s*PS4|Z2\s*PS5|Z3)\s*:\s*(\d+)/gi)) {
    q[m[1].replace(/\s+/g, '').toUpperCase()] = +m[2];
  }
  return q;
}

function parsePrices(text) {
  const p = {};
  for (const m of text.matchAll(/(Z2|Z3)\s*:\s*([\d,]+)\s*T?/gi)) p[m[1].toUpperCase()] = m[2] + ' T';
  return p;
}

// ---------- availability ----------

function monthIndex(word) {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase());
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Sheet dates have no year: pick the year that puts the date closest to today.
function nearestDate(day, month) {
  const t = today();
  let best = null;
  for (const y of [t.getFullYear() - 1, t.getFullYear(), t.getFullYear() + 1]) {
    const d = new Date(y, month, day);
    if (!best || Math.abs(d - t) < Math.abs(best - t)) best = d;
  }
  return best;
}

// Each cell can list several copies (one per line): "Free", "Unavailable" or "21 October - 10 November".
function parseCopies(text) {
  const copies = [];
  const re = /free|unavailable|(\d{1,2})\s+([a-z]+)\s*-\s*(\d{1,2})\s+([a-z]+)/gi;
  for (const m of text.matchAll(re)) {
    const w = m[0].toLowerCase();
    if (w === 'free') copies.push({ type: 'free' });
    else if (w === 'unavailable') copies.push({ type: 'unavailable' });
    else {
      const mi = monthIndex(m[4]);
      if (mi < 0) continue;
      copies.push({ type: 'rented', end: nearestDate(+m[3], mi) });
    }
  }
  return copies;
}

function availability(game, consoleDef) {
  const copies = parseCopies(game.cells[consoleDef.key]);
  const queue = game.queues[consoleDef.queueKey] || 0;
  const price = game.prices[consoleDef.priceKey] || '';
  const usable = copies.filter(c => c.type !== 'unavailable');

  if (!usable.length) return { kind: 'off', queue: 0, price };
  if (usable.some(c => c.type === 'free')) return { kind: 'free', queue, price };

  const date = usable.map(c => c.end).sort((a, b) => a - b)[0];
  const t = today();

  // Rough guess of when the user's turn comes: each queued renter takes one full rent period on some copy.
  let estimate = null;
  if (queue > 0 && game.rentDays) {
    const rounds = Math.ceil(queue / usable.length);
    estimate = new Date(Math.max(date, t) + rounds * game.rentDays * DAY);
  }
  return { kind: date < t ? 'overdue' : 'wait', date, queue, estimate, price };
}

function fmtDate(d) {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
}

function statusText(a) {
  const q = a.queue ? ` + ${a.queue} in queue` : '';
  if (a.kind === 'off') return 'Unavailable';
  if (a.kind === 'free') return 'Free now' + q;
  if (a.kind === 'overdue') return `Should be free (rented until ${fmtDate(a.date)})` + q;
  return `Free from ${fmtDate(a.date)}` + q;
}

// Sort key: free first, then soonest date, unavailable last.
function rank(a) {
  if (a.kind === 'free') return a.queue;
  if (a.kind === 'overdue') return 1000 + a.queue;
  if (a.kind === 'wait') return 2000 + (a.estimate || a.date) / DAY;
  return 1e9;
}

function favStatusKey(fav, game) {
  return CONSOLES.filter(c => fav.consoles.includes(c.key))
    .map(c => c.key + ':' + statusText(availability(game, c))).join('|');
}

// ---------- rendering ----------

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function initials(name) {
  return name.split(/\s+/).filter(w => /^[a-z0-9]/i.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// Games whose picture link isn't known yet get a placeholder that hydrateImages() swaps later.
function cover(name, cls) {
  const src = images[name];
  const width = { thumb: 192, 'dice-cover': 280 }[cls] || 96; // 2x the displayed size for sharp screens
  if (src) return `<img class="${cls}" src="${esc(pictureUrl(src, width))}" data-name="${esc(name)}" alt="" loading="lazy">`;
  return `<div class="${cls} ph" data-name="${esc(name)}">${esc(initials(name))}</div>`;
}

function priceLine(g) {
  return Object.entries(g.prices).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

function render() {
  $('#loading').hidden = true;
  $('#dashboard').hidden = false;

  const byName = new Map(games.map(g => [g.name, g]));
  const items = state.favorites.map(fav => {
    const g = byName.get(fav.name);
    if (!g) return { fav, missing: true, rank: 2e9 };
    const rows = CONSOLES.filter(c => fav.consoles.includes(c.key)).map(c => ({ c, a: availability(g, c) }));
    return { fav, g, rows, text: favStatusKey(fav, g), rank: rows.length ? Math.min(...rows.map(r => rank(r.a))) : 1.5e9 };
  }).sort((a, b) => a.rank - b.rank);

  // Flag favorites whose status changed since the user last saw them.
  const changed = [];
  for (const it of items) {
    if (it.missing) continue;
    const prev = state.snapshot[it.fav.name];
    it.updated = prev !== undefined && prev !== it.text;
    if (it.updated) changed.push(it.fav.name);
  }
  renderChangedBanner(changed);

  $('#favCount').textContent = items.length ? `${items.length} game${items.length > 1 ? 's' : ''}` : '';
  $('#favEmpty').hidden = items.length > 0;
  $('#favList').innerHTML = items.map(it => it.missing ? missingCard(it.fav) : gameCard(it)).join('');
  hydrateImages();
}

function missingCard(fav) {
  return `<article class="game">
    <div class="game-head">
      ${cover(fav.name, 'thumb')}
      <div class="game-info"><div class="game-name">${esc(fav.name)}</div><div class="game-meta">No longer in the list</div></div>
      <button class="remove" data-remove="${esc(fav.name)}" title="Remove">✕</button>
    </div>
  </article>`;
}

function gameCard({ fav, g, rows, updated }) {
  const toggles = CONSOLES.map(c => {
    const on = fav.consoles.includes(c.key);
    return `<button class="ztoggle ${on ? 'on' : ''}" data-toggle="${c.key}" data-game="${esc(fav.name)}" aria-pressed="${on}">${c.short}</button>`;
  }).join('');
  return `<article class="game ${updated ? 'updated' : ''}">
    <div class="game-head">
      ${cover(g.name, 'thumb')}
      <div class="game-info">
        <div class="game-name" title="${esc(g.name)}">${updated ? '<span class="tag upd">UPDATED</span>' : ''}${esc(g.name)}</div>
        <div class="game-meta">${esc(g.level)} · ${esc(g.rent)}</div>
        <div class="ztoggles">${toggles}</div>
      </div>
      <button class="remove" data-remove="${esc(fav.name)}" title="Remove">✕</button>
    </div>
    <div class="zrows">${rows.length ? rows.map(({ c, a }) => zRow(c, a)).join('')
      : '<p class="muted hint">Tap an account type above to see when it\'s free.</p>'}</div>
  </article>`;
}

const fmtShort = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// Fixed two-line row: status pills on top, details + price below, so every card has the same height.
function zRow(c, a) {
  let pill;
  if (a.kind === 'off') pill = '<span class="pill off">Unavailable</span>';
  else if (a.kind === 'free') pill = '<span class="pill free">Free now</span>';
  else if (a.kind === 'overdue') pill = '<span class="pill free">Should be free</span>';
  else pill = `<span class="pill wait">${fmtDate(a.date)}</span>`;
  const queue = a.queue && a.kind !== 'off' ? `<span class="pill queue">+${a.queue} in queue</span>` : '';
  const details = [
    a.kind === 'overdue' ? `Listed until ${fmtShort(a.date)}` : '',
    a.estimate ? `Your turn ≈ ${fmtShort(a.estimate)} (est.)` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="zrow">
    <span class="zlabel">${c.label}</span>
    <span class="status">${pill}${queue}</span>
    <span class="details" title="${esc(details)}">${esc(details)}</span>
    <span class="price">${a.kind === 'off' ? '' : esc(a.price)}</span>
  </div>`;
}

function renderChangedBanner(changed) {
  const old = $('#bannerChanged');
  if (old) old.remove();
  if (!changed.length) return;
  const div = document.createElement('div');
  div.id = 'bannerChanged';
  div.className = 'banner changed';
  div.innerHTML = `<div class="banner-head"><b>${changed.length} of your games changed since your last visit</b>
    <button class="link" id="ackChanged">Got it</button></div>`;
  $('#banners').append(div);
  $('#ackChanged').onclick = () => { commitSnapshot(); render(); };
}

// Remember what the user has now seen so the next change can be flagged.
function commitSnapshot() {
  const byName = new Map(games.map(g => [g.name, g]));
  const snap = {};
  for (const fav of state.favorites) {
    const g = byName.get(fav.name);
    if (g) snap[fav.name] = favStatusKey(fav, g);
  }
  state.snapshot = snap;
  saveState();
}

function renderNewBanner() {
  const old = $('#bannerNew');
  if (old) old.remove();
  const list = [...newGames].filter(n => games.some(g => g.name === n));
  if (!list.length) return;
  const names = favNames();
  const div = document.createElement('div');
  div.id = 'bannerNew';
  div.className = 'banner new';
  div.innerHTML = `<div class="banner-head"><b>🆕 ${list.length} new game${list.length > 1 ? 's' : ''} added to the list</b>
    <button class="link" id="ackNew">Dismiss</button></div>
    <ul class="new-list">${list.map(n => `<li>${cover(n, 'mini')}<span class="nm">${esc(n)}</span>${names.includes(n)
      ? '<span class="muted">Added</span>' : `<button class="btn sm" data-addnew="${esc(n)}">+ Add</button>`}</li>`).join('')}</ul>`;
  $('#banners').prepend(div);
  $('#ackNew').onclick = () => { newGames.clear(); renderNewBanner(); };
  hydrateImages();
}

function showError(msg) {
  $('#loading').hidden = true;
  const old = $('#bannerError');
  if (old) old.remove();
  if (!msg) return;
  const div = document.createElement('div');
  div.id = 'bannerError';
  div.className = 'banner error';
  div.textContent = msg;
  $('#banners').prepend(div);
}

// ---------- picker ----------

let pickLevel = 'All';
let pickDraft = new Map(); // game name -> chosen account types

// `preselect` opens the picker with that game ticked and searched for (used by the new-games banner).
function openPicker(preselect) {
  pickDraft = new Map(state.favorites.map(f => [f.name, [...f.consoles]]));
  if (preselect && !pickDraft.has(preselect)) pickDraft.set(preselect, []);
  $('#search').value = preselect || '';
  pickLevel = 'All';
  renderPicker();
  $('#picker').showModal();
}

function pickItem(g) {
  const chosen = pickDraft.get(g.name);
  const ticks = chosen ? `<div class="pick-z"><span class="muted">Rent on:</span>${CONSOLES.map(c => `
      <label class="ztick"><input type="checkbox" data-pickz="${c.key}" data-game="${esc(g.name)}" ${chosen.includes(c.key) ? 'checked' : ''}>
      ${c.label}</label>`).join('')}
      ${chosen.length ? '' : '<span class="warn">Tick at least one</span>'}</div>` : '';
  return `<div class="pick-item ${chosen ? 'sel' : ''}" data-item="${esc(g.name)}">
    <label class="pick-main">
      <input type="checkbox" value="${esc(g.name)}" ${chosen ? 'checked' : ''}>
      ${cover(g.name, 'mini')}
      <span class="nm">
        ${esc(g.name)}${newGames.has(g.name) ? '<span class="tag new">NEW</span>' : ''}
        <small>${esc(g.level)} · ${esc(g.rent)} · ${esc(priceLine(g))}</small>
      </span>
    </label>${ticks}
  </div>`;
}

function rerenderPickItem(name) {
  const el = [...document.querySelectorAll('#pickList [data-item]')].find(e => e.dataset.item === name);
  const g = games.find(x => x.name === name);
  if (el && g) el.outerHTML = pickItem(g);
  $('#pickCount').textContent = `${pickDraft.size} selected`;
  hydrateImages();
}

function renderPicker() {
  const levels = ['All', ...[...new Set(games.map(g => g.level).filter(Boolean))].sort()];
  if (newGames.size) levels.push('New');
  $('#levelChips').innerHTML = levels.map(l =>
    `<button class="chip ${l === pickLevel ? 'on' : ''}" data-level="${esc(l)}">${esc(l)}</button>`).join('');

  const q = $('#search').value.trim().toLowerCase();
  const list = games.filter(g =>
    (pickLevel === 'All' || (pickLevel === 'New' ? newGames.has(g.name) : g.level === pickLevel)) &&
    (!q || g.name.toLowerCase().includes(q)));

  $('#pickList').innerHTML = list.length ? list.map(pickItem).join('') : '<p class="muted center">No games match.</p>';
  $('#pickCount').textContent = `${pickDraft.size} selected`;
  hydrateImages();
}

// ---------- refresh & notifications ----------

async function refresh() {
  try {
    let data, lastErr;
    for (let i = 0; i < 3 && !data; i++) {  // Google is sometimes slow; retry
      try { data = await fetchSheet(); } catch (e) { lastErr = e; }
    }
    if (!data) throw lastErr;
    games = parseSheet(data);
    if (!games.length) throw new Error('Empty sheet');
    showError('');
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(games)); } catch {}

    const names = games.map(g => g.name);
    if (state.known) {
      const known = new Set(state.known);
      const added = names.filter(n => !known.has(n));
      added.forEach(n => newGames.add(n));
      if (added.length) notify(added);
    }
    state.known = names;
    saveState();

    render();
    renderNewBanner();
    if ($('#picker').open) renderPicker();
    if (games.some(g => !images[g.name])) loadImageLinks(); // e.g. pictures for newly added games
    $('#lastUpdated').textContent = `${games.length} games · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {
    console.error(e);
    showError(games.length
      ? "Couldn't refresh the game list — showing the last saved copy. Tap Refresh to try again."
      : "Couldn't load the game list. Check your connection and tap Refresh.");
  }
}

function notify(added) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const body = added.length === 1 ? added[0] : `${added.slice(0, 3).join(', ')}${added.length > 3 ? '…' : ''}`;
  try { new Notification(`${added.length} new game${added.length > 1 ? 's' : ''} for rent`, { body }); } catch {}
}

function updateNotifyButton() {
  $('#btnNotify').hidden = !('Notification' in window) || Notification.permission !== 'default';
}

// ---------- events ----------


document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('[data-close]')) t.closest('dialog').close();

  const rm = t.closest('[data-remove]');
  if (rm) {
    state.favorites = state.favorites.filter(f => f.name !== rm.dataset.remove);
    delete state.snapshot[rm.dataset.remove];
    saveState();
    render();
  }

  const toggle = t.closest('[data-toggle]');
  if (toggle) {
    const fav = findFav(toggle.dataset.game);
    const key = toggle.dataset.toggle;
    fav.consoles = fav.consoles.includes(key) ? fav.consoles.filter(k => k !== key) : [...fav.consoles, key];
    const g = games.find(x => x.name === fav.name);
    if (g) state.snapshot[fav.name] = favStatusKey(fav, g); // the user's own change isn't an "update"
    saveState();
    render();
  }

  const addNew = t.closest('[data-addnew]');
  if (addNew) openPicker(addNew.dataset.addnew);

  const chip = t.closest('[data-level]');
  if (chip) { pickLevel = chip.dataset.level; renderPicker(); }
});

$('#pickList').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.pickz) {
    // A Z tick on a selected game
    const name = t.dataset.game;
    const keys = pickDraft.get(name).filter(k => k !== t.dataset.pickz);
    pickDraft.set(name, t.checked ? [...keys, t.dataset.pickz] : keys);
    rerenderPickItem(name);
    return;
  }
  if (t.checked) pickDraft.set(t.value, []);
  else pickDraft.delete(t.value);
  rerenderPickItem(t.value);
});

$('#search').addEventListener('input', renderPicker);

$('#btnPickDone').onclick = () => {
  const kept = state.favorites.filter(f => pickDraft.has(f.name)).map(f => f.name);
  const added = [...pickDraft.keys()].filter(n => !kept.includes(n));
  state.favorites = [...kept, ...added].map(name => ({ name, consoles: pickDraft.get(name) }));
  commitSnapshot();
  $('#picker').close();
  render();
  renderNewBanner();
};

$('#btnEmptyAdd').onclick = () => openPicker();

$('#btnAdd').onclick = () => openPicker();

// ---------- dice: random free game ----------

let diceGame = null;

// The player's chosen account types on which the game is free right now with nobody waiting.
function freeConsoles(g) {
  const fav = findFav(g.name);
  return CONSOLES.filter(c => fav && fav.consoles.includes(c.key))
    .filter(c => { const a = availability(g, c); return a.kind === 'free' && !a.queue; });
}

function rollDice() {
  const byName = new Map(games.map(g => [g.name, g]));
  const pool = favNames().map(n => byName.get(n)).filter(g => g && freeConsoles(g).length);
  const choices = pool.length > 1 ? pool.filter(g => g !== diceGame) : pool;
  diceGame = choices.length ? choices[Math.floor(Math.random() * choices.length)] : null;

  const box = $('#diceResult');
  box.classList.remove('rolling');
  void box.offsetWidth; // restart the shake animation
  box.classList.add('rolling');
  $('#btnReroll').disabled = pool.length < 2;
  if (!diceGame) {
    box.innerHTML = `<p class="muted dice-empty">${state.favorites.length
      ? 'None of your games are free right now on the account types you chose.'
      : 'Add some games first, then roll the dice.'}</p>`;
    return;
  }
  const g = diceGame;
  box.innerHTML = `${cover(g.name, 'dice-cover')}
    <div class="dice-info">
      <div class="game-name" title="${esc(g.name)}">${esc(g.name)}</div>
      <div class="game-meta">${esc(g.level)} · ${esc(g.rent)}</div>
      <div class="dice-free">${freeConsoles(g).map(c => `<div>
        <span><span class="pill free">Free now</span> ${c.label}</span>
        <b>${esc(g.prices[c.priceKey] || '')}</b></div>`).join('')}</div>
      <span class="muted">${pool.length} of your games ${pool.length > 1 ? 'are' : 'is'} free now</span>
    </div>`;
}

$('#btnDice').onclick = () => {
  diceGame = null;
  rollDice();
  $('#diceDlg').showModal();
};
$('#btnReroll').onclick = rollDice;
$('#btnRefresh').onclick = refresh;
$('#btnNotify').onclick = async () => {
  try { await Notification.requestPermission(); } catch {}
  updateNotifyButton();
};

// Refresh periodically and whenever the tab comes back into view.
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

updateNotifyButton();
// Show the last saved list and picture links right away, then fetch fresh data.
try { games = JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch {}
try { images = JSON.parse(localStorage.getItem(IMG_CACHE_KEY)) || {}; } catch {}
if (games.length) render();
loadImageLinks(); // always fetch fresh links once per visit, in case the sheet's picture links changed
refresh();
