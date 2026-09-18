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

  // ── Exception-повідомлення: good-categories-модуль ──
  'err.goodCategory.notFound': 'Категорію товарів не знайдено',
  'err.goodCategory.parentNotFound': 'Батьківську категорію не знайдено',
  'err.goodCategory.systemImmutable': 'Системну категорію не можна перейменовувати або переносити',
  'err.goodCategory.ownParent': 'Категорія не може бути власним батьком',
  'err.goodCategory.systemUndeletable': 'Системну категорію не можна видалити',
  'err.goodCategory.moveIntoDescendant':
    'Неможливо перенести категорію у власну підкатегорію (утворився б цикл)',

  // ── Exception-повідомлення: work-categories-модуль ──
  'err.workCategory.notFound': 'Категорію не знайдено',
  'err.workCategory.parentNotFound': 'Батьківську категорію не знайдено',
  'err.workCategory.systemImmutable': 'Системну категорію не можна перейменовувати або переносити',
  'err.workCategory.systemUndeletable': 'Системну категорію не можна видалити',

  // ── Exception-повідомлення: units-модуль ──
  'err.unit.deletedNotFound': 'Видалену одиницю виміру не знайдено',
  'err.unit.systemUnrestorable': 'Системну одиницю виміру не можна відновити',
  'err.unit.notFound': 'Одиниця виміру не знайдена',
  'err.unit.shortNameExists': 'Одиниця з такою скороченою назвою вже існує',
  'err.unit.systemUndeletable': 'Системну одиницю виміру не можна видалити',
  'err.unit.activeShortNameExists':
    'Активна одиниця з такою скороченою назвою вже існує — відновлення неможливе',
  'err.unit.shortNameInArchive':
    'Одиниця з такою скороченою назвою існує у архіві. Спочатку відновіть її або оберіть інше скорочення.',

  // ── Exception-повідомлення: zones-модуль ──
  'err.zone.notFound': 'Зону не знайдено',
  'err.lift.notFound': 'Підйомник не знайдено',
  'err.zone.hasActiveLifts':
    'Неможливо видалити: у зоні є активні підйомники. Спочатку видаліть або перенесіть їх',

  // ── Exception-повідомлення: services-модуль ──
  'err.service.notFound': 'Послугу не знайдено',
  'err.service.deletedNotFound': 'Видалену послугу не знайдено',
  'err.service.worksNotFound': 'Одну або кілька робіт не знайдено',
  'err.service.goodsNotFound': 'Один або кілька товарів не знайдено',

  // ── Exception-повідомлення: loyalty-модуль ──
  'err.loyalty.counterpartyNotFound': 'Контрагента не знайдено',
  'err.loyalty.pointsPositive': 'Кількість балів має бути > 0',
  'err.loyalty.accountNotFound': 'Рахунок лояльності не знайдено',
  'err.loyalty.insufficientPoints': 'Недостатньо балів',

  // ── Exception-повідомлення: cash-registers-модуль ──
  'err.cashRegister.notFound': 'Касу не знайдено',
  'err.cashRegister.prroOnlyFiscal':
    'Провайдера ПРРО можна привʼязати лише до фіскальної каси (увімкніть «Фіскальна каса»)',
  'err.cashRegister.prroNotConfigured':
    'Провайдера ПРРО не налаштовано для цієї філії — спершу введіть його креди у Налаштуваннях',

  // ── Exception-повідомлення: warranties-модуль ──
  'err.warranty.notFound': 'Гарантію не знайдено',
  'err.warranty.workOrderNotFound': 'Наряд не знайдено',
  'err.warranty.counterpartyNotFound': 'Контрагента не знайдено',
  'err.warranty.lineNotFound': 'Рядок наряду не знайдено',
  'err.warranty.partNotFound': 'Запчастину наряду не знайдено',
  'err.warranty.endDateFuture': 'Дата завершення гарантії має бути в майбутньому',
  'err.warranty.alreadyClaimed': 'Гарантія вже використана',
  'err.warranty.expired': 'Термін гарантії минув',
  'err.warranty.claimWorkOrderNotFound': 'Гарантійний наряд не знайдено',

  // ── Exception-повідомлення: completion-acts-модуль ──
  'err.completionAct.notFound': 'Акт не знайдено',
  'err.completionAct.workOrderNotFound': 'Наряд не знайдено',
  'err.completionAct.workOrderNotCompleted': 'Акт можна сформувати лише для завершеного наряду',
  'err.completionAct.activeExists': 'Для цього наряду вже існує активний акт',
  'err.completionAct.onlyDraftSignable': 'Підписати можна лише чернетку акту',
  'err.completionAct.statusChanged': 'Статус акту змінився — повторіть дію',
  'err.completionAct.signedNotCancelable': 'Підписаний акт не можна скасувати',

  // ── Exception-повідомлення: files-модуль ──
  'err.file.multipartExpected': 'Очікується multipart/form-data',
  'err.file.notReceived': 'Файл не отримано',
  'err.file.onlyImages': 'Дозволені тільки зображення',
  'err.file.tooLarge': 'Файл завеликий (максимум 10 МБ)',
  'err.file.serviceUnavailable': 'Сервіс файлів недоступний',
  'err.file.disallowedFormat': 'Недозволений формат файлу',
  'err.file.workOrderNotFound': 'Наряд не знайдено',
  'err.file.saveFailed': 'Помилка збереження файлу',

  // ── Exception-повідомлення: work-order-media-модуль ──
  'err.workOrderMedia.multipartExpected': 'Очікується multipart/form-data',
  'err.workOrderMedia.tooLarge': 'Файл завеликий (максимум 10 МБ)',
  'err.workOrderMedia.notReceived': 'Файл не отримано',
  'err.workOrderMedia.disallowedFormat': 'Дозволені формати: JPEG, PNG, HEIC, HEIF, PDF',
  'err.workOrderMedia.disallowedExtension': 'Недозволене розширення файлу',
  'err.workOrderMedia.workOrderNotFound': 'Наряд не знайдено',
  'err.workOrderMedia.notFound': 'Медіа не знайдено',

  // ── Exception-повідомлення: expense-categories-модуль ──
  'err.expenseCategory.notFound': 'Статтю не знайдено',
  'err.expenseCategory.deletedNotFound': 'Видалену статтю не знайдено',
  'err.expenseCategory.parentNotFound': 'Батьківську статтю не знайдено',
  'err.expenseCategory.typeMismatchParent': 'Тип статті має збігатися з типом батьківської статті',
  'err.expenseCategory.maxDepth': 'Досягнуто максимальної глибини вкладеності статей',
  'err.expenseCategory.nameExists': 'Стаття з такою назвою вже існує',
  'err.expenseCategory.activeNameExists':
    'Активна стаття з такою назвою вже існує — відновлення неможливе',
  'err.expenseCategory.ownParent': 'Стаття не може бути власним батьком',
  'err.expenseCategory.parentTypeMismatch': 'Батьківська стаття має бути того ж типу',
  'err.expenseCategory.moveIntoDescendant': 'Не можна перенести статтю у власного нащадка',
};
