'use strict';
/**
 * Фейк Tehnomir за swagger https://tehnomir.com.ua/index.php?r=swagger%2Fjson-schema: усі запити
 * POST JSON з `apiToken` у тілі, відповідь `{success, data}`. `/test/connect`, `/price/search`
 * {code, isShowAnalogs}, `/basket/add|getPositions|clear`, `/order/create` {orderNumber, basketIds}
 * — замовляє ЛИШЕ перелічені позиції, `/order/search`, `/order/getOrderPositions` (стан позицій
 * рухається з кожним опитуванням). Токен: `tm-test-token`. Сценарій `partial` — одна одиниця
 * першої позиції у стані «Отказ».
 */
const { CATALOG, findByArticle, analogsOf } = require('./catalog');

const TOKEN = 'tm-test-token';
const productId = c => 900 + CATALOG.indexOf(c);
const RESTS = {
  oc90: [
    {
      priceLogo: 'ABCD',
      currency: 'UAH',
      factor: 0.94,
      quantity: 20,
      quantityType: 'MORE',
      multiplicity: 1,
      deliveryTime: 3,
    },
    {
      priceLogo: 'EU01',
      currency: 'EUR',
      eur: 2.6,
      quantity: 5,
      quantityType: 'EQUAL',
      multiplicity: 2,
      deliveryTime: 10,
    },
  ],
  w712: [
    {
      priceLogo: 'ABCD',
      currency: 'UAH',
      factor: 0.9,
      quantity: 7,
      quantityType: 'EQUAL',
      multiplicity: 1,
      deliveryTime: 2,
    },
  ],
  gdb1330: [
    {
      priceLogo: 'PL22',
      currency: 'UAH',
      factor: 1.1,
      quantity: 2,
      quantityType: 'EQUAL',
      multiplicity: 1,
      deliveryTime: 1,
    },
  ],
};
const STATE_FLOW = ['В работе', 'На складе', 'Выдан'];

function product(c) {
  return {
    productId: productId(c),
    brandId: 10 + CATALOG.indexOf(c),
    brand: c.brand,
    code: c.article,
    descriptionRus: c.name,
    descriptionUa: c.name,
    isOriginal: false,
    rests: (RESTS[c.key] || []).map(r => ({
      priceLogo: r.priceLogo,
      price: r.eur ? r.eur : Math.round(c.basePrice * r.factor * 100) / 100,
      currency: r.currency,
      quantity: r.quantity,
      quantityType: r.quantityType,
      multiplicity: r.multiplicity,
      deliveryTime: r.deliveryTime,
      deliveryDate: '2026-10-21 12:00:00',
      priceQuality: 4,
      deliveryPercent: 95,
      country: r.currency === 'EUR' ? 'Польща' : 'Україна',
    })),
  };
}

function initState() {
  return { basket: [], basketSeq: 15847520, orders: [], orderSeq: 0 };
}

function handle(ctx) {
  const { method, path, data, body } = ctx;
  if (method !== 'POST') return ctx.json(405, { success: false, message: 'POST only' });
  if (!body || body.apiToken !== TOKEN)
    return ctx.json(200, { success: false, message: 'Invalid apiToken' });

  if (path === '/test/connect')
    return ctx.json(200, { success: true, data: { testString: body.string } });
  if (path === '/price/search') {
    const found = findByArticle(body.code);
    const withAnalogs = Number(body.isShowAnalogs) === 1;
    const all = withAnalogs ? [...found, ...found.flatMap(analogsOf)] : found;
    return ctx.json(200, { success: true, data: all.map(product) });
  }
  if (path === '/basket/getPositions') {
    return ctx.json(200, { success: true, data: data.basket.map(b => ({ ...b })) });
  }
  if (path === '/basket/add') {
    if (!body.productId || !body.priceLogo || !(body.quantity >= 1 && body.quantity <= 200)) {
      return ctx.json(200, { success: false, message: 'Invalid position' });
    }
    data.basketSeq += 1;
    const c = CATALOG.find(x => productId(x) === body.productId);
    const r = c && product(c).rests.find(x => x.priceLogo === body.priceLogo);
    data.basket.push({
      basketId: data.basketSeq,
      priceLogo: body.priceLogo,
      brand: c ? c.brand : '',
      code: c ? c.article : '',
      quantity: body.quantity,
      price: r ? r.price : 0,
      currency: r ? r.currency : 'UAH',
      reference: body.reference,
      comment: body.comment,
      productId: body.productId,
    });
    return ctx.json(200, { success: true, data: { basketId: data.basketSeq } });
  }
  if (path === '/basket/clear') {
    data.basket = [];
    return ctx.json(200, { success: true });
  }
  if (path === '/order/create') {
    const ids = Array.isArray(body.basketIds) ? body.basketIds : data.basket.map(b => b.basketId);
    const positions = data.basket.filter(b => ids.includes(b.basketId));
    if (!positions.length) return ctx.json(200, { success: false, message: 'Basket is empty' });
    data.basket = data.basket.filter(b => !ids.includes(b.basketId));
    data.orderSeq += 1;
    const order = {
      orderId: 3300000 + data.orderSeq,
      orderNumber: body.orderNumber,
      positions,
      polls: 0,
      partial: ctx.partial(),
    };
    data.orders.push(order);
    return ctx.json(200, {
      success: true,
      data: {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        sum: positions.reduce((s, p) => s + p.price * p.quantity, 0),
        statusId: '1',
        status: 'Новый',
        createTime: '2026-10-18 10:00:00',
      },
    });
  }
  if (path === '/order/search') {
    const list = data.orders.filter(o => !body.orderNumber || o.orderNumber === body.orderNumber);
    return ctx.json(200, {
      success: true,
      data: list.map(o => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        sum: 0,
        statusId: '1',
        status: 'Новый',
      })),
    });
  }
  if (path === '/order/getOrderPositions') {
    const o = data.orders.find(x => x.orderId === Number(body.orderId));
    if (!o) return ctx.json(200, { success: true, data: [] });
    const state = STATE_FLOW[Math.min(o.polls, STATE_FLOW.length - 1)];
    o.polls += 1;
    return ctx.json(200, {
      success: true,
      data: o.positions.map((p, i) => ({
        orderId: o.orderId,
        orderNumber: o.orderNumber,
        orderPositionId: o.orderId * 10 + i,
        priceLogo: p.priceLogo,
        brand: p.brand,
        code: p.code,
        price: p.price,
        currency: p.currency,
        reference: p.reference,
        states:
          o.partial && i === 0 && p.quantity > 1
            ? [
                { quantity: p.quantity - 1, statusId: 2, status: state },
                { quantity: 1, statusId: 9, status: 'Отказ поставщика' },
              ]
            : [{ quantity: p.quantity, statusId: 2, status: state }],
      })),
    });
  }
  return undefined;
}

module.exports = { initState, handle, TOKEN, productId };
