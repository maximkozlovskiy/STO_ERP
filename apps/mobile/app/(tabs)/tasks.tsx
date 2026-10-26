import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  SectionList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { formatKyivDateTime, groupTasksByDue, isTaskOverdueAt } from '@sto/shared';
import { database } from '../../src/lib/database';
import { syncTasks, type TaskSyncResult } from '../../src/lib/sync';
import {
  taskLinkSummary,
  taskPriorityBadge,
  taskStatusBadge,
  toTaskView,
  type TaskView,
} from '../../src/lib/task-ui';
import type { TaskModel } from '../../src/models/TaskModel';

/** Як часто перераховувати групи: задача стає простроченою з плином часу (BR-TASK-005). */
const REGROUP_INTERVAL_MS = 60_000;

const LOCAL_DB_ERROR = 'Не вдалося прочитати задачі з пам’яті планшета — потягніть донизу ще раз';

function syncNotice(result: TaskSyncResult): string | null {
  if (result.pull.status === 'offline') {
    return 'Немає зв’язку з сервером — показано задачі, збережені на планшеті';
  }
  if (result.pull.status === 'error') return `Не вдалося оновити задачі: ${result.pull.message}`;
  return null;
}

function showRejections(result: TaskSyncResult) {
  if (result.rejected.length === 0) return;
  Alert.alert(
    'Сервер не прийняв зміну статусу',
    result.rejected.map(r => `«${r.title}»: ${r.message}`).join('\n'),
  );
}

export default function MyTasksScreen() {
  const router = useRouter();
  const [items, setItems] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const mounted = useRef(true);

  const loadFromDb = useCallback(async () => {
    const records = await database.get<TaskModel>('tasks').query().fetch();
    if (mounted.current) setItems(records.map(toTaskView));
  }, []);

  const runSync = useCallback(async () => {
    const result = await syncTasks();
    if (!mounted.current) return;
    setNotice(syncNotice(result));
    showRejections(result);
    setNow(new Date());
    await loadFromDb();
  }, [loadFromDb]);

  useEffect(() => {
    mounted.current = true;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), REGROUP_INTERVAL_MS);
    void (async () => {
      try {
        await loadFromDb();
      } finally {
        if (mounted.current) setLoading(false);
      }
      await runSync();
    })().catch(() => {
      if (mounted.current) setNotice(LOCAL_DB_ERROR);
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [loadFromDb, runSync]);

  // Повернулись з екрана задачі — статус могли змінити там.
  useFocusEffect(
    useCallback(() => {
      void loadFromDb();
    }, [loadFromDb]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await runSync();
    } catch {
      if (mounted.current) setNotice(LOCAL_DB_ERROR);
    } finally {
      setRefreshing(false);
    }
  };

  const sections = useMemo(
    () =>
      now
        ? groupTasksByDue(items, now).map(g => ({
            key: g.key,
            title: `${g.label} (${g.items.length})`,
            data: g.items,
          }))
        : [],
    [items, now],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {notice && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}
      <SectionList
        sections={sections}
        keyExtractor={item => item.remoteId}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor="#2563eb"
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>Задач немає</Text>
            <Text style={styles.emptyHint}>Потягніть донизу, щоб оновити</Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, section.key === 'OVERDUE' && styles.overdueText]}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            overdue={now ? isTaskOverdueAt(item, now) : false}
            onPress={() => router.push(`/task/${item.remoteId}`)}
          />
        )}
      />
    </View>
  );
}

function TaskCard({
  task,
  overdue,
  onPress,
}: {
  task: TaskView;
  overdue: boolean;
  onPress: () => void;
}) {
  const status = taskStatusBadge(task.status);
  const priority = taskPriorityBadge(task.priority);
  const link = taskLinkSummary(task);
  return (
    <TouchableOpacity
      style={[styles.card, overdue && styles.cardOverdue]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.title} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={[styles.badge, { backgroundColor: status.color + '20' }]}>
          <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
        </View>
      </View>

      {link !== '' && (
        <Text style={styles.linkText} numberOfLines={1}>
          {link}
        </Text>
      )}

      <View style={styles.cardFooter}>
        <View style={[styles.badge, { backgroundColor: priority.color + '20' }]}>
          <Text style={[styles.badgeText, { color: priority.color }]}>{priority.label}</Text>
        </View>
        <Text style={[styles.due, overdue && styles.overdueText]}>
          {task.dueAt != null ? `Термін: ${formatKyivDateTime(task.dueAt)}` : 'Без терміну'}
        </Text>
      </View>

      {task.isDirty && <Text style={styles.dirtyText}>Не відправлено на сервер</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 },
  notice: {
    backgroundColor: '#fffbeb',
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  noticeText: { color: '#92400e', fontSize: 13 },
  list: { padding: 12, gap: 10 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 2,
  },
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
  cardOverdue: { borderLeftWidth: 4, borderLeftColor: '#dc2626' },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 6,
  },
  title: { flex: 1, fontSize: 15, fontWeight: '700', color: '#111827' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  linkText: { fontSize: 13, color: '#374151', marginBottom: 8 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  due: { fontSize: 12, color: '#6b7280' },
  overdueText: { color: '#dc2626', fontWeight: '600' },
  dirtyText: { marginTop: 6, fontSize: 11, color: '#d97706' },
  emptyText: { color: '#9ca3af', fontSize: 14 },
  emptyHint: { color: '#9ca3af', fontSize: 12, marginTop: 4 },
});
