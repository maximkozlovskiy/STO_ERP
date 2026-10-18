'use strict';
/**
 * Фейк BM Parts за https://developer.bm.parts/openapi.json: `Authorization: <токен>`, без
 * `User-Agent` — 403, `X-Test-Mode` записується в журнал. `GET /profile/me`,
 * `GET /search/products` (products_as=arr|obj, search_mode=strict), `GET /product/{uuid}?analogs_available=1`
 * (analogs — мапа uuid → картка; у специфікації схема порожня), `POST /shopping/carts`,
 * `POST /shopping/reserve/process` (analysis reserved/planned), `GET /shopping/reserves`
 * (reserves → picking після відвантаження чи першого опитування), `GET /processing/departures`,
 * `POST /processing/reserve/process`. Токен: `bm-test-token`.
 */
const { CATALOG, findByArticle, analogsOf } = require('./catalog');

const TOKEN = 'bm-test-token';
const WAREHOUSES = [
  { uuid: '81F4005056AC66D611EAD7173350C7AA', name: 'Київ', short_name: 'Київ', is_main: true },
  { uuid: '81F4005056AC66D611EAD7173350C7BB', name: 'Львів', short_name: 'Львів', is_main: false },
];
const STOCK = { oc90: ['12', '>'], w712: ['3', '0'], gdb1330: ['0', '5'], k015: ['1', '0'] };
const PRICE_FACTOR = 0.98;

const productUuid = c => `BB${String(CATALOG.indexOf(c)).padStart(30, '0')}`;
const price = c => (Math.round(c.basePrice * PRICE_FACTOR * 100) / 100).toFixed(2);

function card(c, withUuid) {
  return {
    ...(withUuid ? { uuid: productUuid(c) } : {}),
    name: c.name,
    article: c.article,
    brand: c.brand,
    price: price(c),
    currency_name: 'UAH',
    multiplicity: 1,
    available: true,
    in_stocks: WAREHOUSES.map((w, i) => ({
      uuid: w.uuid,
      name: w.name,
      short_name: w.short_name,
      is_main: w.is_main,
      has_reserves: false,
      quantity: (STOCK[c.key] || ['0', '0'])[i],
    })),
    in_others: { uuid: '-', name: 'На інших', has_reserves: false, quantity: '-' },
    in_waiting: { uuid: '-', name: 'Очікується', has_reserves: false, quantity: '-' },
  };
}

function initState() {
  return { carts: {}, reserves: [], seq: 0, departureRequests: 0 };
}

function handle(ctx) {
  const { method, path, data, body } = ctx;
  if (!ctx.headers['user-agent'])
    return ctx.json(403, { error: 'User-Agent required', result: false });
  if (ctx.headers.authorization !== TOKEN)
    return ctx.json(401, { error: 'Unauthorized', result: false });

  if (method === 'GET' && path === '/profile/me')
    return ctx.json(200, { uuid: 'client-1', name: 'СТО Тест' });
  if (method === 'GET' && path === '/search/products') {
    const found = findByArticle(ctx.query.get('q'));
    const asArr = ctx.query.get('products_as') === 'arr';
    const products = asArr
      ? found.map(c => card(c, true))
      : Object.fromEntries(found.map(c => [productUuid(c), card(c, false)]));
    return ctx.json(200, {
      products,
      search: { hits: found.length, total_pages: 1 },
      headers: WAREHOUSES.map(w => ({
        warehouse: w.name,
        short_name: w.short_name,
        is_main: w.is_main,
      })),
    });
  }
  const prod = /^\/product\/([^/]+)$/.exec(path);
  if (method === 'GET' && prod) {
    const c = CATALOG.find(x => productUuid(x) === prod[1]);
    if (!c) return ctx.json(404, { error: 'not found' });
    const analogs =
      ctx.query.get('analogs_available') === '1'
        ? Object.fromEntries(analogsOf(c).map(a => [productUuid(a), card(a, false)]))
        : null;
    return ctx.json(200, { product: { ...card(c, true), analogs }, headers: [] });
  }
  if (method === 'POST' && path === '/shopping/carts') {
    data.seq += 1;
    const uuid = `CART${String(data.seq).padStart(28, '0')}`;
    data.carts[uuid] = {
      uuid,
      name: body?.name,
      comment: body?.comment,
      warehouse: body?.warehouse,
      products: body?.products || [],
    };
    return ctx.json(201, {
      carts: {
        uuid,
        name: body?.name,
        comment: body?.comment,
        products_count: (body?.products || []).length,
      },
    });
  }
  if (method === 'POST' && path === '/shopping/reserve/process') {
    const cart = data.carts[body?.order_uuid];
    if (!cart) return ctx.json(422, { error: 'Кошик не знайдено', result: false });
    const partial = ctx.partial();
    data.seq += 1;
    const uuid = `RES${String(data.seq).padStart(29, '0')}`;
    const analysis = cart.products.map(p => {
      const c = CATALOG.find(x => productUuid(x) === p.uuid);
      return {
        uuid: p.uuid,
        article: c ? c.article : '',
        brand_name: c ? c.brand : '',
        planned: p.qnt,
        reserved: partial ? Math.floor(p.qnt / 2) : p.qnt,
      };
    });
    data.reserves.push({
      uuid,
      number: `РЗ-${String(data.seq).padStart(6, '0')}`,
      status: 'Резерв',
      comment: body?.comment,
      warehouse: body?.warehouse_uuid,
      branch: 'reserves',
      polls: 0,
    });
    return ctx.json(201, { uuid, result: true, analysis });
  }
  if (method === 'GET' && path === '/shopping/reserves') {
    const view = branch =>
      WAREHOUSES.map(w => ({
        warehouse_uuid: w.uuid,
        warehouse_name: w.name,
        orders: data.reserves
          .filter(r => r.branch === branch && r.warehouse === w.uuid)
          .map(r => ({
            uuid: r.uuid,
            number: r.number,
            status: r.status,
            comment: r.comment,
            sum: 0,
            currency: 'UAH',
          })),
      }));
    const out = { reserves: view('reserves'), picking: view('picking') };
    for (const r of data.reserves) {
      r.polls += 1;
      if (r.polls >= 1 && r.branch === 'reserves') {
        r.branch = 'picking';
        r.status = 'Збирання';
      }
    }
    return ctx.json(200, out);
  }
  if (method === 'GET' && path === '/processing/departures') {
    data.departureRequests += 1;
    return ctx.json(200, {
      departures: [
        {
          uuid: 'KEY123 2026-10-18T08:00:00Z',
          key: 'KEY123',
          name: 'Київ ранок',
          route_code: 'R001',
          departure_at: '2026-10-18T12:00:00Z',
          expired_at: '2026-10-18T10:00:00Z',
          route_at: '2026-10-18T08:00:00Z',
          additional: { is_fastest: true },
        },
      ],
    });
  }
  if (method === 'POST' && path === '/processing/reserve/process') {
    const ids = body?.orders_array || [];
    const res = data.reserves.filter(r => ids.includes(r.uuid));
    if (!res.length || res.some(r => r.shipped))
      return ctx.json(422, { error: 'Невалідний orders_array', result: false });
    for (const r of res) {
      r.shipped = true;
      r.branch = 'picking';
      r.status = 'Відвантаження';
    }
    return ctx.json(201, {
      result: true,
      document: { uuid: 'DOC1', number: 'РН-000777', type: 'realization' },
    });
  }
  return undefined;
}

module.exports = { initState, handle, TOKEN, WAREHOUSES, productUuid };
