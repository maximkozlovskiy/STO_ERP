// Shared types and constants for settings tabs.
// Each tab imports only what it needs — nothing is passed via props from page.tsx.

export type CostMethod = 'FIFO' | 'FEFO' | 'LIFO' | 'AVG_COST';

export const COST_METHOD_OPTIONS: { value: CostMethod; label: string; hint: string }[] = [
  { value: 'FIFO', label: 'FIFO', hint: 'Перший прийшов — перший пішов' },
  { value: 'FEFO', label: 'FEFO', hint: 'За терміном придатності (раніший пішов першим)' },
  { value: 'LIFO', label: 'LIFO', hint: 'Останній прийшов — перший пішов' },
  { value: 'AVG_COST', label: 'Середній', hint: 'За середньозваженою собівартістю' },
];

export interface OrgSettings {
  orgId: string;
  currency: string;
  vatMode: string;
  defaultVatRateId?: string | null;
  invoiceDueDays: number;
  autoArchiveDays: number;
  defaultWarrantyDays: number;
  requireClientApproval: boolean;
  allowPartialPayment: boolean;
  brandTheme: string;
  costMethod: CostMethod;
  followUpActive?: boolean;
  followUpDays?: number;
  nbuFetchHour?: number;
  uiFeatures?: import('@/hooks/useUiFeatures').UiFeatures;
  loyaltyEnabled?: boolean;
  loyaltyEarnPer?: number;
  loyaltyEarnPoints?: number;
  loyaltyRedeemRate?: number;
  recalcPlannedHoursFromLines?: boolean;
  recalcActualHoursFromLines?: boolean;
  syncCalendarSlotWithPlannedHours?: boolean;
  updatedAt: string;
}

export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  requiresFiscal: boolean;
  // Системний метод (Готівка/Картка/…) — сервер блокує видалення та перейменування
  // (payment-methods.service). isActive/sortOrder лишаються редагованими за org.
  isSystem?: boolean;
}

export interface NotificationTemplate {
  id: string;
  eventType: string;
  channel: string;
  subject: string | null;
  body: string;
  isActive: boolean;
}

export interface DocNumberConfig {
  id: string;
  documentType: string;
  prefix: string | null;
  includeDate: boolean;
  separator: string;
  padding: number;
  currentSeq: number;
  resetPeriod: string;
}

export interface BranchInfo {
  id: string;
  name: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseCode?: number | null;
  createdAt: string;
}

export interface OrgInfo {
  id: string;
  orgId?: string;
  name: string;
  edrpou?: string | null;
  logoUrl?: string | null;
  legalAddress?: string | null;
  actualAddress?: string | null;
  bankAccountId?: string | null;
  updatedAt?: string;
}

export const VAT_LABELS: Record<string, string> = {
  NONE: 'Без ПДВ',
  EXCLUSIVE: 'ПДВ зверху',
  INCLUSIVE: 'ПДВ включено',
};

export const EVENT_LABELS: Record<string, string> = {
  WO_COMPLETED: 'Наряд завершено',
  WO_ESTIMATE_READY: 'Кошторис готовий',
  WO_APPROVED: 'Наряд підтверджено',
  WO_IN_PROGRESS: 'Наряд в роботі',
  WO_READY_FOR_PICKUP: 'Авто готове до видачі',
  PAYMENT_RECEIVED: 'Оплата отримана',
  INVOICE_SENT: 'Рахунок надіслано',
  LOW_STOCK_ALERT: 'Низький залишок',
  FOLLOWUP_REMINDER: 'Нагадування про планове ТО',
};

export const WEBHOOK_EVENT_OPTIONS = [
  { value: 'WO_STATUS_CHANGED', label: 'Зміна статусу наряду' },
  { value: 'PAYMENT_RECEIVED', label: 'Отримання оплати' },
  { value: 'LOW_STOCK_ALERT', label: 'Низький залишок' },
];
