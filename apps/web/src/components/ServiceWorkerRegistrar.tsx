'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // У DEV НЕ реєструємо SW: cache-first на статику віддає застарілі JS-бандли
    // (ламає HMR і, зокрема, обробники форм — напр. логін «не сабмітиться»).
    // Додатково — прибираємо вже зареєстрований SW + його кеш, щоб розробник,
    // який колись відкривав prod-збірку на тому ж localhost, не лишався з мертвим кешем.
    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then(regs => regs.forEach(r => void r.unregister()))
        .catch(() => {});
      if (typeof caches !== 'undefined') {
        caches
          .keys()
          .then(keys =>
            keys.filter(k => k.startsWith('sto-erp')).forEach(k => void caches.delete(k)),
          )
          .catch(() => {});
      }
      return;
    }

    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  return null;
}
