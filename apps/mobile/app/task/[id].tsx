import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { Q } from '@nozbe/watermelondb';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  formatKyivDateTime,
  isTaskOverdueAt,
} from '@sto/shared';
import { database } from '../../src/lib/database';
import { apiFetch, isNetworkError } from '../../src/lib/api';
import { queueTaskTransition, syncTasks } from '../../src/lib/sync';
import {
  TASK_TRANSITION_COLORS,
  TASK_TRANSITION_LABELS,
  taskPriorityBadge,
  taskStatusBadge,
  toTaskView,
  type TaskView,
} from '../../src/lib/task-ui';
import type { TaskModel } from '../../src/models/TaskModel';

interface TaskComment {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

/** Межа тіла коментаря — як у `CreateCommentDto` (MaxLength 2000). */
const COMMENT_MAX_LENGTH = 2000;

const OFFLINE_COMMENTS =
  'Коментарі доступні лише зі зв’язком із сервером. Потягніть донизу, коли мережа з’явиться.';

type CommentsState =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: TaskComment[] };

/** Механік — виконавець своєї задачі; керувати (скасувати, повернути) він не може (BR-TASK-003). */
const ASSIGNEE = { isManager: false, isAssignee: true } as const;

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const mounted = useRef(true);

  const [task, setTask] = useState<TaskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [comments, setComments] = useState<CommentsState>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const loadTask = useCallback(async () => {
    const [record] = await database.get<TaskModel>('tasks').query(Q.where('remote_id', id)).fetch();
    if (!mounted.current) return;
    setTask(record ? toTaskView(record) : null);
    setNow(new Date());
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      const res = await apiFetch<{ items: TaskComment[] }>(
        `/comments?entityType=Task&entityId=${encodeURIComponent(id)}`,
      );
      if (mounted.current) setComments({ status: 'ready', items: res.items ?? [] });
    } catch (e: unknown) {
      if (!mounted.current) return;
      if (isNetworkError(e)) setComments({ status: 'offline' });
      else {
        setComments({
          status: 'error',
          message: e instanceof Error ? e.message : 'Не вдалося завантажити коментарі',
        });
      }
    }
  }, [id]);

  const syncAndReload = useCallback(async () => {
    const result = await syncTasks();
    if (!mounted.current) return result;
    if (result.rejected.length > 0) {
      Alert.alert(
        'Сервер не прийняв зміну статусу',
        result.rejected.map(r => `«${r.title}»: ${r.message}`).join('\n'),
      );
    }
    await loadTask();
    return result;
  }, [loadTask]);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        await loadTask();
      } finally {
        if (mounted.current) setLoading(false);
      }
    })().catch(() => {
      if (mounted.current) setNotice('Не вдалося прочитати задачу з пам’яті планшета');
    });
    void loadComments();
    return () => {
      mounted.current = false;
    };
  }, [loadTask, loadComments]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await syncAndReload();
      setNotice(
        result.pull.status === 'offline'
          ? 'Немає зв’язку з сервером — показано дані, збережені на планшеті'
          : result.pull.status === 'error'
            ? `Не вдалося оновити задачу: ${result.pull.message}`
            : null,
      );
      await loadComments();
    } catch {
      setNotice('Не вдалося оновити задачу');
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  };

  const doTransition = (to: string) => {
    const label = TASK_STATUS_LABELS[to] ?? to;
    Alert.alert('Зміна статусу', `Перевести задачу в статус «${label}»?`, [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Підтвердити',
        onPress: () =>
          void (async () => {
            setTransitioning(true);
            try {
              // Спершу на планшеті (працює без мережі), потім спроба відправити.
              await queueTaskTransition(id, to);
              await loadTask();
              const result = await syncAndReload();
              if (mounted.current && result.pull.status === 'offline') {
                setNotice(
                  'Немає зв’язку з сервером. Статус збережено на планшеті й буде відправлено під час наступної синхронізації.',
                );
              }
            } catch (e: unknown) {
              Alert.alert('Помилка', e instanceof Error ? e.message : 'Не вдалося змінити статус');
            } finally {
              if (mounted.current) setTransitioning(false);
            }
          })(),
      },
    ]);
  };

  const sendComment = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      await apiFetch('/comments', {
        method: 'POST',
        body: JSON.stringify({ entityType: 'Task', entityId: id, body }),
      });
      if (!mounted.current) return;
      setDraft('');
      await loadComments();
    } catch (e: unknown) {
      Alert.alert(
        'Коментар не надіслано',
        isNetworkError(e)
          ? 'Немає зв’язку з сервером. Текст лишився в полі — надішліть, коли з’явиться мережа.'
          : e instanceof Error
            ? e.message
            : 'Не вдалося надіслати коментар',
      );
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  if (!task) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Задачу не знайдено на планшеті</Text>
        <Text style={styles.hintText}>Можливо, її скасовано або передано іншому працівнику.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← Назад</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const status = taskStatusBadge(task.status);
  const priority = taskPriorityBadge(task.priority);
  const overdue = now ? isTaskOverdueAt(task, now) : false;
  const allowed = (TASK_STATUS_TRANSITIONS[task.status] ?? []).filter(to =>
    canTransitionTask(task.status, to, ASSIGNEE),
  );
  const workOrderId = task.workOrderId;
  const canOpenWorkOrder = workOrderId !== null && !task.workOrderDeleted;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor="#2563eb"
        />
      }
    >
      {notice && (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      <View style={[styles.header, overdue && styles.headerOverdue]}>
        <Text style={styles.title}>{task.title}</Text>
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { backgroundColor: status.color + '20' }]}>
            <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: priority.color + '20' }]}>
            <Text style={[styles.badgeText, { color: priority.color }]}>{priority.label}</Text>
          </View>
          {overdue && (
            <View style={[styles.badge, styles.overdueBadge]}>
              <Text style={[styles.badgeText, styles.overdueText]}>Прострочена</Text>
            </View>
          )}
        </View>
        {task.isDirty && (
          <Text style={styles.dirtyText}>
            Статус змінено на планшеті й ще не відправлено на сервер
          </Text>
        )}
      </View>

      {allowed.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Змінити статус</Text>
          <View style={styles.transitionRow}>
            {allowed.map(to => (
              <TouchableOpacity
                key={to}
                onPress={() => doTransition(to)}
                disabled={transitioning}
                style={[
                  styles.transitionBtn,
                  { backgroundColor: TASK_TRANSITION_COLORS[to] ?? '#6b7280' },
                  transitioning && styles.disabled,
                ]}
                activeOpacity={0.8}
              >
                <Text style={styles.transitionBtnText}>
                  {TASK_TRANSITION_LABELS[to] ?? TASK_STATUS_LABELS[to] ?? to}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Деталі</Text>
        <View style={styles.infoCard}>
          <InfoRow label="Початок" value={formatKyivDateTime(task.startAt) || '—'} />
          <InfoRow
            label="Термін"
            value={formatKyivDateTime(task.dueAt) || 'Без терміну'}
            danger={overdue}
          />
          {task.completedAt != null && (
            <InfoRow label="Виконано" value={formatKyivDateTime(task.completedAt)} />
          )}
          {task.createdByName && <InfoRow label="Поставив" value={task.createdByName} />}
          {task.workOrderNumber && (
            <InfoRow
              label="Наряд"
              value={`${task.workOrderNumber}${task.workOrderDeleted ? ' (видалений)' : ''}`}
              onPress={
                canOpenWorkOrder ? () => router.push(`/work-order/${workOrderId}`) : undefined
              }
            />
          )}
          {task.vehicleSummary && <InfoRow label="Авто" value={task.vehicleSummary} />}
          {task.counterpartyName && <InfoRow label="Клієнт" value={task.counterpartyName} />}
        </View>
      </View>

      {task.description && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Опис</Text>
          <View style={styles.textCard}>
            <Text style={styles.bodyText}>{task.description}</Text>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Коментарі</Text>
        <CommentsBlock state={comments} />
        <View style={styles.commentForm}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Написати коментар…"
            multiline
            maxLength={COMMENT_MAX_LENGTH}
            style={styles.commentInput}
            editable={!sending}
          />
          <TouchableOpacity
            onPress={() => void sendComment()}
            disabled={sending || draft.trim() === ''}
            style={[styles.sendBtn, (sending || draft.trim() === '') && styles.disabled]}
            activeOpacity={0.8}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.sendBtnText}>Надіслати</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </ScrollView>
  );
}

function CommentsBlock({ state }: { state: CommentsState }) {
  switch (state.status) {
    case 'loading':
      return <ActivityIndicator color="#2563eb" style={{ marginVertical: 8 }} />;
    case 'offline':
      return <Text style={styles.mutedText}>{OFFLINE_COMMENTS}</Text>;
    case 'error':
      return <Text style={styles.errorInline}>{state.message}</Text>;
    case 'ready':
      if (state.items.length === 0)
        return <Text style={styles.mutedText}>Коментарів ще немає</Text>;
      return (
        <View style={styles.infoCard}>
          {state.items.map((c, i) => (
            <View key={c.id} style={[styles.comment, i > 0 && styles.commentBorder]}>
              <Text style={styles.commentMeta}>
                {c.authorName} · {formatKyivDateTime(c.createdAt)}
              </Text>
              <Text style={styles.bodyText}>{c.body}</Text>
            </View>
          ))}
        </View>
      );
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function InfoRow({
  label,
  value,
  danger,
  onPress,
}: {
  label: string;
  value: string;
  danger?: boolean;
  onPress?: (() => void) | undefined;
}) {
  const content = (
    <>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, danger && styles.overdueText, onPress && styles.linkValue]}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <TouchableOpacity style={styles.infoRow} onPress={onPress} activeOpacity={0.7}>
        {content}
      </TouchableOpacity>
    );
  }
  return <View style={styles.infoRow}>{content}</View>;
}

const card = {
  backgroundColor: '#fff',
  borderRadius: 12,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.04,
  shadowRadius: 2,
  elevation: 1,
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorText: { color: '#6b7280', fontSize: 16, marginBottom: 6 },
  hintText: { color: '#9ca3af', fontSize: 13, marginBottom: 16, textAlign: 'center' },
  backBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
  },
  backBtnText: { color: '#374151', fontSize: 14 },

  notice: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  noticeText: { color: '#92400e', fontSize: 13 },

  header: { ...card, padding: 16, marginBottom: 12 },
  headerOverdue: { borderLeftWidth: 4, borderLeftColor: '#dc2626' },
  title: { fontSize: 19, fontWeight: '700', color: '#111827', marginBottom: 8 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  overdueBadge: { backgroundColor: '#fee2e2' },
  overdueText: { color: '#dc2626', fontWeight: '600' },
  dirtyText: { marginTop: 8, fontSize: 12, color: '#d97706' },

  section: { marginBottom: 12 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },

  transitionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  transitionBtn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8 },
  transitionBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.5 },

  infoCard: { ...card, overflow: 'hidden' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  infoLabel: { fontSize: 13, color: '#6b7280' },
  infoValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
    maxWidth: '65%',
    textAlign: 'right',
  },
  linkValue: { color: '#2563eb' },

  textCard: { ...card, padding: 14 },
  bodyText: { fontSize: 14, color: '#111827', lineHeight: 20 },

  mutedText: { color: '#9ca3af', fontSize: 13, fontStyle: 'italic', marginBottom: 8 },
  errorInline: { color: '#dc2626', fontSize: 13, marginBottom: 8 },
  comment: { paddingHorizontal: 14, paddingVertical: 10 },
  commentBorder: { borderTopWidth: 1, borderTopColor: '#f3f4f6' },
  commentMeta: { fontSize: 11, color: '#9ca3af', marginBottom: 3 },
  commentForm: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 10 },
  commentInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
  },
  sendBtn: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minWidth: 100,
    alignItems: 'center',
  },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
