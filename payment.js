'use strict';

/**
 * Смена способа оплаты — второй инструмент боковой панели.
 *
 * Поток: номер продажи -> Enter -> карточка -> новый способ + причина ->
 *        «Изменить оплату» -> подтверждение -> PATCH.
 *
 * Загружается после panel.js той же страницей, поэтому переиспользует его
 * request() / ApiError / httpError / bannerIcon() / bannerBody() и активный
 * профиль `settings`. Всё своё здесь начинается с pm / PM_, чтобы не
 * пересекаться с глобальными именами panel.js.
 *
 * Что подтверждено на живом хосте (маршруты, без авторизации — см. API_NOTES.md):
 *   GET   /sells/{id}            существует (Allow: GET, PUT, PATCH, DELETE)
 *   PATCH /sells/{id}/patch      существует (Allow: PATCH)
 *   GET   /payment-methods       существует (Allow: DELETE, GET)
 *   GET   /sells-list            существует; запасной путь, если прямой GET отдаёт 405
 *
 * Рабочее тело PATCH — то, что шлёт сам интерфейс ox-sys (снято из devtools,
 * продажа с двумя оплатами, 2026-09-04):
 *   {"sellRecords":[{"assistants":[],"managers":[]},{"assistants":[],"managers":[]}],
 *    "note":null,
 *    "payments":[{"paymentMethod":1,"price":12244000,"type":"sell"},
 *                {"paymentMethod":7,"price":16000000,"type":"sell"}],
 *    "status":"completed"}
 * Ключа customer в нём нет; по одной заглушке sellRecords на каждую запись
 * продажи; строк payments может быть сколько угодно.
 *
 * PATCH заменяет объект целиком, поэтому тело всегда собирается из того, что
 * вернул GET, — меняется только payments[i].paymentMethod выбранной строки,
 * остальные строки уходят эхом с теми же суммами. Форма ответа GET ещё
 * не подтверждена: для каждого поля перебирается список путей-кандидатов
 * (PM_FIELDS), и если обязательное поле не нашлось, запись не отправляется.
 */

// --- configuration -----------------------------------------------------------

// Пути берутся из профиля (profiles.js): sellPath, sellPatchPath,
// sellsListPath, paymentMethodsPath. Здесь — только форма данных.

// Пути-кандидаты для каждого логического поля; берётся первый найденный.
const PM_FIELDS = {
  id: ['id', 'sellId'],
  finishedTime: ['finishedTime', 'finished_time', 'finishedAt', 'closedAt', 'createdAt'],
  zoneId: ['zone.id', 'zone', 'zoneId', 'branch.zone.id'],
  zoneName: ['zone.name', 'zone.title', 'branch.name', 'branch.title'],
  customerId: ['customer.id', 'customer', 'customerId'],
  customerName: ['customer.name', 'customer.fullName', 'customer.firstName', 'customer.phone', 'customerName'],
  total: ['totalPrice', 'total', 'price', 'sum', 'amount'],
  status: ['status'],
  note: ['note', 'comment'],
  sellRecords: ['sellRecords', 'sell_records', 'records'],
  payments: ['payments'],
};

const PM_PAYMENT = {
  method: ['paymentMethod', 'payment_method', 'method'],
  price: ['price', 'amount', 'sum'],
  type: ['type'],
};

// Как объект превращается в скаляр и подпись.
const PM_ID_FIELDS = ['id', 'value', 'code'];
const PM_NAME_FIELDS = ['name', 'title', 'label', 'caption', 'nameRu', 'nameUz', 'nameEn', 'fullName'];

// Где в ответе списка лежат элементы.
const PM_ITEMS_PATHS = ['items', 'data', 'results', 'hydra:member', 'sells', 'content', 'list'];

// Сборка тела PATCH. Порядок ключей — как в рабочем curl.
const PM_BODY = {
  // customer в теле нет — так шлёт сам интерфейс ox-sys; сервер его не трогает.
  order: ['sellRecords', 'note', 'payments', 'status'],
  required: ['sellRecords', 'payments', 'status'],
  paymentKeys: ['paymentMethod', 'price', 'type'],
  // 'echo'    — sellRecords уходят ровно такими, какими пришли (read-modify-write).
  // 'minimal' — [{"assistants":[…],"managers":[…]}] с id вместо объектов, как в образце curl.
  // На живом тенанте 'echo' даёт 422: Symfony-форма не принимает вложенные
  // объекты (product, variation, …), которые GET возвращает внутри записей.
  sellRecordsMode: 'minimal',
  // 'echo' — каждый ключ записи payments из GET; 'curl' — только paymentKeys.
  // 'echo' тоже даёт 422 из-за лишних ключей (id, createdAt) — «extra fields».
  paymentKeysMode: 'curl',
};

// Запасной поиск по /sells-list, когда /sells/{id} недоступен.
const PM_LIST = {
  size: 20,
  maxPages: 10,
  position: 'finished',
  dayStart: ' 00:00:00',
  dayEnd: ' 23:59:59',
  // null = без фильтра зоны. 1 — последний вариант: зона у каждого тенанта своя.
  zoneCandidates: [null, 1],
};

// Журнал изменений — в chrome.storage.local, общий для профилей.
const PM_LOG_KEY = 'paymentLog';
const PM_LOG_MAX = 500;
const PM_LOG_SHOWN = 20;

// Chrome 114+: числа читаются как исходный текст, и price уходит байт в байт.
const PM_HAS_RAW = typeof JSON.rawJSON === 'function';

// --- state -------------------------------------------------------------------

let pmSell = null;        // нормализованная продажа с карточки
let pmMode = 'direct';    // 'direct' | 'list'
let pmMethods = [];       // [{ id, name }]
let pmMethodsFor = '';    // id профиля, для которого загружен список
let pmArmed = false;      // показан блок подтверждения
let pmBusy = false;
let pmProfile = null;     // профиль, захваченный на время операции (см. pmGet)
let pmReloadPending = false; // профиль сменился во время записи; применить после
let pmLog = [];           // последние записи журнала, для списка в панели
let pmLineSelects = [];   // <select> нового способа, по одному на строку payments

// --- element handles ---------------------------------------------------------

const pel = {
  tabStock: document.getElementById('tabStock'),
  tabPay: document.getElementById('tabPay'),
  profile: document.getElementById('profile'),
  stockView: document.getElementById('stockView'),
  view: document.getElementById('payView'),
  sellId: document.getElementById('sellId'),
  scan: document.getElementById('payScan'),
  search: document.getElementById('paySearch'),
  hint: document.getElementById('payHint'),
  dateRow: document.getElementById('dateRow'),
  sellDate: document.getElementById('sellDate'),
  status: document.getElementById('payStatus'),
  done: document.getElementById('payDone'),
  doneTitle: document.getElementById('payDoneTitle'),
  doneSub: document.getElementById('payDoneSub'),
  card: document.getElementById('payCard'),
  facts: document.getElementById('payFacts'),
  allRow: document.getElementById('payAllRow'),
  all: document.getElementById('payAll'),
  methods: document.getElementById('payMethods'),
  change: document.getElementById('payChange'),
  reason: document.getElementById('payReason'),
  submit: document.getElementById('paySubmit'),
  confirm: document.getElementById('payConfirm'),
  confirmTitle: document.getElementById('payConfirmTitle'),
  confirmSub: document.getElementById('payConfirmSub'),
  confirmYes: document.getElementById('payConfirmYes'),
  confirmNo: document.getElementById('payConfirmNo'),
  logList: document.getElementById('payLogList'),
  logCount: document.getElementById('payLogCount'),
  logEmpty: document.getElementById('payLogEmpty'),
};

// --- raw-number JSON ----------------------------------------------------------

/**
 * price приходит в минимальных единицах и должен вернуться тем же текстом.
 * JSON.parse превратил бы 90071992547409931 в 90071992547409940 — этого
 * достаточно, чтобы никогда не гонять суммы через float. С reviver-контекстом
 * каждое число сохраняется как JSON.rawJSON(исходный текст), и
 * JSON.stringify выводит его без изменений.
 */
function pmParse(text) {
  if (!PM_HAS_RAW) return JSON.parse(text);
  return JSON.parse(text, function (key, value, ctx) {
    if (typeof value === 'number' && ctx && typeof ctx.source === 'string') {
      return JSON.rawJSON(ctx.source);
    }
    return value;
  });
}

function pmIsRaw(v) {
  return Boolean(v) && typeof v === 'object' && typeof v.rawJSON === 'string';
}

/** Скаляр (или raw-число) как строка; объект — как JSON. */
function pmStr(v) {
  if (pmIsRaw(v)) return v.rawJSON;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function pmGetPath(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Первый путь из списка, по которому что-то есть. */
function pmPick(obj, paths) {
  for (const p of paths) {
    const v = pmGetPath(obj, p);
    if (v !== undefined && v !== null) return { value: v, path: p };
  }
  return { value: undefined, path: null };
}

/** {id: 117202, name: ...} -> 117202 (raw сохраняется); скаляр — как есть. */
function pmIdOf(v) {
  if (v && typeof v === 'object' && !pmIsRaw(v)) return pmPick(v, PM_ID_FIELDS).value;
  return v;
}

/** Подпись объекта. У скаляра подписи нет. */
function pmLabelOf(v) {
  if (v && typeof v === 'object' && !pmIsRaw(v)) return pmStr(pmPick(v, PM_NAME_FIELDS).value);
  return typeof v === 'string' ? v : '';
}

/**
 * Сумма как скаляр. На живом тенанте price/totalPrice — мультивалютный объект:
 *   {"first":"UZS","ratio":{…},"order":["UZS","USD"],"UZS":16373000,"USD":1364.42}
 * PATCH ждёт число в основной валюте (в рабочем curl — "price":16373000),
 * то есть значение по ключу `first`. Raw-число сохраняется — уходит байт в байт.
 */
function pmAmountOf(v) {
  if (!v || typeof v !== 'object' || pmIsRaw(v)) return v;
  const keys = [];
  if (typeof v.first === 'string') keys.push(v.first);
  if (Array.isArray(v.order)) keys.push(...v.order.filter((k) => typeof k === 'string'));
  keys.push('UZS', 'value', 'amount');
  for (const k of keys) {
    if (v[k] !== undefined && v[k] !== null && typeof v[k] !== 'object') return v[k];
    if (pmIsRaw(v[k])) return v[k];
  }
  return v;
}

function pmItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const p of PM_ITEMS_PATHS) {
    const v = pmGetPath(data, p);
    if (Array.isArray(v)) return v;
  }
  return null;
}

/** Группировка разрядов для экрана. В запрос уходит исходная строка, не эта. */
function pmMoney(v) {
  const s = pmStr(v);
  if (!/^-?\d+$/.test(s)) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// --- normalisation -----------------------------------------------------------

function pmNormalizePayments(sell) {
  const arr = pmPick(sell, PM_FIELDS.payments).value;
  if (!Array.isArray(arr)) return null;
  return arr.map((p) => {
    const raw = pmPick(p, PM_PAYMENT.method).value;
    const asObject = raw && typeof raw === 'object' && !pmIsRaw(raw);
    return {
      methodId: pmStr(asObject ? pmPick(raw, PM_ID_FIELDS).value : raw),
      methodName: asObject ? pmStr(pmPick(raw, PM_NAME_FIELDS).value) : '',
      price: pmStr(pmAmountOf(pmPick(p, PM_PAYMENT.price).value)),
      type: pmStr(pmPick(p, PM_PAYMENT.type).value),
    };
  });
}

function pmNormalizeSell(sell) {
  const f = PM_FIELDS;
  const payments = pmNormalizePayments(sell) || [];
  const customerRaw = pmPick(sell, f.customerId).value;

  const missing = [];
  for (const name of PM_BODY.required) {
    const list = name === 'customer' ? f.customerId : f[name];
    if (pmPick(sell, list).value === undefined) missing.push(name);
  }
  if (!Array.isArray(pmPick(sell, f.payments).value) && !missing.includes('payments')) {
    missing.push('payments');
  }

  const norm = {
    id: pmStr(pmPick(sell, f.id).value),
    finishedTime: pmStr(pmPick(sell, f.finishedTime).value),
    zoneId: pmStr(pmIdOf(pmPick(sell, f.zoneId).value)),
    zoneName: pmLabelOf(pmPick(sell, f.zoneName).value),
    customerId: pmStr(pmIdOf(customerRaw)),
    customerName: pmLabelOf(customerRaw) || pmStr(pmPick(sell, f.customerName).value),
    total: pmStr(pmAmountOf(pmPick(sell, f.total).value)),
    status: pmStr(pmIdOf(pmPick(sell, f.status).value)),
    payments,
    missing,
  };
  // Слепок того, что видел оператор: перед записью продажа читается заново
  // и сверяется с ним, чтобы не переписать чужое изменение.
  norm.fingerprint = JSON.stringify({
    s: norm.status,
    c: norm.customerId,
    p: payments.map((p) => [p.methodId, p.price, p.type]),
  });
  return norm;
}

// --- PATCH body --------------------------------------------------------------

/**
 * Собирает тело только из ответа GET. Ничего не выдумывается: отсутствующее
 * обязательное поле попадает в `missing`, и запись не отправляется.
 */
function pmBuildBody(sell, newMethods = []) {
  const f = PM_FIELDS;
  const body = {};
  const missing = [];
  const echoed = [];

  for (const name of PM_BODY.order) {
    if (name === 'customer') {
      const got = pmPick(sell, f.customerId);
      if (got.value === undefined) { missing.push(name); continue; }
      body.customer = pmIdOf(got.value);
      echoed.push(pmStr(body.customer));
    } else if (name === 'sellRecords') {
      const got = pmPick(sell, f.sellRecords);
      if (got.value === undefined) { missing.push(name); continue; }
      if (PM_BODY.sellRecordsMode === 'minimal' && Array.isArray(got.value)) {
        // Форма ждёт id, а GET может вернуть объекты {id, name}.
        const ids = (arr) => (Array.isArray(arr) ? arr.map(pmIdOf) : []);
        body.sellRecords = got.value.map((r) => ({
          assistants: ids(r && r.assistants),
          managers: ids(r && r.managers),
        }));
      } else {
        body.sellRecords = got.value;
      }
    } else if (name === 'note') {
      const got = pmPick(sell, f.note);
      // В рабочем curl note: null — единственное поле, которому можно отсутствовать.
      body.note = got.value === undefined ? null : got.value;
    } else if (name === 'payments') {
      const arr = pmPick(sell, f.payments).value;
      if (!Array.isArray(arr) || arr.length === 0) { missing.push(name); continue; }
      body.payments = arr.map((p, i) => {
        const entry = {};
        // newMethods[i] — новый способ строки i; null/undefined — оставить как есть.
        const method = pmPick(p, PM_PAYMENT.method);
        const wanted = newMethods[i];
        const methodId = wanted !== null && wanted !== undefined ? wanted : pmIdOf(method.value);
        if (methodId === undefined || methodId === null) missing.push(`payments[${i}].paymentMethod`);
        if (PM_BODY.paymentKeysMode === 'curl') {
          entry.paymentMethod = methodId;
          const price = pmPick(p, PM_PAYMENT.price);
          const type = pmPick(p, PM_PAYMENT.type);
          if (price.value === undefined) missing.push('payments.price');
          else entry.price = pmAmountOf(price.value);
          if (type.value === undefined) missing.push('payments.type');
          else entry.type = pmIdOf(type.value);
        } else {
          // Все ключи из GET; порядок как в curl, остальные следом.
          const own = Object.keys(p || {});
          const ordered = PM_BODY.paymentKeys.filter((k) => own.includes(k))
            .concat(own.filter((k) => !PM_BODY.paymentKeys.includes(k)));
          for (const k of ordered) {
            if (PM_PAYMENT.method.includes(k)) entry[k] = methodId;
            else if (PM_PAYMENT.price.includes(k)) entry[k] = pmAmountOf(p[k]);
            else entry[k] = p[k];
          }
          if (entry.paymentMethod === undefined) entry.paymentMethod = methodId;
          if (entry.price === undefined) {
            const got = pmPick(p, PM_PAYMENT.price);
            if (got.value === undefined) missing.push('payments.price');
            else entry.price = pmAmountOf(got.value);
          }
          if (entry.type === undefined) {
            const got = pmPick(p, PM_PAYMENT.type);
            if (got.value === undefined) missing.push('payments.type');
            else entry.type = got.value;
          }
        }
        if (entry.price && typeof entry.price === 'object' && !pmIsRaw(entry.price)) {
          missing.push('payments.price (не удалось выделить сумму)');
        }
        echoed.push(pmStr(pmAmountOf(pmPick(p, PM_PAYMENT.price).value)));
        return entry;
      });
    } else if (name === 'status') {
      const got = pmPick(sell, f.status);
      if (got.value === undefined) { missing.push(name); continue; }
      body.status = pmIdOf(got.value);
    }
  }
  return { body, missing, echoed };
}

/**
 * Без JSON.rawJSON: каждое число, которое уходит эхом, обязано встретиться в
 * исходном ответе целым JSON-токеном. Подстрока не годится — "16373000.5"
 * входит в "16373000.50", но это другая сумма.
 */
function pmFidelityIssues(rawText, values) {
  if (PM_HAS_RAW) return [];
  return values.filter((v) => {
    if (v === '') return false;
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp('(?<![\\d.eE+-])' + esc + '(?![\\d.eE])').test(rawText);
  });
}

// --- operations --------------------------------------------------------------

/**
 * Запрос от имени профиля, захваченного в начале операции. request() сам
 * подставляет заголовки из глобального `settings`, но переключение аккаунта
 * между перечитыванием продажи и PATCH подменило бы токен и хост на полпути —
 * поэтому и URL, и заголовки здесь берутся из pmProfile явно.
 */
function pmRequest(pathTemplate, id, params, options = {}) {
  const path = id === undefined ? pathTemplate : fillId(pathTemplate, id);
  const profile = pmProfile || settings;
  return request(profileUrl(profile, path, params || {}), {
    ...options,
    headers: { ...authHeaders(profile.token, profile.authScheme), ...(options.headers || {}) },
  });
}

function pmGet(pathTemplate, id, params) {
  return pmRequest(pathTemplate, id, params);
}

/**
 * Прямой GET /sells/{id}. 405 — на этом тенанте маршрут не принимает GET,
 * тогда единственный путь — список за дату. 404 — маршрут есть, продажи нет.
 */
async function pmFindDirect(id) {
  if (!pmProfile.sellPath.includes('{id}')) {
    throw new ApiError('В пути продажи нет {id}. Проверьте настройки.', 'config');
  }
  const res = await pmGet(pmProfile.sellPath, id);
  if (res.status === 405) return { routeMissing: true };
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw httpError(res);

  const data = pmParse(res.text);
  const sell = data && typeof data === 'object' && !Array.isArray(data)
    ? (pmPick(data, PM_ITEMS_PATHS.concat(['sell'])).value || data)
    : null;
  if (!sell || typeof sell !== 'object' || Array.isArray(sell)) {
    throw new ApiError('Неожиданный формат ответа /sells/{id}', 'shape', res.status);
  }
  return { sell, rawText: res.text };
}

/** Запасной путь: /sells-list за день, страница за страницей, поиск по id. */
async function pmFindInList(id, date, zoneHint) {
  const zones = [];
  if (zoneHint) zones.push(zoneHint);
  for (const z of PM_LIST.zoneCandidates) if (!zones.includes(z)) zones.push(z);

  for (const zone of zones) {
    for (let page = 1; page <= PM_LIST.maxPages; page++) {
      const params = {
        size: PM_LIST.size,
        page,
        'finishedTime[min]': date + PM_LIST.dayStart,
        'finishedTime[max]': date + PM_LIST.dayEnd,
        position: PM_LIST.position,
      };
      if (zone !== null) params['zone[0]'] = zone;

      const res = await pmGet(pmProfile.sellsListPath, undefined, params);
      if (!res.ok) {
        // Неудачный фильтр зоны не должен ронять весь поиск.
        if (page === 1 && zone !== null) break;
        throw httpError(res);
      }
      const items = pmItems(pmParse(res.text));
      if (!items) throw new ApiError('Неожиданный формат ответа списка продаж', 'shape', res.status);

      // Имена способов оплаты, встроенные в список, — запасной источник подписей.
      for (const it of items) {
        for (const p of pmNormalizePayments(it) || []) {
          if (p.methodId && p.methodName) pmRememberMethod(p.methodId, p.methodName);
        }
      }
      const hit = items.find((it) => pmStr(pmPick(it, PM_FIELDS.id).value) === String(id));
      if (hit) return { sell: hit, rawText: res.text, zone };
      if (items.length < PM_LIST.size) break;
    }
  }
  return { notFound: true };
}

async function pmLoadSell(id, date) {
  const direct = await pmFindDirect(id);
  if (direct.sell) return { ...direct, mode: 'direct' };

  if (!date) return { ...direct, needsDate: true };
  const viaList = await pmFindInList(id, date, pmSell && pmSell.zoneId);
  if (viaList.sell) return { ...viaList, mode: 'list' };
  return { notFound: true, directStatus: direct.routeMissing ? 405 : 404 };
}

function pmRememberMethod(id, name) {
  const key = String(id);
  const hit = pmMethods.find((m) => m.id === key);
  if (hit) {
    if (!hit.name && name) hit.name = name;
    return;
  }
  pmMethods.push({ id: key, name: name || '' });
}

/**
 * GET /payment-methods, один раз на профиль. Дополняет pmMethods, а не
 * заменяет: имена, подсмотренные в списке продаж, должны пережить этот вызов.
 * При неудаче (кроме 401/403) список необязателен — подписи придут из самой
 * продажи, а следующий поиск попробует ещё раз.
 */
async function pmLoadMethods() {
  if (pmMethodsFor === pmProfile.id) return;

  const res = await pmGet(pmProfile.paymentMethodsPath);
  if (res.status === 401 || res.status === 403) throw httpError(res);
  if (!res.ok) return;

  const items = pmItems(res.json);
  if (!items) return;
  for (const it of items) {
    const id = pmStr(pmPick(it, PM_ID_FIELDS).value);
    if (id) pmRememberMethod(id, pmStr(pmPick(it, PM_NAME_FIELDS).value));
  }
  pmMethodsFor = pmProfile.id;
}

function pmMethodName(id) {
  const hit = pmMethods.find((m) => m.id === String(id));
  return hit && hit.name ? hit.name : `№${id}`;
}

// --- UI ----------------------------------------------------------------------

/** Подсказка «введите номер» видна, только пока на экране больше ничего нет. */
function pmUpdateHint() {
  pel.hint.hidden = !pel.card.hidden || !pel.status.hidden || !pel.done.hidden;
}

function pmShowStatus(text, isError = false) {
  pel.status.textContent = '';
  if (!isError) {
    pel.status.className = 'note note--left';
    pel.status.textContent = text;
  } else {
    pel.status.className = 'banner';
    pel.status.append(bannerIcon('err'), bannerBody(text));
  }
  pel.status.hidden = false;
  pmUpdateHint();
}

function pmClearStatus() {
  pel.status.textContent = '';
  pel.status.hidden = true;
  pmUpdateHint();
}

function pmShowDone(title, sub) {
  pel.doneTitle.textContent = title;
  pel.doneSub.textContent = sub;
  pel.done.hidden = false;
  pmUpdateHint();
}

function pmFactRow(label, value) {
  const row = document.createElement('div');
  row.className = 'row row--static';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'row__v';
  v.textContent = value;
  row.append(l, v);
  return row;
}

function pmRenderCard() {
  const s = pmSell;
  const current = s.payments[0] || null;

  pel.facts.textContent = '';
  const rows = [
    ['Продажа', `№${s.id}`],
    ['Завершена', s.finishedTime],
    ['Зона', s.zoneName || (s.zoneId ? `№${s.zoneId}` : '')],
    ['Клиент', s.customerName ? `${s.customerName} (№${s.customerId})` : (s.customerId ? `№${s.customerId}` : '')],
    ['Сумма', pmMoney(s.total)],
    ['Статус', s.status],
  ];
  // Одна строка — «Оплата»; раздельная — «Оплата 1», «Оплата 2», …
  const many = s.payments.length > 1;
  s.payments.forEach((p, i) => {
    rows.push([many ? `Оплата ${i + 1}` : 'Оплата', `${pmLineLabel(p)} · ${pmMoney(p.price)}`]);
  });
  if (!current) rows.push(['Оплата', '—']);
  for (const [label, value] of rows) {
    if (value) pel.facts.appendChild(pmFactRow(label, value));
  }

  if (s.missing.length) {
    pmShowStatus(`В ответе нет полей для записи: ${s.missing.join(', ')}. Запись отключена.`, true);
  }

  pmRenderMethods();

  pel.reason.value = '';
  pmDisarm();
  pmUpdateSubmit();
  pel.card.hidden = false;
  pmUpdateHint();
}

function pmLineLabel(p) {
  return p.methodName || pmMethodName(p.methodId);
}

function pmMethodOption(m, currentId) {
  const opt = document.createElement('option');
  opt.value = m.id;
  const name = m.name ? `${m.name} (№${m.id})` : `№${m.id}`;
  opt.textContent = m.id === currentId ? `${name} — сейчас` : name;
  return opt;
}

/**
 * По селекту на каждую строку оплаты; по умолчанию выбран текущий способ.
 * Меняют любые строки — одну, несколько или все, — и подтверждают один раз.
 * При нескольких строках сверху «Все оплаты сразу»: выставляет один способ всем.
 */
function pmRenderMethods() {
  const s = pmSell;
  const many = s.payments.length > 1;
  pel.methods.textContent = '';
  pmLineSelects = [];

  s.payments.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'payrow';
    const label = document.createElement('span');
    label.className = 'payrow__l';
    const b = document.createElement('b');
    b.textContent = many ? `${i + 1}. ${pmLineLabel(p)}` : pmLineLabel(p);
    label.append(b, document.createTextNode(` · ${pmMoney(p.price)}`));

    const sel = document.createElement('select');
    sel.className = 'sel sel--row';
    sel.dataset.line = String(i);
    sel.setAttribute('aria-label', `Новый способ для оплаты ${i + 1}`);
    // Текущий способ может отсутствовать в справочнике — тогда он всё равно нужен в списке.
    const known = pmMethods.some((m) => m.id === p.methodId);
    if (!known && p.methodId) sel.appendChild(pmMethodOption({ id: p.methodId, name: p.methodName }, p.methodId));
    for (const m of pmMethods) sel.appendChild(pmMethodOption(m, p.methodId));
    sel.value = p.methodId;

    row.append(label, sel);
    pel.methods.appendChild(row);
    pmLineSelects.push(sel);
  });

  pel.allRow.hidden = !many;
  pel.all.textContent = '';
  const first = document.createElement('option');
  first.value = '';
  first.textContent = '— выбрать для всех —';
  pel.all.appendChild(first);
  for (const m of pmMethods) pel.all.appendChild(pmMethodOption(m, ''));
  pel.all.value = '';

  const others = pmMethods.filter((m) => !s.payments.every((p) => p.methodId === m.id));
  if (!others.length && !s.missing.length) {
    pmShowStatus(pmMethods.length
      ? 'Известен только один способ оплаты — менять не на что.'
      : `Список способов оплаты не загрузился (${(pmProfile || settings).paymentMethodsPath}).`, true);
  }
}

/** Строки, у которых выбран способ, отличный от текущего. */
function pmChanges() {
  if (!pmSell) return [];
  const out = [];
  pmLineSelects.forEach((sel, i) => {
    const p = pmSell.payments[i];
    const toId = sel.value;
    if (p && toId && toId !== p.methodId) out.push({ i, from: p, toId });
  });
  return out;
}

function pmFocusFirstMethod() {
  if (!pel.allRow.hidden) pel.all.focus();
  else if (pmLineSelects[0]) pmLineSelects[0].focus();
}

function pmHideCard() {
  pel.card.hidden = true;
  pmSell = null;
  pmDisarm();
  pmUpdateHint();
}

function pmUpdateSubmit() {
  const blocked = !pmSell || pmSell.missing.length > 0 || pmSell.payments.length === 0;
  const ready = !blocked && pmChanges().length > 0 && pel.reason.value.trim().length > 0;
  pel.submit.disabled = pmBusy || !ready;
  if (!ready) pmDisarm();
}

/** Первый клик — только показать, что именно произойдёт. */
function pmArm() {
  const changes = pmChanges();
  const total = pmSell.payments.length;
  const reason = pel.reason.value.trim();
  if (changes.length === 1 && total === 1) {
    const c = changes[0];
    pel.confirmTitle.textContent =
      `Изменить продажу №${pmSell.id}: ${pmLineLabel(c.from)} → ${pmMethodName(c.toId)}?`;
    pel.confirmSub.textContent = `${pmMoney(c.from.price)} · Причина: ${reason}`;
  } else {
    pel.confirmTitle.textContent =
      `Изменить продажу №${pmSell.id} (оплат: ${changes.length} из ${total})?`;
    const lines = changes.map((c) =>
      `${c.i + 1}) ${pmLineLabel(c.from)} → ${pmMethodName(c.toId)} · ${pmMoney(c.from.price)}`);
    pel.confirmSub.textContent = `${lines.join('; ')}. Причина: ${reason}`;
  }
  pel.confirm.hidden = false;
  pel.submit.hidden = true;
  pmArmed = true;
  pel.confirmYes.focus();
}

function pmDisarm() {
  pel.confirm.hidden = true;
  pel.submit.hidden = false;
  pmArmed = false;
}

function pmSetBusy(busy) {
  pmBusy = busy;
  pel.sellId.disabled = busy;
  pel.search.disabled = busy;
  pel.sellDate.disabled = busy;
  pel.all.disabled = busy;
  for (const sel of pmLineSelects) sel.disabled = busy;
  pel.reason.disabled = busy;
  pel.confirmYes.disabled = busy;
  pel.confirmNo.disabled = busy;
  pel.tabStock.disabled = busy;
  // Переключатель аккаунтов общий с приёмом; на время записи он заперт,
  // а после — возвращается в то состояние, которое ему задаёт panel.js.
  if (busy) pel.profile.disabled = true;
  else pel.profile.disabled = profiles.length < 2;
  pmUpdateSubmit();

  // Смена профиля, пришедшая во время запроса, применяется только теперь.
  if (!busy && pmReloadPending) {
    pmReloadPending = false;
    pmResetForProfile();
  }
}

/** Всё на экране принадлежало прежнему аккаунту. */
function pmResetForProfile() {
  pmHideCard();
  pmClearStatus();
  pel.done.hidden = true;
  pmUpdateHint();
  pmMethods = [];
  pmMethodsFor = '';
  pmMode = 'direct';
  pel.dateRow.hidden = true;
  pmProfile = null;
}

function pmFocusSellId() {
  if (pel.view.hidden) return;
  pel.sellId.focus();
  pel.sellId.select();
}

/** Перезапуск анимации: снять класс, дождаться кадра, надеть снова. */
function pmPulseSellId() {
  pel.scan.classList.remove('scan--pulse');
  void pel.scan.offsetWidth;
  pel.scan.classList.add('scan--pulse');
}

// --- journal -----------------------------------------------------------------

async function pmReadLog() {
  const s = await chrome.storage.local.get(PM_LOG_KEY);
  return Array.isArray(s[PM_LOG_KEY]) ? s[PM_LOG_KEY] : [];
}

async function pmAppendLog(entry) {
  // Перечитать перед записью: страница настроек могла очистить журнал.
  const log = await pmReadLog();
  log.unshift(entry);
  const kept = log.slice(0, PM_LOG_MAX);
  await chrome.storage.local.set({ [PM_LOG_KEY]: kept });
  pmLog = kept;
}

function pmLogTitle(e) {
  const which = e.lines > 1 ? ` (оплата ${e.line}/${e.lines})` : '';
  return `№${e.sellId}${which}: ${e.fromName} → ${e.toName}`;
}

function pmRenderLog() {
  const shown = pmLog.slice(0, PM_LOG_SHOWN);
  pel.logCount.textContent = String(pmLog.length);
  pel.logEmpty.hidden = shown.length > 0;
  pel.logList.textContent = '';

  for (const e of shown) {
    const li = document.createElement('li');
    li.className = 'li';
    const main = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'li__n';
    n.textContent = pmLogTitle(e);
    const m = document.createElement('div');
    m.className = 'li__m';
    m.textContent = `${new Date(e.at).toLocaleString('ru-RU')} · ${e.profile || e.host || ''}`;
    main.append(n, m);
    const q = document.createElement('div');
    q.className = 'li__q';
    q.textContent = pmMoney(e.amount);
    li.append(main, q);
    pel.logList.appendChild(li);
  }
}

// --- handlers ----------------------------------------------------------------

function pmReportError(err) {
  if (err instanceof ApiError && err.kind === 'auth') {
    // Та же формулировка, что и в приёме: токен один на оба инструмента.
    pmShowStatus('Сессия истекла или нет прав на это действие. Проверьте токен в настройках.', true);
    return;
  }
  pmShowStatus(err instanceof ApiError ? err.message : `Ошибка: ${err && err.message ? err.message : err}`, true);
  console.error('[payment]', err);
}

async function pmOnSearch() {
  if (pmBusy || !settings) return;
  const id = pel.sellId.value.trim();
  if (!id) { pmShowStatus('Введите номер продажи.', true); return; }
  if (!/^\d+$/.test(id)) { pmShowStatus('Номер продажи — только цифры.', true); return; }

  // Прямой поиск пробуется всегда; дата нужна только если он не сработал,
  // и об этом pmLoadSell скажет сам. Так один неудачный номер не заставляет
  // вводить дату для всех следующих.
  const date = pel.sellDate.value || '';

  pmProfile = settings;
  pmSetBusy(true);
  pel.done.hidden = true;
  pmHideCard();
  pmShowStatus('Поиск…');

  try {
    const got = await pmLoadSell(id, date);
    if (got.needsDate) {
      pmMode = 'list';
      pel.dateRow.hidden = false;
      pmShowStatus(got.routeMissing
        ? 'Прямой поиск по номеру на этом сервере недоступен. Укажите дату продажи и повторите.'
        : `Продажа №${id} не найдена прямым поиском. Укажите дату — поищем в списке за день.`, true);
      pel.sellDate.focus();
      return;
    }
    if (got.notFound) {
      pmShowStatus(`Продажа №${id} не найдена.`, true);
      return;
    }

    pmMode = got.mode;
    if (got.mode === 'direct') pel.dateRow.hidden = true;

    pmSell = pmNormalizeSell(got.sell);
    await pmLoadMethods();
    for (const p of pmSell.payments) pmRememberMethod(p.methodId, p.methodName);

    pmClearStatus();
    pmRenderCard();
    if (!pel.change.hidden) pmFocusFirstMethod();
  } catch (err) {
    pmReportError(err);
    beep('err');
  } finally {
    pmSetBusy(false);
  }
}

async function pmOnConfirm() {
  if (pmBusy || !pmArmed || !pmSell) return;
  const shown = pmSell;
  const changes = pmChanges();
  const reason = pel.reason.value.trim();
  if (!changes.length) { pmShowStatus('Выберите новый способ оплаты.', true); return; }
  if (changes.some((c) => !Number.isFinite(Number(c.toId)))) {
    pmShowStatus('Выберите способ оплаты.', true);
    return;
  }
  // Новый способ по каждой строке; null — оставить как есть.
  const newMethods = shown.payments.map(() => null);
  for (const c of changes) newMethods[c.i] = Number(c.toId);

  // Карточка принадлежит профилю, под которым была загружена. Если аккаунт
  // с тех пор сменился, писать под новым — это писать в чужой тенант.
  if (!pmProfile || pmProfile.id !== settings.id) {
    pmShowStatus('Аккаунт сменился после загрузки продажи. Найдите её заново.', true);
    pmHideCard();
    return;
  }
  pmSetBusy(true);
  pmShowStatus('Запись…');

  try {
    // Читаем заново прямо перед записью и сверяем со слепком с экрана.
    const fresh = await pmLoadSell(shown.id, pel.sellDate.value || '');
    if (!fresh.sell) throw new ApiError('Продажа не перечиталась перед записью. Ничего не отправлено.', 'gone');
    const norm = pmNormalizeSell(fresh.sell);
    if (norm.fingerprint !== shown.fingerprint) {
      throw new ApiError('Продажа изменилась на сервере после загрузки. Ничего не отправлено — найдите её заново.', 'stale');
    }

    const built = pmBuildBody(fresh.sell, newMethods);
    if (built.missing.length) {
      throw new ApiError(`В ответе нет обязательных полей: ${built.missing.join(', ')}. Ничего не отправлено.`, 'missing');
    }
    const bad = pmFidelityIssues(fresh.rawText, built.echoed);
    if (bad.length) {
      throw new ApiError(`Отказ: суммы не проходят без изменений (${bad.join(', ')}).`, 'fidelity');
    }

    const bodyText = JSON.stringify(built.body);
    const res = await pmRequest(pmProfile.sellPatchPath, shown.id, {}, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    });
    if (!res.ok) {
      // Тело и ответ — в консоль панели: по ним видно, какое поле отвергнуто.
      console.error('[payment] PATCH отклонён', { status: res.status, sent: bodyText, response: res.text });
      throw httpError(res);
    }

    // Одна запись журнала на каждую изменённую строку — CSV остаётся плоским.
    const at = new Date().toISOString();
    const entries = changes.map((c) => ({
      at,
      profile: profileLabel(pmProfile),
      host: `${pmProfile.subdomain}.${pmProfile.domain}`,
      sellId: shown.id,
      line: c.i + 1,
      lines: shown.payments.length,
      fromId: c.from.methodId,
      fromName: pmLineLabel(c.from),
      toId: String(Number(c.toId)),
      toName: pmMethodName(c.toId),
      amount: c.from.price,
      reason,
    }));
    for (const e of entries.slice().reverse()) await pmAppendLog(e);
    pmRenderLog();

    pmClearStatus();
    pmHideCard();
    pel.sellId.value = '';
    if (entries.length === 1) {
      pmShowDone(pmLogTitle(entries[0]), `${pmMoney(entries[0].amount)} · ${reason}`);
    } else {
      pmShowDone(`№${shown.id}: изменено оплат — ${entries.length} из ${shown.payments.length}`,
        `${entries.map((e) => `${e.line}) ${e.fromName} → ${e.toName}`).join('; ')} · ${reason}`);
    }
    beep('ok');
  } catch (err) {
    pmDisarm();
    pmReportError(err);
    beep('err');
  } finally {
    pmSetBusy(false);
    pmFocusSellId();
  }
}

// --- tool switching ----------------------------------------------------------

const PM_TOOL_KEY = 'activeTool';

function pmShowTool(tool) {
  const pay = tool === 'payment';
  pel.stockView.hidden = pay;
  pel.view.hidden = !pay;
  pel.tabStock.classList.toggle('tab--on', !pay);
  pel.tabPay.classList.toggle('tab--on', pay);
  pel.tabStock.setAttribute('aria-selected', String(!pay));
  pel.tabPay.setAttribute('aria-selected', String(pay));
  if (pay) { pmFocusSellId(); pmPulseSellId(); }
  else if (typeof focusBarcode === 'function') focusBarcode();
}

async function pmSelectTool(tool) {
  pmShowTool(tool);
  await chrome.storage.local.set({ [PM_TOOL_KEY]: tool });
}

// --- wiring ------------------------------------------------------------------

function pmBindEvents() {
  pel.tabStock.addEventListener('click', () => pmSelectTool('stock'));
  pel.tabPay.addEventListener('click', () => pmSelectTool('payment'));

  pel.search.addEventListener('click', pmOnSearch);
  pel.scan.addEventListener('animationend', () => pel.scan.classList.remove('scan--pulse'));
  pel.sellId.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    pmOnSearch();
  });
  pel.sellDate.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    pmOnSearch();
  });
  pel.sellDate.addEventListener('change', () => {
    if (pmMode === 'list' && pel.sellId.value.trim()) pmOnSearch();
  });

  // «Все сразу» выставляет выбранный способ каждой строке; дальше строки можно править по одной.
  pel.all.addEventListener('change', () => {
    if (pel.all.value) for (const sel of pmLineSelects) sel.value = pel.all.value;
    pmUpdateSubmit();
  });
  pel.methods.addEventListener('change', () => { pel.all.value = ''; pmUpdateSubmit(); });
  pel.reason.addEventListener('input', pmUpdateSubmit);
  pel.submit.addEventListener('click', () => { if (!pel.submit.disabled) pmArm(); });
  pel.confirmNo.addEventListener('click', () => { pmDisarm(); pmFocusFirstMethod(); });
  pel.confirmYes.addEventListener('click', pmOnConfirm);

  // Смена профиля обнуляет карточку — она принадлежит прежнему аккаунту.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[PM_LOG_KEY]) {
      pmLog = Array.isArray(changes[PM_LOG_KEY].newValue) ? changes[PM_LOG_KEY].newValue : [];
      pmRenderLog();
    }
    if (!changes.profiles && !changes.activeProfileId) return;
    if (pmBusy) {
      pmReloadPending = true;
      return;
    }
    pmResetForProfile();
  });
}

async function pmInit() {
  pmLog = await pmReadLog();
  pmRenderLog();
  const s = await chrome.storage.local.get(PM_TOOL_KEY);
  pmShowTool(s[PM_TOOL_KEY] === 'payment' ? 'payment' : 'stock');
}

pmBindEvents();
pmInit();
