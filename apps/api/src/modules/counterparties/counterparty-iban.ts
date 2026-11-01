/** Український IBAN: UA + 27 цифр (без пробілів). */
const UA_IBAN = /UA\d{27}/;

/**
 * `Counterparty.iban` — ключ автозіставлення рядків виписки з контрагентом (payerIban → контрагент,
 * BR-CP-018). Окремого поля у формі немає: реквізит вводять у «Розрахунковий рахунок» (`bankAccount`,
 * вільний текст для друку), і IBAN виводиться з нього — без пробілів, великими літерами, перший
 * український IBAN у тексті («р/р UA21 3223…»). IBAN у тексті немає → `null` (зіставлення вимкнено).
 */
export function ibanFromBankAccount(bankAccount: string | null | undefined): string | null {
  if (!bankAccount) return null;
  return bankAccount.toUpperCase().replace(/\s+/g, '').match(UA_IBAN)?.[0] ?? null;
}
