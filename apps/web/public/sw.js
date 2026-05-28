const CACHE_NAME = 'sto-erp-v1';
const OFFLINE_URL = '/offline.html';

const PRECACHE = [
  '/',
  '/dashboard',
  '/offline.html',
];

// CacheStorage may be unavailable (private mode, disk pressure, disabled flag).
// Detect once; every cache access is additionally wrapped in try/catch.
function cachesAvailable() {
  try {
    return typeof caches !== 'undefined' && caches != null;
  } catch {
    return false;
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  if (!cachesAvailable()) return;
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE);
      } catch {
        // Disk full / quota exceeded / CacheStorage blocked — install anyway.
        // SW will just pass requests through to the network.
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
  if (!cachesAvailable()) return;
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
        );
      } catch {
        /* ignore — stale caches are harmless */
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // API calls: never cached, never intercepted — let them hit the network
  // directly so the SW adds zero overhead on data requests.
  if (request.url.includes('/api/')) {
    return;
  }

  // Only GET requests are cacheable; pass everything else straight through.
  if (request.method !== 'GET') {
    return;
  }

  // If CacheStorage is unavailable, do not call respondWith at all —
  // the browser performs its own default fetch with no SW overhead.
  if (!cachesAvailable()) {
    return;
  }

  // Navigation requests: network-first → offline page fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          try {
            const cache = await caches.open(CACHE_NAME);
            const offline = await cache.match(OFFLINE_URL);
            if (offline) return offline;
          } catch {
            /* CacheStorage failed — fall through */
          }
          return new Response('Офлайн', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // Static assets: cache-first, but never let a cache failure break the load.
  event.respondWith(
    (async () => {
      try {
        const cached = await caches.match(request);
        if (cached) return cached;
      } catch {
        // CacheStorage.match threw (disk pressure) — fall back to network.
        return fetch(request);
      }

      const response = await fetch(request);
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        // Best-effort cache write; ignore quota / disk-full errors.
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(request, clone))
          .catch(() => {});
      }
      return response;
    })()
  );
});
