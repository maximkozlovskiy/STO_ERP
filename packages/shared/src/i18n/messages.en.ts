// English values for validation keys. Key set MUST match messages.uk.ts 1:1 (key-parity checked).
// Professional English translations; range messages inline the same literal numbers as uk.

export const en: Record<string, string> = {
  // ── Infra keys (used by ZodValidationPipe.formatIssue) ──
  'v.fieldSuffix': '(field "{{path}}")',
  'v.validationFailed': 'Validation failed',
  'v.invalid': 'Invalid value',

  // ── validators.ts (shared helpers) ──
  'v.phone': 'Invalid phone format (+380XXXXXXXXX)',
  'v.email': 'Invalid email format',
  'v.iban': 'Invalid IBAN format (UA + 27 digits)',
  'v.uuid': 'Invalid UUID format',
  'v.positive': 'Value must be greater than zero',
  'v.nonNeg': 'Value cannot be negative',
  'v.dateFormat': 'Invalid date format',

  // ── counterparty.schema.ts ──
  'v.counterparty.type.required': 'Select the counterparty type',
  'v.counterparty.email.invalid': 'Invalid email format',
  'v.counterparty.name.supplier': "Enter the supplier's company name",
  'v.counterparty.name.any': "Enter the company name or the counterparty's first/last name",

  // ── good.schema.ts ──
  'v.good.name.required': 'Enter the product name',
  'v.good.name.max': 'Name is too long',

  // ── employee.schema.ts ──
  'v.employee.firstName.required': 'Enter the first name',
  'v.employee.firstName.max': 'First name is too long',
  'v.employee.lastName.required': 'Enter the last name',
  'v.employee.lastName.max': 'Last name is too long',
  'v.employee.role.required': 'Select the position',
  'v.employee.percent.range': 'Percent must be from 1 to 100',
  'v.employee.ratePerHour.nonNeg': 'Rate per standard hour must be a non-negative number',
  'v.employee.fixedMonthly.nonNeg': 'Fixed rate must be a non-negative number',
  'v.employee.bonusPercent.range': 'Bonus must be from 0 to 100',
  'v.employee.loginEmail.required': 'Enter the login email',
  'v.employee.password.required': 'Enter the password',
  'v.employee.password.min': 'Password must be at least 6 characters',
  'v.employee.loginEmail.invalid': 'Invalid login email format',

  // ── vehicle.schema.ts ──
  'v.vehicle.year.int': 'Must be an integer',
  'v.vehicle.year.min': 'Year cannot be earlier than 1900',
  'v.vehicle.year.max': 'Year is in the future',
  'v.vehicle.nonNegInt': 'Cannot be negative',
  'v.vehicle.nonNegFloat': 'Cannot be negative',
  'v.vehicle.make.required': 'Enter the make',
  'v.vehicle.make.max': 'Too long',
  'v.vehicle.model.required': 'Enter the model',
  'v.vehicle.model.max': 'Too long',
  'v.vehicle.customerGarage.required': "Select the customer's garage",

  // ── invoice.schema.ts ──
  'v.invoice.line.description.required': 'Enter the line description',
  'v.invoice.line.description.max': 'Description is too long',
  'v.invoice.line.quantity.min': 'Quantity must be greater than zero',
  'v.invoice.line.unitPrice.nonNeg': 'Price cannot be negative',
  'v.invoice.line.vatRate.nonNeg': 'VAT cannot be negative',
  'v.invoice.line.vatRate.max': 'VAT cannot exceed 100%',
  'v.invoice.counterparty.required': 'Select the counterparty',
  'v.invoice.amount.min': 'Amount must be greater than 0.01',

  // ── purchase-order.schema.ts ──
  'v.purchaseOrder.line.good.required': 'Select the product',
  'v.purchaseOrder.line.quantity.min': 'Quantity must be greater than zero',
  'v.purchaseOrder.line.price.nonNeg': 'Price cannot be negative',
  'v.purchaseOrder.trackingNumber.max': 'Tracking number cannot exceed 64 characters',
  'v.purchaseOrder.supplier.required': 'Select the supplier',
  'v.purchaseOrder.warehouse.required': 'Select the warehouse',
  'v.purchaseOrder.uuid.invalid': 'Invalid UUID format',

  // ── stock-document.schema.ts ──
  'v.stockDocument.line.good.required': 'Select the product',
  'v.stockDocument.line.quantity.min': 'Quantity must be greater than zero',
  'v.stockDocument.type.required': 'Select the document type',
  'v.stockDocument.branch.required': 'Select the branch',
  'v.stockDocument.warehouse.required': 'Select the warehouse',
  'v.stockDocument.transfer.targetRequired': 'Select the destination warehouse for the transfer',
  'v.stockDocument.transfer.targetSame': 'Source and destination warehouses cannot be the same',

  // ── supplier-return.schema.ts ──
  'v.supplierReturn.line.good.required': 'Select the product',
  'v.supplierReturn.line.quantity.min': 'Quantity must be greater than zero',
  'v.supplierReturn.line.price.nonNeg': 'Price cannot be negative',
  'v.supplierReturn.supplier.required': 'Select the supplier',
  'v.supplierReturn.warehouse.required': 'Select the warehouse',

  // ── supplier-payment.schema.ts ──
  'v.supplierPayment.supplier.required': 'Select the supplier',
  'v.supplierPayment.sourceType.required': 'Select the source of funds',
  'v.supplierPayment.amount.min': 'Payment amount must be greater than zero',
  'v.supplierPayment.method.required': 'Select the payment method',
  'v.supplierPayment.bank.required': 'For a bank payment specify the account',
  'v.supplierPayment.cash.required': 'For a cash payment specify the cash register',
  'v.supplierPayment.source.conflict': 'Cannot specify both a bank and a cash register',

  // ── work-order.schema.ts ──
  'v.workOrder.nonNegInt.int': 'Value must be an integer',
  'v.workOrder.nonNegInt.min': 'Value cannot be negative',
  'v.workOrder.branch.required': 'Select the branch',
  'v.workOrder.vehicle.required': 'Select the vehicle',
  'v.workOrder.counterparty.required': 'Select the counterparty',
  'v.workOrder.dateFormat': 'Invalid date format',
  'v.workOrder.uuid.invalid': 'Invalid UUID format',
  'v.workOrder.hours.nonNeg': 'Value cannot be negative',
  'v.workOrder.line.work.required': 'Select the work',
  'v.workOrder.line.employee.required': 'Select the performer',
  'v.workOrder.line.normoHours.min': 'Standard hours must be greater than zero',
  'v.workOrder.part.good.required': 'Select the product',
  'v.workOrder.part.warehouse.required': 'Select the warehouse',
  'v.workOrder.part.quantity.min': 'Quantity must be greater than zero',

  // ── Exception messages: http-exception.filter own strings (Prisma/fallback/Fastify) ──
  'err.internal': 'Internal server error',
  'err.badRequest': 'Invalid request data',
  'err.fastifyBadRequest': 'Malformed request: check the body and Content-Type',
  'err.prisma.unique': 'A record with this value already exists ({{fields}})',
  'err.prisma.foreignKey': 'Foreign key violation: the related record was not found',
  'err.prisma.notFound': 'Record not found',
  'err.prisma.badId': 'Invalid identifier format',
  'err.prisma.tooLong': 'Value is too long for the field',
  'err.prisma.nullConstraint': 'A required field cannot be empty',

  // ── Exception messages: currencies module ──
  'err.currency.notFound': 'Currency not found',
  'err.currency.codeExists': 'A currency with code "{{code}}" already exists',
  'err.currency.systemImmutable': 'A system currency cannot be renamed or have its code changed',
  'err.currency.systemUndeletable': 'A system currency cannot be deleted',

  // ── Exception messages: bank-accounts module ──
  'err.bankAccount.notFound': 'Bank account not found',
  'err.branch.notFound': 'Branch not found',

  // ── Exception messages: exchange-rates module ──
  'err.exchangeRate.notFound': 'Exchange rate not found',
  'err.exchangeRate.dateExists': 'A rate for this date already exists',
  'err.exchangeRate.baseCurrencyNotConfigured':
    'The base currency ({{code}}) is not configured — create it in Reference → Currencies',
  'err.exchangeRate.noRateForDate':
    'No exchange rate for currency {{code}} on {{date}} — add a rate in Reference → Exchange rates',

  // ── Exception messages: good-categories module ──
  'err.goodCategory.notFound': 'Product category not found',
  'err.goodCategory.parentNotFound': 'Parent category not found',
  'err.goodCategory.systemImmutable': 'A system category cannot be renamed or moved',
  'err.goodCategory.ownParent': 'A category cannot be its own parent',
  'err.goodCategory.systemUndeletable': 'A system category cannot be deleted',
  'err.goodCategory.moveIntoDescendant':
    'A category cannot be moved into its own subcategory (this would create a cycle)',

  // ── Exception messages: work-categories module ──
  'err.workCategory.notFound': 'Category not found',
  'err.workCategory.parentNotFound': 'Parent category not found',
  'err.workCategory.systemImmutable': 'A system category cannot be renamed or moved',
  'err.workCategory.systemUndeletable': 'A system category cannot be deleted',

  // ── Exception messages: units module ──
  'err.unit.deletedNotFound': 'Deleted unit of measure not found',
  'err.unit.systemUnrestorable': 'A system unit of measure cannot be restored',
  'err.unit.notFound': 'Unit of measure not found',
  'err.unit.shortNameExists': 'A unit with this short name already exists',
  'err.unit.systemUndeletable': 'A system unit of measure cannot be deleted',
  'err.unit.activeShortNameExists':
    'An active unit with this short name already exists — restoration is not possible',
  'err.unit.shortNameInArchive':
    'A unit with this short name exists in the archive. First restore it or choose a different short name.',

  // ── Exception messages: zones module ──
  'err.zone.notFound': 'Zone not found',
  'err.lift.notFound': 'Lift not found',
  'err.zone.hasActiveLifts': 'Cannot delete: the zone has active lifts. First delete or move them',

  // ── Exception messages: services module ──
  'err.service.notFound': 'Service not found',
  'err.service.deletedNotFound': 'Deleted service not found',
  'err.service.worksNotFound': 'One or more works not found',
  'err.service.goodsNotFound': 'One or more products not found',

  // ── Exception messages: loyalty module ──
  'err.loyalty.counterpartyNotFound': 'Counterparty not found',
  'err.loyalty.pointsPositive': 'The number of points must be > 0',
  'err.loyalty.accountNotFound': 'Loyalty account not found',
  'err.loyalty.insufficientPoints': 'Insufficient points',

  // ── Exception messages: cash-registers module ──
  'err.cashRegister.notFound': 'Cash register not found',
  'err.cashRegister.prroOnlyFiscal':
    'A PRRO provider can be linked only to a fiscal cash register (enable "Fiscal cash register")',
  'err.cashRegister.prroNotConfigured':
    'The PRRO provider is not configured for this branch — first enter its credentials in Settings',

  // ── Exception messages: warranties module ──
  'err.warranty.notFound': 'Warranty not found',
  'err.warranty.workOrderNotFound': 'Work order not found',
  'err.warranty.counterpartyNotFound': 'Counterparty not found',
  'err.warranty.lineNotFound': 'Work order line not found',
  'err.warranty.partNotFound': 'Work order part not found',
  'err.warranty.endDateFuture': 'The warranty end date must be in the future',
  'err.warranty.alreadyClaimed': 'The warranty has already been claimed',
  'err.warranty.expired': 'The warranty has expired',
  'err.warranty.claimWorkOrderNotFound': 'Warranty work order not found',

  // ── Exception messages: completion-acts module ──
  'err.completionAct.notFound': 'Act not found',
  'err.completionAct.workOrderNotFound': 'Work order not found',
  'err.completionAct.workOrderNotCompleted':
    'An act can be created only for a completed work order',
  'err.completionAct.activeExists': 'An active act already exists for this work order',
  'err.completionAct.onlyDraftSignable': 'Only a draft act can be signed',
  'err.completionAct.statusChanged': 'The act status has changed — repeat the action',
  'err.completionAct.signedNotCancelable': 'A signed act cannot be cancelled',

  // ── Exception messages: files module ──
  'err.file.multipartExpected': 'multipart/form-data is expected',
  'err.file.notReceived': 'File not received',
  'err.file.onlyImages': 'Only images are allowed',
  'err.file.tooLarge': 'The file is too large (maximum 10 MB)',
  'err.file.serviceUnavailable': 'The file service is unavailable',
  'err.file.disallowedFormat': 'Disallowed file format',
  'err.file.workOrderNotFound': 'Work order not found',
  'err.file.saveFailed': 'File save error',

  // ── Exception messages: work-order-media module ──
  'err.workOrderMedia.multipartExpected': 'multipart/form-data is expected',
  'err.workOrderMedia.tooLarge': 'The file is too large (maximum 10 MB)',
  'err.workOrderMedia.notReceived': 'File not received',
  'err.workOrderMedia.disallowedFormat': 'Allowed formats: JPEG, PNG, HEIC, HEIF, PDF',
  'err.workOrderMedia.disallowedExtension': 'Disallowed file extension',
  'err.workOrderMedia.workOrderNotFound': 'Work order not found',
  'err.workOrderMedia.notFound': 'Media not found',

  // ── Exception messages: expense-categories module ──
  'err.expenseCategory.notFound': 'Expense category not found',
  'err.expenseCategory.deletedNotFound': 'Deleted expense category not found',
  'err.expenseCategory.parentNotFound': 'Parent category not found',
  'err.expenseCategory.typeMismatchParent': 'The category type must match the parent category type',
  'err.expenseCategory.maxDepth': 'Maximum category nesting depth reached',
  'err.expenseCategory.nameExists': 'A category with this name already exists',
  'err.expenseCategory.activeNameExists':
    'An active category with this name already exists — restoration is not possible',
  'err.expenseCategory.ownParent': 'A category cannot be its own parent',
  'err.expenseCategory.parentTypeMismatch': 'The parent category must be of the same type',
  'err.expenseCategory.moveIntoDescendant': 'A category cannot be moved into its own descendant',
};
