// Українські значення validation-ключів. ЄДИНЕ джерело правди uk-текстів валідації (web + api).
//
// Значення тут — БАЙТ-ІДЕНТИЧНІ оригінальним inline-рядкам зі схем (apostrophes, guillemets,
// пробіли, числа в діапазонних повідомленнях). Рендер uk лишається незмінним → поведінка збережена.
// Ключі мусять збігатися 1:1 з messages.en.ts (перевіряється key-parity тестом/санітаркою).

export const uk: Record<string, string> = {
  // ── Інфра-ключі (використовує ZodValidationPipe.formatIssue) ──
  'v.fieldSuffix': '(поле "{{path}}")',
  'v.validationFailed': 'Помилка валідації',
  'v.invalid': 'Невірне значення',

  // ── validators.ts (спільні хелпери) ──
  'v.phone': 'Невірний формат телефону (+380XXXXXXXXX)',
  'v.email': 'Невірний формат email',
  'v.iban': 'Невірний формат IBAN (UA + 27 цифр)',
  'v.uuid': 'Невірний UUID формат',
  'v.positive': 'Значення має бути більше нуля',
  'v.nonNeg': "Значення не може бути від'ємним",
  'v.dateFormat': 'Невірний формат дати',

  // ── counterparty.schema.ts ──
  'v.counterparty.type.required': 'Оберіть тип контрагента',
  'v.counterparty.email.invalid': 'Невірний формат email',
  'v.counterparty.name.supplier': 'Вкажіть назву компанії постачальника',
  'v.counterparty.name.any': "Вкажіть назву компанії або ім'я/прізвище контрагента",

  // ── good.schema.ts ──
  'v.good.name.required': 'Вкажіть назву товару',
  'v.good.name.max': 'Назва занадто довга',

  // ── employee.schema.ts ──
  'v.employee.firstName.required': "Вкажіть ім'я",
  'v.employee.firstName.max': "Ім'я занадто довге",
  'v.employee.lastName.required': 'Вкажіть прізвище',
  'v.employee.lastName.max': 'Прізвище занадто довге',
  'v.employee.role.required': 'Оберіть посаду',
  'v.employee.percent.range': 'Відсоток має бути від 1 до 100',
  'v.employee.ratePerHour.nonNeg': "Ставка за нормо-годину повинна бути невід'ємним числом",
  'v.employee.fixedMonthly.nonNeg': "Фіксована ставка повинна бути невід'ємним числом",
  'v.employee.bonusPercent.range': 'Бонус має бути від 0 до 100',
  'v.employee.loginEmail.required': 'Вкажіть email для входу',
  'v.employee.password.required': 'Вкажіть пароль',
  'v.employee.password.min': 'Пароль має бути не менше 6 символів',
  'v.employee.loginEmail.invalid': 'Невірний формат email для логіну',

  // ── vehicle.schema.ts ──
  'v.vehicle.year.int': 'Має бути цілим числом',
  'v.vehicle.year.min': 'Рік не раніше 1900',
  'v.vehicle.year.max': 'Рік у майбутньому',
  'v.vehicle.nonNegInt': "Не може бути від'ємним",
  'v.vehicle.nonNegFloat': "Не може бути від'ємним",
  'v.vehicle.make.required': 'Вкажіть марку',
  'v.vehicle.make.max': 'Занадто довго',
  'v.vehicle.model.required': 'Вкажіть модель',
  'v.vehicle.model.max': 'Занадто довго',
  'v.vehicle.customerGarage.required': 'Оберіть гараж клієнта',

  // ── invoice.schema.ts ──
  'v.invoice.line.description.required': 'Вкажіть опис позиції',
  'v.invoice.line.description.max': 'Опис занадто довгий',
  'v.invoice.line.quantity.min': 'Кількість має бути більше нуля',
  'v.invoice.line.unitPrice.nonNeg': "Ціна не може бути від'ємною",
  'v.invoice.line.vatRate.nonNeg': "ПДВ не може бути від'ємним",
  'v.invoice.line.vatRate.max': 'ПДВ не більше 100%',
  'v.invoice.counterparty.required': 'Оберіть контрагента',
  'v.invoice.amount.min': 'Сума має бути більше 0.01',

  // ── purchase-order.schema.ts ──
  'v.purchaseOrder.line.good.required': 'Оберіть товар',
  'v.purchaseOrder.line.quantity.min': 'Кількість повинна бути більшою за нуль',
  'v.purchaseOrder.line.price.nonNeg': "Ціна не може бути від'ємною",
  'v.purchaseOrder.trackingNumber.max': 'Номер накладної не більше 64 символів',
  'v.purchaseOrder.supplier.required': 'Оберіть постачальника',
  'v.purchaseOrder.warehouse.required': 'Оберіть склад',
  'v.purchaseOrder.uuid.invalid': 'Невірний UUID формат',

  // ── stock-document.schema.ts ──
  'v.stockDocument.line.good.required': 'Оберіть товар',
  'v.stockDocument.line.quantity.min': 'Кількість повинна бути більшою за нуль',
  'v.stockDocument.type.required': 'Оберіть тип документа',
  'v.stockDocument.branch.required': 'Оберіть філію',
  'v.stockDocument.warehouse.required': 'Оберіть склад',
  'v.stockDocument.transfer.targetRequired': 'Для переміщення оберіть склад призначення',
  'v.stockDocument.transfer.targetSame': 'Склад джерела і призначення не можуть збігатись',

  // ── supplier-return.schema.ts ──
  'v.supplierReturn.line.good.required': 'Оберіть товар',
  'v.supplierReturn.line.quantity.min': 'Кількість повинна бути більшою за нуль',
  'v.supplierReturn.line.price.nonNeg': "Ціна не може бути від'ємною",
  'v.supplierReturn.supplier.required': 'Оберіть постачальника',
  'v.supplierReturn.warehouse.required': 'Оберіть склад',

  // ── supplier-payment.schema.ts ──
  'v.supplierPayment.supplier.required': 'Оберіть постачальника',
  'v.supplierPayment.sourceType.required': 'Оберіть джерело коштів',
  'v.supplierPayment.amount.min': 'Сума оплати повинна бути більшою за нуль',
  'v.supplierPayment.method.required': 'Оберіть спосіб оплати',
  'v.supplierPayment.bank.required': 'Для оплати з банку вкажіть рахунок',
  'v.supplierPayment.cash.required': 'Для оплати з каси вкажіть касу',
  'v.supplierPayment.source.conflict': 'Не можна одночасно вказувати банк і касу',

  // ── work-order.schema.ts ──
  'v.workOrder.nonNegInt.int': 'Значення має бути цілим',
  'v.workOrder.nonNegInt.min': "Значення не може бути від'ємним",
  'v.workOrder.branch.required': 'Оберіть філію',
  'v.workOrder.vehicle.required': 'Оберіть авто',
  'v.workOrder.counterparty.required': 'Оберіть контрагента',
  'v.workOrder.dateFormat': 'Невірний формат дати',
  'v.workOrder.uuid.invalid': 'Невірний UUID формат',
  'v.workOrder.hours.nonNeg': "Значення не може бути від'ємним",
  'v.workOrder.line.work.required': 'Оберіть роботу',
  'v.workOrder.line.employee.required': 'Оберіть виконавця',
  'v.workOrder.line.normoHours.min': 'Нормо-години повинні бути більшими за нуль',
  'v.workOrder.part.good.required': 'Оберіть товар',
  'v.workOrder.part.warehouse.required': 'Оберіть склад',
  'v.workOrder.part.quantity.min': 'Кількість повинна бути більшою за нуль',

  // ── Exception-повідомлення: http-exception.filter власні строки (Prisma/fallback/Fastify) ──
  'err.internal': 'Внутрішня помилка сервера',
  'err.badRequest': 'Некоректні дані запиту',
  'err.fastifyBadRequest': 'Некоректний запит: перевірте тіло та Content-Type',
  'err.prisma.unique': 'Запис з таким значенням вже існує ({{fields}})',
  'err.prisma.foreignKey': "Порушення зовнішнього ключа: пов'язаний запис не знайдено",
  'err.prisma.notFound': 'Запис не знайдено',
  'err.prisma.badId': 'Некоректний формат ідентифікатора',
  'err.prisma.tooLong': 'Значення занадто довге для поля',
  'err.prisma.nullConstraint': "Обов'язкове поле не може бути порожнім",

  // ── Exception-повідомлення: currencies-модуль ──
  'err.currency.notFound': 'Валюту не знайдено',
  'err.currency.codeExists': 'Валюта з кодом "{{code}}" вже існує',
  'err.currency.systemImmutable': 'Системну валюту не можна перейменовувати або змінювати код',
  'err.currency.systemUndeletable': 'Системну валюту не можна видалити',

  // ── Exception-повідомлення: bank-accounts-модуль ──
  'err.bankAccount.notFound': 'Банківський рахунок не знайдено',
  'err.branch.notFound': 'Філію не знайдено',

  // ── Exception-повідомлення: exchange-rates-модуль ──
  'err.exchangeRate.notFound': 'Курс валюти не знайдено',
  'err.exchangeRate.dateExists': 'Курс на цю дату вже існує',
  'err.exchangeRate.baseCurrencyNotConfigured':
    'Базову валюту ({{code}}) не налаштовано — створіть її у НДІ → Валюти',
  'err.exchangeRate.noRateForDate':
    'Немає курсу валюти {{code}} на {{date}} — додайте курс у НДІ → Курси валют',
};
