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

  // ── Exception messages: invoices module ──
  'err.invoice.notFound': 'Invoice not found',
  'err.invoice.workOrderNotFound': 'Work order not found',
  'err.invoice.onlyCompletedInvoiceable':
    'An invoice can only be issued for a completed work order',
  'err.invoice.activeExists': 'An active invoice already exists for this work order',
  'err.invoice.counterpartyNotFound': 'Counterparty not found',
  'err.invoice.onlyDraftEditable': 'Only a draft can be edited',
  'err.invoice.statusChanged': 'The invoice status has changed — repeat the action',
  'err.invoice.counterpartyDeletedNoClone':
    'The counterparty was deleted — cloning is not possible',
  'err.invoice.linesOnlyDraftAdd': 'Lines can only be added to a draft',
  'err.invoice.partNotFound': 'Part not found',
  'err.invoice.workNotFound': 'Work not found',
  'err.invoice.unitNotFoundForGood': 'Unit of measure not found for this good',
  'err.invoice.linesOnlyDraftEdit': 'Lines can only be edited in a draft',
  'err.invoice.lineNotFound': 'Line not found',
  'err.invoice.linesOnlyDraftRemove': 'Lines can only be removed from a draft',
  'err.invoice.activeNotFound': 'Active invoice not found',
  'err.invoice.onlyDraftRefresh':
    'Only an invoice draft can be updated. Cancel the current one and issue a new invoice.',
  'err.invoice.onlyDraftDeletable': 'Only a draft can be deleted',
  'err.invoice.concurrentIssueConflict':
    'Another user has just issued an invoice for this work order. Refresh the page.',
  'err.invoice.concurrentRefreshConflict':
    'Another user has just updated this invoice. Refresh the page and try again.',

  // ── Exception messages: payments module ──
  'err.payment.counterpartyNotFound': 'Counterparty not found',
  'err.payment.notFound': 'Payment not found',
  'err.payment.receiptAlreadyIssued': 'The receipt has already been issued — a retry is not needed',
  'err.payment.retryOnlyFailed': 'Retry is possible only for receipts in the “Error” status',
  'err.payment.workOrderStatusNoPayment':
    'Work order is in "{{status}}" status — payment is not possible',
  'err.payment.fiscalOnlyBaseCurrency':
    'Fiscalization is possible only in the base currency ({{code}}). Choose a cash register/account in {{code}} or a payment method without a fiscal registrar.',
  'err.payment.currencyMustMatchWorkOrder':
    'The payment currency must match the work order currency',
  'err.payment.invoiceStatusNoPayment':
    'Invoice is in "{{status}}" status — payment is not possible',
  'err.payment.invoiceNotForWorkOrder': 'The invoice does not belong to the specified work order',
  'err.payment.currencyMustMatchInvoice': 'The payment currency must match the invoice currency',
  'err.payment.amountExceedsInvoiceRemaining':
    'The amount exceeds the invoice balance ({{remaining}})',
  'err.payment.invoiceConcurrentChange':
    'The invoice was changed by a concurrent operation — try again',
  'err.payment.bankAccountNotSpecified': 'No bank account specified',
  'err.payment.bankAccountNotFound': 'Bank account not found',
  'err.payment.cashRegisterNotSpecified': 'No cash register specified',
  'err.payment.cashRegisterNotFound': 'Cash register not found',
  // cash-shift
  'err.cashShift.fiscalNotConfigured':
    'Fiscalization is not configured (provider/credentials/enablement)',
  'err.cashShift.unknownProvider': 'Unknown fiscal registrar provider: {{provider}}',
  'err.cashShift.noCashRegisterForBranch': 'There is no cash register for this branch',
  'err.cashShift.alreadyOpen': 'The shift is already open',
  'err.cashShift.notFound': 'Shift not found',
  'err.cashShift.alreadyClosed': 'The shift is already closed',
  'err.cashShift.fiscalNotConfiguredToken':
    'Fiscalization is not configured — the token cannot be refreshed',
  // fiscal / gateway / provider-config controllers + online-payment
  'err.fiscalProvider.invalidCode': 'Invalid provider code',
  'err.fiscalProvider.unknown': 'Unknown fiscal registrar provider: {{code}}',
  'err.paymentGateway.invalidCode': 'Invalid gateway code',
  'err.paymentGateway.unknown': 'Unknown payment gateway: {{code}}',
  'err.onlinePayment.invoiceNotFound': 'Invoice not found',
  'err.onlinePayment.invoiceStatusNoPayment':
    'Invoice is in "{{status}}" status — payment is not possible',
  'err.onlinePayment.noRemaining': 'There is no balance to pay',
  'err.onlinePayment.amountExceedsRemaining': 'The amount exceeds the balance ({{remaining}} UAH)',
  'err.onlinePayment.acquiringNotConfigured': 'Online payment (acquiring) is not configured',
  'err.onlinePayment.unknownGateway': 'Unknown payment gateway: {{provider}}',
  'err.onlinePayment.gatewayCreateFailed': '{{name}}: failed to create an invoice — {{error}}',
  'err.onlinePayment.intentNotFound': 'Payment intent not found',
  'err.providerConfig.invalidCode': 'Invalid provider code',
  'err.providerConfig.notConfiguredForBranch': 'The provider is not configured for this branch',
  'err.providerConfig.enterCredentialsFirst': 'Enter the provider credentials first',
  'err.providerConfig.branchNotFound': 'Branch not found',

  // ── Exception messages: supplier-payments module ──
  'err.supplierPayment.dateXorTarget': 'You must specify exactly one: date OR target',
  'err.supplierPayment.supplierNotFound': 'Supplier not found',
  'err.supplierPayment.fromDateAfterTo': 'The "from" date cannot be later than the "to" date',
  'err.supplierPayment.windowExceedsLimit': 'The schedule window cannot exceed 100 days',
  'err.supplierPayment.notFound': 'Payment not found',
  'err.supplierPayment.notASupplier': 'The counterparty is not a supplier',
  'err.supplierPayment.bankAccountNotFound': 'Bank account not found',
  'err.supplierPayment.cashRegisterNotFound': 'Cash register not found',
  'err.supplierPayment.purchaseOrderNotFound': 'Purchase order not found',
  'err.supplierPayment.orderNotForSupplier': 'The order does not belong to the specified supplier',
  'err.supplierPayment.sourceHasNoCurrency': 'The source account has no currency',
  'err.supplierPayment.onlyDraftEditable': 'Editing is allowed only in the "Draft" status',
  'err.supplierPayment.currencyMustMatchOrder':
    'The payment currency must match the order currency',
  'err.supplierPayment.cannotConfirmFromStatus':
    'Cannot confirm the payment from the "{{status}}" status',
  'err.supplierPayment.alreadyConfirmedOrChanged':
    'The payment has already been confirmed or the status changed — refresh the page',
  'err.supplierPayment.orderConcurrentChange':
    'The order was changed by a concurrent operation — try again',
  'err.supplierPayment.cannotCancelFromStatus':
    'Cannot cancel the payment from the "{{status}}" status',
  'err.supplierPayment.confirmedNotDeletable': 'A confirmed payment cannot be deleted',
  'err.supplierPayment.bankRequiresAccount': 'For a bank payment you must specify a bank account',
  'err.supplierPayment.sourceConflict':
    'You cannot specify both a bank account and a cash register',
  'err.supplierPayment.cashRequiresRegister': 'For a cash payment you must specify a cash register',

  // ── Exception messages: purchase-orders module ──
  'err.deliveryProvider.invalidCode': 'Invalid service code',
  'err.deliveryProvider.unknown': 'Unknown delivery service: {{code}}',
  'err.purchaseOrder.goodNotFound': 'Good not found: {{missing}}',
  'err.purchaseOrder.notFound': 'Order not found',
  'err.purchaseOrder.supplierNotFound': 'Supplier not found',
  'err.purchaseOrder.warehouseNotFound': 'Warehouse not found',
  'err.purchaseOrder.contractNotFound': 'Contract not found',
  'err.purchaseOrder.onlyDraftEditable': 'Only a draft can be edited',
  'err.purchaseOrder.receiveOnlyOrderedOrPartial':
    'Receiving is possible only for orders with ORDERED or PARTIAL status',
  'err.purchaseOrder.unitNotFoundInOrg': 'Unit of measure not found within the organization',
  'err.purchaseOrder.receiveLineMustBeUnique': 'Each receipt line must be unique',
  'err.purchaseOrder.receiveExceedsLineRemaining':
    'The received quantity exceeds the line balance (ordered {{quantity}}, ' +
    'already received {{received}}, to receive {{remaining}})',
  'err.purchaseOrder.statusChangedRetry':
    'The order status changed to "{{status}}" — repeat the receipt',
  'err.purchaseOrder.receiveAlreadyProcessed':
    'The receipt has already been processed or the line was changed by another operation — try again',
  'err.purchaseOrder.onlyDraftDeletable': 'Only a draft can be deleted',
  'err.purchaseOrder.priceOnlyReceived':
    'Only received goods can be priced (RECEIVED or PARTIAL status)',

  // ── Exception messages: supplier-returns module ──
  'err.supplierReturn.notFound': 'Return not found',
  'err.supplierReturn.supplierNotFound': 'Supplier not found',
  'err.supplierReturn.warehouseNotFound': 'Warehouse not found',
  'err.supplierReturn.orderNotFound': 'Order not found',
  'err.supplierReturn.onlyDraftEditable': 'Editing is allowed only in the "Draft" status',
  'err.supplierReturn.cannotConfirmFromStatus':
    'Cannot confirm the return from the "{{status}}" status',
  'err.supplierReturn.confirmRequiresLines': 'A return cannot be confirmed without lines',
  'err.supplierReturn.alreadyConfirmedOrChanged':
    'The return has already been confirmed or the status changed — refresh the page',
  'err.supplierReturn.cannotCancelFromStatus':
    'Cannot cancel the return from the "{{status}}" status',
  'err.supplierReturn.onlyDraftDeletable': 'Only a return with the "Draft" status can be deleted',
  'err.supplierReturn.goodNotFound': 'Good not found: {{missing}}',
  'err.supplierReturn.unitNotFound': 'Unit of measure not found: {{missing}}',

  // ── Exception messages: stock-documents module ──
  'err.stockDocument.notFound': 'Document not found',
  'err.stockDocument.goodNotFound': 'Good not found: {{missing}}',
  'err.stockDocument.branchNotFound': 'Branch not found',
  'err.stockDocument.warehouseNotFound': 'Warehouse not found',
  'err.stockDocument.orderNotFound': 'Order not found',
  'err.stockDocument.transferTargetRequired': 'A destination warehouse is required for a transfer',
  'err.stockDocument.targetWarehouseNotFound': 'Destination warehouse not found',
  'err.stockDocument.sourceTargetSame': 'The source and destination warehouses cannot be the same',
  'err.stockDocument.onlyDraftEditable': 'Only a draft can be edited',
  'err.stockDocument.confirmRequiresLines': 'A document cannot be confirmed without items',
  'err.stockDocument.statusChanged': 'The document status has changed — repeat the action',
  'err.stockDocument.unsupportedType': 'Unsupported document type: {{type}}',
  'err.stockDocument.onlyDraftDeletable': 'Only a draft can be deleted',

  // ── Exception messages: goods module ──
  'err.good.maxBulkGoods': 'Maximum 100 goods at a time',
  'err.good.invalidGoodId': 'Invalid goodId: {{invalid}}',
  'err.good.notFound': 'Good not found',
  'err.good.statusNotFound': 'Status not found',
  'err.good.statusNotAssigned': 'The status is not assigned to this good',
  'err.good.skuExists': 'A good with the SKU "{{sku}}" already exists',
  'err.good.hasStockOrReserve': 'Cannot delete: the good has non-zero stock or reservation',
  'err.good.deletedNotFound': 'Deleted good not found',
  'err.good.restoreSkuExists':
    'Cannot restore: an active good with the SKU "{{sku}}" already exists',
  'err.good.restoreCodeExists':
    'Cannot restore: an active good with the code "{{code}}" already exists',
  'err.good.brandNotFound': 'Brand not found',
  'err.good.unitNotFound': 'Unit of measure not found',
  'err.good.supplierNotFound': 'Supplier not found',
  'err.good.categoryNotFound': 'Goods category not found',
  'err.good.barcodeEmpty': 'The barcode cannot be empty',
  'err.good.barcodeInUse': 'The barcode is already in use',
  'err.good.barcodeNotFound': 'Barcode not found',
  'err.good.uomAlreadyAdded': 'This unit of measure has already been added to the good',
  'err.good.uomRecordNotFound': 'Unit of measure record not found',
  'err.good.cannotDeleteOnlyUom': 'You cannot delete the only unit of measure',
  'err.good.goodUomNotFound': 'The good’s unit of measure not found',

  // ── Exception messages: inventory module ──
  'err.inventory.goodNotFound': 'Good not found',
  'err.inventory.batchConcurrentChange':
    'The batch was changed by another transaction — repeat the operation',
  'err.inventory.insufficientBatches':
    'Insufficient batches for write-off: {{remaining}} units of the good are missing',
  'err.inventory.batchNotFound': 'Batch not found',
  'err.inventory.returnExceedsBatchReceived': 'The return exceeds the received batch quantity',
  'err.inventory.quantityZero': 'The quantity cannot be zero',
  'err.inventory.invalidQuantity': 'Invalid quantity value',
  'err.inventory.invalidPrice': 'Invalid price value',
  'err.inventory.reservationReleaseNegative': 'Reservation release: the quantity must be negative',
  'err.inventory.returnMustBePositive': 'Return to stock: the quantity must be positive',
  'err.inventory.returnRequiresSourceDoc': 'Return to stock requires a source document',
  'err.inventory.unitNotFoundInOrg': 'Unit of measure not found within the organization',
  'err.inventory.insufficientStock': 'Insufficient goods in stock',
  'err.inventory.insufficientAvailableForReservation':
    'Insufficient available goods for reservation',
  'err.inventory.cannotReleaseMoreThanReserved':
    'Cannot release the reservation: the reserved quantity is less than requested',
  'err.inventory.insufficientStockConcurrentWriteoff':
    'Insufficient goods in stock (concurrent WRITEOFF)',
  'err.inventory.reservedNegativeConcurrentRelease':
    'The reservation cannot become negative (concurrent RESERVATION_RELEASE)',
  'err.inventory.insufficientAvailableConcurrentReservation':
    'Insufficient available goods for reservation (concurrent RESERVATION)',
  'err.inventory.writeoffBelowReserved':
    'The write-off would drop the balance below the reserved amount — release the reservation first',
  'err.inventory.stockItemNotFound': 'Stock item not found',
  'err.inventory.unknownMovementType': 'Unknown movement type',
  'err.pricingRule.goodNotFound': 'Good not found',
  'err.pricingRule.brandNotFound': 'Brand not found',
  'err.pricingRule.supplierNotFound': 'Supplier not found',
  'err.pricingRule.notFound': 'Rule not found',
};
