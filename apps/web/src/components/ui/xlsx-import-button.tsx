'use client';

import { useState, useRef, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface ImportResult {
  created: number;
  updated: number;
  errors: string[];
}

interface XlsxImportButtonProps {
  templateType: string;
  importUrl: string;
  onImportComplete?: (result: ImportResult) => void;
  className?: string;
}

interface TemplateResponse {
  file: string;
  filename: string;
}

export function XlsxImportButton({
  templateType,
  importUrl,
  onImportComplete,
  className,
}: XlsxImportButtonProps) {
  const [downloading, setDownloading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError('');
    try {
      const data = await apiFetch<TemplateResponse>(`/xlsx/templates/${templateType}`);
      const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0));
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження шаблону');
    } finally {
      setDownloading(false);
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = '';

    setImporting(true);
    setError('');
    setResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await apiMultipartFetch<ImportResult>(importUrl, formData);
      setResult(data);
      onImportComplete?.(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Помилка імпорту');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex gap-2">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border bg-surface text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {downloading ? 'Завантаження...' : 'Шаблон XLSX'}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border border-border bg-surface text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          {importing ? 'Імпорт...' : 'Імпорт XLSX'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {error && (
        <div className="text-[12px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded px-2 py-1">
          {error}
        </div>
      )}

      {result && (
        <div className="text-[12px] bg-secondary border border-border rounded px-2 py-1.5">
          <div className="font-medium text-foreground">
            Імпорт: створено {result.created}, оновлено {result.updated}
          </div>
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-destructive-text">
                Помилки: {result.errors.length}
              </summary>
              <ul className="mt-1 list-disc list-inside text-muted-foreground space-y-0.5">
                {result.errors.slice(0, 10).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {result.errors.length > 10 && <li>...та ще {result.errors.length - 10}</li>}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
