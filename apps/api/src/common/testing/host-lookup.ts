import type { HostLookup } from '../utils/url-guard';

/**
 * Фейкові `HostLookup` для спеків SSRF-перевірки (resolved). Дають специфікатору керувати тим, що
 * «резолвить» DNS, не торкаючись мережі: публічна адреса → перевірка проходить і доходить до fetch;
 * внутрішня адреса → `validatePublicUrlResolved` повертає причину й блокує запит.
 *
 * ЧОМУ тут: `settings.contract.spec` ходив у справжній DNS (`api.checkbox.ua`) через дефолтний
 * `lookupAllAddresses` і зрідка валив повний прогін. Тепер `HOST_LOOKUP` інжектиться через DI, а
 * тест-модуль підставляє `publicHostLookup` — мережа не чіпається.
 */

/** Будь-яке ім'я «резолвиться» у публічну адресу (example.com) → resolved-перевірка проходить. */
export const publicHostLookup: HostLookup = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

/** Будь-яке ім'я «резолвиться» у loopback → resolved-перевірка блокує (DNS-rebinding сценарій). */
export const loopbackHostLookup: HostLookup = () =>
  Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

/** Будь-яке ім'я «резолвиться» у cloud-metadata адресу → resolved-перевірка блокує. */
export const metadataHostLookup: HostLookup = () =>
  Promise.resolve([{ address: '169.254.169.254', family: 4 }]);

/** `HostLookup`, що резолвить у задану адресу (сімейство виводиться з наявності `:`). */
export function fixedHostLookup(address: string): HostLookup {
  const family = address.includes(':') ? 6 : 4;
  return () => Promise.resolve([{ address, family }]);
}
