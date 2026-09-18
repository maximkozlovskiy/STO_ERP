// Стабільні validation-ключі як TS-константи (typo-safety). Дзеркалять рядкові ключі, що
// емітяться зі схем (issue.message = key) і резолвляться messages.uk/messages.en.
//
// Схеми можуть використовувати raw-рядки ('v.good.name.required') АБО V.good.name.required —
// обидва еквівалентні. VALIDATION_KEYS — плаский список для key-parity/повноти тестів.

export const V = {
  // Інфра
  fieldSuffix: 'v.fieldSuffix',
  validationFailed: 'v.validationFailed',
  invalid: 'v.invalid',

  // validators.ts
  phone: 'v.phone',
  email: 'v.email',
  iban: 'v.iban',
  uuid: 'v.uuid',
  positive: 'v.positive',
  nonNeg: 'v.nonNeg',
  dateFormat: 'v.dateFormat',

  counterparty: {
    type: { required: 'v.counterparty.type.required' },
    email: { invalid: 'v.counterparty.email.invalid' },
    name: { supplier: 'v.counterparty.name.supplier', any: 'v.counterparty.name.any' },
  },

  good: {
    name: { required: 'v.good.name.required', max: 'v.good.name.max' },
  },

  employee: {
    firstName: { required: 'v.employee.firstName.required', max: 'v.employee.firstName.max' },
    lastName: { required: 'v.employee.lastName.required', max: 'v.employee.lastName.max' },
    role: { required: 'v.employee.role.required' },
    percent: { range: 'v.employee.percent.range' },
    ratePerHour: { nonNeg: 'v.employee.ratePerHour.nonNeg' },
    fixedMonthly: { nonNeg: 'v.employee.fixedMonthly.nonNeg' },
    bonusPercent: { range: 'v.employee.bonusPercent.range' },
    loginEmail: {
      required: 'v.employee.loginEmail.required',
      invalid: 'v.employee.loginEmail.invalid',
    },
    password: { required: 'v.employee.password.required', min: 'v.employee.password.min' },
  },

  vehicle: {
    year: { int: 'v.vehicle.year.int', min: 'v.vehicle.year.min', max: 'v.vehicle.year.max' },
    nonNegInt: 'v.vehicle.nonNegInt',
    nonNegFloat: 'v.vehicle.nonNegFloat',
    make: { required: 'v.vehicle.make.required', max: 'v.vehicle.make.max' },
    model: { required: 'v.vehicle.model.required', max: 'v.vehicle.model.max' },
    customerGarage: { required: 'v.vehicle.customerGarage.required' },
  },

  invoice: {
    line: {
      description: {
        required: 'v.invoice.line.description.required',
        max: 'v.invoice.line.description.max',
      },
      quantity: { min: 'v.invoice.line.quantity.min' },
      unitPrice: { nonNeg: 'v.invoice.line.unitPrice.nonNeg' },
      vatRate: { nonNeg: 'v.invoice.line.vatRate.nonNeg', max: 'v.invoice.line.vatRate.max' },
    },
    counterparty: { required: 'v.invoice.counterparty.required' },
    amount: { min: 'v.invoice.amount.min' },
  },

  purchaseOrder: {
    line: {
      good: { required: 'v.purchaseOrder.line.good.required' },
      quantity: { min: 'v.purchaseOrder.line.quantity.min' },
      price: { nonNeg: 'v.purchaseOrder.line.price.nonNeg' },
    },
    trackingNumber: { max: 'v.purchaseOrder.trackingNumber.max' },
    supplier: { required: 'v.purchaseOrder.supplier.required' },
    warehouse: { required: 'v.purchaseOrder.warehouse.required' },
    uuid: { invalid: 'v.purchaseOrder.uuid.invalid' },
  },

  stockDocument: {
    line: {
      good: { required: 'v.stockDocument.line.good.required' },
      quantity: { min: 'v.stockDocument.line.quantity.min' },
    },
    type: { required: 'v.stockDocument.type.required' },
    branch: { required: 'v.stockDocument.branch.required' },
    warehouse: { required: 'v.stockDocument.warehouse.required' },
    transfer: {
      targetRequired: 'v.stockDocument.transfer.targetRequired',
      targetSame: 'v.stockDocument.transfer.targetSame',
    },
  },

  supplierReturn: {
    line: {
      good: { required: 'v.supplierReturn.line.good.required' },
      quantity: { min: 'v.supplierReturn.line.quantity.min' },
      price: { nonNeg: 'v.supplierReturn.line.price.nonNeg' },
    },
    supplier: { required: 'v.supplierReturn.supplier.required' },
    warehouse: { required: 'v.supplierReturn.warehouse.required' },
  },

  supplierPayment: {
    supplier: { required: 'v.supplierPayment.supplier.required' },
    sourceType: { required: 'v.supplierPayment.sourceType.required' },
    amount: { min: 'v.supplierPayment.amount.min' },
    method: { required: 'v.supplierPayment.method.required' },
    bank: { required: 'v.supplierPayment.bank.required' },
    cash: { required: 'v.supplierPayment.cash.required' },
    source: { conflict: 'v.supplierPayment.source.conflict' },
  },

  workOrder: {
    nonNegInt: { int: 'v.workOrder.nonNegInt.int', min: 'v.workOrder.nonNegInt.min' },
    branch: { required: 'v.workOrder.branch.required' },
    vehicle: { required: 'v.workOrder.vehicle.required' },
    counterparty: { required: 'v.workOrder.counterparty.required' },
    dateFormat: 'v.workOrder.dateFormat',
    uuid: { invalid: 'v.workOrder.uuid.invalid' },
    hours: { nonNeg: 'v.workOrder.hours.nonNeg' },
    line: {
      work: { required: 'v.workOrder.line.work.required' },
      employee: { required: 'v.workOrder.line.employee.required' },
      normoHours: { min: 'v.workOrder.line.normoHours.min' },
    },
    part: {
      good: { required: 'v.workOrder.part.good.required' },
      warehouse: { required: 'v.workOrder.part.warehouse.required' },
      quantity: { min: 'v.workOrder.part.quantity.min' },
    },
  },
} as const;

/** Плаский список усіх validation-ключів (для key-parity / повноти каталогів у тестах). */
export const VALIDATION_KEYS = [
  'v.fieldSuffix',
  'v.validationFailed',
  'v.invalid',
  'v.phone',
  'v.email',
  'v.iban',
  'v.uuid',
  'v.positive',
  'v.nonNeg',
  'v.dateFormat',
  'v.counterparty.type.required',
  'v.counterparty.email.invalid',
  'v.counterparty.name.supplier',
  'v.counterparty.name.any',
  'v.good.name.required',
  'v.good.name.max',
  'v.employee.firstName.required',
  'v.employee.firstName.max',
  'v.employee.lastName.required',
  'v.employee.lastName.max',
  'v.employee.role.required',
  'v.employee.percent.range',
  'v.employee.ratePerHour.nonNeg',
  'v.employee.fixedMonthly.nonNeg',
  'v.employee.bonusPercent.range',
  'v.employee.loginEmail.required',
  'v.employee.password.required',
  'v.employee.password.min',
  'v.employee.loginEmail.invalid',
  'v.vehicle.year.int',
  'v.vehicle.year.min',
  'v.vehicle.year.max',
  'v.vehicle.nonNegInt',
  'v.vehicle.nonNegFloat',
  'v.vehicle.make.required',
  'v.vehicle.make.max',
  'v.vehicle.model.required',
  'v.vehicle.model.max',
  'v.vehicle.customerGarage.required',
  'v.invoice.line.description.required',
  'v.invoice.line.description.max',
  'v.invoice.line.quantity.min',
  'v.invoice.line.unitPrice.nonNeg',
  'v.invoice.line.vatRate.nonNeg',
  'v.invoice.line.vatRate.max',
  'v.invoice.counterparty.required',
  'v.invoice.amount.min',
  'v.purchaseOrder.line.good.required',
  'v.purchaseOrder.line.quantity.min',
  'v.purchaseOrder.line.price.nonNeg',
  'v.purchaseOrder.trackingNumber.max',
  'v.purchaseOrder.supplier.required',
  'v.purchaseOrder.warehouse.required',
  'v.purchaseOrder.uuid.invalid',
  'v.stockDocument.line.good.required',
  'v.stockDocument.line.quantity.min',
  'v.stockDocument.type.required',
  'v.stockDocument.branch.required',
  'v.stockDocument.warehouse.required',
  'v.stockDocument.transfer.targetRequired',
  'v.stockDocument.transfer.targetSame',
  'v.supplierReturn.line.good.required',
  'v.supplierReturn.line.quantity.min',
  'v.supplierReturn.line.price.nonNeg',
  'v.supplierReturn.supplier.required',
  'v.supplierReturn.warehouse.required',
  'v.supplierPayment.supplier.required',
  'v.supplierPayment.sourceType.required',
  'v.supplierPayment.amount.min',
  'v.supplierPayment.method.required',
  'v.supplierPayment.bank.required',
  'v.supplierPayment.cash.required',
  'v.supplierPayment.source.conflict',
  'v.workOrder.nonNegInt.int',
  'v.workOrder.nonNegInt.min',
  'v.workOrder.branch.required',
  'v.workOrder.vehicle.required',
  'v.workOrder.counterparty.required',
  'v.workOrder.dateFormat',
  'v.workOrder.uuid.invalid',
  'v.workOrder.hours.nonNeg',
  'v.workOrder.line.work.required',
  'v.workOrder.line.employee.required',
  'v.workOrder.line.normoHours.min',
  'v.workOrder.part.good.required',
  'v.workOrder.part.warehouse.required',
  'v.workOrder.part.quantity.min',
  // Exception-повідомлення (http-exception.filter власні строки)
  'err.internal',
  'err.badRequest',
  'err.fastifyBadRequest',
  'err.prisma.unique',
  'err.prisma.foreignKey',
  'err.prisma.notFound',
  'err.prisma.badId',
  'err.prisma.tooLong',
  'err.prisma.nullConstraint',
] as const;

export type ValidationKey = (typeof VALIDATION_KEYS)[number];
