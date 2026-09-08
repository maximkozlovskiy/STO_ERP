import { Injectable } from '@nestjs/common';
import { validatePublicUrl } from '../../../common/utils/url-guard';
import { redactSecrets } from '../../../common/utils/redact';

const DEFAULT_BASE = 'https://api.novaposhta.ua';
const HTTP_TIMEOUT_MS = 10_000;

/** Сирий результат трекінгу: код статусу НП + текст. */
export interface NovaPoshtaStatus {
  statusCode: string;
  status: string;
}

/**
 * Тонкий клієнт Нової Пошти. Єдиний endpoint POST /v2.0/json/ з тілом
 * {apiKey, modelName, calledMethod, methodProperties}. Трекінг — TrackingDocument.getStatusDocuments.
 * SSRF-guard (validatePublicUrl) + redirect:'manual' + AbortController timeout + reject-3xx.
 * Без webhook — лише polling за номером накладної (offline-first за NAT). Точний shape звірити
 * на реальному акаунті — цей клас ізолює будь-які зміни від решти коду (як monobank.client).
 */
@Injectable()
export class NovaPoshtaClient {
  /** Статус накладної (ЕН). Повертає код статусу НП + текст (мапінг у provider). */
  async getStatusDocument(
    apiUrl: string | null | undefined,
    apiKey: string,
    trackingNumber: string,
  ): Promise<NovaPoshtaStatus> {
    const res = await this.call(
      apiUrl,
      {
        apiKey,
        modelName: 'TrackingDocument',
        calledMethod: 'getStatusDocuments',
        methodProperties: { Documents: [{ DocumentNumber: trackingNumber, Phone: '' }] },
      },
      apiKey,
    );
    // success:false → errors[] (напр. невалідний ключ). data[] порожній → накладну не знайдено.
    if (res?.success === false) {
      const err =
        Array.isArray(res?.errors) && res.errors.length
          ? redactSecrets(res.errors.join('; '), [apiKey])
          : 'Нова Пошта: помилка запиту';
      throw new Error(err);
    }
    const doc = Array.isArray(res?.data) ? res.data[0] : undefined;
    if (!doc) {
      // Порожній data → накладна не знайдена (НП повертає success:true з порожнім data).
      return { statusCode: '3', status: 'Номер не знайдено' };
    }
    return {
      statusCode: String(doc.StatusCode ?? ''),
      status: String(doc.Status ?? ''),
    };
  }

  /** SSRF-guard + redirect:'manual' + timeout + reject-3xx. Єдиний POST /v2.0/json/. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(
    apiUrlRaw: string | null | undefined,
    body: unknown,
    secret?: string,
  ): Promise<any> {
    const apiUrl = (apiUrlRaw || DEFAULT_BASE).replace(/\/$/, '');
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний Нова Пошта API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/v2.0/json/`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Нова Пошта повернула перенаправлення ${response.status} — запит відхилено`);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Нова Пошта ${response.status}: ${redactSecrets(err, [secret])}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
