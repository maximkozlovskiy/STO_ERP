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
  'v.invalidNumber': 'Вкажіть число',

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
  'v.warranty.expiresAt.required': 'Вкажіть дату закінчення гарантії',
  'v.warranty.expiresAt.format': 'Невірний формат дати',

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
  'err.requestFileTooLarge':
    'Файл завеликий — перевищено максимальний розмір завантаження. Зменшіть роздільність або розбийте файл на частини.',
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
  'err.completionAct.workOrderCancelled': 'Наряд скасовано — акт підписати не можна',
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
  'err.payment.invoiceNotForCounterparty':
    'Рахунок виписано на іншого контрагента — оплату приймаємо лише від платника рахунку',
  'err.payment.workOrderNotForCounterparty':
    'Наряд оформлено на іншого контрагента — оплату наряду приймаємо лише від його замовника',
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

  // ── Exception-повідомлення: work-orders-модуль ──
  'err.workOrder.notFound': 'Наряд не знайдено',
  'err.workOrder.generateTokenFailed': 'Не вдалося згенерувати токен — спробуйте ще раз',
  'err.workOrder.shareLinkInvalid': 'Посилання не дійсне або термін дії минув',
  'err.workOrder.customerPhoneMissing': 'Телефон клієнта не вказано',
  'err.workOrder.shareOnlyDraftEstimateApproved':
    'Поділитися кошторисом можна лише у статусі чернетка / кошторис / затверджено',
  'err.workOrder.publicUrlNotConfigured':
    'Публічний URL не налаштовано (WEB_PUBLIC_URL) — зверніться до адміністратора',
  'err.workOrder.totalZeroCannotComplete':
    'Загальна сума наряду дорівнює нулю — завершення неможливе',
  'err.workOrder.vehicleNotFound': 'Автомобіль не знайдено',
  'err.workOrder.counterpartyNotFound': 'Контрагента не знайдено',
  'err.workOrder.contractNotFound': 'Договір не знайдено',
  'err.workOrder.cannotEditClosed': 'Не можна редагувати закритий наряд',
  'err.workOrder.outMileageLessThanIn': 'Вихідний пробіг не може бути меншим за вхідний',
  'err.workOrder.onlyDraftOrCancelledDeletable':
    'Можна видалити лише наряд у статусі Чернетка або Скасовано',
  'err.workOrder.vehicleDeletedNoClone': 'Автомобіль було видалено — клонування неможливе',
  'err.workOrder.counterpartyDeletedNoClone': 'Контрагента було видалено — клонування неможливе',
  'err.workOrder.branchDeletedNoClone': 'Філію було видалено — клонування неможливе',
  'err.workOrder.statusChanged': 'Статус наряду змінився — повторіть дію',
  'err.workOrder.cannotEditLinesInStatus': 'Не можна редагувати позиції наряду в поточному статусі',
  'err.workOrder.workNotFound': 'Роботу не знайдено',
  'err.workOrder.employeeNotFound': 'Співробітника не знайдено',
  'err.workOrder.lineNotFound': 'Позицію не знайдено',
  'err.workOrder.warehouseNotFound': 'Склад не знайдено',
  'err.workOrder.unitNotConfiguredForGood':
    'Одиницю виміру не сконфігуровано для цього товару. Налаштуйте у каталозі (Товари → Одиниці виміру) або виберіть базову.',

  // ── Exception-повідомлення: calendar-модуль ──
  'err.calendar.invalidDateFormatExpected': 'Невірний формат дати. Очікується YYYY-MM-DD',
  'err.calendar.endBeforeStart': 'Час завершення має бути після початку',
  'err.calendar.employeeNotFound': 'Співробітника не знайдено',
  'err.calendar.workOrderNotFound': 'Наряд не знайдено',
  'err.calendar.clientNotFound': 'Клієнта не знайдено',
  'err.calendar.vehicleNotFound': 'Автомобіль не знайдено',
  'err.calendar.liftBusy': 'Підйомник вже зайнятий на цей час',
  'err.calendar.employeeBusy': 'Співробітник вже зайнятий на цей час',
  'err.calendar.liftBusyNextDay': 'Підйомник вже зайнятий на наступний день',
  'err.calendar.employeeBusyNextDay': 'Співробітник вже зайнятий на наступний день',
  'err.calendar.slotSplitTwoDays': 'Слот розбитий на 2 дні — редагуйте кожен окремо',
  'err.calendar.slotNotFound': 'Слот не знайдено',
  'err.calendar.invalidTimeInterval': 'Невірний інтервал часу',
  'err.calendar.invalidDateFormat': 'Невірний формат дати',

  // ── Exception-повідомлення: xlsx-модуль ──
  'err.xlsx.purchaseOrderNotDraft': 'Замовлення постачальника не в статусі DRAFT',
  'err.xlsx.stockDocumentNotDraft': 'Складський документ не в статусі DRAFT',
  'err.xlsx.unknownTemplateType': 'Невідомий тип шаблону',
  'err.xlsx.unknownDocumentType': 'Невідомий тип документа',
  'err.xlsx.invalidDocumentId': 'Некоректний ідентифікатор документа',
  'err.xlsx.fileNotUploaded': 'Файл не завантажено',
  'err.xlsx.sheetGoodsNotFound': 'Аркуш "Товари" не знайдено',
  'err.xlsx.tableNoDataRows': 'Таблиця не містить жодного рядка даних',
  'err.xlsx.sheetWorksNotFound': 'Аркуш "Роботи" не знайдено',
  'err.xlsx.sheetBrandsNotFound': 'Аркуш "Бренди" не знайдено',
  'err.xlsx.sheetUnitsNotFound': 'Аркуш "Одиниці" не знайдено',
  'err.xlsx.purchaseOrderNotFound': 'Замовлення постачальника не знайдено',
  'err.xlsx.orderNotDraft': 'Замовлення не в статусі DRAFT',
  'err.xlsx.stockDocumentNotFound': 'Складський документ не знайдено',
  'err.xlsx.documentNotDraft': 'Документ не в статусі DRAFT',
  'err.xlsx.workOrderNotFound': 'Наряд-замовлення не знайдено',
  'err.xlsx.workOrderNotDraftOrEstimate': 'Наряд не в статусі DRAFT або ESTIMATE',
  'err.xlsx.tableNotFound': 'Таблиця не знайдена',
  'err.xlsx.fileNoDataRows': 'Файл не містить жодного рядка даних',
  'err.xlsx.documentNotFound': 'Документ не знайдено',
  'err.xlsx.rowGoodMissing': 'Рядок {{row}}: не вказано товар',
  'err.xlsx.rowGoodNotFound': 'Рядок {{row}}: товар не знайдено',
  'err.xlsx.fileNoGoodRows': 'Файл не містить рядків товарів',
  'err.xlsx.fileNotUploadedDetail': 'Файл не завантажено: {{detail}}',
  'err.xlsx.fileNotUploadedMultipart': 'очікується multipart/form-data',
  'err.xlsx.rowError': 'Помилка в рядку {{row}}: {{detail}}',
  'err.xlsx.rowErrorUnknown': 'невідома помилка',
  'err.xlsx.rowGoodNameRequired': 'Рядок {{row}}: назва товару обовʼязкова для створення',
  'err.xlsx.fileReadFailed':
    'Не вдалося прочитати файл — очікується Excel (.xlsx), CSV (.csv), PDF (.pdf) або фото/скан (.jpg, .png)',
  'err.xlsx.unsupportedFormat':
    'Непідтримуваний формат файлу — очікується Excel (.xlsx), CSV (.csv), PDF (.pdf) або фото/скан (.jpg, .png). Фото з iPhone у форматі HEIC не підтримується: у Налаштуваннях → Камера → Формати виберіть «Найбільш сумісний».',
  'err.xlsx.imageNoTableStructure':
    'На зображенні не вдалося розпізнати таблицю позицій — переконайтеся, що у кадр потрапила вся таблична частина накладної',
  'err.xlsx.ocrNoText':
    'На зображенні не знайдено тексту. Сфотографуйте накладну рівно, при доброму освітленні й без розмиття, або надішліть файл Excel/CSV.',
  'err.xlsx.ocrTimeout':
    'Розпізнавання триває задовго — спробуйте зменшити кількість сторінок або надішліть файл Excel/CSV',
  'err.xlsx.ocrModelsMissing':
    'Модулі розпізнавання не встановлені на цій інсталяції — зверніться до підтримки',
  'err.xlsx.pdfScanOcrUnavailable':
    'Розпізнавання PDF-сканів недоступне на цій інсталяції — зверніться до підтримки',
  'err.xlsx.pdfNoTextLayer':
    'Не вдалося прочитати позиції: у PDF немає текстового шару, а розпізнати скан не вдалося. Спробуйте чіткіший скан, попросіть у постачальника файл Excel/CSV, або введіть позиції вручну.',
  'err.xlsx.pdfUnreadable':
    'Не вдалося прочитати PDF — файл пошкоджений, запаролений або сторінка повернута',
  'err.xlsx.pdfNoTableStructure':
    'У PDF не вдалося розпізнати таблицю позицій — перевірте, що файл містить табличну частину накладної',

  // ── Exception-повідомлення: bank-statements-модуль (вхідні банк-платежі) ──
  'err.bankStatement.txNotFound': 'Банківську транзакцію не знайдено',
  'err.bankStatement.alreadyMatched': 'Транзакцію вже рознесено або проведено',
  'err.bankStatement.notUnmatched': 'Дію дозволено лише для нерознесених транзакцій',
  'err.bankStatement.bankAccountNotFound': 'Банківський рахунок не знайдено',
  'err.bankStatement.counterpartyNotFound': 'Контрагента не знайдено',
  'err.bankStatement.invoiceNotFound': 'Рахунок не знайдено',
  'err.bankStatement.invoiceRequiredForType': 'Для типу «Рахунок» потрібно вказати рахунок',
  'err.bankStatement.invalidFile': 'Непідтримуваний формат файлу — очікується .xlsx, .csv або .dbf',
  'err.bankStatement.fileReadFailed': 'Не вдалося прочитати файл виписки',
  'err.bankStatement.noDataRows': 'Файл виписки не містить жодного рядка даних',
  'err.bankStatement.matchFailed': 'Не вдалося провести платіж за транзакцією',
  'err.bankStatement.invalidOperationDate':
    'Некоректна дата операції «{{value}}» (очікується YYYY-MM-DD або ISO)',
  // ── DTO-валідація bank-statements ──
  'err.dto.bankStatement.bankAccountId.uuid': 'Невірний ідентифікатор банківського рахунку',
  'err.dto.bankStatement.startRow.int': 'Рядок початку має бути цілим числом',
  'err.dto.bankStatement.startRow.min': 'Рядок початку має бути не менше 1',
  'err.dto.bankStatement.dateCol.int': 'Колонка дати має бути цілим числом',
  'err.dto.bankStatement.dateCol.min': 'Колонка дати має бути не менше 1',
  'err.dto.bankStatement.amountCol.int': 'Колонка суми має бути цілим числом',
  'err.dto.bankStatement.amountCol.min': 'Колонка суми має бути не менше 1',
  'err.dto.bankStatement.externalIdCol.int': 'Колонка ідентифікатора має бути цілим числом',
  'err.dto.bankStatement.externalIdCol.min': 'Колонка ідентифікатора має бути не менше 1',
  'err.dto.bankStatement.col.int': 'Номер колонки має бути цілим числом',
  'err.dto.bankStatement.col.min': 'Номер колонки має бути не менше 1',
  'err.dto.bankStatement.rows.max': 'Забагато рядків для одного імпорту (максимум 1000)',
  'err.dto.bankStatement.reason.required': 'Вкажіть причину ігнорування',
  'err.dto.bankStatement.type.invalid': 'Невірний тип рознесення транзакції',

  // ── Exception-повідомлення: counterparties-модуль ──
  'err.counterparty.notFound': 'Контрагента не знайдено',
  'err.counterparty.notAClient': 'Контрагент є постачальником — оберіть клієнта',
  'err.counterparty.notASupplier': 'Контрагент не є постачальником',
  'err.counterparty.statusNotFound': 'Статус не знайдено',
  'err.counterparty.statusNotAssigned': 'Статус не призначено цьому контрагенту',
  'err.counterparty.nameRequired': 'Вкажіть назву компанії або ім’я/прізвище контрагента',
  'err.counterparty.hasActiveWorkOrders': 'Неможливо видалити: контрагент має активні наряди',
  'err.counterparty.hasOpenOrders': 'Неможливо видалити: контрагент має незакриті замовлення',
  'err.counterparty.hasOpenInvoices': 'Неможливо видалити: контрагент має відкриті рахунки',
  'err.counterparty.hasNonZeroBalance':
    'Неможливо видалити контрагента з ненульовим балансом (є заборгованість)',
  'err.counterparty.garageNotFound': 'Гараж не знайдено',
  'err.counterparty.supplierOnlyPurchaseContract': 'Постачальник може мати лише договір Купівлі',
  'err.counterparty.clientOnlySaleContract': 'Клієнт може мати лише договір Продажу',
  'err.counterparty.deletedContractNotFound': 'Видалений договір не знайдено',
  'err.counterparty.currencyNotFound': 'Валюта з кодом "{{code}}" не знайдена',
  'err.counterparty.contractNotFound': 'Договір не знайдено',
  'err.counterparty.supplierNeedsAtLeastOneContract':
    'Постачальник повинен мати хоча б один договір',

  // ── Exception-повідомлення: booking-модуль ──
  'err.booking.invalidBranchId': 'Некоректний branchId',
  'err.booking.dateFormatExpected': 'Дата у форматі YYYY-MM-DD',
  'err.booking.branchNotFound': 'Філію не знайдено',
  'err.booking.someServicesNotFound': 'Деякі послуги не знайдено',
  'err.booking.selectedLiftNotFound': 'Обраний підйомник не знайдено',
  'err.booking.invalidDateFormat': 'Невірний формат дати',
  'err.booking.dateInPast': 'Дата запису не може бути в минулому',
  'err.booking.nonWorkingDay': 'Запит на неробочий день',
  'err.booking.outsideWorkingHours': 'Час поза робочими годинами ({{start}}–{{end}})',
  'err.booking.requestNotFound': 'Заявку не знайдено',
  'err.booking.cancelledCannotConfirm': 'Скасовану заявку не можна підтвердити',
  'err.booking.slotNotFound': 'Слот не знайдено',

  // ── Exception-повідомлення: auth-модуль ──
  'err.auth.invalidCredentials': 'Невірний email або пароль',
  'err.auth.accountBlocked': 'Обліковий запис заблоковано',
  'err.auth.accountTempLocked':
    'Обліковий запис тимчасово заблоковано через невдалі спроби входу. Спробуйте пізніше',
  'err.auth.sessionExpired': 'Сесія застаріла, увійдіть знову',
  'err.auth.userNotFound': 'Користувача не знайдено',
  'err.auth.accountNotFound': 'Обліковий запис не знайдено',
  'err.auth.currentPasswordWrong': 'Поточний пароль невірний',
  'err.auth.noBranchAccess': 'Немає доступу до цієї філії',
  'err.auth.insufficientRights': 'Недостатньо прав для виконання цієї дії',
  'err.auth.sessionInvalid': 'Сесія недійсна',

  // ── Exception-повідомлення: idempotency-interceptor ──
  'err.idempotency.inProgress': 'Запит з цим Idempotency-Key вже обробляється',
  'err.idempotency.keyReusedDifferentBody': 'Idempotency-Key вже використано з іншим тілом запиту',

  // ── Exception-повідомлення: fsm ──
  'err.fsm.transitionNotAllowed': 'Перехід зі статусу "{{from}}" в "{{to}}" неможливий',

  // ── Exception-повідомлення: audit-модуль ──
  'err.audit.unknownEntityType': 'Невідомий тип сутності',

  // ── Exception-повідомлення: brands-модуль ──
  'err.brand.deletedNotFound': 'Видалений бренд не знайдено',
  'err.brand.notFound': 'Бренд не знайдено',
  'err.brand.nameExists': 'Бренд з такою назвою вже існує',
  'err.brand.activeNameExists': 'Активний бренд з такою назвою вже існує — відновлення неможливе',

  // ── Exception-повідомлення: cash-модуль ──
  'err.cash.amountMustBePositive': 'Сума має бути додатною',
  'err.cash.categoryNotFound': 'Статтю не знайдено',
  'err.cash.categoryInactive': 'Стаття вимкнена — оберіть активну',
  'err.cash.categoryTypeIncome': 'Для внесення оберіть статтю оприбуткування',
  'err.cash.categoryTypeExpense': 'Для видачі оберіть статтю витрат',
  'err.cash.shiftRequiredForFiscal':
    'Для фіскальної каси відкрийте зміну перед операціями з готівкою',
  'err.cash.concurrentOperation': 'Каса зайнята паралельною операцією — повторіть',
  'err.cash.expenseRequiresCategory': 'Для витрати вкажіть статтю витрат',
  'err.cash.insufficientCash':
    'Недостатньо готівки в касі: доступно {{available}}, потрібно {{required}}',

  // ── Exception-повідомлення: comments-модуль ──
  'err.comment.unknownEntityType': 'Невідомий тип сутності для коментарів: {{entityType}}',
  'err.comment.entityIdRequired': "entityId обов'язковий",
  'err.comment.entityNotFound': 'Сутність не знайдено',
  'err.comment.notFound': 'Коментар не знайдено',
  'err.comment.deleteForbidden': 'Видаляти коментарі можуть лише автор або адміністратор',

  // ── Exception-повідомлення: document-number-модуль ──
  'err.documentNumber.configNotFound': 'Конфігурацію нумерації для "{{documentType}}" не знайдено',

  // ── Exception-повідомлення: dead-letter-модуль ──
  'err.deadLetter.notFound': 'DLQ-запис не знайдено',

  // ── Exception-повідомлення: employees-модуль ──
  'err.employee.notFound': 'Співробітника не знайдено',
  'err.employee.passwordRequiredWithEmail': "Пароль обов'язковий якщо вказано email для входу",
  'err.employee.loginEmailInUse': 'Цей email вже використовується для входу',
  'err.employee.zonesNotFound': 'Одну або кілька зон не знайдено',
  'err.employee.liftsNotFound': 'Один або кілька підйомників не знайдено',
  'err.employee.categoriesNotFound': 'Одну або кілька категорій не знайдено',
  'err.employee.branchesNotFound': 'Одну або кілька філій не знайдено',
  'err.employee.assignedToActiveOrders':
    'Неможливо видалити: співробітник призначений на активні наряди',
  'err.employee.invalidRateScheme': 'Невірна схема нарахування: {{details}}',

  // ── Exception-повідомлення: good-statuses-модуль ──
  'err.goodStatus.notFound': 'Статус не знайдено',
  'err.goodStatus.nameExists': 'Статус з такою назвою вже існує',
  'err.goodStatus.deletedNotFound': 'Видалений статус не знайдено',
  'err.goodStatus.activeNameExists':
    'Активний статус з такою назвою вже існує — відновлення неможливе',

  // ── Exception-повідомлення: counterparty-statuses-модуль ──
  'err.counterpartyStatus.notFound': 'Статус не знайдено',
  'err.counterpartyStatus.nameExists': 'Статус з такою назвою вже існує',
  'err.counterpartyStatus.deletedNotFound': 'Видалений статус не знайдено',
  'err.counterpartyStatus.activeNameExists':
    'Активний статус з такою назвою вже існує — відновлення неможливе',

  // ── Exception-повідомлення: counterparty-import-mappings-модуль ──
  'err.counterpartyImportMapping.counterpartyNotFound': 'Контрагента не знайдено',

  // ── Exception-повідомлення: integration-logs-модуль ──
  'err.integrationLog.invalidDateFormat': 'Невірний формат дати у полі "{{field}}"',

  // ── Exception-повідомлення: maintenance-schedules-модуль ──
  'err.maintenanceSchedule.notFound': 'Графік ТО не знайдено',
  'err.maintenanceSchedule.vehicleNotFound': 'Авто не знайдено',

  // ── Exception-повідомлення: notifications-модуль ──
  'err.notification.templateNotFound': 'Шаблон не знайдено',
  'err.notification.providerNotFound': 'Провайдер не знайдено',
  'err.notification.unknownProvider': 'Невідомий провайдер',
  'err.notification.providerChannelUnsupported':
    'Провайдер {{provider}} не підтримує канал {{channel}}',
  'err.notification.invalidProviderCode': 'Некоректний код провайдера',

  // ── Exception-повідомлення: payment-methods-модуль ──
  'err.paymentMethod.notFound': 'Метод оплати не знайдено',
  'err.paymentMethod.codeExists': 'Метод оплати з кодом "{{code}}" вже існує',
  'err.paymentMethod.systemImmutableName': 'Системний метод оплати не можна перейменовувати',
  'err.paymentMethod.systemUndeletable': 'Системний метод оплати не можна видалити',

  // ── Exception-повідомлення: payroll-модуль ──
  'err.payroll.startAfterEnd': 'Дата початку має бути не пізніше дати закінчення',
  'err.payroll.periodNotFound': 'Період не знайдено',
  'err.payroll.onlyDraftCalculable': 'Розрахувати можна лише період у статусі «Чернетка»',
  'err.payroll.calculateConcurrentChange': 'Період уже розраховано або змінено іншим користувачем',
  'err.payroll.onlyCalculatedPayable': 'Виплатити можна лише розрахований період',
  'err.payroll.payConcurrentChange': 'Період уже виплачено або змінено іншим користувачем',
  'err.payroll.paidNotDeletable': 'Не можна видалити виплачений період',

  // ── Exception-повідомлення: report-builder-модуль ──
  'err.reportBuilder.aggregationNotAllowed': 'Агрегація {{agg}} недозволена для "{{label}}"',
  'err.reportBuilder.sumNotAllowedState': 'SUM недозволена для "{{label}}" (стан, не потік)',
  'err.reportBuilder.modelUnavailable': 'Модель {{model}} недоступна',
  'err.reportBuilder.savedReportNotFound': 'Збережений звіт не знайдено',
  'err.reportBuilder.filterInRequiresArray': 'Фільтр "in" потребує масив',
  'err.reportBuilder.filterContainsTextOnly': 'Фільтр "contains" лише для текстових полів',
  'err.reportBuilder.disallowedOperator': 'Недозволений оператор: {{op}}',
  'err.reportBuilder.startAfterEnd': 'Дата початку має бути не пізніше дати закінчення',
  'err.reportBuilder.fieldNotFilterable': 'Поле "{{label}}" не фільтрується',
  'err.reportBuilder.unknownEntity': 'Невідома сутність звіту: {{key}}',
  'err.reportBuilder.unknownField': 'Невідоме поле "{{key}}" для «{{entity}}»',
  'err.reportBuilder.disallowedRelation': "Недозволений зв'язок у полі: {{prefix}}",
  'err.reportBuilder.unknownEnum': 'Невідомий enum: {{enumName}}',
  'err.reportBuilder.disallowedEnumValue': 'Недозволене значення "{{value}}" для {{enumName}}',

  // ── Exception-повідомлення: reports-модуль ──
  'err.report.startAfterEnd': 'Дата початку має бути не пізніше дати закінчення',
  'err.report.warehouseNotFound': 'Склад не знайдено',

  // ── Exception-повідомлення: settings-модуль ──
  'err.settings.currencyNotFound': 'Валюта з кодом "{{code}}" не знайдена',
  'err.settings.workEndAfterStart': 'Час кінця роботи повинен бути після часу початку',
  'err.settings.configNotFound': 'Конфігурацію не знайдено',
  'err.settings.taxRateNotFound': 'Ставку ПДВ не знайдено',
  'err.settings.defaultTaxRateUndeletable': 'Не можна видалити ставку за замовчуванням',
  'err.settings.organisationNotFound': 'Організацію не знайдено',

  // ── Exception-повідомлення: settlements-модуль ──
  'err.settlement.counterpartyNotFound': 'Контрагента не знайдено',
  'err.settlement.accountNotFound': 'Розрахунковий рахунок не знайдено',
  'err.settlement.actPeriodTooLarge':
    'У періоді понад {{limit}} транзакцій — звузьте період акта звірки',
  'err.settlement.reconciliationActNotFound': 'Акт звірки не знайдено',
  'err.settlement.amountMustBePositive': 'Сума транзакції повинна бути більшою за нуль',
  'err.settlement.counterpartyAccountNotFound': 'Розрахунковий рахунок контрагента не знайдено',

  // ── Exception-повідомлення: setup-модуль ──
  'err.setup.alreadyConfiguredReinit':
    'Систему вже налаштовано. Повторна ініціалізація заборонена.',
  'err.setup.alreadyConfigured': 'Систему вже налаштовано',

  // ── Exception-повідомлення: user-preferences-модуль ──
  'err.userPreference.keyEmpty': 'Ключ не може бути порожнім',
  'err.userPreference.keyTooLong': 'Ключ занадто довгий (максимум {{max}} символів)',
  'err.userPreference.keyMismatch': 'Ключ у URL та тілі запиту мають збігатися',

  // ── Exception-повідомлення: vehicles-модуль ──
  'err.vehicle.notFound': 'Автомобіль не знайдено',
  'err.vehicle.garageNotFound': 'Гараж не знайдено',
  'err.vehicle.vinExists': 'Автомобіль з VIN "{{vin}}" вже існує',
  'err.vehicle.deletedNotFound': 'Видалене авто не знайдено',
  'err.vehicle.counterpartyDeletedRestoreFirst':
    'Контрагента авто видалено. Спочатку відновіть контрагента.',
  'err.vehicle.garageDeletedRestoreFirst':
    'Гараж авто видалено. Спочатку відновіть гараж або перемістіть авто.',
  'err.vehicle.hasActiveWorkOrders':
    'Неможливо видалити: автомобіль має активні наряди ({{count}})',
  'err.vehicle.nodeNotFound': 'Вузол не знайдено',

  // ── Exception-повідомлення: inspection-модуль ──
  'err.inspection.reportExists': 'Звіт огляду вже існує для цього наряду',
  'err.inspection.workLinesStatusForbidden':
    'Не можна додавати рядки робіт у наряд цього статусу. Огляд з критичними точками потребує редагованого наряду.',

  // ── Exception-повідомлення: warehouses-модуль ──
  'err.warehouse.notFound': 'Склад не знайдено',
  'err.warehouse.hasStockOrReserve': 'Неможливо видалити: на складі є ненульові залишки або резерв',
  'err.warehouse.onlyOneMain':
    'Лише один склад може бути основним у організації. Спробуйте ще раз.',

  // ── Exception-повідомлення: webhooks-модуль ──
  'err.webhook.notFound': 'Вебхук не знайдено',

  // ── Exception-повідомлення: work-order-templates-модуль ──
  'err.workOrderTemplate.notFound': 'Шаблон не знайдено',

  // ── Exception-повідомлення: works-модуль ──
  'err.work.notFound': 'Роботу не знайдено',
  'err.work.categoryNotFound': 'Категорію не знайдено',
  'err.work.deletedNotFound': 'Видалену роботу не знайдено',

  // ── class-validator generic-констрейнти (err.cv.*) ──
  'err.cv.isNotEmpty': 'Поле "{{field}}" не може бути порожнім',
  'err.cv.isDefined': 'Поле "{{field}}" обов\'язкове',
  'err.cv.isOptional': 'Поле "{{field}}" має невалідне значення',
  'err.cv.isString': 'Поле "{{field}}" має бути рядком',
  'err.cv.minLength': 'Поле "{{field}}" занадто коротке',
  'err.cv.maxLength': 'Поле "{{field}}" занадто довге',
  'err.cv.length': 'Поле "{{field}}" має некоректну довжину',
  'err.cv.matches': 'Поле "{{field}}" має некоректний формат',
  'err.cv.isNumber': 'Поле "{{field}}" має бути числом',
  'err.cv.isInt': 'Поле "{{field}}" має бути цілим числом',
  'err.cv.isPositive': 'Поле "{{field}}" має бути додатнім числом',
  'err.cv.isNegative': 'Поле "{{field}}" має бути від\'ємним числом',
  'err.cv.min': 'Поле "{{field}}" менше за допустимий мінімум',
  'err.cv.max': 'Поле "{{field}}" більше за допустимий максимум',
  'err.cv.isBoolean': 'Поле "{{field}}" має бути логічним (true/false)',
  'err.cv.isBooleanString': 'Поле "{{field}}" має бути "true" або "false"',
  'err.cv.isUuid': 'Поле "{{field}}" має бути UUID',
  'err.cv.isEmail': 'Поле "{{field}}" має бути email-адресою',
  'err.cv.isUrl': 'Поле "{{field}}" має бути URL',
  'err.cv.isIso8601': 'Поле "{{field}}" має бути датою у форматі ISO 8601 (YYYY-MM-DD)',
  'err.cv.isDateString': 'Поле "{{field}}" має бути коректною датою',
  'err.cv.isPhoneNumber': 'Поле "{{field}}" має бути номером телефону',
  'err.cv.isJson': 'Поле "{{field}}" має бути валідним JSON',
  'err.cv.isEnum': 'Поле "{{field}}" має одне з допустимих значень',
  'err.cv.isArray': 'Поле "{{field}}" має бути масивом',
  'err.cv.arrayMinSize': 'Масив "{{field}}" містить замало елементів',
  'err.cv.arrayMaxSize': 'Масив "{{field}}" містить забагато елементів',
  'err.cv.arrayUnique': 'Масив "{{field}}" має містити унікальні елементи',
  'err.cv.nestedValidation': 'Вкладене поле "{{field}}" має некоректні значення',
  'err.cv.whitelistValidation': 'Поле "{{field}}" недозволене',

  // ── DTO inline @IsX({message}) оверрайди (err.dto.*) ──
  'err.dto.auth.email.invalid': 'Невірний формат email',
  'err.dto.auth.password.notEmpty': 'Пароль не може бути порожнім',
  'err.dto.auth.password.tooShort': 'Пароль занадто короткий',
  'err.dto.bankAccount.iban.format':
    'Невірний формат IBAN. Має починатись з UA та містити 29 символів',
  'err.dto.booking.services.max': 'Не більше 50 послуг',
  'err.dto.booking.phone.format': 'Телефон має бути у форматі +380XXXXXXXXX',
  'err.dto.brand.synonyms.max': 'Не більше 20 синонімів',
  'err.dto.counterpartyStatus.color.hex': 'Колір має бути у форматі HEX (#rrggbb)',
  'err.dto.goodStatus.color.hex': 'Колір має бути у форматі HEX (#rrggbb)',
  'err.dto.good.categories.max': 'Не більше 100 категорій у фільтрі',
  'err.dto.inspection.points.max': 'Не більше 50 точок огляду',
  'err.dto.pricingRule.tiers.max': 'Не більше 50 рівнів у правилі ціноутворення',
  'err.dto.purchaseOrder.lines.max': 'Не більше 500 рядків у покупковому ордері',
  'err.dto.purchaseOrder.receiveLines.max': 'Не більше 500 рядків у частковому прийнятті',
  'err.dto.reportBuilder.groupBy.max': 'Не більше 5 рівнів групування',
  'err.dto.search.query.min': 'Запит має містити мінімум 2 символи',
  'err.dto.settings.currencyCode.max': 'Код валюти не може перевищувати 10 символів',
  'err.dto.settings.time.format': 'Формат “ГГ:ХХ” (00:00–23:59)',
  'err.dto.settings.workingDays.max': 'Не більше 7 робочих днів',
  'err.dto.setup.email.invalid': 'Невірний формат email',
  'err.dto.setup.password.notEmpty': 'Пароль не може бути порожнім',
  'err.dto.setup.password.min': 'Пароль має бути не менше 8 символів',
  'err.dto.setup.password.max': 'Пароль занадто довгий (максимум 128 символів)',
  'err.dto.stockDocument.lines.max': 'Не більше 500 рядків у документі обліку',
  'err.dto.supplierPayment.amount.min': 'Сума оплати повинна бути більшою за нуль',
  'err.dto.supplierPayment.from.dateValid': 'from має бути валідною датою',
  'err.dto.supplierPayment.from.dateFormat': 'from має бути у форматі YYYY-MM-DD',
  'err.dto.supplierPayment.to.dateValid': 'to має бути валідною датою',
  'err.dto.supplierPayment.to.dateFormat': 'to має бути у форматі YYYY-MM-DD',
  'err.dto.supplierPayment.date.dateValid': 'date має бути валідною датою',
  'err.dto.supplierPayment.date.dateFormat': 'date має бути у форматі YYYY-MM-DD',
  'err.dto.supplierPayment.target.in': 'target має бути overdue або planned',
  'err.dto.supplierReturn.lines.max': 'Не більше 500 рядків у поверненні',
  'err.dto.userPreference.key.notEmpty': 'Ключ не може бути порожнім',
  'err.dto.userPreference.value.object': "Значення має бути об'єктом",
  'err.dto.workOrderTemplate.workLines.max': 'Не більше 200 рядків робіт у шаблоні',
  'err.dto.workOrderTemplate.parts.max': 'Не більше 200 запчастин у шаблоні',
  'err.dto.work.categories.max': 'Не більше 100 категорій у фільтрі',
  'err.dto.xlsx.rows.max': 'Не більше 1000 рядків за один імпорт',
  'err.dto.employee.loginEmail.invalid': 'Невірний формат email для логіну',
  'err.dto.employee.password.min': 'Пароль має бути не менше 6 символів',
  'err.dto.employee.password.max': 'Пароль занадто довгий (максимум 128 символів)',
  'err.dto.employee.branches.max': 'Максимум 50 філій на співробітника',
  'err.dto.employee.zones.max': 'Максимум 30 зон на співробітника',
  'err.dto.employee.lifts.max': 'Максимум 30 підйомників на співробітника',
  'err.dto.employee.categories.max': 'Максимум 50 категорій робіт на співробітника',
  'err.dto.service.works.max': 'Не більше 100 робіт у послузі',
  'err.dto.service.goods.max': 'Не більше 100 запчастин у послузі',
};
