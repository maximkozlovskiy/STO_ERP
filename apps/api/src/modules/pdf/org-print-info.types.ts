/**
 * Реквізити організації для шапки друкованого документа (`OrgPrintInfoService.get`).
 * Усе, крім назви, необов'язкове: незаповнене в НДІ просто не друкується.
 */
export interface OrgPrintInfo {
  name: string;
  edrpou?: string | null;
  /** ІПН платника ПДВ. */
  ipn?: string | null;
  /** Фактична адреса, інакше юридична. */
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  /** Логотип як data URL (PNG/JPEG) — лише перевірений `OrgPrintInfoService`. */
  logo?: string | null;
  /** Основний банківський рахунок організації (НДІ → «Реквізити»). */
  bank?: {
    iban: string;
    bankName?: string | null;
    mfo?: string | null;
    /** ЄДРПОУ одержувача на рахунку, якщо відрізняється від ЄДРПОУ організації. */
    edrpou?: string | null;
  } | null;
}
