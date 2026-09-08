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
    // Ігноруємо порожні/короткі значення — підстроки на кшталт "1"/"" зіпсували б увесь текст.
    if (!s || s.length < 6) continue;
    out = out.split(s).join('***');
  }
  return out;
}
