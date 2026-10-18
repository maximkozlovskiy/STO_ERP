'use strict';
/**
 * Фейк AD Ukraine / АвтоТехнікс за https://api.ad.ua/swagger/eCom.OpenApi.v2/swagger.json:
 * `POST /api/v2/ecom/auth/login` {login, pwd, company} → data.token (JWT з exp; невірні дані — 401
 * ErrorResultDto), `Authorization: Bearer`, `item/search` {code} → data.rows (ItemDataDto),
 * `order/create` → data.docNo, `order/one` {docNo} (лише невідвантажені; відвантажене — 400),
 * `order/list` {page}, `location/list`. Креди: ad-login / ad-pwd, company=autotechnics.
 */
const { CATALOG, findByArticle } = require('./catalog');

const LOGIN = 'ad-login';
const PWD = 'ad-pwd';
const STOCK = { oc90: { КИЕВ2: '>10', ЛЬВОВ: '3' }, gdb1330: { КИЕВ2: '2' }, k015: { ЛЬВОВ: '1' } };

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = n =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: LOGIN, n, exp: 4102444800 })}.sig`;
const err = (ctx, status, title) =>
  ctx.json(status, { errors: [{ status: String(status), code: 'error', title, detail: title }] });

function initState() {
  return { tokens: {}, seq: 0, orders: [], docSeq: 0 };
}

function handle(ctx) {
  const { method, path, data, body } = ctx;
  if (method !== 'POST') return err(ctx, 405, 'POST only');
  if (path === '/api/v2/ecom/auth/login') {
    if (body?.login !== LOGIN || body?.pwd !== PWD)
      return err(ctx, 401, 'Неправильно введені логін чи пароль');
    data.seq += 1;
    const token = jwt(data.seq);
    data.tokens[token] = true;
    return ctx.json(200, {
      data: { token, userName: LOGIN, custNo: '00000', custName: 'СТО Тест', location: 'КИЕВ2' },
    });
  }
  const auth = String(ctx.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !data.tokens[auth.slice(7)])
    return err(ctx, 401, 'Unauthorized');

  if (path === '/api/v2/ecom/location/list') {
    return ctx.json(200, {
      data: {
        rows: [
          { code: 'КИЕВ2', sort: 1, name2: 'Київ', aduUnionOrders: false },
          { code: 'ЛЬВОВ', sort: 2, name2: 'Львів', aduUnionOrders: false },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      },
    });
  }
  if (path === '/api/v2/ecom/item/search') {
    const rows = findByArticle(body?.code).map(c => ({
      itemNo: c.article.replace(/\s+/g, ''),
      itemNo2: c.article,
      brand: c.brand,
      description: c.name,
      inStock: true,
      retail: Math.round(c.basePrice * 1.3 * 100) / 100,
      price: Math.round(c.basePrice * 1.02 * 100) / 100,
      stock: Object.entries(STOCK[c.key] || {}).map(([location, quantity]) => ({
        location,
        quantity,
      })),
    }));
    return ctx.json(200, { data: { rows, total: rows.length, page: 1, pageSize: 100 } });
  }
  if (path === '/api/v2/ecom/order/create') {
    if (!Array.isArray(body?.items) || !body.items.length || !body.locationCode)
      return err(ctx, 400, 'Некоректні дані');
    data.docSeq += 1;
    const docNo = `ЗК-${String(data.docSeq).padStart(7, '0')}`;
    data.orders.push({
      docNo,
      locationCode: body.locationCode,
      customerComment: body.customerComment,
      items: body.items,
      polls: 0,
      partial: ctx.partial(),
    });
    return ctx.json(200, { data: { docNo } });
  }
  const view = o => ({
    docNo: o.docNo,
    locationCode: o.locationCode,
    status: 1,
    documentStatusName: 'Прийнято',
    orderDate: '2026-10-18T10:00:00',
    orderLinesQuantity: o.items.length,
    customerComment: o.customerComment,
    lines: o.items.map((it, i) => {
      const c = CATALOG.find(x => x.article.replace(/\s+/g, '') === it.itemNo);
      const qty = o.partial && i === 0 ? Math.floor(it.quantity / 2) : it.quantity;
      return {
        docNo: o.docNo,
        lineNo: (i + 1) * 10000,
        type: 2,
        itemNo: it.itemNo,
        brand: c ? c.brand : '',
        locationCode: o.locationCode,
        quantity: qty,
        unitPrice: c ? Math.round(c.basePrice * 1.02 * 100) / 100 : 0,
        reserve: qty,
        salesOrderMultiple: 1,
      };
    }),
  });
  if (path === '/api/v2/ecom/order/one') {
    const o = data.orders.find(x => x.docNo === body?.docNo);
    if (!o) return err(ctx, 400, 'Замовлення не знайдено');
    o.polls += 1;
    if (o.polls > 2) return err(ctx, 400, 'Замовлення не знайдено серед невідвантажених');
    return ctx.json(200, { data: view(o) });
  }
  if (path === '/api/v2/ecom/order/list') {
    const page = Number(body?.page || 1);
    const pageSize = 20;
    const rows = data.orders.slice((page - 1) * pageSize, page * pageSize).map(view);
    return ctx.json(200, { data: { rows, total: data.orders.length, page, pageSize } });
  }
  return undefined;
}

module.exports = { initState, handle, LOGIN, PWD };
