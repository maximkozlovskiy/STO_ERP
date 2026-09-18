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
};
