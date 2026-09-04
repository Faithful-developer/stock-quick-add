'use strict';

/**
 * Shared profile storage — one profile per ox-sys account.
 *
 * An operator moving between companies changes subdomain, token, default
 * location and reason all at once, so those travel together as a unit instead
 * of as loose top-level keys.
 *
 * Loaded by panel.html, options.html and sw.js (via importScripts), so this must
 * stay a plain classic script: no imports, no exports, no DOM access.
 */

// ox-sys tenants live on two domains; a company is on one or the other.
// Anything added here must also be added to host_permissions in manifest.json,
// or fetch is blocked with no visible error.
const DOMAINS = ['ox-sys.com', 'oxapp.io'];

const DEFAULTS = {
  domain: DOMAINS[0],
  stockPath: '/corrections',
  stockMethod: 'POST',
  reason: 'Другое',
  authScheme: 'auto',
  // Смена оплаты. {id} подставляется номером продажи.
  sellPath: '/sells/{id}',
  sellPatchPath: '/sells/{id}/patch',
  sellsListPath: '/sells-list',
  paymentMethodsPath: '/payment-methods',
};

/** Base URL for one profile's tenant. */
function profileBase(profile) {
  return `https://${profile.subdomain}.${profile.domain || DEFAULTS.domain}`;
}

/**
 * A stored path is only ever a path on the tenant, so it is forced to exactly
 * one leading slash. Both other shapes leave the tenant: `corrections` makes
 * `https://acme.ox-sys.comcorrections` (a different host), and `//evil.com/x`
 * is protocol-relative, so `new URL()` would resolve it to another origin
 * entirely. The options form is not the place to catch this — migrateLegacy()
 * and values stored by older builds never pass through it.
 */
function normalizePath(value, fallback) {
  const path = (value || '').trim();
  if (!path) return fallback;
  return '/' + path.replace(/^\/+/, '');
}

/** The stock write creates a document; anything else here is a corrupt value. */
const STOCK_METHODS = ['POST', 'PUT', 'PATCH'];

function normalizeMethod(value) {
  const method = (value || '').trim().toUpperCase();
  return STOCK_METHODS.includes(method) ? method : DEFAULTS.stockMethod;
}

/**
 * The one place tenant URLs are built. Callers pass a path and params, never a
 * concatenated string, so a stored path cannot steer a request — token headers
 * and all — at a host the operator never configured.
 */
function profileUrl(profile, path, params = {}) {
  const url = new URL(profileBase(profile) + normalizePath(path, '/'));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Fills the {id} placeholder in a stored path template.
 *
 * The id is encoded, so a value typed into the panel cannot add path segments
 * or a query of its own to a URL that carries the token. A template without
 * {id} is returned unchanged — that is a misconfiguration the caller checks
 * for, not something to paper over by appending the id somewhere arbitrary.
 */
function fillId(template, id) {
  return String(template).replace(/\{id\}/g, encodeURIComponent(String(id)));
}

/**
 * Accepts a bare label ("acme") or a whole host pasted from the address bar
 * ("https://acme.oxapp.io/app/..."), so the domain does not have to be picked
 * by hand when it is already there in what was pasted.
 */
function splitHost(value) {
  const host = (value || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '');

  for (const domain of DOMAINS) {
    if (host.toLowerCase().endsWith('.' + domain)) {
      return { subdomain: host.slice(0, -(domain.length + 1)), domain };
    }
  }
  return { subdomain: host, domain: null };
}

// What pre-profile builds wrote at the top level of chrome.storage.local.
const LEGACY_KEYS = [
  'subdomain', 'token', 'locationId', 'stockPath', 'stockMethod', 'reason', 'authScheme',
];

/** Normalises anything profile-shaped, filling in defaults for missing fields. */
function makeProfile(values = {}) {
  return {
    id: values.id || crypto.randomUUID(),
    name: (values.name || '').trim(),
    subdomain: (values.subdomain || '').trim(),
    domain: DOMAINS.includes(values.domain) ? values.domain : DEFAULTS.domain,
    token: (values.token || '').trim(),
    authScheme: values.authScheme || DEFAULTS.authScheme,
    locationId: (values.locationId || '').trim(),
    reason: (values.reason || '').trim() || DEFAULTS.reason,
    stockPath: normalizePath(values.stockPath, DEFAULTS.stockPath),
    stockMethod: normalizeMethod(values.stockMethod),
    sellPath: normalizePath(values.sellPath, DEFAULTS.sellPath),
    sellPatchPath: normalizePath(values.sellPatchPath, DEFAULTS.sellPatchPath),
    sellsListPath: normalizePath(values.sellsListPath, DEFAULTS.sellsListPath),
    paymentMethodsPath: normalizePath(values.paymentMethodsPath, DEFAULTS.paymentMethodsPath),
  };
}

/** A profile is usable once it can actually reach a tenant. */
function isConfigured(profile) {
  return Boolean(profile && profile.subdomain && profile.token);
}

/** Never blank, so a half-filled profile is still selectable in a list. */
function profileLabel(profile) {
  if (!profile) return '';
  return profile.name || profile.subdomain || 'Без названия';
}

/**
 * Reads every profile plus the active one. The active id can go stale if a
 * profile was deleted elsewhere, so fall back to the first that exists.
 */
async function readState() {
  const s = await chrome.storage.local.get(['profiles', 'activeProfileId']);
  const profiles = Array.isArray(s.profiles) ? s.profiles.map(makeProfile) : [];
  const active = profiles.find((p) => p.id === s.activeProfileId) || profiles[0] || null;
  return { profiles, active, activeProfileId: active ? active.id : null };
}

async function writeProfiles(profiles, activeProfileId) {
  await chrome.storage.local.set({ profiles, activeProfileId });
}

async function setActiveProfile(id) {
  await chrome.storage.local.set({ activeProfileId: id });
}

/** Sound is a per-device preference, not a per-account one. On by default. */
async function readSound() {
  const s = await chrome.storage.local.get('sound');
  return s.sound !== false;
}

async function writeSound(on) {
  await chrome.storage.local.set({ sound: Boolean(on) });
}

/**
 * ox-sys takes two auth styles and they are NOT interchangeable: the JWT the web
 * app issues is only accepted as `Authorization: Bearer` — the same JWT in an
 * `auth-token` header answers 401 — while a static API key goes in `auth-token`.
 * 'auto' picks by shape, since a JWT is three dot-separated segments.
 */
function isJwt(token) {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

function authHeaders(token, scheme) {
  const resolved = !scheme || scheme === 'auto'
    ? (isJwt(token) ? 'bearer' : 'auth-token')
    : scheme;

  return resolved === 'bearer'
    ? { Authorization: `Bearer ${token}` }
    : { 'auth-token': token };
}

/**
 * Moves a pre-profile install into the new shape, and drops the endpoint older
 * builds guessed at (`PATCH /stocks`, which never wrote anything — the real
 * write is `POST /corrections`). Safe to run repeatedly.
 */
async function migrateLegacy() {
  const s = await chrome.storage.local.get(null);

  if (Array.isArray(s.profiles) && s.profiles.length) return false;
  if (!s.subdomain && !s.token) return false;

  const legacyEndpoint = !s.stockPath || s.stockPath === '/stocks';
  const profile = makeProfile({
    name: s.subdomain || '',
    subdomain: s.subdomain,
    token: s.token,
    authScheme: s.authScheme,
    locationId: s.locationId,
    reason: s.reason,
    stockPath: legacyEndpoint ? DEFAULTS.stockPath : s.stockPath,
    stockMethod: legacyEndpoint ? DEFAULTS.stockMethod : s.stockMethod,
  });

  await chrome.storage.local.set({ profiles: [profile], activeProfileId: profile.id });
  await chrome.storage.local.remove(LEGACY_KEYS);
  return true;
}
