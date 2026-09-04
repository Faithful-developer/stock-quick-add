'use strict';

/**
 * Options page: manages the list of ox-sys accounts. Each profile keeps its own
 * subdomain, token, auth style, default location and correction endpoint in
 * chrome.storage.local. Credentials are typed in per user and can be removed
 * again; nothing is baked into source.
 *
 * Profile shape, defaults and auth-header rules live in profiles.js.
 */

const COMMAND_NAME = 'open-panel';
const REQUEST_TIMEOUT_MS = 10000;

// Key under which the not-yet-saved profile parks its draft.
const DRAFT_NEW = '__new__';

// Every location this profile has, unfiltered — the <select> only ever shows a
// subset of it once something is typed in the search box.
let locationItems = [];
// Bumped per request so a slow tenant's answer cannot land on another profile.
let locationsRequestId = 0;

const el = {
  profileList: document.getElementById('profileList'),
  addProfile: document.getElementById('addProfile'),
  name: document.getElementById('name'),
  subdomain: document.getElementById('subdomain'),
  domain: document.getElementById('domain'),
  token: document.getElementById('token'),
  authScheme: document.getElementById('authScheme'),
  location: document.getElementById('location'),
  locationSearch: document.getElementById('locationSearch'),
  locationHint: document.getElementById('locationHint'),
  stockMethod: document.getElementById('stockMethod'),
  stockPath: document.getElementById('stockPath'),
  reason: document.getElementById('reason'),
  preview: document.getElementById('preview'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  remove: document.getElementById('remove'),
  msg: document.getElementById('msg'),
  sound: document.getElementById('sound'),
  shortcutValue: document.getElementById('shortcutValue'),
  editShortcut: document.getElementById('editShortcut'),
  sellPath: document.getElementById('sellPath'),
  sellPatchPath: document.getElementById('sellPatchPath'),
  sellsListPath: document.getElementById('sellsListPath'),
  paymentMethodsPath: document.getElementById('paymentMethodsPath'),
  stockLogSummary: document.getElementById('stockLogSummary'),
  stockLogExport: document.getElementById('stockLogExport'),
  stockLogClear: document.getElementById('stockLogClear'),
  stockLogTable: document.getElementById('stockLogTable'),
  stockLogBody: document.getElementById('stockLogBody'),
  payLogSummary: document.getElementById('payLogSummary'),
  payLogExport: document.getElementById('payLogExport'),
  payLogClear: document.getElementById('payLogClear'),
  payLogTable: document.getElementById('payLogTable'),
  payLogBody: document.getElementById('payLogBody'),
};

let profiles = [];
let activeProfileId = null;
let editingId = null;          // null while editing a profile that was never saved
let removeArmed = false;       // guards the two-step delete, so no modal is needed

// In-progress edits, kept per profile for this page's lifetime. Switching
// accounts mid-edit is normal, and silently dropping typed credentials is not.
const drafts = new Map();

// --- messages ----------------------------------------------------------------

function showMessage(text, kind) {
  el.msg.textContent = text;
  el.msg.className = `msg msg--${kind}`;
  el.msg.hidden = false;
}

function clearMessage() {
  el.msg.textContent = '';
  el.msg.hidden = true;
}

function updatePreview() {
  const { subdomain } = splitHost(el.subdomain.value);
  el.preview.textContent = `${subdomain || '<субдомен>'}.${el.domain.value}`;
}

/**
 * Pasting a whole address is the common case — the operator has the tenant open
 * in another tab. Peel the host apart and set the domain to match.
 */
function normaliseHostField() {
  const { subdomain, domain } = splitHost(el.subdomain.value);
  if (domain) {
    el.subdomain.value = subdomain;
    el.domain.value = domain;
  }
  updatePreview();
}

/** Only the host label, so no dots, slashes or protocol. */
function isValidSubdomain(value) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(value);
}

function disarmRemove() {
  removeArmed = false;
  el.remove.textContent = 'Удалить профиль';
}

// --- API ---------------------------------------------------------------------

/**
 * GET against one tenant with a 10s timeout covering the body as well as the
 * headers — fetch settles once the headers arrive, so a stalled body would hang
 * with the button reading "Проверка…" and no way out.
 * Returns { ok, status, json }.
 */
async function apiGet(profile, path, params = {}) {
  const url = profileUrl(profile, path, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...authHeaders(profile.token, profile.authScheme) },
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Превышено время ожидания (10 с)');
    }
    throw new Error('Нет связи с сервером');
  } finally {
    clearTimeout(timer);
  }
}

/** Fills the location dropdown for the profile being edited. */
async function loadLocations(profile) {
  // Every switch between profiles starts a new request, and each one is against
  // a DIFFERENT tenant, so their latencies genuinely differ and the answers can
  // arrive out of order. Only the newest may touch the form: an older one would
  // repopulate the list with another account's locations and, worse, select
  // that account's id — which Save would then store on the profile on screen.
  const requestId = ++locationsRequestId;
  const current = () => requestId === locationsRequestId;

  if (!isConfigured(profile)) {
    locationItems = [];
    renderLocationOptions(profile.locationId);
    el.locationHint.textContent = 'Список загрузится после сохранения доступа.';
    return;
  }

  try {
    const res = await apiGet(profile, '/locations', { page: '1', size: '100' });
    if (!current()) return;

    if (!res.ok) {
      el.locationHint.textContent = `Не удалось загрузить список (HTTP ${res.status}).`;
      return;
    }

    const items = res.json && Array.isArray(res.json.items) ? res.json.items : [];
    locationItems = items.map((loc) => ({
      id: String(loc.id),
      label: loc.name ? `${loc.name} (#${loc.id})` : `Локация ${loc.id}`,
    }));

    renderLocationOptions(profile.locationId);
    el.locationHint.textContent = `Загружено локаций: ${items.length}. Поиск — в поле выше.`;
  } catch (err) {
    if (!current()) return;
    el.locationHint.textContent = err.message;
  }
}

/**
 * Rebuilds the <select> from locationItems, narrowed by whatever is in the
 * search box. Options are built with the DOM API — never innerHTML with server
 * data. The selected id is always kept in the list even when it does not match
 * the search, so typing can never silently clear a saved location.
 */
function renderLocationOptions(selectedId) {
  const chosen = String(selectedId ?? el.location.value ?? '');
  const needle = el.locationSearch.value.trim().toLowerCase();
  const matches = needle
    ? locationItems.filter((loc) => loc.label.toLowerCase().includes(needle))
    : locationItems;

  el.location.textContent = '';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— не указывать —';
  el.location.appendChild(blank);

  const shown = matches.slice();
  if (chosen && !shown.some((loc) => loc.id === chosen)) {
    const known = locationItems.find((loc) => loc.id === chosen);
    shown.unshift(known || { id: chosen, label: `Локация ${chosen}` });
  }

  for (const loc of shown) {
    const opt = document.createElement('option');
    opt.value = loc.id;
    opt.textContent = loc.label;
    el.location.appendChild(opt);
  }

  el.location.value = chosen;

  if (needle && !matches.length) {
    el.locationHint.textContent = 'Ничего не найдено — очистите поиск.';
  }
}

// --- form <-> profile --------------------------------------------------------

function formValues() {
  return {
    name: el.name.value,
    subdomain: el.subdomain.value,
    domain: el.domain.value,
    token: el.token.value,
    authScheme: el.authScheme.value,
    locationId: el.location.value,
    stockPath: el.stockPath.value,
    stockMethod: el.stockMethod.value,
    reason: el.reason.value,
    sellPath: el.sellPath.value,
    sellPatchPath: el.sellPatchPath.value,
    sellsListPath: el.sellsListPath.value,
    paymentMethodsPath: el.paymentMethodsPath.value,
  };
}

function fillForm(values) {
  const p = makeProfile(values);

  el.name.value = values.name || '';
  el.subdomain.value = values.subdomain || '';
  el.domain.value = p.domain;
  el.token.value = values.token || '';
  el.authScheme.value = p.authScheme;
  el.stockPath.value = p.stockPath;
  el.stockMethod.value = p.stockMethod;
  el.reason.value = p.reason;
  el.sellPath.value = p.sellPath;
  el.sellPatchPath.value = p.sellPatchPath;
  el.sellsListPath.value = p.sellsListPath;
  el.paymentMethodsPath.value = p.paymentMethodsPath;

  // A search left over from the previous profile would hide this one's list.
  el.locationSearch.value = '';
  locationItems = [];

  // Keep the stored id selectable even before the location list arrives.
  renderLocationOptions(p.locationId);

  updatePreview();
  el.locationHint.textContent = 'Список загрузится после сохранения доступа.';
  loadLocations(p);
}

/** Remembers what is on screen so switching away does not discard it. */
function stashDraft() {
  drafts.set(editingId || DRAFT_NEW, formValues());
}

function renderProfileList() {
  el.profileList.textContent = '';

  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.id === activeProfileId
      ? `${profileLabel(p)} — активный`
      : profileLabel(p);
    el.profileList.appendChild(opt);
  }

  // The unsaved profile needs a row of its own to be selectable.
  if (editingId === null) {
    const opt = document.createElement('option');
    opt.value = DRAFT_NEW;
    opt.textContent = '— новый профиль —';
    el.profileList.appendChild(opt);
  }

  el.profileList.value = editingId === null ? DRAFT_NEW : editingId;
  el.remove.disabled = editingId === null;
}

function editProfile(id) {
  editingId = id;
  const stored = profiles.find((p) => p.id === id);
  fillForm(drafts.get(id) || stored || {});
  renderProfileList();
  clearMessage();
  disarmRemove();
}

function newProfile() {
  stashDraft();
  editingId = null;
  fillForm(drafts.get(DRAFT_NEW) || {});
  renderProfileList();
  clearMessage();
  disarmRemove();
  el.name.focus();
}

// --- load / save / remove ----------------------------------------------------

async function load() {
  // Device-wide, so it is not part of any profile and saves on the spot.
  el.sound.checked = await readSound();

  const state = await readState();
  profiles = state.profiles;
  activeProfileId = state.activeProfileId;

  if (profiles.length) {
    editProfile(activeProfileId || profiles[0].id);
  } else {
    newProfile();
  }
}

/** Validates the form and returns the values, or null if something is wrong. */
function readForm() {
  normaliseHostField();

  const subdomain = el.subdomain.value.trim();
  const token = el.token.value.trim();

  if (!subdomain) {
    showMessage('Укажите субдомен.', 'err');
    el.subdomain.focus();
    return null;
  }
  if (!isValidSubdomain(subdomain)) {
    showMessage('Субдомен должен содержать только латинские буквы, цифры и дефис.', 'err');
    el.subdomain.focus();
    return null;
  }
  if (!token) {
    showMessage('Укажите токен.', 'err');
    el.token.focus();
    return null;
  }

  // stockPath is normalised by makeProfile, so every path stored — including
  // ones migrated from older builds — goes through the same rule.
  return makeProfile({
    ...formValues(), subdomain, token, id: editingId || undefined,
  });
}

async function save() {
  clearMessage();
  disarmRemove();

  const profile = readForm();
  if (!profile) return;

  // The panel, or a second copy of this page, can change things while this one
  // sits open, so nothing read at load time is trustworthy. Re-read and merge
  // into what is actually stored: writing back the local array would silently
  // drop a profile added elsewhere, token and all.
  const stored = await readState();
  profiles = stored.profiles.slice();

  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);

  // Only choose a new active profile when the stored one points at nothing
  // (first save, or it was deleted). Writing back a stale id would yank the
  // panel to another tenant mid-scan, which looks exactly like the account
  // "not working".
  activeProfileId = profiles.some((p) => p.id === stored.activeProfileId)
    ? stored.activeProfileId
    : profile.id;

  await writeProfiles(profiles, activeProfileId);

  drafts.delete(DRAFT_NEW);
  drafts.delete(profile.id);
  editingId = profile.id;

  // Echo back what was actually stored, defaults included.
  fillForm(profile);
  renderProfileList();
  showMessage('Сохранено.', 'ok');
}

/** Live check that this profile's subdomain and token actually work. */
async function testConnection() {
  clearMessage();
  disarmRemove();

  const profile = readForm();
  if (!profile) return;

  el.test.disabled = true;
  el.test.textContent = 'Проверка…';

  // The most common failure is the wrong header, so always name the one sent.
  const used = Object.keys(authHeaders(profile.token, profile.authScheme))[0];

  try {
    const res = await apiGet(profile, '/variations', { page: '1', size: '1' });

    if (res.ok) {
      const total = res.json && typeof res.json.total_count === 'number'
        ? res.json.total_count
        : '?';
      showMessage(`Связь есть: ${profile.subdomain}.${profile.domain} (${used}). Доступно позиций: ${total}.`, 'ok');
    } else if (res.status === 401 || res.status === 403) {
      showMessage(
        `Токен отклонён (HTTP ${res.status}) с заголовком ${used}. ` +
        'Проверьте значение или смените способ авторизации.',
        'err'
      );
    } else {
      showMessage(`Сервер ответил HTTP ${res.status}.`, 'err');
    }
  } catch (err) {
    showMessage(err.message, 'err');
  } finally {
    el.test.disabled = false;
    el.test.textContent = 'Проверить связь';
  }
}

/** Two-step removal of the profile being edited. */
async function removeProfile() {
  clearMessage();
  if (editingId === null) return;

  if (!removeArmed) {
    removeArmed = true;
    el.remove.textContent = 'Точно удалить?';
    return;
  }

  const removed = editingId;
  drafts.delete(removed);

  // Re-read and filter what is stored, for the same reason as in save(): the
  // local array can be missing profiles added since this page loaded, and
  // writing it back would delete them along with the one actually removed.
  const stored = await readState();
  profiles = stored.profiles.filter((p) => p.id !== removed);
  activeProfileId = stored.activeProfileId;

  // Deleting the account the panel is on hands it the next one, or nothing.
  if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles.length ? profiles[0].id : null;
  }
  await writeProfiles(profiles, activeProfileId);

  disarmRemove();
  if (profiles.length) {
    editProfile(activeProfileId);
    showMessage('Профиль удалён.', 'ok');
  } else {
    newProfile();
    showMessage('Профилей не осталось. Панель снова попросит настройки.', 'ok');
  }
}

// --- journals ----------------------------------------------------------------

// Both journals are written by the panel (panel.js, payment.js); this page
// only reads, exports and clears them. One implementation, two instances.

function groupDigits(value) {
  const s = String(value === null || value === undefined ? '' : value);
  return /^-?\d+$/.test(s) ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : s;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {object} spec
 *   key       — chrome.storage.local key
 *   columns   — [[entryField, csvHeader], …]
 *   file      — CSV file name prefix
 *   empty     — summary text when there is nothing
 *   row(e)    — [[cellText, className], …] for the table
 *   els       — { summary, exportBtn, clearBtn, table, body }
 */
function makeJournal(spec) {
  const j = { entries: [], clearArmed: false };

  async function load() {
    const s = await chrome.storage.local.get(spec.key);
    j.entries = Array.isArray(s[spec.key]) ? s[spec.key] : [];
    render();
  }

  function render() {
    const { els } = spec;
    els.summary.textContent = j.entries.length
      ? `Записей: ${j.entries.length} из 500.`
      : spec.empty;
    els.exportBtn.disabled = !j.entries.length;
    els.clearBtn.disabled = !j.entries.length;
    els.table.hidden = !j.entries.length;
    els.body.textContent = '';
    for (const e of j.entries) {
      const tr = document.createElement('tr');
      for (const [text, cls] of spec.row(e)) {
        const td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        tr.appendChild(td);
      }
      els.body.appendChild(tr);
    }
  }

  /** UTF-8 BOM up front so Excel reads Cyrillic without an import wizard. */
  function exportCsv() {
    const lines = [spec.columns.map(([, label]) => csvCell(label)).join(',')];
    for (const e of j.entries) lines.push(spec.columns.map(([key]) => csvCell(e[key])).join(','));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${spec.file}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Two clicks, like removeProfile(): the journal is the only record there is. */
  async function clear() {
    if (!j.clearArmed) {
      j.clearArmed = true;
      spec.els.clearBtn.textContent = 'Точно очистить?';
      return;
    }
    j.clearArmed = false;
    spec.els.clearBtn.textContent = 'Очистить журнал';
    await chrome.storage.local.remove(spec.key);
    j.entries = [];
    render();
  }

  spec.els.exportBtn.addEventListener('click', exportCsv);
  spec.els.clearBtn.addEventListener('click', () => {
    clear().catch((err) => console.error(`${spec.key} clear failed:`, err));
  });

  return { key: spec.key, load };
}

const stockJournal = makeJournal({
  key: 'stockLog',
  file: 'stock-corrections',
  empty: 'Операций пока нет.',
  columns: [
    ['at', 'timestamp'], ['profile', 'account'], ['host', 'host'], ['name', 'product'],
    ['quantity', 'quantity'], ['location', 'location'], ['correctionId', 'correction_id'],
  ],
  row: (e) => [
    [new Date(e.at).toLocaleString('ru-RU'), 'num'],
    [e.profile || e.host || '', ''],
    [e.name || '', ''],
    [e.quantity < 0 ? `−${Math.abs(e.quantity)}` : `+${e.quantity}`, 'num'],
    [e.location || '', ''],
    [e.correctionId ? `№${e.correctionId}` : '', 'num'],
  ],
  els: {
    summary: el.stockLogSummary, exportBtn: el.stockLogExport, clearBtn: el.stockLogClear,
    table: el.stockLogTable, body: el.stockLogBody,
  },
});

const payJournal = makeJournal({
  key: 'paymentLog',
  file: 'payment-changes',
  empty: 'Изменений пока нет.',
  columns: [
    ['at', 'timestamp'], ['profile', 'account'], ['host', 'host'], ['sellId', 'sell_id'],
    ['line', 'payment_line'], ['lines', 'payment_lines'],
    ['fromId', 'from_id'], ['fromName', 'from_name'], ['toId', 'to_id'], ['toName', 'to_name'],
    ['amount', 'amount'], ['reason', 'reason'],
  ],
  row: (e) => [
    [new Date(e.at).toLocaleString('ru-RU'), 'num'],
    [e.profile || e.host || '', ''],
    [e.lines > 1 ? `№${e.sellId} (${e.line}/${e.lines})` : `№${e.sellId}`, 'num'],
    [`${e.fromName} → ${e.toName}`, ''],
    [groupDigits(e.amount), 'num'],
    [e.reason || '', ''],
  ],
  els: {
    summary: el.payLogSummary, exportBtn: el.payLogExport, clearBtn: el.payLogClear,
    table: el.payLogTable, body: el.payLogBody,
  },
});

// --- keyboard shortcut -------------------------------------------------------

/**
 * Shows the shortcut currently bound to the panel command.
 * Extensions cannot assign their own shortcuts — chrome://extensions/shortcuts
 * is the only place a user can change them, so we just read and link to it.
 */
async function loadShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find((c) => c.name === COMMAND_NAME);
  const shortcut = command && command.shortcut;

  el.shortcutValue.textContent = shortcut || 'Не назначена (конфликт с другим расширением?)';
  el.shortcutValue.classList.toggle('shortcut__value--empty', !shortcut);
}

// --- wiring ------------------------------------------------------------------

el.profileList.addEventListener('change', () => {
  stashDraft();
  const chosen = el.profileList.value;
  if (chosen === DRAFT_NEW) {
    editingId = null;
    fillForm(drafts.get(DRAFT_NEW) || {});
    renderProfileList();
    clearMessage();
    disarmRemove();
  } else {
    editProfile(chosen);
  }
});

// The panel and any second copy of this page write the same storage. Refresh
// the list so it matches, and leave the form alone so nothing half-typed is lost.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes[stockJournal.key]) stockJournal.load();
  if (area === 'local' && changes[payJournal.key]) payJournal.load();
  if (area !== 'local' || (!changes.profiles && !changes.activeProfileId)) return;

  const stored = await readState();
  profiles = stored.profiles;
  activeProfileId = stored.activeProfileId;

  // The profile being edited was deleted elsewhere. Keep what is on screen, but
  // treat it as new, so saving creates a fresh profile instead of resurrecting
  // an id someone has just removed.
  if (editingId && !profiles.some((p) => p.id === editingId)) editingId = null;

  renderProfileList();
});

el.sound.addEventListener('change', () => {
  writeSound(el.sound.checked).catch((err) => console.error('sound save failed:', err));
});

el.addProfile.addEventListener('click', newProfile);
el.save.addEventListener('click', save);
el.test.addEventListener('click', testConnection);
el.remove.addEventListener('click', removeProfile);
el.locationSearch.addEventListener('input', () => renderLocationOptions());
el.subdomain.addEventListener('input', updatePreview);
el.subdomain.addEventListener('blur', normaliseHostField);
el.domain.addEventListener('change', updatePreview);

// chrome:// pages cannot be opened from a link, only via the tabs API.
el.editShortcut.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// Any edit cancels a pending delete.
for (const input of [
  el.name, el.subdomain, el.domain, el.token, el.authScheme,
  el.location, el.stockPath, el.stockMethod, el.reason,
  el.sellPath, el.sellPatchPath, el.sellsListPath, el.paymentMethodsPath,
]) {
  input.addEventListener('input', disarmRemove);
}

// Enter saves from any text field.
for (const input of [el.name, el.subdomain, el.token, el.stockPath, el.reason]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });
}

// The user may rebind the shortcut, or switch accounts in the panel, and come
// straight back to this tab — so refresh both on return.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  loadShortcut();

  const stored = await readState();
  if (stored.activeProfileId !== activeProfileId) {
    activeProfileId = stored.activeProfileId;
    renderProfileList();
  }
});

load();
loadShortcut();
stockJournal.load();
payJournal.load();
