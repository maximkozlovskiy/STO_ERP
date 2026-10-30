// Каталоги, що НЕ входять у бандл оболонки (resources.ts): їх реєструє модуль, якому вони потрібні
// (`automation-ns.ts`), — щоб ~10 КБ gzip автоматизації не вантажились на кожній сторінці
// (бюджет first-load, check-page-budget.mjs). Тести паритету читають їх звідси разом з resources.
import ukAutomation from './locales/uk/automation.json';
import enAutomation from './locales/en/automation.json';

export const lazyResources = {
  uk: { automation: ukAutomation },
  en: { automation: enAutomation },
} as const;
