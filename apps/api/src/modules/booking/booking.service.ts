import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookingRequestDto, BookingRequestResponseDto, AvailabilitySlotDto } from './booking.dto';

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async getAvailability(orgId: string, branchId: string, date: string, serviceIds?: string[]): Promise<AvailabilitySlotDto[]> {
    // Find all lifts in the branch (lifts belong to zones, zones belong to branches)
    const lifts = await this.prisma.lift.findMany({
      where: {
        orgId,
        deletedAt: null,
        zone: { branchId },
      },
      take: 50,
    });

    // Occupied slots for this day
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const busySlots = await this.prisma.calendarSlot.findMany({
      where: { orgId, startAt: { gte: dayStart, lte: dayEnd }, deletedAt: null },
      select: { liftId: true, startAt: true, endAt: true },
      take: 500,
    });

    // Calculate duration from requested services
    let totalMinutes = 60; // default 1 hour
    if (serviceIds?.length) {
      const works = await this.prisma.work.findMany({
        where: { id: { in: serviceIds }, orgId, deletedAt: null },
        select: { normoHours: true },
        take: 20,
      });
      const totalHours = works.reduce((sum, w) => sum + Number(w.normoHours ?? 1), 0);
      totalMinutes = Math.ceil(totalHours * 60);
    }

    // Working hours 09:00–18:00, 30-min steps
    const slots: AvailabilitySlotDto[] = [];
    for (const lift of lifts) {
      for (let hour = 9; hour < 18; hour++) {
        for (const min of [0, 30]) {
          const slotStart = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`);
          const slotEnd = new Date(slotStart.getTime() + totalMinutes * 60_000);
          if (slotEnd.getUTCHours() > 18 || (slotEnd.getUTCHours() === 18 && slotEnd.getUTCMinutes() > 0)) continue;

          const isBusy = busySlots.some(
            (b) =>
              b.liftId === lift.id &&
              new Date(b.startAt) < slotEnd &&
              new Date(b.endAt) > slotStart,
          );

          slots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            liftId: lift.id,
            liftName: lift.name,
            available: !isBusy,
          });
        }
      }
    }
    return slots;
  }

  async create(orgId: string, dto: CreateBookingRequestDto): Promise<BookingRequestResponseDto> {
    const branch = await this.prisma.garageBranch.findFirst({
      where: { id: dto.branchId, orgId, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Філію не знайдено');

    const req = await this.prisma.bookingRequest.create({
      data: {
        orgId,
        branchId: dto.branchId,
        clientName: dto.clientName,
        clientPhone: dto.clientPhone,
        requestedDate: new Date(dto.requestedDate),
        serviceIds: dto.serviceIds ?? [],
        notes: dto.notes ?? null,
      },
    });

    // SMS confirmation via BullMQ (offline-first)
    await this.smsQueue.add(
      'send-sms',
      {
        orgId,
        phone: dto.clientPhone,
        templateCode: 'BOOKING_CONFIRMATION',
        params: {
          clientName: dto.clientName,
          date: new Date(dto.requestedDate).toLocaleDateString('uk-UA'),
          branchName: branch.name,
        },
      },
      { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
    );

    return this.toDto(req);
  }

  async findAll(orgId: string): Promise<{ items: BookingRequestResponseDto[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.bookingRequest.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.bookingRequest.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map((r) => this.toDto(r)), total };
  }

  async confirm(orgId: string, id: string): Promise<BookingRequestResponseDto> {
    const req = await this.prisma.bookingRequest.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!req) throw new NotFoundException('Заявку не знайдено');
    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: { status: 'CONFIRMED' },
    });
    return this.toDto(updated);
  }

  async cancel(orgId: string, id: string): Promise<void> {
    const req = await this.prisma.bookingRequest.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!req) throw new NotFoundException('Заявку не знайдено');
    await this.prisma.bookingRequest.update({
      where: { id },
      data: { status: 'CANCELLED', deletedAt: new Date() },
    });
  }

  private toDto(r: {
    id: string;
    status: string;
    clientName: string;
    clientPhone: string;
    requestedDate: Date;
    branchId: string;
    notes: string | null;
    createdAt: Date;
  }): BookingRequestResponseDto {
    return {
      id: r.id,
      status: r.status,
      clientName: r.clientName,
      clientPhone: r.clientPhone,
      requestedDate: r.requestedDate.toISOString(),
      branchId: r.branchId,
      notes: r.notes ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
