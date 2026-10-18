'use strict';
/**
 * Фейк AVD Trade за https://dev-api.avdtrade.com.ua/openapi.yaml (AVDtrade public API 1.2.0):
 * `x-api-key`, конверт `{status, track_uuid, data}`, `POST /items/query` (page, per_page, has_stock),
 * `GET /price/export` → download_url, файл двічі відповідає 202, далі CSV; кошики
 * `POST /carts`, `PATCH /carts/{uuid}`, `POST /carts/{uuid}/lines` (add|replace),
 * `POST /carts/{uuid}/checkout`; `GET /orders?order_uuid&include_lines` — статус рухається з кожним
 * опитуванням. Ключ: `avd-test-key`. Сценарій `partial` — оформлення підтверджує половину рядка.
 */
const { CATALOG } = require('./catalog');

const API_KEY = 'avd-test-key';
const WAREHOUSES = [
  { uuid: 'a1111111-0000-4000-8000-000000000001', name: 'ЖИТОМИР' },
  { uuid: 'a1111111-0000-4000-8000-000000000002', name: 'КИЇВ' },
];
const STOCK = {
  oc90: [4, 25],
  w712: [2, 0],
  gdb1330: [0, 1],
  k015: [0, 0],
};
const ORDER_FLOW = [
  'В черзі на відправку',
  'Відправлено на зборку',
  'Готовий до відвантаження',
  'Відправлено (відвантажено)',
];

const itemUuid = i => `a0000000-0000-4000-8000-00000000000${i + 1}`;
const ok = data => ({
  status: 'success',
  track_uuid: 'f0000000-0000-4000-8000-000000000000',
  data,
});

function items() {
  return CATALOG.map((c, i) => ({
    uuid: itemUuid(i),
    article: c.article,
    brand_uuid: `b0000000-0000-4000-8000-00000000000${i + 1}`,
    brand: c.brand,
    category_uuid: 'c0000000-0000-4000-8000-000000000001',
    category: c.name,
    name: c.name,
    price: { currency: 'UAH', value: c.basePrice, type: 'personal' },
    stock: WAREHOUSES.map((w, wi) => {
      const q = (STOCK[c.key] || [0, 0])[wi] || 0;
      return {
        warehouse_uuid: w.uuid,
        warehouse: w.name,
        is_capped: q > 10,
        quantity: Math.min(q, 10),
      };
    }),
  }));
}

function initState() {
  return { carts: {}, orders: {}, cartSeq: 0, exportCalls: 0 };
}

function cartView(c) {
  return {
    uuid: c.uuid,
    status: c.status,
    number: c.number,
    created_date: '2026-10-18',
    location_uuid: c.location_uuid,
    total_price: c.lines.reduce((s, l) => s + l.price * l.quantity, 0),
    customer_comment: c.customer_comment,
    allowed_actions: {
      edit: c.status === 'Зарезервовано',
      delete: true,
      checkout: c.status === 'Зарезервовано',
    },
    lines: c.lines.map((l, i) => ({
      uuid: `${c.uuid.slice(0, 30)}${String(i).padStart(6, '0')}`,
      item: { uuid: l.item_uuid },
      warehouse_uuid: l.warehouse_uuid,
      quantity: l.quantity,
      price: l.price,
      total_price: l.price * l.quantity,
    })),
  };
}

function handle(ctx) {
  const { method, path, data, body } = ctx;
  if (path === '/files/price.csv' && method === 'GET') {
    data.exportCalls += 1;
    if (data.exportCalls <= 2) return ctx.json(202, '');
    const head = 'uuid;article;brand;name;price;currency;ЖИТОМИР;КИЇВ';
    const rows = items().map(
      it =>
        `${it.uuid};${it.article};${it.brand};${it.name};${it.price.value};UAH;${it.stock[0].quantity};${it.stock[1].is_capped ? '>10' : it.stock[1].quantity}`,
    );
    return ctx.json(200, [head, ...rows].join('\n'));
  }
  if (ctx.headers['x-api-key'] !== API_KEY) {
    return ctx.json(401, {
      status: 'error',
      error: { code: 'UNAUTHORIZED', message: 'Немає / невалідний ключ.' },
    });
  }
  const limitHeaders = {
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '59',
    'x-ratelimit-reset': '30',
  };

  if (method === 'GET' && path === '/api/v1/health') return ctx.json(200, ok({ healthy: true }));
  if (method === 'GET' && path === '/api/v1/warehouses') {
    return ctx.json(200, ok({ warehouses: WAREHOUSES }), limitHeaders);
  }
  if (method === 'POST' && path === '/api/v1/items/query') {
    const page = Number(body?.page || 1);
    const perPage = Number(body?.per_page || 30);
    if (data.queryDisabled)
      return ctx.json(405, { status: 'error', error: { code: 'METHOD_NOT_ALLOWED' } });
    let all = items();
    if (body?.has_stock) all = all.filter(i => i.stock.some(s => s.quantity > 0));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    return ctx.json(
      200,
      ok({
        items: slice,
        pagination: {
          page,
          per_page: perPage,
          total_pages: Math.max(1, Math.ceil(all.length / perPage)),
          total_items: all.length,
        },
      }),
      limitHeaders,
    );
  }
  if (method === 'GET' && path === '/api/v1/price/export') {
    return ctx.json(200, ok({ download_url: `${ctx.baseUrl}/files/price.csv` }));
  }
  if (method === 'GET' && path === '/api/v1/carts') {
    return ctx.json(200, ok({ carts: Object.values(data.carts).map(cartView) }));
  }
  if (method === 'POST' && path === '/api/v1/carts') {
    data.cartSeq += 1;
    const uuid = `e0000000-0000-4000-8000-${String(data.cartSeq).padStart(12, '0')}`;
    data.carts[uuid] = {
      uuid,
      status: 'Зарезервовано',
      number: `AGS${String(1000 + data.cartSeq).padStart(8, '0')}`,
      location_uuid: body?.location_uuid,
      customer_comment: null,
      lines: [],
    };
    return ctx.json(200, ok({ cart: { uuid } }));
  }
  const cartMatch = /^\/api\/v1\/carts\/([^/]+)(\/lines|\/checkout)?$/.exec(path);
  if (cartMatch) {
    const cart = data.carts[cartMatch[1]];
    if (!cart)
      return ctx.json(404, {
        status: 'error',
        error: { code: 'NOT_FOUND', message: 'Ресурс не знайдено.' },
      });
    const tail = cartMatch[2];
    if (!tail && method === 'PATCH') {
      if (body?.customer_comment !== undefined) cart.customer_comment = body.customer_comment;
      return ctx.json(200, ok(undefined));
    }
    if (tail === '/lines' && method === 'GET') return ctx.json(200, ok({ cart: cartView(cart) }));
    if (tail === '/lines' && method === 'POST') {
      const all = items();
      const results = [];
      const next = body?.operation === 'replace' ? [] : cart.lines.slice();
      (body?.lines || []).forEach((l, idx) => {
        const it = all.find(i => i.uuid === l.item_uuid);
        const st = it && it.stock.find(s => s.warehouse_uuid === l.warehouse_uuid);
        if (!it || !st) {
          results.push({
            requested_line_index: idx,
            status: 'error',
            added_quantity: 0,
            error_message: 'Товар з таким ідентифікатором не знайдено',
          });
          return;
        }
        const available = st.is_capped ? 1000 : st.quantity;
        const add = Math.min(l.quantity, available);
        const existing = next.find(
          x => x.item_uuid === l.item_uuid && x.warehouse_uuid === l.warehouse_uuid,
        );
        if (existing) existing.quantity += add;
        else if (add > 0)
          next.push({
            item_uuid: l.item_uuid,
            warehouse_uuid: l.warehouse_uuid,
            quantity: add,
            price: it.price.value,
          });
        results.push({
          requested_line_index: idx,
          requested_item_uuid: l.item_uuid,
          requested_warehouse_uuid: l.warehouse_uuid,
          requested_quantity: l.quantity,
          status: add === l.quantity ? 'success' : add > 0 ? 'adjusted' : 'skipped',
          added_quantity: add,
        });
      });
      cart.lines = next;
      const count = s => results.filter(r => r.status === s).length;
      return ctx.json(
        200,
        ok({
          summary: {
            total: results.length,
            success: count('success'),
            adjusted: count('adjusted'),
            skipped: count('skipped'),
            error: count('error'),
          },
          lines_result: results,
        }),
      );
    }
    if (tail === '/checkout' && method === 'POST') {
      if (cart.status !== 'Зарезервовано')
        return ctx.json(400, {
          status: 'error',
          error: { code: 'BAD_REQUEST', message: 'Кошик не можна оформити' },
        });
      const partial = ctx.partial();
      const lines = cart.lines.map((l, i) => {
        const confirmed = partial ? Math.floor(l.quantity / 2) : l.quantity;
        return {
          line_uuid: `l0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          item_uuid: l.item_uuid,
          warehouse_uuid: l.warehouse_uuid,
          requested_quantity: l.quantity,
          confirmed_quantity: confirmed,
          status: confirmed === l.quantity ? 'full' : confirmed > 0 ? 'partial' : 'out_of_stock',
        };
      });
      data.orders[cart.uuid] = {
        uuid: cart.uuid,
        number: cart.number,
        customer_comment: cart.customer_comment,
        polls: 0,
        lines: lines.map(l => {
          const src = cart.lines.find(
            x => x.item_uuid === l.item_uuid && x.warehouse_uuid === l.warehouse_uuid,
          );
          return {
            item_uuid: l.item_uuid,
            warehouse_uuid: l.warehouse_uuid,
            quantity: l.confirmed_quantity,
            price: src.price,
          };
        }),
      };
      cart.status = 'checked_out';
      return ctx.json(
        200,
        ok({
          processing: { flow: 'direct_shipment', reason: '', status: 'В черзі на відправку' },
          summary: {
            total: lines.length,
            full: lines.filter(l => l.status === 'full').length,
            partial: lines.filter(l => l.status === 'partial').length,
            out_of_stock: lines.filter(l => l.status === 'out_of_stock').length,
          },
          lines_result: lines,
        }),
      );
    }
  }
  if (method === 'GET' && path === '/api/v1/orders') {
    const id = ctx.query.get('order_uuid');
    const withLines = ctx.query.get('include_lines') === 'true';
    const list = Object.values(data.orders).filter(o => !id || o.uuid === id);
    return ctx.json(
      200,
      ok({
        orders: list.map(o => {
          const status = ORDER_FLOW[Math.min(o.polls, ORDER_FLOW.length - 1)];
          o.polls += 1;
          return {
            uuid: o.uuid,
            status,
            number: o.number,
            location_uuid: null,
            total_price: o.lines.reduce((s, l) => s + l.price * l.quantity, 0),
            customer_comment: o.customer_comment,
            created_date: '2026-10-18',
            shipment_date: '2026-10-19',
            posting_date: null,
            ...(withLines
              ? {
                  lines: o.lines.map(l => ({
                    item: { uuid: l.item_uuid },
                    warehouse_uuid: l.warehouse_uuid,
                    quantity: l.quantity,
                    price: l.price,
                    total_price: l.price * l.quantity,
                  })),
                }
              : {}),
          };
        }),
        pagination: { page: 1, per_page: 30, total_pages: 1, total_items: list.length },
      }),
    );
  }
  return undefined;
}

module.exports = { initState, handle, API_KEY, WAREHOUSES, itemUuid };
