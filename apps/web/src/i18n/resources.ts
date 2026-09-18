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
import ukPayments from './locales/uk/payments.json';
import ukSupplierPayments from './locales/uk/supplierPayments.json';
import ukStockDocuments from './locales/uk/stockDocuments.json';
import ukCounterparties from './locales/uk/counterparties.json';
import ukCatalog from './locales/uk/catalog.json';
import ukNdi from './locales/uk/ndi.json';
import ukCash from './locales/uk/cash.json';
import ukCalendar from './locales/uk/calendar.json';
import ukWorkOrders from './locales/uk/workOrders.json';
import ukReports from './locales/uk/reports.json';
import ukInfrastructure from './locales/uk/infrastructure.json';
import ukVehicles from './locales/uk/vehicles.json';
import ukInventory from './locales/uk/inventory.json';
import ukPayroll from './locales/uk/payroll.json';

import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enSettings from './locales/en/settings.json';
import enStatuses from './locales/en/statuses.json';
import enFormat from './locales/en/format.json';
import enEmployees from './locales/en/employees.json';
import enInvoices from './locales/en/invoices.json';
import enPurchaseOrders from './locales/en/purchaseOrders.json';
import enPayments from './locales/en/payments.json';
import enSupplierPayments from './locales/en/supplierPayments.json';
import enStockDocuments from './locales/en/stockDocuments.json';
import enCounterparties from './locales/en/counterparties.json';
import enCatalog from './locales/en/catalog.json';
import enNdi from './locales/en/ndi.json';
import enCash from './locales/en/cash.json';
import enCalendar from './locales/en/calendar.json';
import enWorkOrders from './locales/en/workOrders.json';
import enReports from './locales/en/reports.json';
import enInfrastructure from './locales/en/infrastructure.json';
import enVehicles from './locales/en/vehicles.json';
import enInventory from './locales/en/inventory.json';
import enPayroll from './locales/en/payroll.json';

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
    payments: ukPayments,
    supplierPayments: ukSupplierPayments,
    stockDocuments: ukStockDocuments,
    counterparties: ukCounterparties,
    catalog: ukCatalog,
    ndi: ukNdi,
    cash: ukCash,
    calendar: ukCalendar,
    workOrders: ukWorkOrders,
    reports: ukReports,
    infrastructure: ukInfrastructure,
    vehicles: ukVehicles,
    inventory: ukInventory,
    payroll: ukPayroll,
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
    payments: enPayments,
    supplierPayments: enSupplierPayments,
    stockDocuments: enStockDocuments,
    counterparties: enCounterparties,
    catalog: enCatalog,
    ndi: enNdi,
    cash: enCash,
    calendar: enCalendar,
    workOrders: enWorkOrders,
    reports: enReports,
    infrastructure: enInfrastructure,
    vehicles: enVehicles,
    inventory: enInventory,
    payroll: enPayroll,
  },
} as const;
