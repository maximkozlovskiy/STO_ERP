import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiFetch } from '../../src/lib/api';

interface WorkOrderLine {
  id: string; workName?: string; employeeName?: string;
  normoHours: number; price: number; amount: number; notes?: string | null;
}
interface WorkOrderPart {
  id: string; goodName?: string; quantity: number; price: number; amount: number;
}
interface WorkOrderDetail {
  id: string; number: string; status: string;
  vehicleSummary?: string; counterpartyName?: string; branchName?: string;
  description?: string | null; inMileage?: number | null; outMileage?: number | null;
  plannedAt?: string | null; completedAt?: string | null;
  totalLabor: number; totalParts: number; totalAmount: number; paidAmount: number;
  lines: WorkOrderLine[];
  parts: WorkOrderPart[];
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ESTIMATE: 'Кошторис', APPROVED: 'Затверджено',
  IN_PROGRESS: 'В роботі', ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
  INVOICED: 'Виставлено', PAID: 'Оплачено', ARCHIVED: 'Архів', CANCELLED: 'Скасовано',
};

const STATUS_COLORS: Record<string, string> = {
  DRAFT: '#9ca3af', ESTIMATE: '#d97706', APPROVED: '#2563eb',
  IN_PROGRESS: '#7c3aed', ON_HOLD: '#ea580c', COMPLETED: '#16a34a',
  INVOICED: '#0d9488', PAID: '#059669', ARCHIVED: '#6b7280', CANCELLED: '#dc2626',
};

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ESTIMATE', 'CANCELLED'],
  ESTIMATE: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: ['INVOICED'],
  INVOICED: ['PAID'],
  PAID: ['ARCHIVED'],
};

const TRANSITION_LABELS: Record<string, string> = {
  ESTIMATE: 'Кошторис', APPROVED: 'Затвердити', IN_PROGRESS: '▶ В роботу',
  ON_HOLD: '⏸ Призупинити', COMPLETED: '✓ Виконано', INVOICED: 'Виставити рахунок',
  PAID: 'Оплачено', ARCHIVED: 'В архів', CANCELLED: '✕ Скасувати', DRAFT: '↩ В чернетку',
};

const TRANSITION_BG: Record<string, string> = {
  IN_PROGRESS: '#7c3aed', COMPLETED: '#16a34a', PAID: '#059669',
  CANCELLED: '#dc2626', APPROVED: '#2563eb', ON_HOLD: '#ea580c',
};

export default function WorkOrderDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [wo, setWo] = useState<WorkOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<WorkOrderDetail>(`/work-orders/${id}`);
      setWo(res);
    } catch {
      Alert.alert('Помилка', 'Не вдалося завантажити наряд');
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const doTransition = (newStatus: string) => {
    const label = STATUS_LABELS[newStatus] ?? newStatus;
    Alert.alert(
      'Зміна статусу',
      `Перевести наряд у статус "${label}"?`,
      [
        { text: 'Скасувати', style: 'cancel' },
        {
          text: 'Підтвердити',
          style: newStatus === 'CANCELLED' ? 'destructive' : 'default',
          onPress: async () => {
            setTransitioning(true);
            try {
              await apiFetch(`/work-orders/${id}/transition`, {
                method: 'POST',
                body: JSON.stringify({ status: newStatus }),
              });
              await load();
            } catch (e: unknown) {
              Alert.alert('Помилка', e instanceof Error ? e.message : 'Не вдалося змінити статус');
            } finally {
              setTransitioning(false);
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!wo) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Наряд не знайдено</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Назад</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const allowedTransitions = TRANSITIONS[wo.status] ?? [];
  const statusColor = STATUS_COLORS[wo.status] ?? '#6b7280';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563eb" />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.woNumber}>{wo.number}</Text>
          <View style={[styles.badge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>
              {STATUS_LABELS[wo.status] ?? wo.status}
            </Text>
          </View>
        </View>
        <Text style={styles.clientText}>{wo.counterpartyName ?? '—'}</Text>
        <Text style={styles.vehicleText}>{wo.vehicleSummary ?? '—'}</Text>
      </View>

      {/* FSM Buttons */}
      {allowedTransitions.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Змінити статус</Text>
          <View style={styles.transitionRow}>
            {allowedTransitions.map(s => (
              <TouchableOpacity
                key={s}
                onPress={() => doTransition(s)}
                disabled={transitioning}
                style={[styles.transitionBtn, { backgroundColor: TRANSITION_BG[s] ?? '#6b7280' }]}
                activeOpacity={0.8}
              >
                <Text style={styles.transitionBtnText}>
                  {transitioning ? '...' : (TRANSITION_LABELS[s] ?? s)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Totals */}
      <View style={styles.totalsRow}>
        <TotalCard label="Роботи" value={wo.totalLabor} />
        <TotalCard label="Запчастини" value={wo.totalParts} />
        <TotalCard label="Разом" value={wo.totalAmount} highlight />
      </View>

      {/* Info */}
      {(wo.inMileage != null || wo.plannedAt || wo.description) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Деталі</Text>
          <View style={styles.infoCard}>
            {wo.inMileage != null && <InfoRow label="Пробіг (вхід)" value={`${wo.inMileage.toLocaleString('uk-UA')} км`} />}
            {wo.outMileage != null && <InfoRow label="Пробіг (вихід)" value={`${wo.outMileage.toLocaleString('uk-UA')} км`} />}
            {wo.plannedAt && <InfoRow label="Заплановано" value={fmtDT(wo.plannedAt)} />}
            {wo.completedAt && <InfoRow label="Виконано" value={fmtDT(wo.completedAt)} />}
            {wo.branchName && <InfoRow label="Філія" value={wo.branchName} />}
            {wo.description && <InfoRow label="Опис" value={wo.description} />}
          </View>
        </View>
      )}

      {/* Lines */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Роботи ({wo.lines.length})</Text>
        {wo.lines.length === 0
          ? <Text style={styles.emptyText}>Роботи не додані</Text>
          : (
            <View style={styles.itemsCard}>
              {wo.lines.map((l, i) => (
                <View key={l.id} style={[styles.item, i > 0 && styles.itemBorder]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{l.workName ?? '—'}</Text>
                    <Text style={styles.itemSub}>{l.employeeName} · {l.normoHours} год</Text>
                    {l.notes ? <Text style={styles.itemSub}>{l.notes}</Text> : null}
                  </View>
                  <Text style={styles.itemAmount}>{fmtMoney(l.amount)}</Text>
                </View>
              ))}
            </View>
          )}
      </View>

      {/* Parts */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Запчастини ({wo.parts.length})</Text>
        {wo.parts.length === 0
          ? <Text style={styles.emptyText}>Запчастини не додані</Text>
          : (
            <View style={styles.itemsCard}>
              {wo.parts.map((p, i) => (
                <View key={p.id} style={[styles.item, i > 0 && styles.itemBorder]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{p.goodName ?? '—'}</Text>
                    <Text style={styles.itemSub}>{p.quantity} шт × {fmtMoney(p.price)}</Text>
                  </View>
                  <Text style={styles.itemAmount}>{fmtMoney(p.amount)}</Text>
                </View>
              ))}
            </View>
          )}
      </View>
    </ScrollView>
  );
}

function TotalCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <View style={[styles.totalCard, highlight && styles.totalCardHL]}>
      <Text style={[styles.totalLabel, highlight && styles.totalLabelHL]}>{label}</Text>
      <Text style={[styles.totalValue, highlight && styles.totalValueHL]}>{fmtMoney(value)}</Text>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

function fmtMoney(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2 }) + ' ₴';
}

function fmtDT(iso: string) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mn = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${mn}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: '#9ca3af', fontSize: 16, marginBottom: 16 },
  backBtn: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#f3f4f6', borderRadius: 8 },
  backBtnText: { color: '#374151', fontSize: 14 },

  header: { backgroundColor: '#fff', borderRadius: 12, padding: 16, marginBottom: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  woNumber: { fontSize: 20, fontWeight: '700', color: '#111827' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  clientText: { fontSize: 15, fontWeight: '500', color: '#374151', marginBottom: 2 },
  vehicleText: { fontSize: 13, color: '#6b7280' },

  section: { marginBottom: 12 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },

  transitionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  transitionBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  transitionBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  totalsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  totalCard: { flex: 1, backgroundColor: '#fff', borderRadius: 10, padding: 10, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  totalCardHL: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe' },
  totalLabel: { fontSize: 10, color: '#9ca3af', fontWeight: '500', marginBottom: 4, textTransform: 'uppercase' },
  totalLabelHL: { color: '#2563eb' },
  totalValue: { fontSize: 13, fontWeight: '700', color: '#111827' },
  totalValueHL: { color: '#1d4ed8', fontSize: 14 },

  infoCard: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  infoLabel: { fontSize: 13, color: '#6b7280' },
  infoValue: { fontSize: 13, color: '#111827', fontWeight: '500', maxWidth: '60%', textAlign: 'right' },

  itemsCard: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1 },
  item: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12 },
  itemBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  itemName: { fontSize: 14, fontWeight: '500', color: '#111827', marginBottom: 2 },
  itemSub: { fontSize: 12, color: '#9ca3af' },
  itemAmount: { fontSize: 14, fontWeight: '600', color: '#111827', marginLeft: 8 },

  emptyText: { color: '#9ca3af', fontSize: 13, fontStyle: 'italic' },
});
