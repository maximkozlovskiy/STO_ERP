import { Injectable } from '@nestjs/common';
import { DeliveryStatus } from '@prisma/client';
import { NovaPoshtaClient } from './nova-poshta.client';
import type {
  DeliveryProvider,
  DeliveryConfig,
  DeliveryStatusResult,
  DeliveryVerifyResult,
} from './delivery-provider.interface';

/**
 * Провайдер служби доставки «Нова Пошта». Обгортка NovaPoshtaClient під DeliveryProvider (registry).
 * Auth: apiKey у тілі запиту. mapStatus: StatusCode НП → нормалізований DeliveryStatus.
 */
@Injectable()
export class NovaPoshtaProvider implements DeliveryProvider {
  readonly code = 'novaposhta';
  readonly name = 'Нова Пошта';

  constructor(private readonly client: NovaPoshtaClient) {}

  private apiKey(cfg: DeliveryConfig): string {
    const k = cfg.credentials?.apiKey;
    if (!k) throw new Error('Нова Пошта: не задано API-ключ');
    return k;
  }

  async getStatus(cfg: DeliveryConfig, trackingNumber: string): Promise<DeliveryStatusResult> {
    const { statusCode, status } = await this.client.getStatusDocument(
      cfg.apiUrl,
      this.apiKey(cfg),
      trackingNumber,
    );
    return { status: this.mapStatus(statusCode), raw: status };
  }

  /**
   * Мапінг StatusCode Нової Пошти → DeliveryStatus. Довідник НП:
   *  1 — відправник створив (очікує); 2 — видалено; 3 — не знайдено;
   *  4/5/6/41/101/102 — у дорозі/місті; 7/8 — прибув на відділення/пункт;
   *  9/10/11 — отримано/платіж переказано; 103/105 — відмова/повернення.
   * Невідомий код → IN_TRANSIT (не термінальний → продовжуємо опитувати).
   */
  private mapStatus(code: string): DeliveryStatus {
    switch (code) {
      case '1':
        return 'PENDING';
      case '2':
        return 'RETURNED';
      case '3':
        return 'NOT_FOUND';
      case '7':
      case '8':
        return 'ARRIVED';
      case '9':
      case '10':
      case '11':
        return 'DELIVERED';
      case '103':
      case '105':
        return 'RETURNED';
      default:
        // 4/5/6/41/101/102 та решта проміжних → у дорозі.
        return 'IN_TRANSIT';
    }
  }

  async verifyCredentials(cfg: DeliveryConfig): Promise<DeliveryVerifyResult> {
    try {
      // Валідність ключа: getStatus на синтетичний ЕН. Валідний ключ → success:true (навіть якщо
      // «не знайдено»); невалідний → client кидає (errors містять «API key»/«apiKey»).
      await this.client.getStatusDocument(cfg.apiUrl, this.apiKey(cfg), '00000000000000');
      return { valid: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка перевірки';
      if (/api\s*key|apikey|ключ/i.test(msg)) return { valid: false, error: 'Невірний API-ключ' };
      return { valid: false, error: msg };
    }
  }
}
