// Статичні imports каталогів → бандлер інлайнить у бандл (offline, 0 network).
// Кожен namespace — окремий JSON на мову. Додаючи мову: додати блок import + запис у resources.
import ukCommon from './locales/uk/common.json';
import ukNav from './locales/uk/nav.json';
import ukSettings from './locales/uk/settings.json';
import ukStatuses from './locales/uk/statuses.json';
import ukFormat from './locales/uk/format.json';
import ukEmployees from './locales/uk/employees.json';
import ukInvoices from './locales/uk/invoices.json';
import ukPurchaseOrders from './locales/uk/purchaseOrders.json';

import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enSettings from './locales/en/settings.json';
import enStatuses from './locales/en/statuses.json';
import enFormat from './locales/en/format.json';
import enEmployees from './locales/en/employees.json';
import enInvoices from './locales/en/invoices.json';
import enPurchaseOrders from './locales/en/purchaseOrders.json';

export const resources = {
  uk: {
    common: ukCommon,
    nav: ukNav,
    settings: ukSettings,
    statuses: ukStatuses,
    format: ukFormat,
    employees: ukEmployees,
    invoices: ukInvoices,
    purchaseOrders: ukPurchaseOrders,
  },
  en: {
    common: enCommon,
    nav: enNav,
    settings: enSettings,
    statuses: enStatuses,
    format: enFormat,
    employees: enEmployees,
    invoices: enInvoices,
    purchaseOrders: enPurchaseOrders,
  },
} as const;
