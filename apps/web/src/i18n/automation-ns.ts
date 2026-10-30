import i18n from './config';
import { lazyResources } from './lazy-resources';

// Неймспейс `automation` — лише там, де він потрібен (налаштування автоматизації, блок
// Telegram-бота в картках, журнал): імпорт цього модуля реєструє каталог до першого рендера.
for (const lng of ['uk', 'en'] as const) {
  if (!i18n.hasResourceBundle(lng, 'automation'))
    i18n.addResourceBundle(lng, 'automation', lazyResources[lng].automation, true, true);
}

export const AUTOMATION_NS = 'automation';
