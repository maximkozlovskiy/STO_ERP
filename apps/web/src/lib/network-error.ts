import i18n from '@/i18n/config';

/**
 * Обрив зв'язку з сервером (fetch відхилено не через AbortController). Браузер кидає TypeError з
 * англійським текстом («Failed to fetch», «Load failed», «NetworkError when attempting…»), і
 * місця, що показують `e.message`, друкували його людині (TECH-DEBT §8 L802). Тут — текст мовою
 * інтерфейсу; оригінал лишається в `cause`.
 *
 * Окремий модуль, а не `api-client.ts`: прямі `fetch` поза ним (вхід у `lib/auth/context.tsx`,
 * публічний запис `/booking`) теж мусять перекладати обрив, а `api-client` імпортує `lib/auth` —
 * імпорт звідти в `context.tsx` замкнув би цикл (Bug #1009).
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(i18n.t('common:networkError'), { cause });
    this.name = 'NetworkError';
  }
}

/** Запит скасував сам клієнт (AbortController), а не обірвала мережа. */
export function isAbortError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * `fetch` з перекладом мережевої помилки. Скасований запит (AbortError) прокидається як є —
 * викликачі розпізнають його за `name` і мовчать.
 */
export async function fetchOrNetworkError(
  input: string,
  init: RequestInit | undefined,
  onNetworkError?: () => void,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    if (isAbortError(err, init?.signal)) throw err;
    onNetworkError?.();
    throw new NetworkError(err);
  }
}
