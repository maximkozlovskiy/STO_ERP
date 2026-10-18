'use strict';
/**
 * Фейкові сервери API постачальників автозапчастин (BR-SCON, BR-SOFR) — для контрактних тестів
 * адаптерів зі справжнім `fetch` і для E2E. Ключів постачальників на момент реалізації немає,
 * тож кожен провайдер тут відтворює ЗАДОКУМЕНТОВАНИЙ формат (джерело — у коментарі модуля
 * `providers/<провайдер>.js`), а не поведінку живого сервера.
 *
 * Один HTTP-сервер, провайдер — перший сегмент шляху:
 *   /avd/api/v1/…   AVD Trade           /bm/…        BM Parts
 *   /tehnomir/…     Tehnomir            /utr/api/…   UTR (UniqTrade)
 *   /ad/api/v2/ecom/… AD Ukraine (АвтоТехнікс)
 *
 * Керування (для тестів і E2E):
 *   POST /__scenario {provider, mode, times?, path?, retryAfter?}
 *        mode: ok | 401 | 429 | 500 | timeout | notFound | partial
 *        times — скільки запитів зачепити (типово безліч); path — підрядок шляху, якого стосується.
 *        `partial` не перехоплює запит: обробник провайдера сам вирішує, що віддати частково.
 *   GET  /__requests?provider=avd  — журнал запитів (заголовки авторизації — як прийшли).
 *   POST /__reset                  — журнал, сценарії, кошики й замовлення — до початкового стану.
 *
 * Без залежностей: лише `node:http`. Не є pnpm-пакетом робочого простору — свідомо, щоб не
 * чіпати lockfile; підключається відносним шляхом (api-спеки) і `node bin.js` (E2E).
 */
const http = require('node:http');

const PROVIDER_FILES = {
  avd: './providers/avd',
  bm: './providers/bm',
  tehnomir: './providers/tehnomir',
  utr: './providers/utr',
  ad: './providers/ad',
};

function loadProviders() {
  const out = {};
  for (const [name, file] of Object.entries(PROVIDER_FILES)) {
    try {
      out[name] = require(file);
    } catch (e) {
      // Провайдер ще не реалізований — сервер працює без нього (його префікс віддає 404).
      if (!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(file.slice(2)))) {
        throw e;
      }
    }
  }
  return out;
}

const AUTH_HEADERS = ['authorization', 'x-api-key', 'user-agent', 'x-test-mode', 'content-type'];

function json(status, body, headers = {}) {
  return { status, body, headers };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorBodyFor(provider, status, message) {
  // Форми помилок — як у документації кожного провайдера.
  switch (provider) {
    case 'avd':
      return {
        status: 'error',
        track_uuid: '00000000-0000-4000-8000-000000000000',
        error: { code: status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'ERROR', message },
      };
    case 'utr':
      return { code: status, message };
    case 'ad':
      return {
        errors: [{ status: String(status), code: 'error', title: message, detail: message }],
      };
    case 'tehnomir':
      return { success: false, message };
    default:
      return { error: message, result: false };
  }
}

async function startSupplierFakes(opts = {}) {
  const providers = loadProviders();
  const state = {
    requests: [],
    scenarios: {},
    data: {},
  };
  const reset = () => {
    state.requests.length = 0;
    state.scenarios = {};
    for (const [name, mod] of Object.entries(providers)) state.data[name] = mod.initState();
  };
  reset();
  const pending = new Set();

  const takeScenario = (provider, path, wanted) => {
    const sc = state.scenarios[provider];
    if (!sc || sc.mode === 'ok') return null;
    if (sc.path && !path.includes(sc.path)) return null;
    if (wanted && sc.mode !== wanted) return null;
    if (!wanted && sc.mode === 'partial') return null;
    if (sc.times !== undefined && sc.times !== null) {
      if (sc.times <= 0) return null;
      sc.times -= 1;
    }
    return sc;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake.local');
    const raw = await readBody(req).catch(() => '');
    const body = parseBody(raw);
    const send = r => {
      if (res.writableEnded) return;
      const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      res.writeHead(r.status, {
        'content-type':
          typeof r.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
        ...(r.headers || {}),
      });
      res.end(payload);
    };

    // ── Керування ─────────────────────────────────────────
    if (url.pathname === '/__health') return send(json(200, { ok: true }));
    if (url.pathname === '/__reset' && req.method === 'POST') {
      reset();
      return send(json(200, { ok: true }));
    }
    if (url.pathname === '/__scenario' && req.method === 'POST') {
      const b = body || {};
      state.scenarios[b.provider] = {
        mode: b.mode || 'ok',
        times: b.times ?? null,
        path: b.path || null,
        retryAfter: b.retryAfter ?? 1,
      };
      return send(json(200, { ok: true, scenario: state.scenarios[b.provider] }));
    }
    if (url.pathname === '/__requests') {
      const p = url.searchParams.get('provider');
      return send(
        json(
          200,
          state.requests.filter(r => !p || r.provider === p),
        ),
      );
    }

    // ── Провайдери ────────────────────────────────────────
    const [, prefix, ...rest] = url.pathname.split('/');
    const mod = providers[prefix];
    if (!mod) return send(json(404, { error: `unknown provider ${prefix}` }));
    const path = '/' + rest.join('/');
    const headers = {};
    for (const h of AUTH_HEADERS) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    state.requests.push({
      provider: prefix,
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body,
      at: new Date().toISOString(),
    });

    const sc = takeScenario(prefix, path);
    if (sc) {
      if (sc.mode === 'timeout') {
        pending.add(res);
        res.on('close', () => pending.delete(res));
        return undefined; // не відповідаємо — клієнт упаде за тайм-аутом
      }
      const status = { 401: 401, 429: 429, 500: 500, notFound: 404 }[sc.mode] || 500;
      const extra =
        status === 429
          ? {
              'retry-after': String(sc.retryAfter),
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(sc.retryAfter),
            }
          : {};
      return send(json(status, errorBodyFor(prefix, status, `scenario ${sc.mode}`), extra));
    }

    try {
      const ctx = {
        method: req.method,
        path,
        query: url.searchParams,
        headers: req.headers,
        body,
        data: state.data[prefix],
        partial: () => !!takeScenario(prefix, path, 'partial'),
        error: (status, message) => json(status, errorBodyFor(prefix, status, message)),
        json,
        baseUrl: `http://${req.headers.host}/${prefix}`,
      };
      const r = await mod.handle(ctx);
      return send(r || json(404, errorBodyFor(prefix, 404, `no route ${req.method} ${path}`)));
    } catch (e) {
      return send(json(500, errorBodyFor(prefix, 500, String(e && e.message))));
    }
  });

  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  return {
    url,
    port: address.port,
    state,
    providers: Object.keys(providers),
    reset,
    setScenario(provider, mode, extra = {}) {
      state.scenarios[provider] = {
        mode,
        times: extra.times ?? null,
        path: extra.path ?? null,
        retryAfter: extra.retryAfter ?? 1,
      };
    },
    requests(provider) {
      return state.requests.filter(r => !provider || r.provider === provider);
    },
    close() {
      for (const res of pending) res.destroy();
      pending.clear();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      return new Promise(resolve => server.close(() => resolve()));
    },
  };
}

module.exports = { startSupplierFakes, PROVIDER_FILES };
