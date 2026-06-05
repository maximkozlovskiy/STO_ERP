'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Upload, Trash2, X, ZoomIn } from 'lucide-react';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type OrgInfo } from './shared';

export default function OrgInfoTab() {
  const currentFeatures = useUiFeatures();
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null);
  const [orgInfoForm, setOrgInfoForm] = useState({
    name: '',
    edrpou: '',
    legalAddress: '',
    actualAddress: '',
    bankAccountId: '',
    bankAccountDisplay: '',
  });
  const [savingOrgInfo, setSavingOrgInfo] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoLightbox, setLogoLightbox] = useState<string | null>(null);
  const [removingLogo, setRemovingLogo] = useState(false);
  const [error, setError] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Close lightbox on Escape (a11y)
  useEffect(() => {
    if (!logoLightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLogoLightbox(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [logoLightbox]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<OrgInfo>('/settings/org-info')
      .then(info => {
        if (cancelled) return;
        setOrgInfo(info);
        setOrgInfoForm({
          name: info.name,
          edrpou: info.edrpou ?? '',
          legalAddress: info.legalAddress ?? '',
          actualAddress: info.actualAddress ?? '',
          bankAccountId: info.bankAccountId ?? '',
          bankAccountDisplay: '',
        });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Помилка завантаження реквізитів');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveOrgInfo = async () => {
    setSavingOrgInfo(true);
    try {
      const updated = await apiFetch<OrgInfo>('/settings/org-info', {
        method: 'PATCH',
        body: JSON.stringify({
          name: orgInfoForm.name || undefined,
          edrpou: orgInfoForm.edrpou || undefined,
          legalAddress: orgInfoForm.legalAddress || null,
          actualAddress: orgInfoForm.actualAddress || null,
          bankAccountId: orgInfoForm.bankAccountId || null,
        }),
      });
      setOrgInfo(updated);
      if (currentFeatures.toastEnabled) toast.success('Збережено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSavingOrgInfo(false);
    }
  };

  const uploadLogo = async (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    setLogoPreview(objectUrl);
    setUploadingLogo(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await apiMultipartFetch<{ url: string }>('/files/upload', formData);
      await apiFetch('/settings/org-info', {
        method: 'PATCH',
        body: JSON.stringify({ logoUrl: result.url }),
      });
      setOrgInfo(prev => (prev ? { ...prev, logoUrl: result.url } : prev));
      setLogoPreview(null);
      if (currentFeatures.toastEnabled) toast.success('Логотип завантажено');
    } catch (e: unknown) {
      setLogoPreview(null);
      setError(e instanceof Error ? e.message : 'Помилка завантаження логотипу');
    } finally {
      setUploadingLogo(false);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
    }
  };

  const removeLogo = async () => {
    setRemovingLogo(true);
    try {
      await apiFetch('/settings/org-info', {
        method: 'PATCH',
        body: JSON.stringify({ logoUrl: null }),
      });
      setOrgInfo(prev => (prev ? { ...prev, logoUrl: null } : prev));
      setLogoPreview(null);
      if (logoInputRef.current) logoInputRef.current.value = '';
      if (currentFeatures.toastEnabled) toast.success('Логотип видалено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення логотипу');
    } finally {
      setRemovingLogo(false);
    }
  };

  return (
    <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
      {error && (
        <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Logo */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-3">Логотип</label>
        <div className="flex items-start gap-5">
          {/* Preview box */}
          <div
            role={logoPreview || orgInfo?.logoUrl ? 'button' : undefined}
            tabIndex={logoPreview || orgInfo?.logoUrl ? 0 : -1}
            aria-label={logoPreview || orgInfo?.logoUrl ? 'Збільшити логотип' : undefined}
            className={`group relative shrink-0 w-48 h-28 rounded-xl border-2 border-dashed border-border bg-secondary flex items-center justify-center overflow-hidden transition-all ${logoPreview || orgInfo?.logoUrl ? 'cursor-zoom-in hover:border-primary/50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary' : ''}`}
            onClick={() => {
              const src = logoPreview ?? orgInfo?.logoUrl;
              if (src) setLogoLightbox(src);
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              const src = logoPreview ?? orgInfo?.logoUrl;
              if (!src) return;
              e.preventDefault();
              setLogoLightbox(src);
            }}
          >
            {logoPreview || orgInfo?.logoUrl ? (
              <img
                src={logoPreview ?? orgInfo!.logoUrl!}
                alt="Логотип організації"
                className="w-full h-full object-contain p-3"
                loading="lazy"
                decoding="async"
                onError={e => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                  const parent = e.currentTarget.parentElement;
                  if (parent) {
                    const fallback = parent.querySelector(
                      '[data-logo-fallback]',
                    ) as HTMLElement | null;
                    if (fallback) fallback.style.display = 'flex';
                  }
                }}
              />
            ) : null}
            <div
              data-logo-fallback
              style={{ display: logoPreview || orgInfo?.logoUrl ? 'none' : 'flex' }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-muted-foreground"
            >
              <ImageIcon className="w-10 h-10 opacity-30" />
              <span className="text-xs opacity-50">Немає логотипу</span>
            </div>
            {/* Zoom hint */}
            {(logoPreview || orgInfo?.logoUrl) && (
              <div className="absolute bottom-1.5 right-1.5 bg-black/40 rounded-md p-0.5 opacity-0 group-hover:opacity-100 pointer-events-none">
                <ZoomIn className="w-3.5 h-3.5 text-white" />
              </div>
            )}
          </div>

          {/* Buttons */}
          <div className="flex flex-col gap-2 pt-0.5">
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void uploadLogo(f);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => logoInputRef.current?.click()}
              loading={uploadingLogo}
            >
              <Upload className="w-4 h-4 mr-2" />
              {orgInfo?.logoUrl || logoPreview ? 'Замінити логотип' : 'Завантажити логотип'}
            </Button>
            {(orgInfo?.logoUrl || logoPreview) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void removeLogo()}
                disabled={removingLogo || uploadingLogo}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Видалити
              </Button>
            )}
            <p className="text-xs text-muted-foreground">PNG, JPG, SVG · макс. 2 МБ</p>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {logoLightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Перегляд логотипу"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLogoLightbox(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <img
              src={logoLightbox}
              alt="Логотип організації"
              className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
            />
            <button
              type="button"
              aria-label="Закрити перегляд"
              onClick={() => setLogoLightbox(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-surface rounded-full border border-border flex items-center justify-center text-foreground hover:bg-secondary transition-colors shadow-lg"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <Input
        label="Назва організації"
        value={orgInfoForm.name}
        onChange={e => setOrgInfoForm({ ...orgInfoForm, name: e.target.value })}
      />
      <Input
        label="ЄДРПОУ"
        value={orgInfoForm.edrpou}
        onChange={e => setOrgInfoForm({ ...orgInfoForm, edrpou: e.target.value })}
      />
      <Input
        label="Юридична адреса"
        value={orgInfoForm.legalAddress}
        onChange={e => setOrgInfoForm({ ...orgInfoForm, legalAddress: e.target.value })}
      />
      <Input
        label="Фактична адреса"
        value={orgInfoForm.actualAddress}
        onChange={e => setOrgInfoForm({ ...orgInfoForm, actualAddress: e.target.value })}
      />

      <Button onClick={() => void saveOrgInfo()} loading={savingOrgInfo} className="w-full">
        Зберегти
      </Button>
    </div>
  );
}
