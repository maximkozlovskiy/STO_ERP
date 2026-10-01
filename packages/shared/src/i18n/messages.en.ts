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
  'v.warranty.expiresAt.required': 'Enter the warranty expiry date',
  'v.warranty.expiresAt.format': 'Invalid date format',

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

  // ── Exception messages: work-orders module ──
  'err.workOrder.notFound': 'Work order not found',
  'err.workOrder.generateTokenFailed': 'Failed to generate token — please try again',
  'err.workOrder.shareLinkInvalid': 'The link is invalid or has expired',
  'err.workOrder.customerPhoneMissing': "Customer's phone number is not provided",
  'err.workOrder.shareOnlyDraftEstimateApproved':
    'The estimate can be shared only in draft / estimate / approved status',
  'err.workOrder.publicUrlNotConfigured':
    'Public URL is not configured (WEB_PUBLIC_URL) — contact the administrator',
  'err.workOrder.totalZeroCannotComplete':
    'The work order total is zero — completion is not possible',
  'err.workOrder.vehicleNotFound': 'Vehicle not found',
  'err.workOrder.counterpartyNotFound': 'Counterparty not found',
  'err.workOrder.contractNotFound': 'Contract not found',
  'err.workOrder.cannotEditClosed': 'A closed work order cannot be edited',
  'err.workOrder.outMileageLessThanIn': 'Outgoing mileage cannot be less than the incoming one',
  'err.workOrder.onlyDraftOrCancelledDeletable':
    'Only a work order in Draft or Cancelled status can be deleted',
  'err.workOrder.vehicleDeletedNoClone': 'The vehicle was deleted — cloning is not possible',
  'err.workOrder.counterpartyDeletedNoClone':
    'The counterparty was deleted — cloning is not possible',
  'err.workOrder.branchDeletedNoClone': 'The branch was deleted — cloning is not possible',
  'err.workOrder.statusChanged': 'The work order status has changed — please retry',
  'err.workOrder.cannotEditLinesInStatus':
    'Work order line items cannot be edited in the current status',
  'err.workOrder.workNotFound': 'Work not found',
  'err.workOrder.employeeNotFound': 'Employee not found',
  'err.workOrder.lineNotFound': 'Line item not found',
  'err.workOrder.warehouseNotFound': 'Warehouse not found',
  'err.workOrder.unitNotConfiguredForGood':
    'The unit of measure is not configured for this good. Set it up in the catalog (Goods → Units of measure) or select the base one.',

  // ── Exception messages: calendar module ──
  'err.calendar.invalidDateFormatExpected': 'Invalid date format. Expected YYYY-MM-DD',
  'err.calendar.endBeforeStart': 'The end time must be after the start time',
  'err.calendar.employeeNotFound': 'Employee not found',
  'err.calendar.workOrderNotFound': 'Work order not found',
  'err.calendar.clientNotFound': 'Client not found',
  'err.calendar.vehicleNotFound': 'Vehicle not found',
  'err.calendar.liftBusy': 'The lift is already busy at this time',
  'err.calendar.employeeBusy': 'The employee is already busy at this time',
  'err.calendar.liftBusyNextDay': 'The lift is already busy on the next day',
  'err.calendar.employeeBusyNextDay': 'The employee is already busy on the next day',
  'err.calendar.slotSplitTwoDays': 'The slot spans 2 days — edit each one separately',
  'err.calendar.slotNotFound': 'Slot not found',
  'err.calendar.invalidTimeInterval': 'Invalid time interval',
  'err.calendar.invalidDateFormat': 'Invalid date format',

  // ── Exception messages: xlsx module ──
  'err.xlsx.purchaseOrderNotDraft': 'The purchase order is not in DRAFT status',
  'err.xlsx.stockDocumentNotDraft': 'The stock document is not in DRAFT status',
  'err.xlsx.unknownTemplateType': 'Unknown template type',
  'err.xlsx.unknownDocumentType': 'Unknown document type',
  'err.xlsx.invalidDocumentId': 'Invalid document identifier',
  'err.xlsx.fileNotUploaded': 'File not uploaded',
  'err.xlsx.sheetGoodsNotFound': 'Sheet "Товари" not found',
  'err.xlsx.tableNoDataRows': 'The table contains no data rows',
  'err.xlsx.sheetWorksNotFound': 'Sheet "Роботи" not found',
  'err.xlsx.sheetBrandsNotFound': 'Sheet "Бренди" not found',
  'err.xlsx.sheetUnitsNotFound': 'Sheet "Одиниці" not found',
  'err.xlsx.purchaseOrderNotFound': 'Purchase order not found',
  'err.xlsx.orderNotDraft': 'The order is not in DRAFT status',
  'err.xlsx.stockDocumentNotFound': 'Stock document not found',
  'err.xlsx.documentNotDraft': 'The document is not in DRAFT status',
  'err.xlsx.workOrderNotFound': 'Work order not found',
  'err.xlsx.workOrderNotDraftOrEstimate': 'The work order is not in DRAFT or ESTIMATE status',
  'err.xlsx.tableNotFound': 'Table not found',
  'err.xlsx.fileNoDataRows': 'The file contains no data rows',
  'err.xlsx.documentNotFound': 'Document not found',
  'err.xlsx.rowGoodMissing': 'Row {{row}}: good is not specified',
  'err.xlsx.rowGoodNotFound': 'Row {{row}}: good not found',
  'err.xlsx.fileNoGoodRows': 'The file contains no good rows',
  'err.xlsx.fileNotUploadedDetail': 'File not uploaded: {{detail}}',
  'err.xlsx.fileNotUploadedMultipart': 'multipart/form-data expected',
  'err.xlsx.rowError': 'Error in row {{row}}: {{detail}}',
  'err.xlsx.rowErrorUnknown': 'unknown error',
  'err.xlsx.rowGoodNameRequired': 'Row {{row}}: good name is required for creation',
  'err.xlsx.unsupportedFormat':
    'Unsupported file format — expected Excel (.xlsx), CSV (.csv) or PDF (.pdf)',
  'err.xlsx.pdfNoTextLayer':
    'This PDF is a scan or photo without a text layer, so line items could not be recognised automatically. Ask the supplier for an Excel, CSV or text-based PDF file, or enter the items manually.',
  'err.xlsx.pdfUnreadable':
    'Could not read the PDF — the file is corrupted, password-protected or the page is rotated',
  'err.xlsx.pdfNoTableStructure':
    'Could not detect a line-items table in the PDF — check that the file contains the tabular part of the invoice',
  'err.xlsx.fileReadFailed':
    'Failed to read the file — expected Excel (.xlsx), CSV (.csv) or PDF (.pdf)',

  // ── Exception messages: bank-statements module (incoming bank payments) ──
  'err.bankStatement.txNotFound': 'Bank transaction not found',
  'err.bankStatement.alreadyMatched': 'The transaction is already matched or posted',
  'err.bankStatement.notUnmatched': 'The action is allowed only for unmatched transactions',
  'err.bankStatement.bankAccountNotFound': 'Bank account not found',
  'err.bankStatement.counterpartyNotFound': 'Counterparty not found',
  'err.bankStatement.invoiceNotFound': 'Invoice not found',
  'err.bankStatement.invoiceRequiredForType': 'An invoice is required for the "Invoice" match type',
  'err.bankStatement.invalidFile': 'Unsupported file format — .xlsx, .csv or .dbf is expected',
  'err.bankStatement.fileReadFailed': 'Failed to read the statement file',
  'err.bankStatement.noDataRows': 'The statement file contains no data rows',
  'err.bankStatement.matchFailed': 'Failed to post a payment for the transaction',
  'err.bankStatement.invalidOperationDate':
    'Invalid transaction date "{{value}}" (expected YYYY-MM-DD or ISO)',
  // ── DTO validation: bank-statements ──
  'err.dto.bankStatement.bankAccountId.uuid': 'Invalid bank account identifier',
  'err.dto.bankStatement.startRow.int': 'Start row must be an integer',
  'err.dto.bankStatement.startRow.min': 'Start row must be at least 1',
  'err.dto.bankStatement.dateCol.int': 'Date column must be an integer',
  'err.dto.bankStatement.dateCol.min': 'Date column must be at least 1',
  'err.dto.bankStatement.amountCol.int': 'Amount column must be an integer',
  'err.dto.bankStatement.amountCol.min': 'Amount column must be at least 1',
  'err.dto.bankStatement.externalIdCol.int': 'Identifier column must be an integer',
  'err.dto.bankStatement.externalIdCol.min': 'Identifier column must be at least 1',
  'err.dto.bankStatement.col.int': 'Column number must be an integer',
  'err.dto.bankStatement.col.min': 'Column number must be at least 1',
  'err.dto.bankStatement.rows.max': 'Too many rows for a single import (maximum 1000)',
  'err.dto.bankStatement.reason.required': 'Provide a reason for ignoring',
  'err.dto.bankStatement.type.invalid': 'Invalid transaction match type',

  // ── Exception messages: counterparties module ──
  'err.counterparty.notFound': 'Counterparty not found',
  'err.counterparty.statusNotFound': 'Status not found',
  'err.counterparty.statusNotAssigned': 'The status is not assigned to this counterparty',
  'err.counterparty.nameRequired': "Enter the company name or the counterparty's first/last name",
  'err.counterparty.hasActiveWorkOrders': 'Cannot delete: the counterparty has active work orders',
  'err.counterparty.hasOpenOrders': 'Cannot delete: the counterparty has open orders',
  'err.counterparty.hasOpenInvoices': 'Cannot delete: the counterparty has open invoices',
  'err.counterparty.hasNonZeroBalance':
    'Cannot delete a counterparty with a non-zero balance (there is outstanding debt)',
  'err.counterparty.garageNotFound': 'Garage not found',
  'err.counterparty.supplierOnlyPurchaseContract': 'A supplier can only have a Purchase contract',
  'err.counterparty.clientOnlySaleContract': 'A client can only have a Sale contract',
  'err.counterparty.deletedContractNotFound': 'Deleted contract not found',
  'err.counterparty.currencyNotFound': 'Currency with code "{{code}}" not found',
  'err.counterparty.contractNotFound': 'Contract not found',
  'err.counterparty.supplierNeedsAtLeastOneContract': 'A supplier must have at least one contract',

  // ── Exception messages: booking module ──
  'err.booking.invalidBranchId': 'Invalid branchId',
  'err.booking.dateFormatExpected': 'Date in YYYY-MM-DD format',
  'err.booking.branchNotFound': 'Branch not found',
  'err.booking.someServicesNotFound': 'Some services not found',
  'err.booking.selectedLiftNotFound': 'The selected lift was not found',
  'err.booking.invalidDateFormat': 'Invalid date format',
  'err.booking.dateInPast': 'The booking date cannot be in the past',
  'err.booking.nonWorkingDay': 'Request for a non-working day',
  'err.booking.outsideWorkingHours': 'Time outside working hours ({{start}}–{{end}})',
  'err.booking.requestNotFound': 'Request not found',
  'err.booking.cancelledCannotConfirm': 'A cancelled request cannot be confirmed',
  'err.booking.slotNotFound': 'Slot not found',

  // ── Exception messages: auth module ──
  'err.auth.invalidCredentials': 'Invalid email or password',
  'err.auth.accountBlocked': 'Account is blocked',
  'err.auth.accountTempLocked':
    'Account is temporarily locked due to failed login attempts. Try again later',
  'err.auth.sessionExpired': 'Session expired, please sign in again',
  'err.auth.userNotFound': 'User not found',
  'err.auth.accountNotFound': 'Account not found',
  'err.auth.currentPasswordWrong': 'Current password is incorrect',
  'err.auth.noBranchAccess': 'No access to this branch',
  'err.auth.insufficientRights': 'Insufficient permissions to perform this action',
  'err.auth.sessionInvalid': 'Session is invalid',

  // ── Exception messages: idempotency interceptor ──
  'err.idempotency.inProgress': 'A request with this Idempotency-Key is already being processed',
  'err.idempotency.keyReusedDifferentBody':
    'Idempotency-Key has already been used with a different request body',

  // ── Exception messages: fsm ──
  'err.fsm.transitionNotAllowed': 'Transition from status "{{from}}" to "{{to}}" is not allowed',

  // ── Exception messages: audit module ──
  'err.audit.unknownEntityType': 'Unknown entity type',

  // ── Exception messages: brands module ──
  'err.brand.deletedNotFound': 'Deleted brand not found',
  'err.brand.notFound': 'Brand not found',
  'err.brand.nameExists': 'A brand with this name already exists',
  'err.brand.activeNameExists':
    'An active brand with this name already exists — restore is not possible',

  // ── Exception messages: cash module ──
  'err.cash.amountMustBePositive': 'Amount must be positive',
  'err.cash.categoryNotFound': 'Category not found',
  'err.cash.categoryInactive': 'Category is disabled — choose an active one',
  'err.cash.categoryTypeIncome': 'For a deposit, choose an income category',
  'err.cash.categoryTypeExpense': 'For a withdrawal, choose an expense category',
  'err.cash.shiftRequiredForFiscal': 'For a fiscal register, open a shift before cash operations',
  'err.cash.concurrentOperation': 'Register is busy with a concurrent operation — retry',
  'err.cash.expenseRequiresCategory': 'For an expense, specify an expense category',
  'err.cash.insufficientCash':
    'Insufficient cash in the register: available {{available}}, required {{required}}',

  // ── Exception messages: comments module ──
  'err.comment.unknownEntityType': 'Unknown entity type for comments: {{entityType}}',
  'err.comment.entityIdRequired': 'entityId is required',
  'err.comment.entityNotFound': 'Entity not found',
  'err.comment.notFound': 'Comment not found',
  'err.comment.deleteForbidden': 'Only the author or an administrator can delete comments',

  // ── Exception messages: document-number module ──
  'err.documentNumber.configNotFound': 'Numbering configuration for "{{documentType}}" not found',

  // ── Exception messages: dead-letter module ──
  'err.deadLetter.notFound': 'DLQ record not found',

  // ── Exception messages: employees module ──
  'err.employee.notFound': 'Employee not found',
  'err.employee.passwordRequiredWithEmail': 'Password is required when a login email is specified',
  'err.employee.loginEmailInUse': 'This email is already used for login',
  'err.employee.zonesNotFound': 'One or more zones not found',
  'err.employee.liftsNotFound': 'One or more lifts not found',
  'err.employee.categoriesNotFound': 'One or more categories not found',
  'err.employee.branchesNotFound': 'One or more branches not found',
  'err.employee.assignedToActiveOrders':
    'Cannot delete: the employee is assigned to active work orders',
  'err.employee.invalidRateScheme': 'Invalid rate scheme: {{details}}',

  // ── Exception messages: good-statuses module ──
  'err.goodStatus.notFound': 'Status not found',
  'err.goodStatus.nameExists': 'A status with this name already exists',
  'err.goodStatus.deletedNotFound': 'Deleted status not found',
  'err.goodStatus.activeNameExists':
    'An active status with this name already exists — restore is not possible',

  // ── Exception messages: counterparty-statuses module ──
  'err.counterpartyStatus.notFound': 'Status not found',
  'err.counterpartyStatus.nameExists': 'A status with this name already exists',
  'err.counterpartyStatus.deletedNotFound': 'Deleted status not found',
  'err.counterpartyStatus.activeNameExists':
    'An active status with this name already exists — restore is not possible',

  // ── Exception messages: counterparty-import-mappings module ──
  'err.counterpartyImportMapping.counterpartyNotFound': 'Counterparty not found',

  // ── Exception messages: integration-logs module ──
  'err.integrationLog.invalidDateFormat': 'Invalid date format in field "{{field}}"',

  // ── Exception messages: maintenance-schedules module ──
  'err.maintenanceSchedule.notFound': 'Maintenance schedule not found',
  'err.maintenanceSchedule.vehicleNotFound': 'Vehicle not found',

  // ── Exception messages: notifications module ──
  'err.notification.templateNotFound': 'Template not found',
  'err.notification.providerNotFound': 'Provider not found',
  'err.notification.unknownProvider': 'Unknown provider',
  'err.notification.providerChannelUnsupported':
    'Provider {{provider}} does not support channel {{channel}}',
  'err.notification.invalidProviderCode': 'Invalid provider code',

  // ── Exception messages: payment-methods module ──
  'err.paymentMethod.notFound': 'Payment method not found',
  'err.paymentMethod.codeExists': 'A payment method with code "{{code}}" already exists',
  'err.paymentMethod.systemImmutableName': 'A system payment method cannot be renamed',
  'err.paymentMethod.systemUndeletable': 'A system payment method cannot be deleted',

  // ── Exception messages: payroll module ──
  'err.payroll.startAfterEnd': 'The start date must not be later than the end date',
  'err.payroll.periodNotFound': 'Period not found',
  'err.payroll.onlyDraftCalculable': 'Only a period in "Draft" status can be calculated',
  'err.payroll.calculateConcurrentChange':
    'The period has already been calculated or changed by another user',
  'err.payroll.onlyCalculatedPayable': 'Only a calculated period can be paid out',
  'err.payroll.payConcurrentChange':
    'The period has already been paid out or changed by another user',
  'err.payroll.paidNotDeletable': 'A paid-out period cannot be deleted',

  // ── Exception messages: report-builder module ──
  'err.reportBuilder.aggregationNotAllowed': 'Aggregation {{agg}} is not allowed for "{{label}}"',
  'err.reportBuilder.sumNotAllowedState': 'SUM is not allowed for "{{label}}" (state, not flow)',
  'err.reportBuilder.modelUnavailable': 'Model {{model}} is unavailable',
  'err.reportBuilder.savedReportNotFound': 'Saved report not found',
  'err.reportBuilder.filterInRequiresArray': 'The "in" filter requires an array',
  'err.reportBuilder.filterContainsTextOnly': 'The "contains" filter is only for text fields',
  'err.reportBuilder.disallowedOperator': 'Disallowed operator: {{op}}',
  'err.reportBuilder.startAfterEnd': 'The start date must not be later than the end date',
  'err.reportBuilder.fieldNotFilterable': 'Field "{{label}}" is not filterable',
  'err.reportBuilder.unknownEntity': 'Unknown report entity: {{key}}',
  'err.reportBuilder.unknownField': 'Unknown field "{{key}}" for «{{entity}}»',
  'err.reportBuilder.disallowedRelation': 'Disallowed relation in field: {{prefix}}',
  'err.reportBuilder.unknownEnum': 'Unknown enum: {{enumName}}',
  'err.reportBuilder.disallowedEnumValue': 'Disallowed value "{{value}}" for {{enumName}}',

  // ── Exception messages: reports module ──
  'err.report.startAfterEnd': 'The start date must not be later than the end date',
  'err.report.warehouseNotFound': 'Warehouse not found',

  // ── Exception messages: settings module ──
  'err.settings.currencyNotFound': 'Currency with code "{{code}}" not found',
  'err.settings.workEndAfterStart': 'The work end time must be after the start time',
  'err.settings.configNotFound': 'Configuration not found',
  'err.settings.taxRateNotFound': 'VAT rate not found',
  'err.settings.defaultTaxRateUndeletable': 'The default rate cannot be deleted',
  'err.settings.organisationNotFound': 'Organisation not found',

  // ── Exception messages: settlements module ──
  'err.settlement.counterpartyNotFound': 'Counterparty not found',
  'err.settlement.accountNotFound': 'Settlement account not found',
  'err.settlement.reconciliationActNotFound': 'Reconciliation act not found',
  'err.settlement.amountMustBePositive': 'The transaction amount must be greater than zero',
  'err.settlement.counterpartyAccountNotFound': 'Counterparty settlement account not found',

  // ── Exception messages: setup module ──
  'err.setup.alreadyConfiguredReinit':
    'The system is already configured. Re-initialization is forbidden.',
  'err.setup.alreadyConfigured': 'The system is already configured',

  // ── Exception messages: user-preferences module ──
  'err.userPreference.keyEmpty': 'Key cannot be empty',
  'err.userPreference.keyTooLong': 'Key is too long (maximum {{max}} characters)',
  'err.userPreference.keyMismatch': 'The key in the URL and the request body must match',

  // ── Exception messages: vehicles module ──
  'err.vehicle.notFound': 'Vehicle not found',
  'err.vehicle.garageNotFound': 'Garage not found',
  'err.vehicle.vinExists': 'A vehicle with VIN "{{vin}}" already exists',
  'err.vehicle.deletedNotFound': 'Deleted vehicle not found',
  'err.vehicle.counterpartyDeletedRestoreFirst':
    "The vehicle's counterparty has been deleted. Restore the counterparty first.",
  'err.vehicle.garageDeletedRestoreFirst':
    "The vehicle's garage has been deleted. Restore the garage or move the vehicle first.",
  'err.vehicle.hasActiveWorkOrders':
    'Cannot delete: the vehicle has active work orders ({{count}})',
  'err.vehicle.nodeNotFound': 'Node not found',

  // ── Exception messages: inspection module ──
  'err.inspection.reportExists': 'An inspection report already exists for this work order',
  'err.inspection.workLinesStatusForbidden':
    'Cannot add work lines to a work order in this status. An inspection with critical points requires an editable work order.',

  // ── Exception messages: warehouses module ──
  'err.warehouse.notFound': 'Warehouse not found',
  'err.warehouse.hasStockOrReserve':
    'Cannot delete: the warehouse has non-zero stock or reservations',
  'err.warehouse.onlyOneMain':
    'Only one warehouse can be the main one in the organisation. Try again.',

  // ── Exception messages: webhooks module ──
  'err.webhook.notFound': 'Webhook not found',

  // ── Exception messages: work-order-templates module ──
  'err.workOrderTemplate.notFound': 'Template not found',

  // ── Exception messages: works module ──
  'err.work.notFound': 'Work not found',
  'err.work.categoryNotFound': 'Category not found',
  'err.work.deletedNotFound': 'Deleted work not found',

  // ── class-validator generic constraints (err.cv.*) ──
  'err.cv.isNotEmpty': 'Field "{{field}}" cannot be empty',
  'err.cv.isDefined': 'Field "{{field}}" is required',
  'err.cv.isOptional': 'Field "{{field}}" has an invalid value',
  'err.cv.isString': 'Field "{{field}}" must be a string',
  'err.cv.minLength': 'Field "{{field}}" is too short',
  'err.cv.maxLength': 'Field "{{field}}" is too long',
  'err.cv.length': 'Field "{{field}}" has an incorrect length',
  'err.cv.matches': 'Field "{{field}}" has an incorrect format',
  'err.cv.isNumber': 'Field "{{field}}" must be a number',
  'err.cv.isInt': 'Field "{{field}}" must be an integer',
  'err.cv.isPositive': 'Field "{{field}}" must be a positive number',
  'err.cv.isNegative': 'Field "{{field}}" must be a negative number',
  'err.cv.min': 'Field "{{field}}" is below the allowed minimum',
  'err.cv.max': 'Field "{{field}}" is above the allowed maximum',
  'err.cv.isBoolean': 'Field "{{field}}" must be a boolean (true/false)',
  'err.cv.isBooleanString': 'Field "{{field}}" must be "true" or "false"',
  'err.cv.isUuid': 'Field "{{field}}" must be a UUID',
  'err.cv.isEmail': 'Field "{{field}}" must be an email address',
  'err.cv.isUrl': 'Field "{{field}}" must be a URL',
  'err.cv.isIso8601': 'Field "{{field}}" must be a date in ISO 8601 format (YYYY-MM-DD)',
  'err.cv.isDateString': 'Field "{{field}}" must be a valid date',
  'err.cv.isPhoneNumber': 'Field "{{field}}" must be a phone number',
  'err.cv.isJson': 'Field "{{field}}" must be valid JSON',
  'err.cv.isEnum': 'Field "{{field}}" must be one of the allowed values',
  'err.cv.isArray': 'Field "{{field}}" must be an array',
  'err.cv.arrayMinSize': 'Array "{{field}}" contains too few elements',
  'err.cv.arrayMaxSize': 'Array "{{field}}" contains too many elements',
  'err.cv.arrayUnique': 'Array "{{field}}" must contain unique elements',
  'err.cv.nestedValidation': 'Nested field "{{field}}" has invalid values',
  'err.cv.whitelistValidation': 'Field "{{field}}" is not allowed',

  // ── DTO inline @IsX({message}) overrides (err.dto.*) ──
  'err.dto.auth.email.invalid': 'Invalid email format',
  'err.dto.auth.password.notEmpty': 'Password cannot be empty',
  'err.dto.auth.password.tooShort': 'Password is too short',
  'err.dto.bankAccount.iban.format':
    'Invalid IBAN format. Must start with UA and contain 29 characters',
  'err.dto.booking.services.max': 'No more than 50 services',
  'err.dto.booking.phone.format': 'Phone must be in the format +380XXXXXXXXX',
  'err.dto.brand.synonyms.max': 'No more than 20 synonyms',
  'err.dto.counterpartyStatus.color.hex': 'Color must be in HEX format (#rrggbb)',
  'err.dto.goodStatus.color.hex': 'Color must be in HEX format (#rrggbb)',
  'err.dto.good.categories.max': 'No more than 100 categories in the filter',
  'err.dto.inspection.points.max': 'No more than 50 inspection points',
  'err.dto.pricingRule.tiers.max': 'No more than 50 tiers in the pricing rule',
  'err.dto.purchaseOrder.lines.max': 'No more than 500 lines in the purchase order',
  'err.dto.purchaseOrder.receiveLines.max': 'No more than 500 lines in the partial receipt',
  'err.dto.reportBuilder.groupBy.max': 'No more than 5 grouping levels',
  'err.dto.search.query.min': 'The query must contain at least 2 characters',
  'err.dto.settings.currencyCode.max': 'Currency code cannot exceed 10 characters',
  'err.dto.settings.time.format': 'Format “HH:MM” (00:00–23:59)',
  'err.dto.settings.workingDays.max': 'No more than 7 working days',
  'err.dto.setup.email.invalid': 'Invalid email format',
  'err.dto.setup.password.notEmpty': 'Password cannot be empty',
  'err.dto.setup.password.min': 'Password must be at least 8 characters',
  'err.dto.setup.password.max': 'Password is too long (maximum 128 characters)',
  'err.dto.stockDocument.lines.max': 'No more than 500 lines in the stock document',
  'err.dto.supplierPayment.amount.min': 'The payment amount must be greater than zero',
  'err.dto.supplierPayment.from.dateValid': 'from must be a valid date',
  'err.dto.supplierPayment.from.dateFormat': 'from must be in the YYYY-MM-DD format',
  'err.dto.supplierPayment.to.dateValid': 'to must be a valid date',
  'err.dto.supplierPayment.to.dateFormat': 'to must be in the YYYY-MM-DD format',
  'err.dto.supplierPayment.date.dateValid': 'date must be a valid date',
  'err.dto.supplierPayment.date.dateFormat': 'date must be in the YYYY-MM-DD format',
  'err.dto.supplierPayment.target.in': 'target must be overdue or planned',
  'err.dto.supplierReturn.lines.max': 'No more than 500 lines in the return',
  'err.dto.userPreference.key.notEmpty': 'Key cannot be empty',
  'err.dto.userPreference.value.object': 'Value must be an object',
  'err.dto.workOrderTemplate.workLines.max': 'No more than 200 work lines in the template',
  'err.dto.workOrderTemplate.parts.max': 'No more than 200 parts in the template',
  'err.dto.work.categories.max': 'No more than 100 categories in the filter',
  'err.dto.xlsx.rows.max': 'No more than 1000 rows per import',
  'err.dto.employee.loginEmail.invalid': 'Invalid login email format',
  'err.dto.employee.password.min': 'Password must be at least 6 characters',
  'err.dto.employee.password.max': 'Password is too long (maximum 128 characters)',
  'err.dto.employee.branches.max': 'Maximum 50 branches per employee',
  'err.dto.employee.zones.max': 'Maximum 30 zones per employee',
  'err.dto.employee.lifts.max': 'Maximum 30 lifts per employee',
  'err.dto.employee.categories.max': 'Maximum 50 work categories per employee',
  'err.dto.service.works.max': 'No more than 100 works in the service',
  'err.dto.service.goods.max': 'No more than 100 goods in the service',
};
