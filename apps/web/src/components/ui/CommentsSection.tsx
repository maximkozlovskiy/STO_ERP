'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/lib/api-client';
import { fmtShortDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';

/** Сутності з коментарями — дзеркало `COMMENT_ENTITY_TYPES` у `comments.dto.ts` API. */
export type CommentEntityType = 'WorkOrder' | 'Counterparty' | 'Vehicle' | 'Invoice' | 'Task';

interface CommentItem {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

interface Props {
  entityType: CommentEntityType;
  entityId: string;
  /** Без поля нового коментаря (видалений документ, немає входу). */
  readOnly?: boolean;
  /** Обгортка-картка (сторінка наряду) чи без рамки (усередині картки задачі). */
  variant?: 'card' | 'plain';
  className?: string;
}

/**
 * Коментарі до сутності (поліморфний `Comment`, `GET/POST /comments`): список і поле нового
 * коментаря (Ctrl+Enter — надіслати). Спільний для наряду й задачі (BR-TASK-008): хто бачить
 * задачу, той читає й пише її коментарі — перевіряє сервер.
 */
export function CommentsSection({
  entityType,
  entityId,
  readOnly = false,
  variant = 'card',
  className,
}: Props) {
  const { t } = useTranslation('common');
  const features = useUiFeatures();
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  // Синхронний guard від подвійного надсилання: `saving` вимикає кнопку лише після рендеру.
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  // Відповідь для попередньої сутності (картку перемкнули на іншу задачу) не пишеться.
  const entityRef = useRef(entityId);
  entityRef.current = entityId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    (signal?: AbortSignal) => {
      const forId = entityId;
      apiFetch<{ items: CommentItem[] }>(
        `/comments?entityType=${entityType}&entityId=${encodeURIComponent(forId)}`,
        { signal },
      ).then(
        r => {
          if (!mountedRef.current || entityRef.current !== forId) return;
          setComments(r.items ?? []);
          setLoadError(false);
        },
        () => {
          if (signal?.aborted || !mountedRef.current || entityRef.current !== forId) return;
          setLoadError(true);
        },
      );
    },
    [entityType, entityId],
  );

  useEffect(() => {
    setComments([]);
    setBody('');
    setLoadError(false);
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const submit = async () => {
    const text = body.trim();
    if (!text || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await apiFetch('/comments', {
        method: 'POST',
        body: JSON.stringify({ entityType, entityId, body: text }),
      });
      if (!mountedRef.current) return;
      setBody('');
      load();
      if (features.toastEnabled) toast.success(t('comments.added'));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('comments.error'));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <section
      className={cn(
        variant === 'card' && 'bg-surface rounded-xl border border-border p-5',
        className,
      )}
      aria-label={t('comments.title')}
      data-testid="comments-section"
    >
      <h2
        className={cn(
          'font-semibold text-foreground',
          variant === 'card' ? 'mb-4' : 'mb-2 text-[13px]',
        )}
      >
        {t('comments.title')}
      </h2>
      {loadError && (
        <p className="text-[13px] text-destructive-text mb-3" role="alert">
          {t('comments.loadError')}
        </p>
      )}
      {comments.length > 0 && (
        <ul className="space-y-3 mb-4">
          {comments.map(c => (
            <li key={c.id} className="flex gap-3" data-testid="comment">
              <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <span className="text-[11px] font-semibold text-primary" aria-hidden="true">
                  {c.authorName ? c.authorName[0] : '?'}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[12px] font-medium text-foreground">
                    {c.authorName || t('comments.unknownAuthor')}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {fmtShortDateTime(c.createdAt)}
                  </span>
                </div>
                <p className="text-[13px] text-foreground whitespace-pre-wrap wrap-break-word">
                  {c.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {comments.length === 0 && !loadError && (
        <p className="text-sm text-muted-foreground mb-4">{t('comments.empty')}</p>
      )}
      {!readOnly && (
        <div className="flex gap-2">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                // Ctrl+Enter картки (Modal onSubmit слухає document) — «Зберегти» картки; у полі
                // коментаря він надсилає коментар, а не зберігає картку.
                e.preventDefault();
                e.stopPropagation();
                void submit();
              }
            }}
            placeholder={t('comments.placeholder')}
            aria-label={t('comments.placeholder')}
            maxLength={2000}
            rows={2}
            className="flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-primary/30 resize-none"
          />
          <Button
            size="sm"
            onClick={() => void submit()}
            loading={saving}
            disabled={!body.trim()}
            className="self-end"
          >
            {t('comments.send')}
          </Button>
        </div>
      )}
    </section>
  );
}
