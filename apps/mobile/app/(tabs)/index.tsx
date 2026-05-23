import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { apiFetch } from '../../src/lib/api';

interface WorkOrder {
  id: string;
  number: string;
  status: string;
  vehicleSummary?: string;
  counterpartyName?: string;
  totalAmount: number;
  plannedAt?: string | null;
  createdAt: string;
}

interface Paginated {
  items: WorkOrder[];
  total: number;
  page: number;
  limit: number;
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

const STATUS_FILTER_TABS = ['', 'IN_PROGRESS', 'APPROVED', 'ON_HOLD', 'COMPLETED'] as const;
const STATUS_FILTER_LABELS: Record<string, string> = {
  '': 'Всі', IN_PROGRESS: 'В роботі', APPROVED: 'Затверджено',
  ON_HOLD: 'Призупинено', COMPLETED: 'Виконано',
};

export default function MyWorkOrdersScreen() {
  const router = useRouter();
  const [data, setData] = useState<Paginated | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (reset = false) => {
    const p = new URLSearchParams({ page: String(reset ? 1 : page), limit: '20' });
    if (statusFilter) p.set('status', statusFilter);

    try {
      const res = await apiFetch<Paginated>(`/work-orders?${p}`);
      if (reset || page === 1) {
        setData(res);
        setPage(1);
      } else {
        setData(prev => prev ? { ...res, items: [...prev.items, ...res.items] } : res);
      }
    } catch {}
  }, [page, statusFilter]);

  useEffect(() => {
    setLoading(true);
    load(true).finally(() => setLoading(false));
  }, [statusFilter]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const loadMore = async () => {
    if (!data || loadingMore) return;
    const totalPages = Math.ceil(data.total / data.limit);
    if (page >= totalPages) return;
    setLoadingMore(true);
    setPage(p => p + 1);
    await load(false);
    setLoadingMore(false);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Status filter tabs */}
      <View style={styles.filterRow}>
        {STATUS_FILTER_TABS.map(s => (
          <TouchableOpacity
            key={s}
            onPress={() => setStatusFilter(s)}
            style={[styles.filterTab, statusFilter === s && styles.filterTabActive]}
          >
            <Text style={[styles.filterTabText, statusFilter === s && styles.filterTabTextActive]}>
              {STATUS_FILTER_LABELS[s]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <FlatList
        data={data?.items ?? []}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2563eb" />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>Нарядів немає</Text>
          </View>
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#2563eb" style={{ marginVertical: 12 }} /> : null}
        renderItem={({ item: wo }) => (
          <TouchableOpacity
            style={styles.card}
            onPress={() => router.push(`/work-order/${wo.id}`)}
            activeOpacity={0.7}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.woNumber}>{wo.number}</Text>
              <View style={[styles.badge, { backgroundColor: STATUS_COLORS[wo.status] + '20' }]}>
                <Text style={[styles.badgeText, { color: STATUS_COLORS[wo.status] }]}>
                  {STATUS_LABELS[wo.status] ?? wo.status}
                </Text>
              </View>
            </View>

            <Text style={styles.clientName} numberOfLines={1}>
              {wo.counterpartyName ?? '—'}
            </Text>
            <Text style={styles.vehicleText} numberOfLines={1}>
              {wo.vehicleSummary ?? '—'}
            </Text>

            <View style={styles.cardFooter}>
              <Text style={styles.amount}>
                {wo.totalAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
              </Text>
              {wo.plannedAt && (
                <Text style={styles.date}>📅 {formatDate(wo.plannedAt)}</Text>
              )}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 },
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  filterTab: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterTabActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  filterTabText: { fontSize: 12, color: '#6b7280', fontWeight: '500' },
  filterTabTextActive: { color: '#fff' },
  list: { padding: 12, gap: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  woNumber: { fontSize: 15, fontWeight: '700', color: '#111827' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  clientName: { fontSize: 14, color: '#374151', fontWeight: '500', marginBottom: 2 },
  vehicleText: { fontSize: 12, color: '#6b7280', marginBottom: 8 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { fontSize: 15, fontWeight: '700', color: '#111827' },
  date: { fontSize: 11, color: '#9ca3af' },
  emptyText: { color: '#9ca3af', fontSize: 14 },
});
