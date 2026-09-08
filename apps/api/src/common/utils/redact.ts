/**
 * Прибирає відомі секрети з тексту (напр. відповіді провайдера, яку ми кладемо у
 * IntegrationLog.error). Захист від провайдерів, що ЕХО-ять надісланий запит у тілі помилки:
 * якщо секрет пішов у body (Нова Пошта apiKey, Checkbox pin_code), а провайдер віддзеркалив його
 * у 4xx-відповіді — `response.text()` міг би витекти у лог. Викликається на рівні клієнта, ДЕ значення
 * секрету у скоупі (IntegrationLogService свідомо секрет-сліпий — не має доступу до credentials).
 *
 * Секрети у заголовках (monobank X-Token, Checkbox Bearer, Вчасно Authorization) сюди не потрапляють —
 * ми не серіалізуємо заголовки. Ця утиліта прикриває саме body-borne-секрети.
 */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    // Пропускаємо лише вироджені значення (порожнє / 1-2 символи) — підстрока на кшталт "1"/"ab"
    // зіпсувала б увесь текст, і реальним секретом бути не може. Але НЕ пропускаємо 4-значний
    // Checkbox pin_code: реальний касирський PIN = рівно 4 цифри, і якщо провайдер віддзеркалить
    // його у тілі 4xx-помилки — при поро̆зі >=6 він витік би у IntegrationLog.error (Bug: PIN leak).
    if (!s || s.length < 3) continue;
    out = out.split(s).join('***');
  }
  return out;
}
