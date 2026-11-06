'use strict';

/**
 * Stock Quick Add — side panel logic.
 *
 * Flow: scan barcode -> Enter -> pick the location -> type quantity -> Enter -> write.
 * Everything is reachable from the keyboard; the mouse is never required.
 *
 * API shapes below were verified against a live ox-sys tenant:
 *   GET /variations?page=1&size=10&barcode=<code>
 *     -> { items: [...], total_count: n, page: 1 }
 *     `barcode` matches anywhere in the code, and needs at least 3 characters.
 *   item -> { id, name, productName, sku, barcode, unit,
 *             stocks: [ { id: <uuid>, count, location, sellPrice: {...} } ] }
 *
 *   POST /corrections
 *     {"location":2,"reason":"Другое",
 *      "records":[{"variation":22,"count":1,"stock":"<stocks[].id>"}]}
 *
 * Stock lives in lots — one per location (sometimes several per location, one
 * per supply batch). A correction targets ONE lot, so it needs both that lot's
 * location and its uuid; the panel makes the operator pick which.
 */

// The panel is opened to scan, so it always starts at the barcode field — never
// wherever the journal was last scrolled to.
history.scrollRestoration = 'manual';

// --- configuration -----------------------------------------------------------

// Paths are relative to https://<subdomain>.ox-sys.com
// Subdomain, token and location come from chrome.storage.local (see options.html).
// Never hardcode credentials here — these files are readable by anyone with the folder.
const SEARCH_PATH = '/variations';
const SEARCH_QUERY = { page: '1', size: '50' };
const LOCATIONS_PATH = '/locations';

const REQUEST_TIMEOUT_MS = 10000;
// Журнал приёма — в chrome.storage.local, как и журнал оплаты: переживает
// закрытие панели, общий для профилей, экспорт CSV на странице настроек.
const STOCK_LOG_KEY = 'stockLog';
const STOCK_LOG_MAX = 500;
const STOCK_LOG_SHOWN = 20;

// No real receipt is this large, and a barcode typed into the quantity box is.
const MAX_QTY = 10000;

// Below this the server's barcode filter returns nothing at all.
const MIN_QUERY = 3;

// --- state -------------------------------------------------------------------

let settings = null;       // the active profile (see profiles.js)
let profiles = [];         // every configured account, for the switcher
let currentProduct = null; // normalised product from the last successful search
let lastQuery = '';        // the code that opened the card; typing it again counts +1
let matchList = null;      // { products, index, query } while a partial code is being resolved
let selectedLotId = '';    // the lot a correction would be written against
let defaultLotMissed = false; // the account's default location had no lot; another was preselected
let defaultLotAmbiguous = false; // the preselected lot shares its location with lots at other prices
let pickerOpen = false;    // the location picker is expanded
let pickerQuery = '';      // what has been typed into its search field
let lastAction = null;     // last successful write, kept so it can be undone
let soundOn = true;        // audible confirmation, toggled in the options page
let inFlight = false;      // guards against double submission from a fast scanner
let reloadPending = false; // settings changed mid-write; applied once it lands
let statusCritical = false;// current status must survive a reload (see reportError)
let stockLog = [];         // последние записи журнала приёма (см. STOCK_LOG_KEY)
let locationNames = null;  // Map<id, name>, best-effort cache for the lot breakdown

// --- element handles ---------------------------------------------------------

const el = {
  setup: document.getElementById('setup'),
  openOptions: document.getElementById('openOptions'),
  app: document.getElementById('app'),
  acct: document.getElementById('acct'),
  profile: document.getElementById('profile'),
  profileName: document.getElementById('profileName'),
  openSettings: document.getElementById('openSettings'),
  barcode: document.getElementById('barcode'),
  status: document.getElementById('status'),
  done: document.getElementById('done'),
  doneTitle: document.getElementById('doneTitle'),
  doneSub: document.getElementById('doneSub'),
  undo: document.getElementById('undo'),
  matches: document.getElementById('matches'),
  matchesTitle: document.getElementById('matchesTitle'),
  matchesCount: document.getElementById('matchesCount'),
  matchesList: document.getElementById('matchesList'),
  matchesHint: document.getElementById('matchesHint'),
  card: document.getElementById('card'),
  pName: document.getElementById('pName'),
  pVariation: document.getElementById('pVariation'),
  skuRow: document.getElementById('skuRow'),
  pSku: document.getElementById('pSku'),
  pBarcode: document.getElementById('pBarcode'),
  pPrice: document.getElementById('pPrice'),
  pStock: document.getElementById('pStock'),
  locs: document.getElementById('locs'),
  lotHint: document.getElementById('lotHint'),
  qty: document.getElementById('qty'),
  qtyMinus: document.getElementById('qtyMinus'),
  qtyPlus: document.getElementById('qtyPlus'),
  submit: document.getElementById('submit'),
  logList: document.getElementById('logList'),
  logEmpty: document.getElementById('logEmpty'),
  logCount: document.getElementById('logCount'),
};

// --- errors ------------------------------------------------------------------

/**
 * Carries a user-facing Russian message plus a machine-readable kind so callers
 * can tell a network failure from an HTTP failure.
 * kind: 'network' | 'timeout' | 'http' | 'auth' | 'pending'
 * 'pending' means a correction was created but not approved — the operator must
 * finish it by hand, and must NOT simply retry.
 */
class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

// --- HTTP --------------------------------------------------------------------

/**
 * fetch with a 10s AbortController timeout, covering the body as well as the
 * headers. Returns { ok, status, json, text } — the body is read exactly once,
 * here, so callers never have to think about a consumed stream.
 * Auth header depends on the token type — see authHeaders().
 * A session cookie is not required: the token alone returns 200.
 * Throws ApiError for transport problems; HTTP status is left to the caller.
 */
async function request(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  // A GET that fails on the wire is retried once: a dropped connection, a DNS
  // hiccup or the laptop waking up is the usual cause, and a second try a
  // moment later succeeds. Writes are never retried — they may have landed.
  const attempts = method === 'GET' ? 2 : 1;
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce(url, options);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof ApiError) || err.kind !== 'network' || attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr;
}

async function requestOnce(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const method = String(options.method || 'GET').toUpperCase();

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...authHeaders(settings.token, settings.authScheme),
        ...(options.headers || {}),
      },
    });

    // The body is read while the timer is still armed. fetch settles as soon as
    // the HEADERS arrive, so clearing the timeout here would leave a stalled
    // body hanging forever — the form stuck on "Отправка…" with no error and no
    // way out but closing the panel.
    const { json, text } = await readBody(res);
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    // AbortError means our own timeout fired; anything else is a transport failure.
    if (err && err.name === 'AbortError') {
      throw new ApiError(`Превышено время ожидания (10 с): ${method} ${url}`, 'timeout');
    }
    // The real reason (Failed to fetch, DNS, TLS, a bad URL) only lives in the
    // console; the banner names the host so a wrong subdomain is obvious.
    console.error('[http]', method, String(url), err);
    let host = '';
    try { host = new URL(url).host; } catch { host = String(url); }
    const detail = err && err.message ? ` (${err.message})` : '';
    const e = new ApiError(`Нет связи с сервером ${host}${detail}. Проверьте интернет и адрес аккаунта в настройках.`, 'network');
    e.cause = err;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a response body once and returns { json, text }. A failure here is not
 * swallowed: mid-body it is usually our own abort, which must surface as a
 * timeout rather than as an empty success.
 */
async function readBody(res) {
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { json, text };
}

/**
 * Flattens Symfony validation payloads into "field: message" lines.
 * Handles all three shapes the backend can produce:
 *   { violations: [{ propertyPath, title|message }] }              (Problem+JSON)
 *   { errors: { children: { field: { errors: [..], children } } } } (form tree)
 *   { errors: { field: ["msg"] } } / { errors: ["msg"] }             (plain map / list)
 */
function validationLines(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;

  if (Array.isArray(json.violations)) {
    for (const v of json.violations) {
      const msg = v && (v.title || v.message || v.detail);
      if (typeof msg === 'string') out.push(v.propertyPath ? `${v.propertyPath}: ${msg}` : msg);
    }
  }

  const walk = (node, path) => {
    if (out.length >= 8 || node === null || node === undefined) return;
    if (typeof node === 'string') { out.push(path ? `${path}: ${node}` : node); return; }
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, typeof n === 'object' ? `${path}[${i}]` : path)); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.errors)) node.errors.forEach((e) => walk(e, path));
    const kids = node.children && typeof node.children === 'object' ? node.children : null;
    const map = kids || node;
    for (const [k, v] of Object.entries(map)) {
      if (!kids && (k === 'errors' || k === 'children')) continue;
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  if (json.errors && typeof json.errors === 'object') walk(json.errors, '');
  return out;
}

/** Pulls the most useful error message the server offers. */
function serverMessage(json, text, status) {
  // Validation details first: "Validation Failed" alone tells the operator nothing.
  const lines = validationLines(json);
  if (lines.length) {
    const head = typeof (json && json.message) === 'string' && json.message.trim() ? `${json.message.trim()}: ` : '';
    return head + lines.slice(0, 4).join('; ');
  }

  const candidates = [
    json && json.message,
    json && json.error_description,
    json && json.error,
    json && json.detail,
    json && json.title,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  // Fall back to a short raw body, but never dump a whole HTML error page.
  const raw = (text || '').trim();
  if (raw && raw.length <= 160 && !raw.startsWith('<')) return raw;
  return `Ошибка сервера (HTTP ${status})`;
}

/** Turns a non-2xx result into an ApiError. */
function httpError(res) {
  if (res.status === 401 || res.status === 403) {
    return new ApiError('Токен недействителен. Проверьте настройки.', 'auth', res.status);
  }
  return new ApiError(serverMessage(res.json, res.text, res.status), 'http', res.status);
}

// --- product normalisation ---------------------------------------------------

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * ox-sys returns stock as an array of lots, one per location, each with its own
 * price. The panel shows the total and the per-location split.
 */
function normalizeProduct(raw) {
  const stocks = Array.isArray(raw.stocks) ? raw.stocks : [];

  // `id` is the lot uuid the correction endpoint calls `stock`.
  // Price travels WITH the lot: two warehouses can sell the same variation at
  // different prices, and the card must show the one being corrected.
  const lots = stocks.map((lot) => ({
    id: String(lot.id || ''),
    count: toNumber(lot.count),
    location: lot.location,
    ...lotPrice(lot),
  }));

  // `name` is the variation ("128 ГБ / Белый"); `productName` is the product.
  // Plenty of catalogues set both to the same string, which printed the title
  // twice — treat that as having no variation at all.
  const name = String(raw.productName || raw.name || '—');
  const variation = raw.name && String(raw.name) !== name ? String(raw.name) : '';

  return {
    id: raw.id,
    name,
    variation,
    sku: String(raw.sku || '—'),
    barcode: String(raw.barcode || ''),
    unit: String(raw.unit || ''),
    total: lots.reduce((sum, lot) => sum + lot.count, 0),
    lots,
  };
}

/**
 * sellPrice is a multi-currency object; `first` names the primary currency,
 * with `order` and UZS as fallbacks (the same order payment.js reads amounts in).
 */
function lotPrice(lot) {
  const price = lot && lot.sellPrice;
  if (!price || typeof price !== 'object') return { price: null, currency: null };

  const keys = [];
  if (typeof price.first === 'string') keys.push(price.first);
  if (Array.isArray(price.order)) keys.push(...price.order.filter((k) => typeof k === 'string'));
  keys.push('UZS');

  for (const currency of keys) {
    const v = price[currency];
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) {
      return { price: Number(v), currency };
    }
  }
  return { price: null, currency: null };
}

/** Lots compared by what the shop floor sees: the shelf price. */
function samePrice(a, b) {
  return a.price === b.price && a.currency === b.currency;
}

/**
 * One variation can sit in several lots at different prices — across
 * warehouses, and within one warehouse when batches arrived at different
 * prices. Stock added to a lot sells at THAT lot's price, so whenever prices
 * differ the operator has to see them before choosing.
 */
function lotsVaryInPrice(lots) {
  return lots.some((lot) => !samePrice(lot, lots[0]));
}

/**
 * The API's `barcode` filter is a SUBSTRING match, verified against a live
 * tenant: "345268" and "35133" both return "4783513345268". So a part of the
 * code typed by hand costs the same single request as a full scan.
 *
 * A full scan resolves to its exact match. Anything else comes back as
 * `partial` for the operator to confirm — a scanner that dropped a digit lands
 * there too, and must never be mistaken for an exact hit.
 */
function selectMatches(json, code) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  const exact = items.filter((i) => String(i.barcode || '').trim() === code);
  if (exact.length === 1) return { product: normalizeProduct(exact[0]) };

  // Two products sharing one barcode are offered as a choice, like a partial.
  // Otherwise the server's matches are re-checked against the code locally.
  const found = exact.length
    ? exact
    : items.filter((i) => String(i.barcode || '').includes(code));
  if (!found.length) return { none: true };

  // total_count counts every match; only the first page is in hand.
  const total = exact.length ? exact.length : Math.max(toNumber(json.total_count), found.length);
  return { partial: found.map(normalizeProduct), total };
}

const numberFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? numberFmt.format(n) : '—';
}

function formatPrice(value, currency) {
  if (value === null) return '—';
  if (!currency) return formatNumber(value);
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      // "150 000 UZS", not "150 000,00 UZS" — the price sits in a narrow picker row.
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    // Unknown ISO code — fall back to a plain number plus the raw code.
    return `${formatNumber(value)} ${currency}`;
  }
}

function locationLabel(id) {
  if (locationNames && locationNames.has(id)) return locationNames.get(id);
  return `Локация ${id}`;
}

// --- sound -------------------------------------------------------------------

/**
 * Short synthesised tones — no audio files to ship or load. An operator watching
 * the goods rather than the screen needs the outcome of a scan to be audible,
 * and the three results have to be distinguishable without looking.
 */
let audio = null;

const TONES = {
  ok: [[880, 0.07, 0.18, 'sine'], [1318.5, 0.10, 0.18, 'sine']],      // rising two-note
  undone: [[880, 0.07, 0.16, 'sine'], [587.3, 0.11, 0.16, 'sine']],   // the same, falling
  tick: [[1400, 0.035, 0.09, 'sine']],                                // quiet, for +1
  err: [[196, 0.22, 0.20, 'square']],                                 // low and obviously wrong
};

function audioContext() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;

  if (!audio) audio = new Ctx();
  // Autoplay policy suspends the context until a gesture; every caller here is
  // downstream of a keypress or a click, so resuming is allowed.
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

function tone(ctx, startAt, freq, duration, peak, type) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  // Ramped, not switched: a square-edged start or stop is an audible click.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

function beep(kind) {
  if (!soundOn) return;

  const spec = TONES[kind];
  if (!spec) return;

  try {
    const ctx = audioContext();
    if (!ctx) return;

    let at = ctx.currentTime;
    for (const [freq, duration, peak, type] of spec) {
      tone(ctx, at, freq, duration, peak, type);
      at += duration * 0.9;
    }
  } catch {
    // Sound is a courtesy; it must never interrupt the actual work.
  }
}

// --- UI helpers --------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHECK_PATH = 'M20 6.5L9 17.5l-5-5';
const BANG_PATHS = ['M12 6v8', 'M12 18.2h.01'];

/** Icons are built node by node — this file never touches innerHTML. */
function icon(paths, size, strokeWidth) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('width', String(size));
  node.setAttribute('height', String(size));
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', String(strokeWidth));
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    node.appendChild(path);
  }
  return node;
}

function bannerIcon(kind) {
  const span = document.createElement('span');
  span.className = `banner__i banner__i--${kind}`;
  span.appendChild(kind === 'ok' ? icon([CHECK_PATH], 16, 3.2) : icon(BANG_PATHS, 16, 3));
  return span;
}

function bannerBody(title, sub) {
  const wrap = document.createElement('div');

  const heading = document.createElement('div');
  heading.className = 'banner__t';
  heading.textContent = title;
  wrap.appendChild(heading);

  if (sub) {
    const detail = document.createElement('div');
    detail.className = 'banner__s';
    detail.textContent = sub;
    wrap.appendChild(detail);
  }
  return wrap;
}

/**
 * One element serves both jobs: quiet grey text while a request is in flight,
 * a full banner when something went wrong. Progress should not shout.
 */
function showStatus(text, isError = false) {
  el.status.textContent = '';
  statusCritical = false;

  if (!isError) {
    el.status.className = 'note note--left';
    el.status.textContent = text;
    el.status.hidden = false;
    return;
  }

  el.status.className = 'banner';
  el.status.append(bannerIcon('err'), bannerBody(text));
  el.status.hidden = false;
}

function clearStatus() {
  el.status.textContent = '';
  el.status.hidden = true;
  statusCritical = false;
}

/** Error banner carrying an action — used for the auth prompt. */
function showStatusWithAction(text, buttonLabel, onClick) {
  el.status.textContent = '';
  el.status.className = 'banner';
  statusCritical = false;

  const body = bannerBody(text);

  const actions = document.createElement('div');
  actions.className = 'banner__a';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link';
  btn.textContent = buttonLabel;
  btn.addEventListener('click', onClick);

  actions.appendChild(btn);
  body.appendChild(actions);

  el.status.append(bannerIcon('err'), body);
  el.status.hidden = false;
}

/** Sticks around until the next scan, unlike a toast nobody manages to read. */
function showDone(title, sub, undoable) {
  el.doneTitle.textContent = title;
  el.doneSub.textContent = sub;
  el.undo.hidden = !undoable;
  el.done.hidden = false;
}

function hideDone() {
  el.done.hidden = true;
}

function hideCard() {
  el.card.hidden = true;
  currentProduct = null;
  lastQuery = '';
  selectedLotId = '';
  pickerOpen = false;
  pickerQuery = '';
  hideMatches();
}

function openProduct(product, query) {
  hideMatches();
  currentProduct = product;
  lastQuery = query;
  renderCard(product);
}

// --- partial matches ---------------------------------------------------------

/**
 * Several products contain the typed digits. Focus stays in the barcode field
 * the whole time — the arrows move the highlight from there and Enter on the
 * emptied field opens it — so a scan arriving now is still a new search.
 */
function showMatches(products, total, query) {
  matchList = { products, index: 0, query };

  el.matchesTitle.textContent = `Совпадения «${query}»`;
  const more = total > products.length;
  el.matchesCount.textContent = more
    ? `${products.length} из ${formatNumber(total)}`
    : String(products.length);
  el.matchesHint.textContent = more
    ? 'Показаны первые — введите больше цифр, чтобы сузить поиск'
    : '↑ ↓ — выбор · Enter — открыть · Esc — отмена';

  renderMatches();
  el.matches.hidden = false;
}

function hideMatches() {
  el.matches.hidden = true;
  el.matchesList.textContent = '';
  matchList = null;
}

function renderMatches() {
  el.matchesList.textContent = '';
  const { products, index, query } = matchList;

  products.forEach((product, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'row picker__opt';
    if (i === index) item.classList.add('picker__opt--on');

    const label = document.createElement('span');
    label.textContent = product.variation ? `${product.name} · ${product.variation}` : product.name;

    item.append(label, markedBarcode(product.barcode, query));
    item.addEventListener('click', () => pickMatch(i));
    el.matchesList.appendChild(item);
  });

  const on = el.matchesList.children[index];
  if (on) on.scrollIntoView({ block: 'nearest' });
}

/** The barcode with the typed digits in bold, so the operator sees why it matched. */
function markedBarcode(barcode, query) {
  const span = document.createElement('span');
  span.className = 'row__v matches__code';

  const at = barcode.indexOf(query);
  if (at < 0) {
    span.textContent = barcode || '—';
    return span;
  }

  const hit = document.createElement('b');
  hit.textContent = barcode.slice(at, at + query.length);
  span.append(barcode.slice(0, at), hit, barcode.slice(at + query.length));
  return span;
}

function moveMatch(delta) {
  const last = matchList.products.length - 1;
  matchList.index = Math.min(last, Math.max(0, matchList.index + delta));
  renderMatches();
}

function pickMatch(i) {
  if (inFlight || !matchList) return;
  const product = matchList.products[i];
  if (!product) return;

  clearStatus();
  openProduct(product, matchList.query);
  // A click moved focus onto the row; the scanner needs it back.
  focusBarcode();
}

function renderCard(product) {
  // textContent everywhere: server-supplied names must never be parsed as HTML.
  el.pName.textContent = product.name;

  el.pVariation.textContent = product.variation;
  el.pVariation.hidden = !product.variation;

  // Many catalogues use the barcode as the SKU; one row is enough for that.
  el.pSku.textContent = product.sku;
  el.skuRow.hidden = product.sku === product.barcode;

  el.pBarcode.textContent = product.barcode || '—';
  // pPrice is filled by renderLocationPicker: the price belongs to the lot.
  el.pStock.textContent = product.unit
    ? `${formatNumber(product.total)} ${product.unit}`
    : formatNumber(product.total);

  chooseDefaultLot(product);
  renderLocationPicker(product);

  el.qty.value = '1';
  el.card.hidden = false;
}

/**
 * Prefer the location configured for this account, else the first lot. The
 * fallback is a DIFFERENT warehouse than the operator expects, so it is flagged
 * (see renderLocationPicker) rather than taken quietly.
 */
function chooseDefaultLot(product) {
  const preferred = settings.locationId
    ? product.lots.find((l) => String(l.location) === settings.locationId)
    : null;

  const chosen = preferred || product.lots[0] || null;
  selectedLotId = chosen ? chosen.id : '';
  defaultLotMissed = Boolean(settings.locationId) && !preferred && Boolean(selectedLotId);

  // Several batches in the chosen location at different prices: the first one
  // listed is just the API's order, not a decision. Flag it like a missed default.
  defaultLotAmbiguous = Boolean(chosen) && product.lots.some((l) => l !== chosen
    && String(l.location) === String(chosen.location)
    && !samePrice(l, chosen));
}

const CHEVRON_PATH = 'M6 9.5l6 6 6-6';

/**
 * Lots, flattened for the picker. A correction targets one specific lot, so the
 * options are lots and not locations: where a location holds several supply
 * batches each is offered separately. Locations holding nothing are listed too,
 * disabled — leaving them out reads as the list being broken.
 */
function lotOptions(product) {
  const byLocation = new Map();
  for (const lot of product.lots) {
    if (!byLocation.has(lot.location)) byLocation.set(lot.location, []);
    byLocation.get(lot.location).push(lot);
  }

  const countOf = (lot) => (product.unit
    ? `${formatNumber(lot.count)} ${product.unit}`
    : formatNumber(lot.count));

  // Price goes on every row as soon as any two lots differ, so lots can be
  // compared across warehouses as well as within one.
  const showPrice = lotsVaryInPrice(product.lots);

  const options = [];
  for (const [location, lots] of byLocation) {
    for (const lot of lots) {
      // The price already tells batches apart; the id is only needed for
      // batches in one location that also share a price.
      const twin = lots.some((other) => other !== lot && samePrice(other, lot));
      options.push({
        id: lot.id,
        lot,
        label: locationLabel(location) + (twin ? ` · ${lot.id.slice(0, 8)}` : ''),
        detail: showPrice
          ? `${countOf(lot)} · ${formatPrice(lot.price, lot.currency)}`
          : countOf(lot),
        disabled: false,
      });
    }
  }

  if (locationNames) {
    for (const [id, label] of locationNames) {
      if (byLocation.has(id)) continue;
      options.push({ id: '', lot: null, label, detail: 'нет остатка', disabled: true });
    }
  }

  return options;
}

/**
 * One collapsed row showing the chosen lot, which expands into a searchable
 * list. A native <select> was the picker here until a tenant with a hundred
 * warehouses turned the platform menu into a scroll hunt — the operator knows
 * the name of the location they want, so let them type it.
 */
function renderLocationPicker(product) {
  el.locs.textContent = '';

  const options = lotOptions(product);
  const selected = options.find((o) => !o.disabled && o.id === selectedLotId) || null;
  const usable = Boolean(selected);

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row row--menu';
  row.classList.toggle('row--empty', !usable);
  row.disabled = !usable || inFlight;
  row.setAttribute('aria-expanded', String(pickerOpen));

  const name = document.createElement('span');
  name.textContent = usable ? selected.label : 'Нет остатка';

  const value = document.createElement('span');
  value.className = 'row__v';
  value.textContent = usable ? selected.detail : '';

  const chevron = document.createElement('span');
  chevron.className = 'row__chev';
  chevron.appendChild(icon([CHEVRON_PATH], 13, 3));

  row.append(name, value, chevron);
  row.addEventListener('click', () => togglePicker(product));
  el.locs.appendChild(row);

  if (pickerOpen && usable) el.locs.appendChild(pickerBody(product, options));

  // Price travels with the lot, so the card follows the selection rather than
  // showing whichever warehouse the API happened to list first.
  el.pPrice.textContent = usable ? formatPrice(selected.lot.price, selected.lot.currency) : '—';

  // Shown until the operator picks a lot themselves (chooseLot clears both).
  const warn = usable && (defaultLotMissed || defaultLotAmbiguous);
  row.classList.toggle('row--warn', warn);

  if (!usable) {
    el.lotHint.textContent = 'Нет остатка ни на одной локации — коррекцией товар не добавить.';
  } else if (defaultLotMissed) {
    el.lotHint.textContent = `На локации по умолчанию (${locationLabel(toId(settings.locationId) ?? settings.locationId)}) ` +
      `этого товара нет — выбрана «${selected.label}» (${selected.detail}). Проверьте перед добавлением.`;
  } else if (defaultLotAmbiguous) {
    el.lotHint.textContent = `На локации «${locationLabel(selected.lot.location)}» несколько партий с разной ценой — ` +
      `выбрана ${formatPrice(selected.lot.price, selected.lot.currency)}. Проверьте перед добавлением.`;
  } else {
    el.lotHint.textContent = '';
  }
  el.lotHint.classList.toggle('note--warn', warn);
  el.lotHint.hidden = usable && !warn;
  el.submit.disabled = inFlight || !usable;
}

/** The expanded half: a search field over a filtered list of lots. */
function pickerBody(product, options) {
  const wrap = document.createElement('div');
  wrap.className = 'picker';

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'picker__input';
  search.placeholder = 'Поиск локации';
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.value = pickerQuery;

  const list = document.createElement('div');
  list.className = 'picker__list';

  // Only the list is repainted while typing, so the search field keeps focus
  // and the caret stays where the operator left it.
  const paint = () => {
    list.textContent = '';

    const matches = filterOptions(options, pickerQuery);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'note note--left picker__empty';
      empty.textContent = 'Ничего не найдено';
      list.appendChild(empty);
      return;
    }

    for (const option of matches) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'row picker__opt';
      item.disabled = option.disabled;
      if (option.id && option.id === selectedLotId) item.classList.add('picker__opt--on');

      const label = document.createElement('span');
      label.textContent = option.label;

      const detail = document.createElement('span');
      detail.className = 'row__v';
      detail.textContent = option.detail;

      item.append(label, detail);
      item.addEventListener('click', () => chooseLot(product, option.id));
      list.appendChild(item);
    }
  };

  search.addEventListener('input', () => {
    pickerQuery = search.value;
    paint();
  });
  search.addEventListener('keydown', (e) => onPickerKey(e, product, options));

  wrap.append(search, list);
  paint();

  // The picker was opened deliberately, so the search field takes the caret —
  // otherwise the first thing typed goes nowhere.
  requestAnimationFrame(() => search.focus());
  return wrap;
}

function filterOptions(options, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((o) => o.label.toLowerCase().includes(needle));
}

/**
 * A USB scanner types into whatever holds the caret, and while the picker is
 * open that is the search box. A scanned code would sit there matching nothing
 * and the operator would read it as the item failing — so a run of digits on
 * Enter is treated as the scan it plainly is and handed to the barcode field.
 * Otherwise Enter takes the first match, which is what typing a name is for.
 */
function onPickerKey(e, product, options) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePicker(product);
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();

  const query = pickerQuery.trim();

  if (/^\d{6,}$/.test(query)) {
    pickerOpen = false;
    pickerQuery = '';
    renderLocationPicker(product);
    el.barcode.value = query;
    onBarcodeEnter();
    return;
  }

  const match = filterOptions(options, query).find((o) => !o.disabled);
  if (match) chooseLot(product, match.id);
}

function togglePicker(product) {
  if (inFlight) return;
  pickerOpen = !pickerOpen;
  pickerQuery = '';
  renderLocationPicker(product);
  // Collapsing hands the caret back to the scanner; opening gives it to search.
  if (!pickerOpen) focusBarcode();
}

/**
 * Closing always returns focus to the barcode field. Every other handler in
 * this file ends the same way: focus that lands on <body> means the next scan
 * is typed into nothing at all and is silently lost.
 */
function closePicker(product) {
  pickerOpen = false;
  pickerQuery = '';
  renderLocationPicker(product);
  focusBarcode();
}

function chooseLot(product, id) {
  if (inFlight || !id) return;
  selectedLotId = id;
  defaultLotMissed = false;
  defaultLotAmbiguous = false;
  closePicker(product);
}

function selectedLot(product) {
  return product.lots.find((l) => l.id === selectedLotId) || null;
}

// The payment tool has its own busy flag; it registers a getter here so the
// switcher lock can consider both tools without panel.js knowing pmBusy.
let externalBusy = () => false;

/**
 * The switcher's disabled state depends on the profile count AND on whether
 * either tool is mid-request. It must be recomputed whenever any of those
 * change: a second company added while the panel sits open does not change
 * the active account, so the reload path never runs, and a select left
 * disabled by an earlier request would ignore every click.
 */
function syncProfileSwitcher() {
  el.profile.disabled = inFlight || externalBusy() || profiles.length < 2;
}

/** The switcher is a transparent select over the name; hidden with one account. */
function renderProfiles() {
  el.profile.textContent = '';

  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = profileLabel(p);
    el.profile.appendChild(opt);
  }

  if (settings) {
    el.profile.value = settings.id;
    el.profileName.textContent = profileLabel(settings);
  }
  el.acct.classList.toggle('acct--single', profiles.length < 2);
  syncProfileSwitcher();
}

/**
 * focus() alone is not enough: on a field that already has the caret it does
 * not scroll, so a panel left scrolled down the journal reopened there.
 */
function scrollToTop() {
  window.scrollTo(0, 0);
}

function focusBarcode() {
  // The payment tool owns focus while its view is up (see payment.js).
  const stockView = document.getElementById('stockView');
  if (stockView && stockView.hidden) return;
  el.barcode.focus();
  el.barcode.select();
}

/** Clamped at 1: a correction of zero writes a document that changes nothing. */
function stepQty(delta) {
  const current = Number.parseInt(el.qty.value, 10);
  const next = (Number.isFinite(current) ? current : 1) + delta;
  el.qty.value = String(Math.min(MAX_QTY, Math.max(1, next)));
}

/**
 * The quantity, or null when the field cannot be trusted — the message is shown
 * here so callers just bail.
 *
 * A USB scanner types wherever the cursor is, and a barcode landing in this box
 * parses as a perfectly good number: Number.parseInt('4780000000229') is a
 * correction of four trillion units, approved automatically a moment later. So
 * the field is read as digits and bounded, not merely parsed. The same check
 * catches '2.5' (silently truncated to 2) and '1e5' (silently 1).
 */
function readQuantity() {
  const raw = el.qty.value.trim();
  const invalid = (message) => {
    showStatus(message, true);
    el.qty.focus();
    el.qty.select();
    return null;
  };

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return invalid('Количество — целое число, не меньше 1');
  }
  if (Number(raw) > MAX_QTY) {
    return invalid(`Больше ${formatNumber(MAX_QTY)} за раз не проводим — похоже, в это поле попал штрихкод`);
  }
  return Number(raw);
}

/** Locks the whole form while a request is in flight. */
function setBusy(busy) {
  inFlight = busy;
  // A product with no lot anywhere cannot be corrected, so the write stays shut
  // even when nothing is in flight.
  const noLot = Boolean(currentProduct) && !selectedLotId;

  el.barcode.disabled = busy;
  syncProfileSwitcher();
  const picker = el.locs.querySelector('.row--menu');
  if (picker) picker.disabled = busy || !selectedLotId;
  el.qty.disabled = busy;
  el.qtyMinus.disabled = busy;
  el.qtyPlus.disabled = busy;
  el.submit.disabled = busy || noLot;
  el.undo.disabled = busy;

  // A settings change that arrived mid-write could not be applied then; the
  // request in flight was using the old profile. Apply it now, or the panel
  // keeps scanning and writing against the account it has already left.
  if (!busy && reloadPending) {
    reloadPending = false;
    applyStorageChange();
  }
}

// --- journal -----------------------------------------------------------------

async function readStockLog() {
  const s = await chrome.storage.local.get(STOCK_LOG_KEY);
  return Array.isArray(s[STOCK_LOG_KEY]) ? s[STOCK_LOG_KEY] : [];
}

/**
 * Одна запись на каждую подтверждённую коррекцию, включая откат (quantity < 0).
 * Перед записью журнал перечитывается: страница настроек могла его очистить.
 */
async function addLogEntry(name, quantity, location, correctionId, status) {
  const entry = {
    at: new Date().toISOString(),
    profile: settings ? profileLabel(settings) : '',
    host: settings ? `${settings.subdomain}.${settings.domain}` : '',
    name,
    quantity,
    location,
    correctionId: correctionId === undefined || correctionId === null ? '' : String(correctionId),
  };
  // Only a write that did not finish carries a status; older entries have none.
  if (status) entry.status = status;
  try {
    const log = await readStockLog();
    log.unshift(entry);
    stockLog = log.slice(0, STOCK_LOG_MAX);
    await chrome.storage.local.set({ [STOCK_LOG_KEY]: stockLog });
  } catch (err) {
    // Запись в склад уже прошла; журнал — вторичен и не должен ронять поток.
    console.error('[stock] journal write failed:', err);
    stockLog.unshift(entry);
  }
  renderLog();
}

function logTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderLog() {
  el.logList.textContent = '';
  const shown = stockLog.slice(0, STOCK_LOG_SHOWN);

  for (const entry of shown) {
    const li = document.createElement('li');
    li.className = 'li';

    const left = document.createElement('div');

    const name = document.createElement('div');
    name.className = 'li__n';
    name.textContent = entry.name;

    const meta = document.createElement('div');
    meta.className = 'li__m';
    const when = logTime(entry.at) || entry.time || '';
    meta.textContent = entry.location ? `${when} · ${entry.location}` : when;

    left.append(name, meta);

    // A correction that may exist unapproved is the one row that needs action.
    if (entry.status === 'pending') {
      const warn = document.createElement('div');
      warn.className = 'li__w';
      warn.textContent = entry.correctionId
        ? `⚠ не подтверждена №${entry.correctionId} — проверьте в ox-sys`
        : '⚠ результат неизвестен — проверьте в ox-sys';
      left.appendChild(warn);
    }

    const qty = document.createElement('span');
    qty.className = entry.quantity < 0 ? 'li__q li__q--neg' : 'li__q';
    if (entry.status === 'pending') qty.classList.add('li__q--pending');
    // A rollback reads as a real minus sign, not a hyphen.
    qty.textContent = entry.quantity < 0
      ? `−${Math.abs(entry.quantity)}`
      : `+${entry.quantity}`;

    li.append(left, qty);
    el.logList.appendChild(li);
  }

  el.logCount.textContent = String(stockLog.length);
  el.logEmpty.hidden = stockLog.length > 0;
  el.logList.hidden = stockLog.length === 0;
}

// Страница настроек может очистить журнал, пока панель открыта.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STOCK_LOG_KEY]) return;
  stockLog = Array.isArray(changes[STOCK_LOG_KEY].newValue) ? changes[STOCK_LOG_KEY].newValue : [];
  renderLog();
});

// --- operations --------------------------------------------------------------

/** Best-effort: used only to label the per-location breakdown. */
async function loadLocations() {
  try {
    const url = profileUrl(settings, LOCATIONS_PATH, { page: '1', size: '100' });

    const res = await request(url.toString(), { method: 'GET' });
    if (!res.ok) return;

    const items = res.json && Array.isArray(res.json.items) ? res.json.items : [];
    locationNames = new Map(items.map((l) => [l.id, String(l.name || `Локация ${l.id}`)]));

    // Names usually arrive after the first scan of a session. Re-render the open
    // card, or it shows raw ids for as long as that card is up.
    if (currentProduct) renderLocationPicker(currentProduct);
  } catch {
    // Names are cosmetic; ids are shown if this fails.
  }
}

async function searchByBarcode(code) {
  const url = profileUrl(settings, SEARCH_PATH, { ...SEARCH_QUERY, barcode: code });

  const res = await request(url.toString(), { method: 'GET' });
  if (!res.ok) throw httpError(res);

  return selectMatches(res.json, code);
}

/**
 * A correction is a two-step write. POST /corrections only creates the document
 * — it comes back `approved: false` and moves no stock. Stock changes when
 * POST /corrections/<id>/approve is called. The web UI does both, two seconds
 * apart, which is why a hand-run curl appears to work in one call.
 */

/**
 * Body for POST /corrections, confirmed against the live API.
 *
 * `count` is a DELTA, not an absolute: sending 1 against a lot holding 6 leaves
 * 7. `stock` is the lot uuid and `location` must be that same lot's location —
 * both come from the option the operator picked, never from the settings.
 */
function buildCorrectionBody(product, lot, quantity) {
  return {
    location: lot.location,
    reason: settings.reason,
    records: [
      { variation: product.id, count: quantity, stock: lot.id },
    ],
  };
}

/** Ids come back as numbers from some endpoints and as digit strings elsewhere. */
function toId(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** The created correction's id, wherever the API chose to put it. */
function correctionId(json) {
  if (!json) return null;
  for (const candidate of [json.id, json.correction && json.correction.id, json.data && json.data.id]) {
    const id = toId(candidate);
    if (id !== null) return id;
  }
  return null;
}

/** Does this listed correction hold exactly the record we just posted? */
function matchesWrite(item, product, lot, quantity) {
  const records = Array.isArray(item && item.records) ? item.records : [];
  return records.some((r) => r
    && String(r.stock || '') === lot.id
    && String(r.variation ?? '') === String(product.id)
    && Number(r.count) === quantity);
}

/**
 * Fallback for when the POST body carries no id. Approving is what actually
 * moves stock, so the candidate is IDENTIFIED, never assumed: taking the newest
 * row on faith approves a colleague's correction whenever one is created in the
 * same tenant in between — moving the wrong stock and reporting success. A row
 * only qualifies if it is still unapproved and carries our exact lot, variation
 * and count. No match means no approval; the caller reports it as pending.
 */
async function matchingCorrectionId(product, lot, quantity) {
  const url = profileUrl(settings, settings.stockPath, { page: '1', size: '5' });

  const res = await request(url.toString(), { method: 'GET' });
  if (!res.ok) return null;

  const items = res.json && Array.isArray(res.json.items) ? res.json.items : [];
  for (const item of items) {
    if (item && item.approved) continue;
    if (matchesWrite(item, product, lot, quantity)) return toId(item.id);
  }
  return null;
}

async function approveCorrection(id) {
  const url = profileUrl(settings, `${settings.stockPath}/${id}/approve`);
  const res = await request(url.toString(), { method: 'POST' });
  if (!res.ok) throw httpError(res);
}

/** Creates the correction, then approves it — stock only moves on the second call. */
async function writeStock(product, lot, quantity) {
  let id;
  try {
    const res = await request(profileUrl(settings, settings.stockPath).toString(), {
      method: settings.stockMethod,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCorrectionBody(product, lot, quantity)),
    });
    if (!res.ok) throw httpError(res);
    id = correctionId(res.json) ?? await matchingCorrectionId(product, lot, quantity);
  } catch (err) {
    // A POST that timed out or lost its connection may well have landed — the
    // answer is what went missing. Retrying blind writes a duplicate, so look
    // for our document first; if it cannot be found the outcome is unknown and
    // the operator must check before sending again.
    if (!(err instanceof ApiError) || (err.kind !== 'timeout' && err.kind !== 'network')) throw err;
    id = await matchingCorrectionId(product, lot, quantity).catch(() => null);
    if (id === null) {
      throw new ApiError(
        `Ответ сервера не получен (${err.message}) — коррекция могла создаться. ` +
        'Проверьте её в ox-sys перед повторной отправкой.',
        'pending'
      );
    }
  }

  if (id === null) {
    throw new ApiError(
      'Коррекция создана, но её номер не получен. Подтвердите её в ox-sys вручную — ' +
      'повторная отправка создаст дубль.',
      'pending'
    );
  }

  try {
    await approveCorrection(id);
  } catch (err) {
    // The document exists and has moved nothing. Repeating the whole operation
    // would create a SECOND correction, so spell out the safe way forward.
    const pending = new ApiError(
      `Коррекция №${id} создана, но не подтверждена: ${err.message} ` +
      'Подтвердите её в ox-sys — повторная отправка создаст дубль.',
      'pending'
    );
    pending.correctionId = id;
    throw pending;
  }

  return id;
}

// --- handlers ----------------------------------------------------------------

function handleAuthError() {
  hideCard();
  showStatusWithAction(
    'Токен недействителен. Проверьте настройки.',
    'Открыть настройки',
    () => chrome.runtime.openOptionsPage()
  );
}

/** Every thrown error reaches the operator through exactly one surface. */
function reportError(err) {
  if (err instanceof ApiError && err.kind === 'auth') {
    handleAuthError();
    return;
  }
  showStatus(err instanceof ApiError ? err.message : 'Неизвестная ошибка', true);
  // A 'pending' correction names a document the operator still has to approve by
  // hand. Nothing may wipe that off the screen — see applyStorageChange().
  statusCritical = err instanceof ApiError && err.kind === 'pending';
}

async function onBarcodeEnter() {
  if (inFlight) return;

  const code = el.barcode.value.trim();

  // Enter on an empty field opens the highlighted match, or commits the open
  // card, so a whole item can be counted and filed without leaving the scanner.
  if (!code) {
    if (matchList) pickMatch(matchList.index);
    else if (currentProduct) onSubmit();
    return;
  }

  // Same code again — scanned, or the same digits typed — counts another one
  // instead of repeating the search.
  if (currentProduct && (code === currentProduct.barcode || code === lastQuery)) {
    stepQty(1);
    el.barcode.value = '';
    beep('tick');
    return;
  }

  // Any other code while a card is open would throw the counted quantity away
  // unwritten — the operator has already put that box down. Refuse it; Enter
  // writes the card, Esc drops it.
  if (currentProduct) {
    showStatus('Сначала добавьте товар (Enter) или уберите карточку (Esc)', true);
    beep('err');
    el.barcode.value = '';
    return;
  }

  // The server ignores shorter queries; say so instead of "не найден". The card
  // stays: a stray keypress must not throw away an item already counted.
  if (code.length < MIN_QUERY) {
    showStatus(`Введите не меньше ${MIN_QUERY} цифр штрихкода`, true);
    beep('err');
    return;
  }

  hideCard();
  hideDone();
  scrollToTop();
  setBusy(true);
  showStatus('Поиск…');

  try {
    const result = await searchByBarcode(code);

    if (result.none) {
      showStatus('Товар не найден', true);
      beep('err');
      return;
    }

    if (result.product) {
      clearStatus();
      openProduct(result.product, code);
    } else if (result.partial.length === 1) {
      // Opened straight away, but labelled: a scanner that dropped a digit
      // lands here too, and the operator should see it was not an exact hit.
      openProduct(result.partial[0], code);
      showStatus(`Найден по части штрихкода «${code}»`);
    } else {
      clearStatus();
      showMatches(result.partial, result.total, code);
    }
    // Cleared so the next scan is either a repeat (+1) or a different product;
    // the code itself stays visible on the card or in the list title.
    el.barcode.value = '';
  } catch (err) {
    reportError(err);
    beep('err');
  } finally {
    setBusy(false);
    // Focus never leaves the barcode field. A scanner types wherever the cursor
    // is, and a barcode landing in the quantity box would post a correction of
    // several billion units.
    focusBarcode();
  }
}

async function onSubmit() {
  if (inFlight || !currentProduct) return;

  const lot = selectedLot(currentProduct);
  if (!lot) {
    showStatus('Выберите локацию с остатком', true);
    return;
  }

  const quantity = readQuantity();
  if (quantity === null) return;

  const product = currentProduct;
  // With several accounts in play, a bare location name is ambiguous; with lots
  // at different prices, so is a bare location — the journal names the price.
  const place = lotsVaryInPrice(product.lots)
    ? `${locationLabel(lot.location)} · ${formatPrice(lot.price, lot.currency)}`
    : locationLabel(lot.location);
  const where = profiles.length > 1 ? `${profileLabel(settings)} · ${place}` : place;

  setBusy(true);
  showStatus('Отправка…');

  try {
    const id = await writeStock(product, lot, quantity);

    await addLogEntry(product.name, quantity, where, id);
    lastAction = { product, lot, quantity, where };
    showDone(`${product.name} +${quantity}`, `${where} · коррекция №${id} подтверждена`, true);
    beep('ok');

    // Success: clear the form completely and go back to scanning.
    el.barcode.value = '';
    el.qty.value = '1';
    hideCard();
    clearStatus();
    scrollToTop();
  } catch (err) {
    clearStatus();
    reportError(err);
    beep('err');

    // 'pending' means the document EXISTS and only needs approving by hand.
    // Enter is the operator's reflex on an error, and here it would create a
    // second correction — so the card goes away and there is nothing left to
    // resend. The warning itself survives (see statusCritical).
    if (err instanceof ApiError && err.kind === 'pending') {
      hideCard();
      el.barcode.value = '';
      // The banner goes with the next scan; the journal keeps the document.
      await addLogEntry(product.name, quantity, where, err.correctionId, 'pending');
    }
    // Any other failure: leave the form as it is so the operator can retry.
  } finally {
    setBusy(false);
    focusBarcode();
  }
}

/**
 * Rolls the last write back with an opposite correction rather than deleting
 * the original: an audited stock ledger should show both the mistake and the
 * fix. Offered for the most recent write only, and only until the next scan.
 */
async function onUndo() {
  if (inFlight || !lastAction) return;

  const { product, lot, quantity, where } = lastAction;

  setBusy(true);
  showStatus('Отмена…');

  try {
    const id = await writeStock(product, lot, -quantity);

    await addLogEntry(product.name, -quantity, where, id);
    lastAction = null;
    showDone(`Отменено: ${product.name} −${quantity}`, `${where} · коррекция №${id}`, false);
    clearStatus();
    beep('undone');
  } catch (err) {
    clearStatus();
    reportError(err);
    beep('err');

    // The reversal document exists; pressing Отменить again would write a
    // second one and take the stock down twice.
    if (err instanceof ApiError && err.kind === 'pending') {
      lastAction = null;
      hideDone();
      await addLogEntry(product.name, -quantity, where, err.correctionId, 'pending');
    }
  } finally {
    setBusy(false);
    focusBarcode();
  }
}

// --- wiring ------------------------------------------------------------------

function bindEvents() {
  // A USB scanner is just a keyboard: it types the code and sends Enter.
  el.barcode.addEventListener('keydown', (e) => {
    // While partial matches are listed the arrows and Esc drive the list, so
    // the caret never has to leave the field the scanner types into.
    if (matchList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      moveMatch(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (matchList && e.key === 'Escape') {
      e.preventDefault();
      hideMatches();
      return;
    }
    // Esc drops the open card unwritten — the deliberate way out, since a scan
    // of another product is refused while one is open (see onBarcodeEnter).
    if (currentProduct && e.key === 'Escape' && !inFlight) {
      e.preventDefault();
      hideCard();
      clearStatus();
      el.barcode.value = '';
      focusBarcode();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onBarcodeEnter();
  });

  // Enter in the quantity field submits too, so the flow never needs the mouse.
  el.qty.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onSubmit();
  });

  el.qtyMinus.addEventListener('click', () => stepQty(-1));
  el.qtyPlus.addEventListener('click', () => stepQty(1));

  el.submit.addEventListener('click', onSubmit);
  el.undo.addEventListener('click', onUndo);
  el.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  el.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Chrome can keep the panel document alive while it is hidden; showing it
  // again is "opening" it as far as the operator is concerned.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    scrollToTop();
    focusBarcode();
  });

  // Switching accounts only writes the active id; the storage listener below
  // does the actual reload, so the same path runs however the change arrived.
  el.profile.addEventListener('change', () => {
    if (inFlight) return;
    setActiveProfile(el.profile.value).catch((err) => console.error('switch failed:', err));
  });

  // Profiles can be edited, switched or removed while the panel is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Sound is a device preference, not part of any profile — apply it in place
    // rather than treating it as an account change.
    if (changes.sound) soundOn = changes.sound.newValue !== false;
    if (!changes.profiles && !changes.activeProfileId) return;

    // Mid-write the profile is in use, so defer rather than drop: setBusy(false)
    // picks this up as soon as the request finishes.
    if (inFlight) {
      reloadPending = true;
      return;
    }
    applyStorageChange();
  });
}

/**
 * Reloads only when the account actually in use changed. Editing some OTHER
 * profile fires this listener too, and tearing down a counted card for that
 * would lose work the operator can never get back — they have already put the
 * box down.
 */
async function applyStorageChange() {
  const state = await readState();
  const next = state.active;
  const sameAccount = Boolean(settings) && Boolean(next)
    && JSON.stringify(next) === JSON.stringify(settings);

  profiles = state.profiles;
  if (sameAccount) {
    // Names in the switcher can still have changed.
    renderProfiles();
    return;
  }

  // Card and undo belong to the account that was active a moment ago.
  hideCard();
  hideDone();
  if (!statusCritical) clearStatus();
  lastAction = null;
  locationNames = null;
  init();
}

async function init() {
  const state = await readState();
  profiles = state.profiles;
  settings = state.active;
  soundOn = await readSound();

  renderProfiles();

  const ready = isConfigured(settings);
  el.setup.hidden = ready;
  el.app.hidden = !ready;

  if (!ready) return;

  stockLog = await readStockLog();
  renderLog();
  scrollToTop();
  focusBarcode();
  if (!locationNames) loadLocations();
}

bindEvents();
init();
