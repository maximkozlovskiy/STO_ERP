'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { type NotificationTemplate, EVENT_LABELS } from './shared';
import NotificationProvidersPanel from './NotificationProvidersPanel';

export default function NotificationsTab() {
  const currentFeatures = useUiFeatures();
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<NotificationTemplate[]>('/notification-templates')
      .then(setTemplates)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Помилка завантаження шаблонів'),
      );
  }, []);

  const saveTemplate = async () => {
    if (!editingTemplate) return;
    setSaving(true);
    try {
      const updated = await apiFetch<NotificationTemplate>(
        `/notification-templates/${editingTemplate.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            body: editingTemplate.body,
            subject: editingTemplate.subject,
            isActive: editingTemplate.isActive,
          }),
        },
      );
      setTemplates(ts => ts.map(t => (t.id === updated.id ? updated : t)));
      setEditingTemplate(null);
      if (currentFeatures.toastEnabled) toast.success('Шаблон збережено');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Помилка збереження шаблону';
      setError(msg);
      if (currentFeatures.toastEnabled) toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      <NotificationProvidersPanel />

      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold text-foreground mb-3">Шаблони повідомлень</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Використовуйте змінні у подвійних дужках: {'{{workOrderNumber}}'}, {'{{clientName}}'},{' '}
        {'{{amount}}'}
      </p>

      {templates.length === 0 && (
        <p className="text-muted-foreground text-sm">Шаблони не знайдено</p>
      )}

      {(['SMS', 'EMAIL', 'PUSH'] as const).map(channel => {
        const channelTemplates = templates.filter(t => t.channel === channel);
        if (channelTemplates.length === 0) return null;
        return (
          <div key={channel}>
            <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <span className="px-2 py-0.5 bg-secondary rounded text-xs font-mono">{channel}</span>
              {channel === 'SMS' && 'SMS-сповіщення'}
              {channel === 'EMAIL' && 'Email-сповіщення'}
              {channel === 'PUSH' && 'Push-сповіщення'}
            </h3>
            <div className="space-y-3">
              {channelTemplates.map(t => (
                <div key={t.id} className="bg-surface rounded-xl border border-border p-4">
                  {editingTemplate?.id === t.id ? (
                    <div className="space-y-3">
                      <span className="text-sm font-medium text-foreground">
                        {EVENT_LABELS[t.eventType] ?? t.eventType}
                      </span>
                      {channel === 'EMAIL' && (
                        <input
                          type="text"
                          value={editingTemplate.subject ?? ''}
                          onChange={e =>
                            setEditingTemplate(et => (et ? { ...et, subject: e.target.value } : et))
                          }
                          placeholder="Тема листа"
                          className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary bg-surface text-foreground"
                        />
                      )}
                      <textarea
                        value={editingTemplate.body}
                        onChange={e =>
                          setEditingTemplate(et => (et ? { ...et, body: e.target.value } : et))
                        }
                        rows={3}
                        className="w-full px-3 py-2 border border-border rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary bg-surface text-foreground"
                      />
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingTemplate.isActive}
                            onChange={e =>
                              setEditingTemplate(et =>
                                et ? { ...et, isActive: e.target.checked } : et,
                              )
                            }
                            className="rounded border-border"
                          />
                          <span className="text-sm text-foreground">Активний</span>
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => void saveTemplate()} loading={saving}>
                          Зберегти
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditingTemplate(null)}
                        >
                          Скасувати
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-foreground">
                            {EVENT_LABELS[t.eventType] ?? t.eventType}
                          </span>
                          <span
                            className={cn(
                              'text-xs px-1.5 py-0.5 rounded',
                              t.isActive
                                ? 'bg-success-subtle text-success'
                                : 'bg-secondary text-muted-foreground',
                            )}
                          >
                            {t.isActive ? 'Активний' : 'Вимкнено'}
                          </span>
                        </div>
                        {t.subject && (
                          <p className="text-xs text-muted-foreground mb-1">Тема: {t.subject}</p>
                        )}
                        <p className="text-xs text-muted-foreground font-mono bg-secondary rounded p-2">
                          {t.body}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setEditingTemplate(t)}>
                        Редагувати
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
