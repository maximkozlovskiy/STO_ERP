'use client';

import { useEffect, useState } from 'react';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

interface WorkOrderMedia {
  // Bug #93: `fileKey` removed — backend no longer leaks the internal MinIO path.
  id: string;
  workOrderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  signedUrl: string;
  createdAt: string;
}

interface WorkOrderMediaSectionProps {
  woId: string;
  media: WorkOrderMedia[];
  /** Reload parent media list after upload / delete. */
  onChanged: () => void;
  /** Surface upload errors at the page level (preserves original UX). */
  onError?: (msg: string) => void;
}

export function WorkOrderMediaSection({
  woId,
  media,
  onChanged,
  onError,
}: WorkOrderMediaSectionProps) {
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Bug #89: Escape closes lightbox + a11y. Without this keyboard users can't
  // dismiss the photo preview at all.
  useEffect(() => {
    if (!lightboxUrl) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxUrl(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [lightboxUrl]);

  const handleMediaUpload = async (files: FileList) => {
    setUploadingMedia(true);
    onError?.('');
    // Bug #85: використовуємо apiMultipartFetch для silent refresh при 401.
    // Раніше native fetch з прямим Bearer ламався після того як access token закінчувався (~15 хв)
    // і користувач отримував абстрактне "Не вдалося завантажити N файл(ів)" без auto-recovery.
    //
    // Parallel upload — each file is an independent multipart POST. With 5+ files
    // sequential waits stack into seconds; Promise.allSettled keeps individual
    // failure tracking intact while collapsing wall-clock time to max(file).
    const results = await Promise.allSettled(
      Array.from(files).map(file => {
        const fd = new FormData();
        fd.append('file', file);
        return apiMultipartFetch(`/work-orders/${woId}/media`, fd);
      }),
    );
    const failures = results.filter(r => r.status === 'rejected').length;
    if (failures > 0) {
      onError?.(`Не вдалося завантажити ${failures} файл(ів)`);
    }
    onChanged();
    setUploadingMedia(false);
  };

  return (
    <>
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-3 border-b border-border bg-secondary flex items-center justify-between">
          <h3 className="font-medium text-foreground text-sm">Фото ({media.length})</h3>
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/*,application/pdf"
              multiple
              className="hidden"
              onChange={e => {
                if (e.target.files) void handleMediaUpload(e.target.files);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              loading={uploadingMedia}
              onClick={e => e.preventDefault()}
            >
              Додати фото
            </Button>
          </label>
        </div>
        <div
          className="p-4"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            void handleMediaUpload(e.dataTransfer.files);
          }}
        >
          {media.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-6 border-2 border-dashed border-border rounded-lg">
              Перетягніть фото сюди або натисніть &quot;Додати фото&quot;
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {media.map(m => (
                <div
                  key={m.id}
                  className="relative group aspect-square rounded-lg overflow-hidden bg-secondary cursor-pointer"
                  onClick={() => setLightboxUrl(m.signedUrl)}
                >
                  {m.mimeType.startsWith('image/') ? (
                    <img
                      src={m.signedUrl}
                      alt={m.filename}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground p-1 text-center break-all">
                      {m.filename}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Видалити файл"
                    onClick={async e => {
                      e.stopPropagation();
                      await apiFetch(`/work-orders/${woId}/media/${m.id}`, { method: 'DELETE' });
                      onChanged();
                    }}
                    className="absolute top-1 right-1 hidden group-hover:flex focus-visible:flex w-6 h-6 bg-destructive text-white rounded-full items-center justify-center text-xs"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox — Bug #89: a11y (role/aria-modal/aria-label) + Escape handled in useEffect above */}
      {lightboxUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Перегляд фото"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Фото"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            decoding="async"
          />
        </div>
      )}
    </>
  );
}
