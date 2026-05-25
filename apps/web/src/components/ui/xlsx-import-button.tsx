'use client';

import { useState, useRef, type ChangeEvent } from 'react';
import { Download, Upload } from 'lucide-react';
import { TOKEN_KEY } from '@/lib/auth';
import { cn } from '@/lib/utils';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

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

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function tryRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json() as { accessToken: string };
    setToken(data.accessToken);
    return data.accessToken;
  } catch {
    return null;
  }
}

async function fetchWithAuth(input: string, init: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status !== 401) return res;

  const newToken = await tryRefresh();
  if (!newToken) {
    clearToken();
    window.location.href = '/login';
    return res;
  }

  headers.set('Authorization', `Bearer ${newToken}`);
  return fetch(input, { ...init, headers });
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
      const res = await fetchWithAuth(`${API_URL}/api/xlsx/templates/${templateType}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText })) as { message: string };
        throw new Error(err.message);
      }
      const data = await res.json() as { file: string; filename: string };
      const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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
      const res = await fetchWithAuth(`${API_URL}/api${importUrl}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText })) as { message: string };
        throw new Error(err.message);
      }
      const data = await res.json() as ImportResult;
      setResult(data);
      onImportComplete?.(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка імпорту');
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
          accept=".xlsx,.xls"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {error && (
        <p className="text-[12px] text-destructive">{error}</p>
      )}

      {result && (
        <div className="text-[12px] rounded-lg bg-success-subtle border border-success/20 px-3 py-2">
          <span className="text-success font-medium">
            Створено: {result.created} / Оновлено: {result.updated}
          </span>
          {result.errors.length > 0 && (
            <ul className="mt-1 text-destructive list-disc list-inside">
              {result.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
