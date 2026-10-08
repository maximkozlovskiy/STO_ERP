// Самовідновлення E2E-сервера. Викликається з playwright.config.ts ДО того, як Playwright
// вирішує, піднімати сервер чи перевикористати наявний.
//
// Навіщо: `reuseExistingServer: true` підхоплює все, що слухає порт, а `webServer.url`
// перевіряє лише корінь. Забутий вручну піднятий екземпляр на :3002 може зіпсуватись так, що
// корінь віддає 200, а всі сторінки `/…/[id]` — 500 (2026-10-08: добу простояв, 23 падіння
// E2E не через код). Чекати людину тут нема чого: такий сервер однаково непридатний.
//
// Що робить:
//   • порт вільний                → нічого, Playwright підніме свіжий сервер сам;
//   • сервер здоровий             → нічого, його перевикористають;
//   • сервер віддає 5xx / мовчить → зупиняє ДЕРЕВО процесів на порту й чекає, поки порт
//                                   звільниться; далі Playwright піднімає свіжий.
//
// Запобіжники: лише локально (не CI) і лише на E2E-порту 3002 — dev-сервер :3001 і будь-який
// інший порт скрипт не чіпає ніколи, хоч би що віддавав.
//
// Вихід: 0 — можна продовжувати; 1 — зіпсований сервер зупинити не вдалося (прогін не почнеться).

const { execFileSync } = require('node:child_process');
const net = require('node:net');

const E2E_PORT = '3002';
const PROBE_PATH = '/vehicles/00000000-0000-4000-8000-000000000000/';
// Холодна компіляція динамічного маршруту в next dev — до 25 с (Bug #343); беремо із запасом.
const PROBE_TIMEOUT_MS = 90_000;

const baseURL = process.argv[2];
const log = msg => console.log(`[e2e-server] ${msg}`);

function portIsListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(2_000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

async function probeStatus(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    return res.status;
  } catch (e) {
    return `немає відповіді (${e.message})`;
  }
}

/** PID процесу, що слухає порт, і PID його батька (порт слухає дочірній start-server.js). */
function findListener(port) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
          `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; ` +
          `$pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; ` +
          `"$($p.ProcessId)|$($pp.ProcessId)|$($pp.CommandLine)" }`,
      ],
      { encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    const [pid, parentPid, parentCmd = ''] = out.split('|');
    return { pid, parentPid, parentCmd };
  }
  const pid = execFileSync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | head -1`], {
    encoding: 'utf8',
  }).trim();
  return pid ? { pid, parentPid: '', parentCmd: '' } : null;
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' });
    }
  } catch {
    // Процес міг уже завершитись разом із батьком — перевіряємо порт нижче.
  }
}

async function main() {
  if (!baseURL) {
    log('не передано baseURL — пропускаю перевірку');
    return 0;
  }
  const url = new URL(baseURL);
  const port = url.port || '80';
  if (process.env.CI || port !== E2E_PORT) return 0; // чужі порти й CI не чіпаємо
  if (!(await portIsListening(port))) return 0; // вільний — Playwright підніме сам

  const probe = new URL(PROBE_PATH, baseURL);
  probe.hostname = '127.0.0.1';
  const status = await probeStatus(probe);
  if (typeof status === 'number' && status < 500) return 0; // здоровий — перевикористовуємо

  log(`сервер на :${port} зіпсований: ${probe.pathname} → ${status}. Зупиняю його сам.`);
  const listener = findListener(port);
  if (listener) {
    // `next dev` тримає дочірній start-server.js: вбити лише дитину — батько лишиться висіти.
    const parentIsNext = /next/i.test(listener.parentCmd) && /\bdev\b/.test(listener.parentCmd);
    killTree(parentIsNext && listener.parentPid ? listener.parentPid : listener.pid);
    killTree(listener.pid);
  }
  for (let i = 0; i < 20; i++) {
    if (!(await portIsListening(port))) {
      log(`порт :${port} вільний — Playwright підніме свіжий сервер.`);
      return 0;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  log(`НЕ вдалося звільнити порт :${port}. Зупиніть процес вручну: `);
  log(
    `  Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { taskkill /PID $_.OwningProcess /T /F }`,
  );
  return 1;
}

// NB: process.exitCode, not process.exit(): a forced exit right after fetch() crashes Node on
// Windows (libuv "UV_HANDLE_CLOSING" assertion) while undici is still closing its sockets.
main().then(
  code => {
    process.exitCode = code;
  },
  e => {
    log(`self-heal failed: ${e.message}`);
    process.exitCode = 1;
  },
);
