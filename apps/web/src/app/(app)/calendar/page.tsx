'use client';

import { Suspense } from 'react';
import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Trash2,
  CalendarDays,
  BarChart2,
  CalendarRange,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import type { CalendarSlot, Lift, PendingSlot, GhostSlot } from './calendar.types';
import {
  HOURS,
  TOTAL_HOURS,
  SIDEBAR_W,
  pad,
  toDateString,
  kyivHours,
  fmtTime,
  decimalHoursToHHMM,
  formatKyivDate,
  fmtKyivMonthYear,
} from './calendar.utils';
import { CalendarMonthView } from './CalendarMonthView';
import { CalendarStatsTab } from './CalendarStatsTab';
import { CalendarSlotModal } from './CalendarSlotModal';
import { useCalendarState, PENDING_DRAG_ID, EMPTY_FORM } from './useCalendarState';

// ─── DraggableSlot ───────────────────────────────────────────────────────────

interface DraggableSlotProps {
  slot: CalendarSlot;
  isEditing: boolean;
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
}

const DraggableSlot = memo(function DraggableSlot({
  slot,
  isEditing,
  onRemove,
  onEdit,
  onResizeStart,
}: DraggableSlotProps) {
  const startH = kyivHours(slot.startAt);
  const endH = kyivHours(slot.endAt);
  const left = ((startH - HOURS[0]!) / TOTAL_HOURS) * 100;
  const width = ((endH - startH) / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: slot.id,
    data: { slot },
  });
  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  const label = [
    `${fmtTime(slot.startAt)}–${fmtTime(slot.endAt)}`,
    slot.workOrderNumber ? `· ${slot.workOrderNumber}` : null,
    slot.counterpartyName ? `· ${slot.counterpartyName}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-calendar-slot
      className={`absolute top-1 bottom-1 rounded text-white text-xs flex items-center overflow-hidden group select-none ring-2 ring-offset-1 ${isEditing ? 'bg-amber-500 ring-amber-400' : 'bg-primary ring-transparent'}`}
      title={label}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>

      <div
        className="flex-1 flex items-center px-3 cursor-grab active:cursor-grabbing min-w-0"
        {...listeners}
        {...attributes}
        onClick={() => onEdit(slot)}
      >
        <span className="truncate">{label}</span>
      </div>

      <button
        type="button"
        onPointerDown={e => e.stopPropagation()}
        onClick={() => onRemove(slot.id)}
        className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-white/80 hover:text-white shrink-0"
        aria-label="Видалити слот"
      >
        <Trash2 className="h-3 w-3" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-white/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onResizeStart(e, slot.id, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-white/50 rounded" />
      </div>
    </div>
  );
});

// ─── PendingSlotBlock ────────────────────────────────────────────────────────

interface PendingSlotBlockProps {
  pending: PendingSlot;
  onOpen: () => void;
  onCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const PendingSlotBlock = memo(function PendingSlotBlock({
  pending,
  onOpen,
  onCancel,
  onPendingResizeStart,
}: PendingSlotBlockProps) {
  const left = ((pending.startH - HOURS[0]!) / TOTAL_HOURS) * 100;
  const width = ((pending.endH - pending.startH) / TOTAL_HOURS) * 100;

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: PENDING_DRAG_ID,
    data: { isPending: true },
  });

  const style: CSSProperties = {
    left: `${left}%`,
    width: `${width}%`,
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 50 : 10,
  };

  return (
    <div
      ref={setNodeRef}
      data-pending-slot
      className="absolute top-1 bottom-1 bg-primary/20 border-2 border-primary rounded flex items-center overflow-hidden group select-none z-10"
      style={style}
      title="Перетягніть щоб змінити підйомник або час. Натисніть щоб відкрити форму"
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-l flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'start');
        }}
        aria-label="Змінити початок"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>

      <span
        className="flex-1 text-xs text-primary font-medium px-3 truncate cursor-grab active:cursor-grabbing"
        onClick={onOpen}
        {...listeners}
        {...attributes}
      >
        {decimalHoursToHHMM(pending.startH)}–{decimalHoursToHHMM(pending.endH)}
      </span>

      <button
        type="button"
        onPointerDown={e => e.stopPropagation()}
        onClick={e => {
          e.stopPropagation();
          onCancel();
        }}
        className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-primary/70 hover:text-primary shrink-0"
        aria-label="Скасувати"
      >
        <Plus className="h-3 w-3 rotate-45" />
      </button>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize z-20 hover:bg-primary/20 rounded-r flex items-center justify-center"
        onPointerDown={e => {
          e.stopPropagation();
          onPendingResizeStart(e, 'end');
        }}
        aria-label="Змінити кінець"
      >
        <div className="w-0.5 h-4 bg-primary/60 rounded" />
      </div>
    </div>
  );
});

// ─── DroppableLiftRow ────────────────────────────────────────────────────────

interface DroppableLiftRowProps {
  liftId: string;
  liftSlots: CalendarSlot[];
  ghost: GhostSlot | null;
  pending: PendingSlot | null;
  editingSlotId: string | null;
  blockedWidth: number;
  onRemove: (id: string) => void;
  onEdit: (slot: CalendarSlot) => void;
  onResizeStart: (
    e: ReactPointerEvent<HTMLDivElement>,
    slotId: string,
    edge: 'start' | 'end',
  ) => void;
  onPendingOpen: () => void;
  onPendingCancel: () => void;
  onPendingResizeStart: (e: ReactPointerEvent<HTMLDivElement>, edge: 'start' | 'end') => void;
}

const DroppableLiftRow = memo(function DroppableLiftRow({
  liftId,
  liftSlots,
  ghost,
  pending,
  editingSlotId,
  blockedWidth,
  onRemove,
  onEdit,
  onResizeStart,
  onPendingOpen,
  onPendingCancel,
  onPendingResizeStart,
}: DroppableLiftRowProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `lift-${liftId}`, data: { liftId } });

  const showGhost = ghost?.liftId === liftId && ghost.endH > ghost.startH;
  const ghostLeft = showGhost ? ((ghost!.startH - HOURS[0]!) / TOTAL_HOURS) * 100 : 0;
  const ghostWidth = showGhost ? ((ghost!.endH - ghost!.startH) / TOTAL_HOURS) * 100 : 0;
  const showPending = pending?.liftId === liftId;

  return (
    <div
      ref={setNodeRef}
      className={`col-span-12 relative min-h-20 transition-colors ${isOver ? 'bg-primary/5' : ''}`}
      style={{ gridColumn: `2 / span ${TOTAL_HOURS}` }}
      data-lift-id={liftId}
    >
      <div className="flex h-full pointer-events-none">
        {HOURS.map(h => (
          <div key={h} className="flex-1 border-r last:border-r-0 border-border min-h-20" />
        ))}
      </div>

      {blockedWidth > 0 && (
        <div
          className="absolute inset-y-0 left-0 pointer-events-none z-1"
          style={{
            width: `${blockedWidth}%`,
            backgroundImage:
              'repeating-linear-gradient(135deg, transparent 0px, transparent 6px, rgba(0,0,0,0.08) 6px, rgba(0,0,0,0.08) 8px)',
            backgroundColor: 'rgba(0,0,0,0.04)',
          }}
          aria-hidden
        >
          {blockedWidth < 100 && (
            <div className="absolute inset-y-0 right-0 w-0.5 bg-foreground/20" />
          )}
        </div>
      )}

      {showGhost && (
        <div
          className="absolute top-1 bottom-1 bg-primary/30 border-2 border-primary border-dashed rounded pointer-events-none z-5"
          style={{ left: `${ghostLeft}%`, width: `${ghostWidth}%` }}
        >
          <span className="text-xs text-primary px-1.5 font-medium">
            {decimalHoursToHHMM(ghost!.startH)}–{decimalHoursToHHMM(ghost!.endH)}
          </span>
        </div>
      )}

      {showPending && (
        <PendingSlotBlock
          pending={pending!}
          onOpen={onPendingOpen}
          onCancel={onPendingCancel}
          onPendingResizeStart={onPendingResizeStart}
        />
      )}

      {liftSlots.map(s => (
        <DraggableSlot
          key={s.id}
          slot={s}
          isEditing={s.id === editingSlotId}
          onRemove={onRemove}
          onEdit={onEdit}
          onResizeStart={onResizeStart}
        />
      ))}
    </div>
  );
});

// ─── CalendarPage ─────────────────────────────────────────────────────────────

function CalendarPageClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC']);

  const cs = useCalendarState();

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <h1 className="page-title">Календар</h1>
        <div className="flex items-center gap-2">
          {/* View switcher */}
          <div className="flex rounded-lg border border-border overflow-hidden text-sm">
            {(
              [
                ['day', 'День', CalendarDays],
                ['month', 'Місяць', CalendarRange],
                ['stats', 'Статистика', BarChart2],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  cs.setCalView(v);
                  if (v === 'stats') {
                    cs.setShowAdd(false);
                    cs.setEditingSlotId(null);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${cs.calView === v ? 'bg-primary text-primary-foreground' : 'bg-surface text-muted-foreground hover:bg-secondary'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {cs.calView !== 'stats' && (
            <Button
              onClick={() => {
                cs.setPendingSlot(null);
                cs.setEditingSlotId(null);
                cs.setError('');
                cs.setCpDisplay('');
                cs.setForm(EMPTY_FORM);
                cs.setShowAdd(v => !v);
              }}
            >
              <Plus className="h-4 w-4" />
              Слот
            </Button>
          )}
        </div>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Date / month navigation — hidden in stats view */}
        {cs.calView !== 'stats' && (
          <div className="flex items-center gap-4 mb-6">
            {cs.calView === 'month' ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = cs.yearMonth.split('-').map(Number);
                    const d = new Date(y, m - 2, 1);
                    cs.setDate(
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
                    );
                  }}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Попередній
                </Button>
                <span className="text-sm font-medium text-foreground capitalize">
                  {cs.date ? fmtKyivMonthYear(cs.date) : ''}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const [y, m] = cs.yearMonth.split('-').map(Number);
                    const d = new Date(y, m, 1);
                    cs.setDate(
                      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
                    );
                  }}
                >
                  Наступний
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  Цей місяць
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={cs.prevDay}>
                  <ChevronLeft className="h-4 w-4" />
                  Попередній
                </Button>
                <div className="flex items-center gap-2">
                  <DatePickerInput
                    value={cs.date}
                    onChange={cs.setDate}
                    placeholder="Дата"
                    className="w-48"
                  />
                  <span
                    className={`text-sm capitalize ${cs.nowMs && cs.date < toDateString(new Date(cs.nowMs)) ? 'text-destructive-text font-medium' : 'text-muted-foreground'}`}
                  >
                    {formatKyivDate(cs.date)}
                    {cs.nowMs && cs.date < toDateString(new Date(cs.nowMs))
                      ? ' — минулий день'
                      : ''}
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={cs.nextDay}>
                  Наступний
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cs.setDate(toDateString(new Date()))}
                >
                  Сьогодні
                </Button>
              </>
            )}
          </div>
        )}

        {/* ── Add / edit form — hidden in stats view ──────────────────────────── */}
        <CalendarSlotModal
          open={cs.showAdd && cs.calView !== 'stats'}
          onClose={cs.handleModalClose}
          onSaved={cs.handleModalSaved}
          date={cs.date}
          lifts={cs.lifts}
          form={cs.form}
          setForm={cs.setForm}
          editingSlotId={cs.editingSlotId}
          isEditingPast={cs.isEditingPast}
          pendingSlot={cs.pendingSlot}
          setPendingSlot={cs.setPendingSlot}
          formMounted={cs.formMounted}
          formVisible={cs.formVisible}
          formCollapseRef={cs.formCollapseRef}
          formInnerRef={cs.formInnerRef}
          minHour={cs.minHour}
          nowMs={cs.nowMs}
          error={cs.error}
          setError={cs.setError}
          saving={cs.saving}
          setSaving={cs.setSaving}
          cpDisplay={cs.cpDisplay}
          setCpDisplay={cs.setCpDisplay}
        />

        {/* ── Hint — day view only ─────────────────────────────────────────────── */}
        {cs.calView === 'day' &&
          !cs.loading &&
          cs.lifts.length > 0 &&
          !cs.pendingSlot &&
          !cs.showAdd && (
            <p className="text-xs text-muted-foreground mb-2">
              Затисніть і перетягніть по рядку підйомника щоб створити слот. Тягніть краї для зміни
              тривалості. Натисніть на проміжок щоб зберегти.
            </p>
          )}
        {cs.calView === 'day' && cs.pendingSlot && !cs.showAdd && (
          <p className="text-xs text-primary mb-2 font-medium">
            ↑ Налаштуйте проміжок і натисніть на нього щоб відкрити форму збереження.
          </p>
        )}

        {/* ── MONTH VIEW ──────────────────────────────────────────────────────── */}
        {cs.calView === 'month' && (
          <CalendarMonthView
            yearMonth={cs.yearMonth}
            monthSlots={cs.monthSlots}
            monthLoading={cs.monthLoading}
            monthError={cs.monthError}
            nowMs={cs.nowMs}
            onDayClick={dayStr => {
              cs.setDate(dayStr);
              cs.setCalView('day');
            }}
          />
        )}

        {/* ── STATS VIEW ──────────────────────────────────────────────────────── */}
        {cs.calView === 'stats' && (
          <CalendarStatsTab
            lifts={cs.lifts}
            statsSlots={cs.statsSlots}
            statsLoading={cs.statsLoading}
            statsError={cs.statsError}
            statsPeriod={cs.statsPeriod}
            setStatsPeriod={cs.setStatsPeriod}
            statsFrom={cs.statsFrom}
            setStatsFrom={cs.setStatsFrom}
            statsTo={cs.statsTo}
            setStatsTo={cs.setStatsTo}
            statsRangeTooLong={cs.statsRangeTooLong}
            date={cs.date}
            setDate={cs.setDate}
            statsRange={cs.statsRange}
          />
        )}

        {/* ── DAY VIEW ────────────────────────────────────────────────────────── */}
        {cs.calView === 'day' && cs.loading && (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        )}

        {cs.calView === 'day' && !cs.loading && cs.lifts.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
            Немає підйомників. Додайте їх у розділі{' '}
            <a href="/infrastructure" className="text-primary hover:underline">
              Інфраструктура
            </a>
            .
          </div>
        )}

        {cs.calView === 'day' && !cs.loading && cs.lifts.length > 0 && (
          <DndContext
            sensors={cs.sensors}
            onDragEnd={e => {
              void cs.handleDragEnd(e);
            }}
          >
            <div
              ref={cs.timelineRef}
              className="bg-surface border border-border rounded-xl overflow-hidden"
            >
              <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}
              >
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary border-r border-border">
                  Підйомник
                </div>
                {HOURS.map(h => (
                  <div
                    key={h}
                    className="px-1 py-2 text-xs text-center text-muted-foreground bg-secondary border-r border-border last:border-r-0"
                  >
                    {pad(h)}:00
                  </div>
                ))}
              </div>

              {cs.lifts.map((lift: Lift) => (
                <div
                  key={lift.id}
                  className="grid border-b border-border last:border-b-0"
                  style={{ gridTemplateColumns: `${SIDEBAR_W}px repeat(${HOURS.length}, 1fr)` }}
                >
                  <div className="px-3 py-3 min-h-20 bg-secondary border-r border-border flex flex-col justify-center gap-0.5">
                    <span className="text-sm font-medium text-foreground leading-tight">
                      {lift.name}
                    </span>
                    {cs.nextSlotByLift.get(lift.id) === 'now' ? (
                      <span className="text-[10px] font-medium text-success-text leading-none">
                        ● зараз
                      </span>
                    ) : cs.nextSlotByLift.has(lift.id) ? (
                      <span className="text-[10px] text-muted-foreground leading-none">
                        ↓ {fmtTime(cs.nextSlotByLift.get(lift.id)!)}
                      </span>
                    ) : null}
                  </div>
                  <DroppableLiftRow
                    liftId={lift.id}
                    liftSlots={cs.slotsByLift.get(lift.id) ?? cs.EMPTY_SLOTS}
                    ghost={cs.ghost}
                    pending={cs.pendingSlot}
                    editingSlotId={cs.editingSlotId}
                    blockedWidth={cs.blockedWidth}
                    onRemove={cs.removeSlot}
                    onEdit={cs.handleEditSlot}
                    onResizeStart={cs.handleResizeStart}
                    onPendingOpen={cs.openFormFromPending}
                    onPendingCancel={cs.cancelPending}
                    onPendingResizeStart={cs.handlePendingResizeStart}
                  />
                </div>
              ))}
            </div>
          </DndContext>
        )}

        {/* Unassigned slots — day view only */}
        {cs.calView === 'day' && cs.unassignedSlots.length > 0 && (
          <div className="mt-6 bg-surface border border-border rounded-xl p-5">
            <h3 className="font-semibold text-foreground mb-3 text-sm">Без підйомника</h3>
            <div className="space-y-2">
              {cs.unassignedSlots.map(s => (
                <div
                  key={s.id}
                  className="flex items-center justify-between px-3 py-2 bg-secondary rounded-lg"
                >
                  <div>
                    <span className="text-sm text-foreground">
                      {fmtTime(s.startAt)} – {fmtTime(s.endAt)}
                    </span>
                    {s.workOrderNumber && (
                      <span className="ml-2 text-xs text-primary">Наряд {s.workOrderNumber}</span>
                    )}
                    {s.counterpartyName && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {s.counterpartyName}
                      </span>
                    )}
                    {s.notes && (
                      <span className="ml-2 text-xs text-muted-foreground">{s.notes}</span>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => cs.removeSlot(s.id)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        <ConfirmDialog {...cs.dialogProps} />
      </div>
      {/* end scrollable content */}
    </div>
  );
}

export default function CalendarPage() {
  return (
    <Suspense fallback={null}>
      <CalendarPageClient />
    </Suspense>
  );
}
