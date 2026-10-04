import { describe, it, expect } from 'vitest';
import { DOC_TRANSITIONS } from './stock-documents.service';
import { PO_TRANSITIONS } from '../purchase-orders/purchase-orders.service';
import { INV_TRANSITIONS } from '../invoices/invoices.service';

/**
 * Bug #780 class — «реверс side-effect, що припускає стан, якого альтернативний ВАЛІДНИЙ
 * шлях не створив» / ширше: асиметричний inc↔reverse на АГРЕГОВАНОМУ лічильнику.
 *
 * ЦИКЛ 2/3 sto-tester: аудит п'яти кандидатів (loyalty, stock-documents, purchase-orders,
 * invoices, settlements) методом Bug #780 — для КОЖНОГО реверс-переходу перелічити всі
 * вхідні шляхи й перевірити, чи кожен створив прямий ефект. Результат: усі п'ять ЧИСТІ.
 * Bug #780 був поодиноким (work-order-stock-effects), а не системним.
 *
 * Ці тести — мутаційні СТРУКТУРНІ guard-и: вони фіксують причину, ЧОМУ кожен модуль чистий,
 * і ПАДАЮТЬ, якщо рефактор відкриє небезпечне ребро FSM, що відтворить клас Bug #780.
 * Транзишн-мапи експортуються як `as const`-подібні константи → тест читає ЄДИНЕ джерело
 * правди, а не дублікат.
 *
 * Чому structural, а не behavioral: реального РЕВЕРСУ (release/decrement, що припускає
 * forward-ефект) у цих чотирьох FSM НЕМА — захист тримається саме на ФОРМІ мапи
 * (термінальність confirmed-станів, відсутність un-receive-ребер). Поведінковий тест
 * «release звільняє min(...)» тут нічого не доводив би — звільняти нема чого. Падати мусить
 * саме відкриття ребра, тож перевіряємо ребра.
 */
describe('Асиметричний inc↔reverse: структурні FSM-guard-и (клас Bug #780)', () => {
  describe('StockDocument (DOC_TRANSITIONS)', () => {
    // Рухи складу (StockMovement) створюються ЛИШЕ на DRAFT→CONFIRMED (transition, гілка
    // newStatus==='CONFIRMED'). CANCELLED-гілка (else) статус-only, БЕЗ реверсу рухів.
    // Інваріант, що робить це безпечним: CONFIRMED термінальний → у CANCELLED можна
    // потрапити ЛИШЕ з DRAFT (рухів ще не було) → нема чого й нема де реверсити.
    it('CONFIRMED термінальний — не можна CONFIRMED→CANCELLED (інакше знадобився б реверс рухів)', () => {
      expect(DOC_TRANSITIONS.CONFIRMED).toEqual([]);
      expect(DOC_TRANSITIONS.CONFIRMED).not.toContain('CANCELLED');
    });

    it('у CANCELLED веде лише DRAFT — єдиний стан БЕЗ складських рухів', () => {
      const intoCancelled = (Object.keys(DOC_TRANSITIONS) as Array<keyof typeof DOC_TRANSITIONS>)
        .filter(from => DOC_TRANSITIONS[from].includes('CANCELLED'))
        .sort();
      // Якщо сюди колись додадуть CONFIRMED (стан З рухами) — тест впаде, нагадавши, що
      // CANCELLED-гілка transition() мусить тоді реверсити рухи з guard-ом Bug #780.
      expect(intoCancelled).toEqual(['DRAFT']);
    });
  });

  describe('PurchaseOrder (PO_TRANSITIONS)', () => {
    // receive() інкрементує receivedQty, пише RECEIPT-рухи + SUPPLIER_CHARGE. transition()
    // до CANCELLED — статус-only (НЕ реверсить отримане: фізичний товар не «розотримати»).
    // Це НАВМИСНА forward-асиметрія, не клас Bug #780 (там реверс припускав forward-ефект;
    // тут реверсу взагалі нема). Guard фіксує, що CANCELLED не веде в реверс отримання.
    it('RECEIVED термінальний — отримане замовлення не можна скасувати (нема un-receive)', () => {
      expect(PO_TRANSITIONS.RECEIVED).toEqual([]);
    });

    it('PARTIAL→CANCELLED дозволено, але це статус-only (отримане лишається у складі/борзі)', () => {
      // Фіксуємо факт: ребро існує і є усвідомленим. Якщо хтось додасть сюди реверс
      // receivedQty/рухів — він ЗОБОВ'ЯЗАНИЙ віднімати лише внесок ЦЬОГО документа
      // (netReceivedByDocument), а не безумовний decrement (інакше = Bug #780).
      expect(PO_TRANSITIONS.PARTIAL).toContain('CANCELLED');
    });
  });

  describe('Invoice (INV_TRANSITIONS)', () => {
    // CHARGE (борг) для standalone-рахунку створюється на DRAFT→SENT. CANCELLED-перехід
    // НЕ реверсить CHARGE (append-only ledger: скасування відбувається зустрічною проводкою
    // через окремий бізнес-процес, не авто-реверсом). PAID термінальний.
    it('PAID термінальний — немає PAID→будь-що (інакше знадобився б реверс сплаченого)', () => {
      expect(INV_TRANSITIONS.PAID).toEqual([]);
    });

    it('CANCELLED термінальний — скасований рахунок не воскрешається', () => {
      expect(INV_TRANSITIONS.CANCELLED).toEqual([]);
    });

    it('у CANCELLED можна з усіх НЕтермінальних станів — ledger append-only, авто-реверсу CHARGE нема', () => {
      // Якщо колись CANCELLED-гілка transition() почне авто-реверсити CHARGE, вона мусить
      // враховувати, що CHARGE є лише у standalone-рахунків, які ПРОЙШЛИ SENT (а DRAFT→CANCELLED
      // його не має) — інакше реверс CHARGE на DRAFT-рахунку = Bug #780. Поки реверсу нема,
      // просто фіксуємо список вхідних станів як усвідомлений контракт.
      const intoCancelled = (Object.keys(INV_TRANSITIONS) as Array<keyof typeof INV_TRANSITIONS>)
        .filter(from => INV_TRANSITIONS[from].includes('CANCELLED'))
        .sort();
      expect(intoCancelled).toEqual(['DRAFT', 'OVERDUE', 'PARTIALLY_PAID', 'SENT']);
    });
  });
});
