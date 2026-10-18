'use strict';
/**
 * Фейк UTR (UniqTrade API v2) за вікі https://api.utr.ua: `POST /api/login_check?browser_fingerprint=`
 * {email, password} → {token, expires_at, refresh_token} (невірні дані — 412), `POST /api/token/refresh`,
 * `Authorization: Bearer`, 401 «Expired JWT Token», `GET /api/search/{oem}?brand=`,
 * `POST /api/deliveries/{date}/{point}/{transporter}`, `POST /api/order/accept` (201, масив),
 * `GET /api/order/{id}` (404 «Order not found!»), `GET /api/order-list/{date}`.
 * Креди: utr@test.ua / utr-pass. `data.expireTokens = true` — наступний запит отримає 401 Expired.
 */
const { CATALOG, findByArticle, norm } = require('./catalog');

const EMAIL = 'utr@test.ua';
const PASSWORD = 'utr-pass';
const STORAGES = [
  { id: 6, name: 'Миколаїв', originalName: 'Николаев' },
  { id: 15, name: 'Kиїв Правий', originalName: 'Kиев Правый' },
];
const REMAINS = { oc90: ['4', '> 10'], gdb1330: ['0', '2'], k015: ['1', '0'], w712: ['0', '0'] };
const PRICE_FACTOR = 1.05;

const detailId = c => 45000 + CATALOG.indexOf(c);

function detail(c) {
  const price = Math.round(c.basePrice * PRICE_FACTOR * 100) / 100;
  return {
    multiplicity: 1,
    id: detailId(c),
    brand: { name: c.brand, externalCode: '00116' },
    displayBrand: c.brand,
    article: c.article,
    title: c.name,
    quantity: 1,
    yourPrice: { amount: price, currency: { code: 'UAH' } },
    yourPriceUAH: { amount: price, currency: { code: 'UAH' } },
    remains: STORAGES.map((s, i) => ({
      storage: s,
      remain: (REMAINS[c.key] || ['0', '0'])[i],
    })).filter(r => r.remain !== '0'),
    detailScanCodes: [],
    category: { name: c.name },
    modifier: 0,
  };
}

function initState() {
  return { tokens: {}, refresh: {}, seq: 0, orders: [], orderSeq: 0, expireTokens: false };
}

function issue(data) {
  data.seq += 1;
  const token = `utr-token-${data.seq}`;
  const refresh = `utr-refresh-${data.seq}`;
  data.tokens[token] = true;
  data.refresh[refresh] = true;
  return {
    token,
    expires_at: '2099-01-01 00:00:00',
    refresh_token: refresh,
  };
}

function orderView(o) {
  return {
    id: o.id,
    externalCode: o.externalCode,
    date: '2026-10-18T08:31:22+03:00',
    orderItems: o.items.map(i => {
      const c = CATALOG.find(x => detailId(x) === i.detail);
      return {
        detail: c ? detail(c) : { id: i.detail },
        storage: STORAGES.find(s => s.id === i.storage) || { id: i.storage },
        quantity: i.quantity,
        price: { amount: c ? Math.round(c.basePrice * PRICE_FACTOR * 100) / 100 : 0 },
      };
    }),
    status: o.status,
    delivery: { name: 'Курьер Киев 9:00' },
    paymentType: o.paymentType,
    comment: o.comment,
    amount: { amount: 0, currency: { code: 'UAH' } },
  };
}

function handle(ctx) {
  const { method, path, data, body } = ctx;
  if (method === 'POST' && path === '/api/login_check') {
    if (!ctx.query.get('browser_fingerprint'))
      return ctx.json(400, { code: 400, message: 'fingerprint' });
    if (body?.email !== EMAIL || body?.password !== PASSWORD) {
      return ctx.json(412, {
        code: 412,
        message:
          'Некоректні дані користувача. Перевірте коректність введених даних і спробуйте ще раз.',
      });
    }
    return ctx.json(200, issue(data));
  }
  if (method === 'POST' && path === '/api/token/refresh') {
    if (!data.refresh[body?.refresh_token]) {
      return ctx.json(401, {
        code: 401,
        message: { status: '401 Unauthorized', message: 'Bad credentials' },
      });
    }
    delete data.refresh[body.refresh_token];
    return ctx.json(200, issue(data));
  }
  const auth = String(ctx.headers.authorization || '');
  if (!auth.startsWith('Bearer '))
    return ctx.json(401, { code: 401, message: 'JWT Token not found' });
  const token = auth.slice(7);
  if (!data.tokens[token]) return ctx.json(401, { code: 401, message: 'Invalid JWT Token' });
  if (data.expireTokens) {
    data.expireTokens = false;
    for (const t of Object.keys(data.tokens)) delete data.tokens[t];
    return ctx.json(401, { code: 401, message: 'Expired JWT Token' });
  }

  if (method === 'GET' && path === '/api/delivery-points') {
    return ctx.json(200, { deliveryPoints: [{ id: 22, address: 'СТОЛИЧКА ВИДУБИЧІ, Київ' }] });
  }
  const search = /^\/api\/search\/([^/]+)$/.exec(path);
  if (method === 'GET' && search) {
    const oem = decodeURIComponent(search[1]);
    const brand = ctx.query.get('brand');
    const found = findByArticle(oem).filter(c => !brand || norm(c.brand) === norm(brand));
    return ctx.json(200, { details: found.map(detail) });
  }
  const deliveries = /^\/api\/deliveries\/(\d{4}-\d{2}-\d{2})\/(\d+)\/(\d+)$/.exec(path);
  if (method === 'POST' && deliveries) {
    if (!Array.isArray(body?.storages) || body.storages.length === 0) {
      return ctx.json(400, { err: 'There is no storages to process' });
    }
    return ctx.json(200, [
      { id: 850, name: 'Заказ до 10-15 \\выезд в 10:30', time: '00:00', timestamp: 1575038033 },
    ]);
  }
  if (method === 'POST' && path === '/api/order/accept') {
    const req = Array.isArray(body) ? body[0] : null;
    if (!req || !req.delivery || !Array.isArray(req.items) || req.items.length === 0) {
      return ctx.json(400, { code: 400, message: 'Значение недопустимо.\r\n' });
    }
    data.orderSeq += 1;
    const order = {
      id: 6802273 + data.orderSeq,
      externalCode: `УЭТ${String(data.orderSeq).padStart(6, '0')}`,
      items: req.items.map(i => ({
        ...i,
        quantity: ctx.partial() ? Math.floor(i.quantity / 2) : i.quantity,
      })),
      status: 'processing',
      paymentType: req.paymentType,
      comment: req.comment,
      polls: 0,
    };
    data.orders.push(order);
    return ctx.json(201, [orderView(order)]);
  }
  const one = /^\/api\/order\/(\d+)$/.exec(path);
  if (method === 'GET' && one) {
    const o = data.orders.find(x => String(x.id) === one[1]);
    if (!o) return ctx.json(404, { code: 404, message: 'Order not found!' });
    o.polls += 1;
    // Документація показує лише processing; другий стан — свідомо невідомий адаптеру.
    if (o.polls > 1) o.status = 'shipped_unknown';
    return ctx.json(200, orderView(o));
  }
  if (method === 'GET' && /^\/api\/order-list\/\d{4}-\d{2}-\d{2}$/.test(path)) {
    return ctx.json(200, data.orders.map(orderView));
  }
  return undefined;
}

module.exports = { initState, handle, EMAIL, PASSWORD, detailId };
