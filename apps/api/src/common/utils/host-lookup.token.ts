import type { HostLookup } from './url-guard';
import { lookupAllAddresses } from './url-guard';

/**
 * DI-токен для `HostLookup` (DNS-резолвер із url-guard). Один спільний токен на весь застосунок:
 * провайдиться й експортується з глобального `CommonModule` із дефолтом `lookupAllAddresses`,
 * тож будь-який сервіс/клієнт у SSRF-шляху інжектить його як `@Inject(HOST_LOOKUP)`.
 *
 * ЧОМУ токен, а не аргумент: resolved-перевірка у клієнтах і при збереженні адреси викликається з
 * request/HTTP-шляху (через контролер), де 4-й аргумент `lookup` передати неможливо. Дефолт у
 * проді ходить у справжній DNS; у тестах модуль перевизначає токен фейком (публічна/loopback
 * адреса) — так unit і contract тести не торкаються мережі (напр. колишній flaky
 * `settings.contract.spec.ts`, що резолвив `api.checkbox.ua`).
 */
export const HOST_LOOKUP = Symbol('HOST_LOOKUP');

/** Провайдер за замовчуванням для `HOST_LOOKUP` (реальний `dns.lookup`). */
export const hostLookupProvider = {
  provide: HOST_LOOKUP,
  useValue: lookupAllAddresses satisfies HostLookup,
};
