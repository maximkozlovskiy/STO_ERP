import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SupplierPaymentsService } from './supplier-payments.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  SupplierPaymentScheduleDocumentsQueryDto,
  SupplierPaymentScheduleQueryDto,
} from './supplier-payments.dto';

/**
 * Contract-тест drill-down endpoint GET schedule/documents.
 * Захищає date XOR target guard у контролері (кастомна логіка поза DTO-декораторами):
 * рівно одне з date/target має бути задане, інакше 400. Regression проти повернення
 * до стану коли обидва/жодного тихо проходять.
 */
describe('SupplierPaymentsController — schedule/documents contract', () => {
  let controller: SupplierPaymentsController;
  let service: { getScheduleDocuments: ReturnType<typeof vi.fn> };
  const ORG = 'org-1';

  beforeEach(() => {
    service = { getScheduleDocuments: vi.fn().mockResolvedValue([]) };
    controller = new SupplierPaymentsController(service as never);
  });

  const q = (over: Partial<SupplierPaymentScheduleDocumentsQueryDto>) =>
    ({ from: '2026-09-02', to: '2026-09-21', ...over }) as SupplierPaymentScheduleDocumentsQueryDto;

  // Bug #616 regression-guard: semantically-invalid `date` (shape passes regex,
  // parse fails) → validation error. Дзеркалить існуючий контракт для `from`/`to`
  // у `SupplierPaymentScheduleQueryDto` (Bug #595).
  describe('Bug #616 — DTO validation for `date` catches semantic-invalid dates', () => {
    it.each(['2026-99-99', '2026-13-01', '2026-02-31', '9999-99-99'])(
      'date=%s → validation error (не пропускається у сервіс)',
      async badDate => {
        const dto = plainToInstance(SupplierPaymentScheduleDocumentsQueryDto, {
          from: '2026-09-02',
          to: '2026-09-21',
          date: badDate,
        });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some(e => e.property === 'date')).toBe(true);
      },
    );

    it('date=2026-09-08 (valid) → no validation errors', async () => {
      const dto = plainToInstance(SupplierPaymentScheduleDocumentsQueryDto, {
        from: '2026-09-02',
        to: '2026-09-21',
        date: '2026-09-08',
      });
      const errors = await validate(dto);
      expect(errors.filter(e => e.property === 'date')).toEqual([]);
    });

    // Symmetric guard: паттерн для `from`/`to` вже покритий; підтверджуємо що обидва
    // DTO мають однакову семантику (не регресія в one but not the other).
    it('`from` у SupplierPaymentScheduleQueryDto — теж ловить semantic-invalid дату', async () => {
      const dto = plainToInstance(SupplierPaymentScheduleQueryDto, {
        from: '2026-99-99',
        to: '2026-09-21',
      });
      const errors = await validate(dto);
      expect(errors.some(e => e.property === 'from')).toBe(true);
    });
  });

  it('date задано → делегує з target {kind:date}', () => {
    controller.getScheduleDocuments(ORG, q({ date: '2026-09-08', supplierId: 'sup-1' }));
    expect(service.getScheduleDocuments).toHaveBeenCalledWith(
      ORG,
      '2026-09-02',
      '2026-09-21',
      { kind: 'date', date: '2026-09-08' },
      'sup-1',
    );
  });

  it('target=overdue → делегує з {kind:overdue}', () => {
    controller.getScheduleDocuments(ORG, q({ target: 'overdue' }));
    expect(service.getScheduleDocuments).toHaveBeenCalledWith(
      ORG,
      '2026-09-02',
      '2026-09-21',
      { kind: 'overdue' },
      undefined,
    );
  });

  it('date + target разом → BadRequestException (взаємовиключні)', () => {
    expect(() =>
      controller.getScheduleDocuments(ORG, q({ date: '2026-09-08', target: 'overdue' })),
    ).toThrow(BadRequestException);
    expect(service.getScheduleDocuments).not.toHaveBeenCalled();
  });

  it('ні date, ні target → BadRequestException', () => {
    expect(() => controller.getScheduleDocuments(ORG, q({}))).toThrow(BadRequestException);
    expect(service.getScheduleDocuments).not.toHaveBeenCalled();
  });
});

// ─── Linked documents (Phase B backend) — full HTTP contract ─────────────
const linkedServiceMock = {
  create: vi.fn(),
  findAll: vi.fn(),
  getSchedule: vi.fn(),
  getScheduleDocuments: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  findOne: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getLinkedDocuments: vi.fn(),
  getLinkedCounts: vi.fn(),
};

let jwtAllow = true;
const mockJwtGuard = {
  canActivate: vi.fn().mockImplementation(ctx => {
    if (!jwtAllow) return false;
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'emp-1', orgId: 'org-1', role: 'ACCOUNTANT' };
    return true;
  }),
};
const mockRolesGuard = { canActivate: vi.fn().mockReturnValue(true) };

describe('SupplierPayments — linked-documents HTTP Contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SupplierPaymentsController],
      providers: [{ provide: SupplierPaymentsService, useValue: linkedServiceMock }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(mockJwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(mockRolesGuard)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jwtAllow = true;
    vi.clearAllMocks();
  });

  const VALID_UUID = '11111111-1111-4111-8111-111111111111';

  describe('GET /supplier-payments/:id/linked-documents', () => {
    it('повертає 200 і делегує (orgId, id)', async () => {
      linkedServiceMock.getLinkedDocuments.mockResolvedValueOnce({
        purchaseOrder: [],
        counterparty: [],
        account: [],
      });
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/supplier-payments/${VALID_UUID}/linked-documents`,
      });
      expect(res.statusCode).toBe(200);
      expect(linkedServiceMock.getLinkedDocuments).toHaveBeenCalledWith('org-1', VALID_UUID);
    });

    it('повертає 400 для не-UUID id', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: '/supplier-payments/not-uuid/linked-documents',
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: :id/linked-documents НЕ має бути перехоплений @Get(':id').
    it('route ordering: linked-documents не ловиться :id (findOne НЕ викликаний)', async () => {
      linkedServiceMock.getLinkedDocuments.mockResolvedValueOnce({
        purchaseOrder: [],
        counterparty: [],
        account: [],
      });
      await (app as NestFastifyApplication).inject({
        method: 'GET',
        url: `/supplier-payments/${VALID_UUID}/linked-documents`,
      });
      expect(linkedServiceMock.getLinkedDocuments).toHaveBeenCalledTimes(1);
      expect(linkedServiceMock.findOne).not.toHaveBeenCalled();
    });
  });

  describe('POST /supplier-payments/linked-counts', () => {
    it('повертає 200 і делегує (orgId, ids)', async () => {
      linkedServiceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-payments/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(linkedServiceMock.getLinkedCounts).toHaveBeenCalledWith('org-1', [VALID_UUID]);
    });

    it('повертає 400 для порожнього масиву (ArrayMinSize)', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-payments/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [] }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для 501 id (ArrayMaxSize)', async () => {
      const ids = Array.from({ length: 501 }, () => VALID_UUID);
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-payments/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids }),
      });
      expect(res.statusCode).toBe(400);
    });

    it('повертає 400 для non-UUID елемента', async () => {
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-payments/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: ['not-a-uuid'] }),
      });
      expect(res.statusCode).toBe(400);
    });

    // Route ordering: POST /linked-counts не має вимагати UUID :id.
    it('route ordering: linked-counts не ловиться POST :id', async () => {
      linkedServiceMock.getLinkedCounts.mockResolvedValueOnce({});
      const res = await (app as NestFastifyApplication).inject({
        method: 'POST',
        url: '/supplier-payments/linked-counts',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ ids: [VALID_UUID] }),
      });
      expect(res.statusCode).toBe(200);
      expect(linkedServiceMock.getLinkedCounts).toHaveBeenCalledTimes(1);
    });
  });
});
