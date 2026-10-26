'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Car, Eye, EyeOff, GitMerge, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConfirm } from '@/hooks/useConfirm';
import { useAuth, useRequireAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  VEHICLE_DIRECTORY_MANAGE_ROLES,
  VEHICLE_DIRECTORY_WRITE_ROLES,
  useCreateVehicleMake,
  useCreateVehicleModel,
  useDeleteVehicleMake,
  useDeleteVehicleModel,
  useMergeVehicleMake,
  useMergeVehicleModel,
  useRenameVehicleMake,
  useRenameVehicleModel,
  useRestoreVehicleMake,
  useRestoreVehicleModel,
  useVehicleMakes,
  useVehicleModels,
} from '@/hooks/api/useVehicleMakes';

type Kind = 'make' | 'model';
interface Entry {
  id: string;
  name: string;
  vehicleCount: number;
  deletedAt?: string | null;
}
interface NameDialog {
  kind: Kind;
  id: string | null;
  name: string;
}
interface MergeDialog {
  kind: Kind;
  source: Entry;
  targetId: string;
}
/** Відмова видалити (BR-VEH-009): текст сервера + пропозиція злити цей запис. */
interface PageError {
  message: string;
  merge?: { kind: Kind; source: Entry };
}

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

/**
 * Довідник марок і моделей авто (BR-VEH-006…013): ліворуч марки, праворуч моделі обраної марки.
 * Додати й перейменувати — власник, адмін, приймальник; видалити, відновити, злити — власник і адмін.
 * Марку чи модель з живими авто сервер не видаляє (400) — показуємо його текст і кнопку злиття.
 */
export default function VehicleMakesTab() {
  // Ті самі ролі, що й список контрагентів (сторінка), — механік обирає марку лише у формі авто.
  useRequireAuth(['OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT']);
  const { t } = useTranslation('counterparties');
  const { employee } = useAuth();
  const role = employee?.role ?? '';
  const canWrite = VEHICLE_DIRECTORY_WRITE_ROLES.includes(role);
  const canManage = VEHICLE_DIRECTORY_MANAGE_ROLES.includes(role);
  const searchParams = useSearchParams();
  const { confirm, dialogProps } = useConfirm();

  const [showDeleted, setShowDeleted] = useState(false);
  const withDeleted = showDeleted && canManage;
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('make'));
  const [pageError, setPageError] = useState<PageError | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameError, setNameError] = useState('');
  const [mergeDialog, setMergeDialog] = useState<MergeDialog | null>(null);
  const [mergeError, setMergeError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  // `fresh`: лічильники авто міняють записи авто поза вкладкою — список перечитується щоразу (Bug #957).
  const makesQuery = useVehicleMakes(withDeleted, { fresh: true });
  const makes = makesQuery.data ?? [];
  const selectedMake = makes.find(m => m.id === selectedId) ?? null;
  const modelsQuery = useVehicleModels(selectedMake?.id ?? null, withDeleted, { fresh: true });
  const models = modelsQuery.data ?? [];

  const createMake = useCreateVehicleMake();
  const renameMake = useRenameVehicleMake();
  const deleteMake = useDeleteVehicleMake();
  const restoreMake = useRestoreVehicleMake();
  const mergeMake = useMergeVehicleMake();
  const createModel = useCreateVehicleModel();
  const renameModel = useRenameVehicleModel();
  const deleteModel = useDeleteVehicleModel();
  const restoreModel = useRestoreVehicleModel();
  const mergeModel = useMergeVehicleModel();

  const needle = search.trim().toLowerCase();
  const visibleMakes = needle ? makes.filter(m => m.name.toLowerCase().includes(needle)) : makes;
  const label = (kind: Kind, key: string) => t(`vehicleMakesTab.${kind}.${key}`);

  const nameSaving =
    createMake.isPending || renameMake.isPending || createModel.isPending || renameModel.isPending;

  const saveName = async () => {
    // Enter у полі назви повторює збереження, поки перший запит ще йде (друга марка → 409).
    if (!nameDialog || nameSaving) return;
    const name = nameDialog.name.trim();
    if (!name) {
      setNameError(label(nameDialog.kind, 'nameRequired'));
      return;
    }
    setNameError('');
    try {
      if (nameDialog.kind === 'make') {
        if (nameDialog.id) await renameMake.mutateAsync({ id: nameDialog.id, name });
        else setSelectedId((await createMake.mutateAsync(name)).id);
      } else if (nameDialog.id) {
        await renameModel.mutateAsync({ id: nameDialog.id, name });
      } else if (selectedMake) {
        await createModel.mutateAsync({ makeId: selectedMake.id, name });
      }
      setNameDialog(null);
      toast.success(t('vehicleMakesTab.saved'));
    } catch (e: unknown) {
      setNameError(errorText(e, t('vehicleMakesTab.saveFailed')));
    }
  };

  const remove = async (kind: Kind, entry: Entry) => {
    const ok = await confirm({
      title: label(kind, 'confirmDeleteTitle'),
      message: t('vehicleMakesTab.confirmDeleteMessage', { name: entry.name }),
      variant: 'destructive',
    });
    if (!ok) return;
    setPageError(null);
    setBusyId(entry.id);
    try {
      if (kind === 'make') await deleteMake.mutateAsync(entry.id);
      else await deleteModel.mutateAsync(entry.id);
      toast.success(t('vehicleMakesTab.deleted'));
    } catch (e: unknown) {
      // Єдина причина відмови, яку виправляє користувач, — живі авто (BR-VEH-009): поряд із
      // текстом сервера — злиття цього запису.
      setPageError({
        message: errorText(e, t('vehicleMakesTab.deleteFailed')),
        merge: { kind, source: entry },
      });
    } finally {
      setBusyId(null);
    }
  };

  const restore = async (kind: Kind, entry: Entry) => {
    if (busyId) return;
    setPageError(null);
    setBusyId(entry.id);
    try {
      if (kind === 'make') await restoreMake.mutateAsync(entry.id);
      else await restoreModel.mutateAsync(entry.id);
      toast.success(t('vehicleMakesTab.restored'));
    } catch (e: unknown) {
      setPageError({ message: errorText(e, t('vehicleMakesTab.restoreFailed')) });
    } finally {
      setBusyId(null);
    }
  };

  const openMerge = (kind: Kind, source: Entry) => {
    setPageError(null);
    setMergeError('');
    setMergeDialog({ kind, source, targetId: '' });
  };

  const mergeTargets = (dialog: MergeDialog): Entry[] =>
    (dialog.kind === 'make' ? makes : models).filter(
      e => e.id !== dialog.source.id && !e.deletedAt,
    );

  const runMerge = async () => {
    if (!mergeDialog?.targetId) return;
    const { kind, source, targetId } = mergeDialog;
    const target = mergeTargets(mergeDialog).find(e => e.id === targetId);
    const ok = await confirm({
      title: label(kind, 'mergeConfirmTitle'),
      message: t('vehicleMakesTab.mergeConfirmMessage', {
        source: source.name,
        target: target?.name ?? '',
        count: source.vehicleCount,
      }),
      confirmLabel: t('vehicleMakesTab.mergeAction'),
      variant: 'destructive',
    });
    if (!ok) return;
    setMergeError('');
    try {
      if (kind === 'make') {
        await mergeMake.mutateAsync({ id: source.id, targetId });
        setSelectedId(targetId);
      } else {
        await mergeModel.mutateAsync({ id: source.id, targetId });
      }
      setMergeDialog(null);
      toast.success(t('vehicleMakesTab.merged'));
    } catch (e: unknown) {
      setMergeError(errorText(e, t('vehicleMakesTab.mergeFailed')));
    }
  };

  const rowActions = (kind: Kind, entry: Entry) => {
    if (entry.deletedAt) {
      return canManage ? (
        <Button
          variant="ghost"
          size="sm"
          loading={busyId === entry.id}
          disabled={busyId === entry.id}
          onClick={() => void restore(kind, entry)}
          className="text-success/70 hover:text-success hover:bg-success/10"
          title={t('vehicleMakesTab.restore')}
          aria-label={`${t('vehicleMakesTab.restore')}: ${entry.name}`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      ) : null;
    }
    return (
      <>
        {canWrite && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNameError('');
              setNameDialog({ kind, id: entry.id, name: entry.name });
            }}
            title={t('vehicleMakesTab.rename')}
            aria-label={`${t('vehicleMakesTab.rename')}: ${entry.name}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openMerge(kind, entry)}
              title={t('vehicleMakesTab.mergeInto')}
              aria-label={`${t('vehicleMakesTab.mergeInto')}: ${entry.name}`}
            >
              <GitMerge className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busyId === entry.id}
              onClick={() => void remove(kind, entry)}
              className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              title={t('vehicleMakesTab.delete')}
              aria-label={`${t('vehicleMakesTab.delete')}: ${entry.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </>
    );
  };

  const loadingRow = (span: number) => (
    <TableRow>
      <TableCell colSpan={span} className="py-10 text-center">
        <div className="flex justify-center">
          <Spinner size="md" />
        </div>
      </TableCell>
    </TableRow>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2" data-testid="vehicle-makes-tab">
      {pageError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5"
        >
          <span className="flex-1">{pageError.message}</span>
          {pageError.merge && canManage && (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<GitMerge className="h-3.5 w-3.5" />}
              onClick={() =>
                pageError.merge && openMerge(pageError.merge.kind, pageError.merge.source)
              }
            >
              {t('vehicleMakesTab.mergeInto')}
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">{t('vehicleMakesTab.description')}</p>
        {canManage && (
          <Button
            variant="outline"
            size="icon-sm"
            title={
              showDeleted ? t('vehicleMakesTab.hideDeleted') : t('vehicleMakesTab.showDeleted')
            }
            aria-label={
              showDeleted ? t('vehicleMakesTab.hideDeleted') : t('vehicleMakesTab.showDeleted')
            }
            aria-pressed={showDeleted}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        )}
      </div>

      <div className="grid flex-1 min-h-0 gap-4 md:grid-cols-2">
        {/* Марки */}
        <section
          className="flex flex-col min-h-0 gap-2"
          aria-label={t('vehicleMakesTab.make.title')}
        >
          <div className="flex items-center gap-2 shrink-0">
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('vehicleMakesTab.searchPlaceholder')}
              aria-label={t('vehicleMakesTab.searchPlaceholder')}
              className="h-8 text-[13px]"
            />
            {canWrite && (
              <Button
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setNameError('');
                  setNameDialog({ kind: 'make', id: null, name: search.trim() });
                }}
              >
                {t('vehicleMakesTab.make.add')}
              </Button>
            )}
          </div>
          <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('vehicleMakesTab.make.colName')}</TableHead>
                  <TableHead className="text-right">{t('vehicleMakesTab.colVehicles')}</TableHead>
                  <TableHead className="text-right">{t('vehicleMakesTab.colModels')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {makesQuery.isLoading && loadingRow(4)}
                {makesQuery.isError && (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-destructive-text">
                      {errorText(makesQuery.error, t('vehicleMakesTab.loadFailed'))}
                    </TableCell>
                  </TableRow>
                )}
                {makesQuery.isSuccess && visibleMakes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-0">
                      <EmptyState icon={Car} size="sm" title={t('vehicleMakesTab.make.empty')} />
                    </TableCell>
                  </TableRow>
                )}
                {visibleMakes.map(m => (
                  <TableRow
                    key={m.id}
                    data-testid="vehicle-make-row"
                    // Моделі марки — кліком по будь-якому місцю рядка; кнопка з назвою лишається для
                    // вибору з клавіатури.
                    onClick={() => setSelectedId(m.id)}
                    className={cn(
                      m.id === selectedMake?.id && 'bg-primary/5',
                      m.deletedAt && 'opacity-60',
                    )}
                  >
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setSelectedId(m.id)}
                        aria-pressed={m.id === selectedMake?.id}
                        className="text-left text-[13px] font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                      >
                        {m.name}
                      </button>
                      {m.deletedAt && (
                        <Badge variant="secondary" className="ml-2">
                          {t('badges.deleted')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-[13px] text-muted-foreground">
                      {m.vehicleCount}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-[13px] text-muted-foreground">
                      {m.modelCount}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {rowActions('make', m)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        {/* Моделі обраної марки */}
        <section
          className="flex flex-col min-h-0 gap-2"
          aria-label={t('vehicleMakesTab.model.title')}
        >
          <div className="flex items-center justify-between gap-2 shrink-0 min-h-8">
            <h2 className="text-[13px] font-semibold">
              {selectedMake
                ? t('vehicleMakesTab.model.titleOf', { make: selectedMake.name })
                : t('vehicleMakesTab.model.title')}
            </h2>
            {canWrite && selectedMake && !selectedMake.deletedAt && (
              <Button
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setNameError('');
                  setNameDialog({ kind: 'model', id: null, name: '' });
                }}
              >
                {t('vehicleMakesTab.model.add')}
              </Button>
            )}
          </div>
          <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('vehicleMakesTab.model.colName')}</TableHead>
                  <TableHead className="text-right">{t('vehicleMakesTab.colVehicles')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {!selectedMake && (
                  <TableRow>
                    <TableCell colSpan={3} className="p-0">
                      <EmptyState
                        icon={Car}
                        size="sm"
                        title={t('vehicleMakesTab.model.pickMake')}
                      />
                    </TableCell>
                  </TableRow>
                )}
                {selectedMake && modelsQuery.isLoading && loadingRow(3)}
                {selectedMake && modelsQuery.isError && (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-destructive-text">
                      {errorText(modelsQuery.error, t('vehicleMakesTab.loadFailed'))}
                    </TableCell>
                  </TableRow>
                )}
                {selectedMake && modelsQuery.isSuccess && models.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="p-0">
                      <EmptyState icon={Car} size="sm" title={t('vehicleMakesTab.model.empty')} />
                    </TableCell>
                  </TableRow>
                )}
                {selectedMake &&
                  models.map(m => (
                    <TableRow
                      key={m.id}
                      data-testid="vehicle-model-row"
                      className={cn(m.deletedAt && 'opacity-60')}
                    >
                      <TableCell className="text-[13px]">
                        {m.name}
                        {m.deletedAt && (
                          <Badge variant="secondary" className="ml-2">
                            {t('badges.deleted')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-[13px] text-muted-foreground">
                        {m.vehicleCount}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {rowActions('model', m)}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>

      <Modal
        open={nameDialog !== null}
        onClose={() => setNameDialog(null)}
        title={
          nameDialog
            ? label(nameDialog.kind, nameDialog.id ? 'renameTitle' : 'createTitle')
            : undefined
        }
        footer={
          <Button
            onClick={() => void saveName()}
            loading={nameSaving}
            disabled={!nameDialog?.name.trim()}
            className="w-full"
          >
            {t('vehicleMakesTab.save')}
          </Button>
        }
      >
        {nameError && (
          <div
            role="alert"
            className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
          >
            {nameError}
          </div>
        )}
        {nameDialog && (
          <Input
            label={label(nameDialog.kind, 'nameLabel')}
            required
            value={nameDialog.name}
            maxLength={100}
            onChange={e => setNameDialog(d => (d ? { ...d, name: e.target.value } : d))}
            onKeyDown={e => {
              if (e.key === 'Enter') void saveName();
            }}
            autoFocus
            className="h-8 text-[13px]"
          />
        )}
      </Modal>

      <Modal
        open={mergeDialog !== null}
        onClose={() => setMergeDialog(null)}
        title={mergeDialog ? label(mergeDialog.kind, 'mergeTitle') : undefined}
        footer={
          <Button
            onClick={() => void runMerge()}
            loading={mergeMake.isPending || mergeModel.isPending}
            disabled={!mergeDialog?.targetId}
            className="w-full"
          >
            {t('vehicleMakesTab.mergeAction')}
          </Button>
        }
      >
        {mergeError && (
          <div
            role="alert"
            className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2"
          >
            {mergeError}
          </div>
        )}
        {mergeDialog && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted-foreground">
              {t('vehicleMakesTab.mergeHint', {
                source: mergeDialog.source.name,
                count: mergeDialog.source.vehicleCount,
              })}
            </p>
            <Select
              id="vehicle-directory-merge-target"
              label={label(mergeDialog.kind, 'mergeTarget')}
              required
              value={mergeDialog.targetId}
              onChange={e => setMergeDialog(d => (d ? { ...d, targetId: e.target.value } : d))}
            >
              <option value="">{t('vehicleMakesTab.mergeTargetPlaceholder')}</option>
              {mergeTargets(mergeDialog).map(e => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
