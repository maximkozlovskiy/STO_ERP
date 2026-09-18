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

  // ── Exception-повідомлення: invoices-модуль ──
  'err.invoice.notFound': 'Рахунок не знайдено',
  'err.invoice.workOrderNotFound': 'Наряд не знайдено',
  'err.invoice.onlyCompletedInvoiceable': 'Рахунок можна виставити лише для завершеного наряду',
  'err.invoice.activeExists': 'Для цього наряду вже існує активний рахунок',
  'err.invoice.counterpartyNotFound': 'Контрагента не знайдено',
  'err.invoice.onlyDraftEditable': 'Редагувати можна лише чернетку',
  'err.invoice.statusChanged': 'Статус рахунку змінився — повторіть дію',
  'err.invoice.counterpartyDeletedNoClone': 'Контрагента було видалено — клонування неможливе',
  'err.invoice.linesOnlyDraftAdd': 'Рядки можна додавати лише до чернетки',
  'err.invoice.partNotFound': 'Запчастину не знайдено',
  'err.invoice.workNotFound': 'Роботу не знайдено',
  'err.invoice.unitNotFoundForGood': 'Одиницю виміру не знайдено для цього товару',
  'err.invoice.linesOnlyDraftEdit': 'Рядки можна редагувати лише у чернетці',
  'err.invoice.lineNotFound': 'Рядок не знайдено',
  'err.invoice.linesOnlyDraftRemove': 'Рядки можна видаляти лише з чернетки',
  'err.invoice.activeNotFound': 'Активний рахунок не знайдено',
  'err.invoice.onlyDraftRefresh':
    'Оновити можна лише чернетку рахунку. Скасуйте поточний і виставте новий.',
  'err.invoice.onlyDraftDeletable': 'Видалити можна лише чернетку',
  'err.invoice.concurrentIssueConflict':
    'Інший користувач щойно виставив рахунок для цього наряду. Оновіть сторінку.',
  'err.invoice.concurrentRefreshConflict':
    'Інший користувач щойно оновив цей рахунок. Оновіть сторінку та повторіть.',

  // ── Exception-повідомлення: payments-модуль ──
  'err.payment.counterpartyNotFound': 'Контрагента не знайдено',
  'err.payment.notFound': 'Платіж не знайдено',
  'err.payment.receiptAlreadyIssued': 'Чек уже пробито — повтор не потрібен',
  'err.payment.retryOnlyFailed': 'Повтор можливий лише для чеків у статусі «Помилка»',
  'err.payment.workOrderStatusNoPayment': 'Наряд у статусі "{{status}}" — оплата неможлива',
  'err.payment.fiscalOnlyBaseCurrency':
    'Фіскалізація можлива лише у базовій валюті ({{code}}). Оберіть касу/рахунок у {{code}} або спосіб оплати без ПРРО.',
  'err.payment.currencyMustMatchWorkOrder': 'Валюта оплати має збігатися з валютою наряду',
  'err.payment.invoiceStatusNoPayment': 'Рахунок у статусі "{{status}}" — оплата неможлива',
  'err.payment.invoiceNotForWorkOrder': 'Рахунок не належить до вказаного наряду',
  'err.payment.currencyMustMatchInvoice': 'Валюта оплати має збігатися з валютою рахунку',
  'err.payment.amountExceedsInvoiceRemaining': 'Сума перевищує залишок за рахунком ({{remaining}})',
  'err.payment.invoiceConcurrentChange': 'Рахунок змінено паралельною операцією — повторіть',
  'err.payment.bankAccountNotSpecified': 'Не вказано банківський рахунок',
  'err.payment.bankAccountNotFound': 'Банківський рахунок не знайдено',
  'err.payment.cashRegisterNotSpecified': 'Не вказано касу',
  'err.payment.cashRegisterNotFound': 'Касу не знайдено',
  // cash-shift
  'err.cashShift.fiscalNotConfigured': 'Фіскалізацію не налаштовано (провайдер/креди/увімкнення)',
  'err.cashShift.unknownProvider': 'Невідомий провайдер ПРРО: {{provider}}',
  'err.cashShift.noCashRegisterForBranch': 'Немає каси для цієї філії',
  'err.cashShift.alreadyOpen': 'Зміна вже відкрита',
  'err.cashShift.notFound': 'Зміну не знайдено',
  'err.cashShift.alreadyClosed': 'Зміна вже закрита',
  'err.cashShift.fiscalNotConfiguredToken': 'Фіскалізацію не налаштовано — неможливо оновити токен',
  // fiscal / gateway / provider-config controllers + online-payment
  'err.fiscalProvider.invalidCode': 'Некоректний код провайдера',
  'err.fiscalProvider.unknown': 'Невідомий провайдер ПРРО: {{code}}',
  'err.paymentGateway.invalidCode': 'Некоректний код шлюзу',
  'err.paymentGateway.unknown': 'Невідомий платіжний шлюз: {{code}}',
  'err.onlinePayment.invoiceNotFound': 'Рахунок не знайдено',
  'err.onlinePayment.invoiceStatusNoPayment': 'Рахунок у статусі "{{status}}" — оплата неможлива',
  'err.onlinePayment.noRemaining': 'Немає залишку до сплати',
  'err.onlinePayment.amountExceedsRemaining': 'Сума перевищує залишок ({{remaining}} грн)',
  'err.onlinePayment.acquiringNotConfigured': 'Онлайн-оплату (еквайринг) не налаштовано',
  'err.onlinePayment.unknownGateway': 'Невідомий платіжний шлюз: {{provider}}',
  'err.onlinePayment.gatewayCreateFailed': '{{name}}: не вдалося створити рахунок — {{error}}',
  'err.onlinePayment.intentNotFound': 'Намір оплати не знайдено',
  'err.providerConfig.invalidCode': 'Некоректний код провайдера',
  'err.providerConfig.notConfiguredForBranch': 'Провайдера не налаштовано для цієї філії',
  'err.providerConfig.enterCredentialsFirst': 'Спершу введіть креди провайдера',
  'err.providerConfig.branchNotFound': 'Філію не знайдено',

  // ── Exception-повідомлення: supplier-payments-модуль ──
  'err.supplierPayment.dateXorTarget': 'Потрібно вказати рівно одне: date АБО target',
  'err.supplierPayment.supplierNotFound': 'Постачальника не знайдено',
  'err.supplierPayment.fromDateAfterTo': 'Дата "від" не може бути пізнішою за дату "до"',
  'err.supplierPayment.windowExceedsLimit': 'Вікно графіка не може перевищувати 100 днів',
  'err.supplierPayment.notFound': 'Оплату не знайдено',
  'err.supplierPayment.notASupplier': 'Контрагент не є постачальником',
  'err.supplierPayment.bankAccountNotFound': 'Банківський рахунок не знайдено',
  'err.supplierPayment.cashRegisterNotFound': 'Касу не знайдено',
  'err.supplierPayment.purchaseOrderNotFound': 'Замовлення постачальнику не знайдено',
  'err.supplierPayment.orderNotForSupplier': 'Замовлення не належить вказаному постачальнику',
  'err.supplierPayment.sourceHasNoCurrency': 'Рахунок-джерело не має валюти',
  'err.supplierPayment.onlyDraftEditable': 'Редагування дозволено лише у статусі "Чернетка"',
  'err.supplierPayment.currencyMustMatchOrder': 'Валюта оплати має збігатися з валютою замовлення',
  'err.supplierPayment.cannotConfirmFromStatus':
    'Неможливо провести оплату зі статусу "{{status}}"',
  'err.supplierPayment.alreadyConfirmedOrChanged':
    'Оплату вже проведено або статус змінився — оновіть сторінку',
  'err.supplierPayment.orderConcurrentChange':
    'Замовлення змінено паралельною операцією — повторіть',
  'err.supplierPayment.cannotCancelFromStatus':
    'Неможливо скасувати оплату зі статусу "{{status}}"',
  'err.supplierPayment.confirmedNotDeletable': 'Проведену оплату видалити неможливо',
  'err.supplierPayment.bankRequiresAccount':
    'Для оплати з банку потрібно вказати банківський рахунок',
  'err.supplierPayment.sourceConflict': 'Не можна одночасно вказувати банківський рахунок і касу',
  'err.supplierPayment.cashRequiresRegister': 'Для оплати з каси потрібно вказати касу',

  // ── Exception-повідомлення: purchase-orders-модуль ──
  'err.deliveryProvider.invalidCode': 'Некоректний код служби',
  'err.deliveryProvider.unknown': 'Невідома служба доставки: {{code}}',
  'err.purchaseOrder.goodNotFound': 'Товар не знайдено: {{missing}}',
  'err.purchaseOrder.notFound': 'Замовлення не знайдено',
  'err.purchaseOrder.supplierNotFound': 'Постачальника не знайдено',
  'err.purchaseOrder.warehouseNotFound': 'Склад не знайдено',
  'err.purchaseOrder.contractNotFound': 'Договір не знайдено',
  'err.purchaseOrder.onlyDraftEditable': 'Редагувати можна лише чернетку',
  'err.purchaseOrder.receiveOnlyOrderedOrPartial':
    'Прийом можливий лише для замовлень зі статусом ORDERED або PARTIAL',
  'err.purchaseOrder.unitNotFoundInOrg': 'Одиницю виміру не знайдено в межах організації',
  'err.purchaseOrder.receiveLineMustBeUnique': 'Кожен рядок прийому має бути унікальним',
  'err.purchaseOrder.receiveExceedsLineRemaining':
    'Кількість прийому перевищує залишок за рядком (замовлено {{quantity}}, ' +
    'вже прийнято {{received}}, до прийому {{remaining}})',
  'err.purchaseOrder.statusChangedRetry':
    'Статус замовлення змінився на "{{status}}" — повторіть прийом',
  'err.purchaseOrder.receiveAlreadyProcessed':
    'Прийом уже опрацьовано або рядок змінено іншою операцією — повторіть',
  'err.purchaseOrder.onlyDraftDeletable': 'Видалити можна лише чернетку',
  'err.purchaseOrder.priceOnlyReceived':
    'Розцінити можна лише отримані товари (статус RECEIVED або PARTIAL)',

  // ── Exception-повідомлення: supplier-returns-модуль ──
  'err.supplierReturn.notFound': 'Повернення не знайдено',
  'err.supplierReturn.supplierNotFound': 'Постачальника не знайдено',
  'err.supplierReturn.warehouseNotFound': 'Склад не знайдено',
  'err.supplierReturn.orderNotFound': 'Замовлення не знайдено',
  'err.supplierReturn.onlyDraftEditable': 'Редагування дозволено лише у статусі "Чернетка"',
  'err.supplierReturn.cannotConfirmFromStatus':
    'Неможливо підтвердити повернення зі статусу "{{status}}"',
  'err.supplierReturn.confirmRequiresLines': 'Повернення не може бути підтверджено без рядків',
  'err.supplierReturn.alreadyConfirmedOrChanged':
    'Повернення вже підтверджено або статус змінився — оновіть сторінку',
  'err.supplierReturn.cannotCancelFromStatus':
    'Неможливо скасувати повернення зі статусу "{{status}}"',
  'err.supplierReturn.onlyDraftDeletable': 'Видалити можна лише повернення зі статусом "Чернетка"',
  'err.supplierReturn.goodNotFound': 'Товар не знайдено: {{missing}}',
  'err.supplierReturn.unitNotFound': 'Одиницю виміру не знайдено: {{missing}}',

  // ── Exception-повідомлення: stock-documents-модуль ──
  'err.stockDocument.notFound': 'Документ не знайдено',
  'err.stockDocument.goodNotFound': 'Товар не знайдено: {{missing}}',
  'err.stockDocument.branchNotFound': 'Філію не знайдено',
  'err.stockDocument.warehouseNotFound': 'Склад не знайдено',
  'err.stockDocument.orderNotFound': 'Замовлення не знайдено',
  'err.stockDocument.transferTargetRequired': 'Для переміщення потрібен склад призначення',
  'err.stockDocument.targetWarehouseNotFound': 'Склад призначення не знайдено',
  'err.stockDocument.sourceTargetSame': 'Склад джерела і призначення не можуть збігатись',
  'err.stockDocument.onlyDraftEditable': 'Редагувати можна лише чернетку',
  'err.stockDocument.confirmRequiresLines': 'Документ не може бути підтверджено без позицій',
  'err.stockDocument.statusChanged': 'Статус документу змінився — повторіть дію',
  'err.stockDocument.unsupportedType': 'Непідтримуваний тип документу: {{type}}',
  'err.stockDocument.onlyDraftDeletable': 'Видалити можна лише чернетку',

  // ── Exception-повідомлення: goods-модуль ──
  'err.good.maxBulkGoods': 'Максимум 100 товарів за раз',
  'err.good.invalidGoodId': 'Некоректний goodId: {{invalid}}',
  'err.good.notFound': 'Товар не знайдено',
  'err.good.statusNotFound': 'Статус не знайдено',
  'err.good.statusNotAssigned': 'Статус не призначено цьому товару',
  'err.good.skuExists': 'Товар з артикулом "{{sku}}" вже існує',
  'err.good.hasStockOrReserve': 'Неможливо видалити: товар має ненульові залишки або резерв',
  'err.good.deletedNotFound': 'Видалений товар не знайдено',
  'err.good.restoreSkuExists':
    'Неможливо відновити: активний товар з артикулом "{{sku}}" вже існує',
  'err.good.restoreCodeExists': 'Неможливо відновити: активний товар з кодом "{{code}}" вже існує',
  'err.good.brandNotFound': 'Бренд не знайдено',
  'err.good.unitNotFound': 'Одиницю виміру не знайдено',
  'err.good.supplierNotFound': 'Постачальника не знайдено',
  'err.good.categoryNotFound': 'Категорію товарів не знайдено',
  'err.good.barcodeEmpty': 'Штрихкод не може бути порожнім',
  'err.good.barcodeInUse': 'Штрихкод уже використовується',
  'err.good.barcodeNotFound': 'Штрихкод не знайдено',
  'err.good.uomAlreadyAdded': 'Ця одиниця виміру вже додана до товару',
  'err.good.uomRecordNotFound': 'Запис одиниці виміру не знайдено',
  'err.good.cannotDeleteOnlyUom': 'Не можна видалити єдину одиницю виміру',
  'err.good.goodUomNotFound': 'Одиницю виміру товару не знайдено',

  // ── Exception-повідомлення: inventory-модуль ──
  'err.inventory.goodNotFound': 'Товар не знайдено',
  'err.inventory.batchConcurrentChange': 'Партію змінено іншою транзакцією — повторіть операцію',
  'err.inventory.insufficientBatches':
    'Недостатньо партій для списання: бракує {{remaining}} одиниць товару',
  'err.inventory.batchNotFound': 'Партію не знайдено',
  'err.inventory.returnExceedsBatchReceived': 'Повернення перевищує отриману кількість партії',
  'err.inventory.quantityZero': 'Кількість не може бути нульовою',
  'err.inventory.invalidQuantity': 'Невірне значення кількості',
  'err.inventory.invalidPrice': 'Невірне значення ціни',
  'err.inventory.reservationReleaseNegative': "Зняття резерву: кількість повинна бути від'ємною",
  'err.inventory.returnMustBePositive': 'Повернення на склад: кількість повинна бути додатною',
  'err.inventory.returnRequiresSourceDoc': 'Повернення на склад потребує документа-джерела',
  'err.inventory.unitNotFoundInOrg': 'Одиницю виміру не знайдено в межах організації',
  'err.inventory.insufficientStock': 'Недостатньо товару на складі',
  'err.inventory.insufficientAvailableForReservation':
    'Недостатньо доступного товару для резервування',
  'err.inventory.cannotReleaseMoreThanReserved':
    'Неможливо зняти резерв: зарезервована кількість менша за запитану',
  'err.inventory.insufficientStockConcurrentWriteoff':
    'Недостатньо товару на складі (concurrent WRITEOFF)',
  'err.inventory.reservedNegativeConcurrentRelease':
    "Резерв не може стати від'ємним (concurrent RESERVATION_RELEASE)",
  'err.inventory.insufficientAvailableConcurrentReservation':
    'Недостатньо доступного товару для резервування (concurrent RESERVATION)',
  'err.inventory.writeoffBelowReserved':
    'Списання опустило б залишок нижче зарезервованого — спершу зніміть резерв',
  'err.inventory.stockItemNotFound': 'Залишок не знайдено',
  'err.inventory.unknownMovementType': 'Невідомий тип руху',
  'err.pricingRule.goodNotFound': 'Товар не знайдено',
  'err.pricingRule.brandNotFound': 'Бренд не знайдено',
  'err.pricingRule.supplierNotFound': 'Постачальника не знайдено',
  'err.pricingRule.notFound': 'Правило не знайдено',
};
