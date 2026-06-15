import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BookingService } from './booking.service';
import { PrismaService } from '../../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bullmq';

/**
 * Bug #254: unit-покриття `BookingService.create` + `confirm` + `cancel`.
 *
 * Фокус:
 *   • Cross-tenant FK validation для `serviceIds` (Bug #252 — public endpoint
 *     приймає UUID-и; перевірка кількості через `prisma.work.count` має ловити
 *     foreign IDs).
 *   • Defense-in-depth `updateMany({ id, orgId, deletedAt: null })` у confirm/cancel.
 *   • Branch tenant guard.
 *
 * Без spec regression у tenant-FK (e.g. видалення count-check під рефактор)
 * пройде CI зеленим — публічний endpoint буде приймати UUID-и з чужих org.
 */
describe('BookingService', () => {
  let service: BookingService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let smsQueue: any;
  const orgId = 'org-1';
  const branchId = 'branch-1';
  const bookingId = 'booking-1';

  beforeEach(async () => {
    prisma = {
      garageBranch: { findFirst: vi.fn() },
      bookingRequest: {
        create: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      work: { count: vi.fn() },
    };
    smsQueue = { add: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('sms'), useValue: smsQueue },
      ],
    }).compile();
    service = module.get(BookingService);
  });

  describe('create', () => {
    const validDto = {
      branchId,
      clientName: 'Іван Тестовий',
      clientPhone: '+380501234567',
      requestedDate: '2026-06-01',
    };

    it('happy path без serviceIds: створює booking + queue SMS', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      prisma.work.count.mockResolvedValueOnce(0);
      prisma.bookingRequest.create.mockResolvedValueOnce({
        id: bookingId,
        status: 'PENDING',
        clientName: validDto.clientName,
        clientPhone: validDto.clientPhone,
        requestedDate: new Date('2026-06-01'),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      const result = await service.create(orgId, validDto);

      expect(prisma.bookingRequest.create).toHaveBeenCalledTimes(1);
      // SMS додано до черги з offline-first attempts=10
      expect(smsQueue.add).toHaveBeenCalledTimes(1);
      const smsArgs = smsQueue.add.mock.calls[0][2];
      expect(smsArgs.attempts).toBe(10);

      expect(result.id).toBe(bookingId);
      expect(result.status).toBe('PENDING');
    });

    it('Bug #252: cross-tenant serviceIds → BadRequestException; bookingRequest НЕ створюється', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: branchId, name: 'Філія 1' });
      // Запитали 2 UUID, в org існує лише 1 — означає що один з чужої org.
      prisma.work.count.mockResolvedValueOnce(1);

      await expect(
        service.create(orgId, {
          ...validDto,
          serviceIds: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Critical: count було викликане з правильним where (orgId + deletedAt: null).
      expect(prisma.work.count).toHaveBeenCalledTimes(1);
      const countArgs = prisma.work.count.mock.calls[0][0];
      expect(countArgs.where.orgId).toBe(orgId);
      expect(countArgs.where.deletedAt).toBe(null);

      // Booking НЕ створюється.
      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(smsQueue.add).not.toHaveBeenCalled();
    });

    it('branch не знайдено (cross-tenant or soft-deleted) → NotFoundException', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
      prisma.work.count.mockResolvedValueOnce(0);

      await expect(service.create(orgId, validDto)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.bookingRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    it('Bug #249 pattern: updateMany з { id, orgId, deletedAt: null }, не голий update', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.bookingRequest.findFirstOrThrow.mockResolvedValueOnce({
        id: bookingId,
        status: 'CONFIRMED',
        clientName: 'Тест',
        clientPhone: '+380501234567',
        requestedDate: new Date(),
        branchId,
        notes: null,
        createdAt: new Date(),
      });

      const result = await service.confirm(orgId, bookingId);

      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledTimes(1);
      const args = prisma.bookingRequest.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe(bookingId);
      expect(args.where.orgId).toBe(orgId);
      expect(args.where.deletedAt).toBe(null);
      expect(args.data.status).toBe('CONFIRMED');

      // Defense-in-depth: НЕ використовувати голий update without orgId.
      expect(prisma.bookingRequest.update).not.toHaveBeenCalled();

      expect(result.status).toBe('CONFIRMED');
    });

    it('cross-tenant booking → NotFoundException (count === 0)', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.confirm(orgId, bookingId)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.bookingRequest.findFirstOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('soft-delete + status=CANCELLED у одному updateMany', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.cancel(orgId, bookingId);

      const args = prisma.bookingRequest.updateMany.mock.calls[0][0];
      expect(args.where.id).toBe(bookingId);
      expect(args.where.orgId).toBe(orgId);
      expect(args.where.deletedAt).toBe(null);
      expect(args.data.status).toBe('CANCELLED');
      expect(args.data.deletedAt).toBeInstanceOf(Date);
    });

    it('повторний cancel (вже soft-deleted) → NotFoundException', async () => {
      prisma.bookingRequest.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.cancel(orgId, bookingId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
