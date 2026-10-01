import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { purchaseOrdersKeys } from './usePurchaseOrders';
import { stockDocsKeys } from './useStockDocuments';

// ─── Типи контракту (дзеркало backend DTO) ───────────────────────────────

export type ExcelImportDocType = 'PURCHASE_ORDER' | 'STOCK_DOCUMENT';

export type PreviewRowStatus = 'matched' | 'ambiguous' | 'notFound';

export interface PreviewCandidate {
  id: string;
  sku: string | null;
  name: string;
  brandName: string | null;
}

export interface PreviewRow {
  rowIndex: number;
  rawCode?: string | null;
  rawArticle?: string | null;
  rawBrand?: string | null;
  rawName?: string | null;
  quantity: number;
  price: number;
  status: PreviewRowStatus;
  matchedGoodId?: string | null;
  candidates: PreviewCandidate[];
}

export interface PreviewResponse {
  rows: PreviewRow[];
}

/**
 * Мапінг колонок Excel (1-based). Всі поля крім startRow — опційні.
 * Дзеркалить GET/PUT /counterparties/:id/import-mapping.
 */
export interface ImportMapping {
  startRow: number;
  codeCol: number | null;
  articleCol: number | null;
  brandCol: number | null;
  nameCol: number | null;
  quantityCol: number | null;
  priceCol: number | null;
}

export interface PreviewImportVars {
  file: File;
  docType: ExcelImportDocType;
  docId: string;
  mapping: ImportMapping;
}

export type ApplyRowAction = 'use' | 'create';

export interface ApplyCreateData {
  name: string;
  sku?: string;
  rawBrand?: string;
}

export interface ApplyRow {
  rowIndex: number;
  action: ApplyRowAction;
  goodId?: string;
  createData?: ApplyCreateData;
  quantity: number;
  price: number;
}

/** Режим запису: замінити ВСІ позиції документа чи додати до наявних. Дзеркалить ApplyImportDto.mode. */
export type ImportApplyMode = 'replace' | 'append';

export interface ApplyImportVars {
  docType: ExcelImportDocType;
  docId: string;
  rows: ApplyRow[];
  mode: ImportApplyMode;
}

// ─── useRawPreview (сирий передперегляд файлу до налаштування колонок) ──────

export interface RawPreviewResponse {
  totalRows: number;
  columnCount: number;
  rows: string[][]; // перші N рядків як текстова сітка (1-based колонки зліва направо)
  /** Канал, з якого прочитано файл — бекенд визначає за розширенням. */
  kind?: 'xlsx' | 'csv' | 'pdf' | 'image';
  /** Текст отримано розпізнаванням → UI попереджає, що дані приблизні й їх треба звірити. */
  ocr?: boolean;
}

/**
 * Сирий передперегляд файлу (.xlsx/.csv/.pdf): показує перші рядки як є, ще до вибору колонок.
 * Приймає лише файл (без docId) — бекенд читає байти за розширенням, у БД не пише.
 */
export function useRawPreview() {
  return useMutation<RawPreviewResponse, Error, File>({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiMultipartFetch<RawPreviewResponse>('/xlsx/import/raw-preview', fd);
    },
  });
}

// ─── usePreviewImport ─────────────────────────────────────────────────────

/**
 * Bug #197/#85: файл завантажується через apiMultipartFetch (FormData). apiFetch фіксує
 * Content-Type=application/json → fastify-multipart відхиляє запит.
 * Мапінг-поля кладемо у FormData як string (multipart не має типів).
 */
export function usePreviewImport() {
  return useMutation<PreviewResponse, Error, PreviewImportVars>({
    mutationFn: ({ file, docType, docId, mapping }) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('docType', docType);
      fd.append('docId', docId);
      fd.append('startRow', String(mapping.startRow));
      // Опційні колонки надсилаємо лише коли задані (>0) — інакше бекенд сам виведе.
      const cols: [keyof ImportMapping, number | null][] = [
        ['codeCol', mapping.codeCol],
        ['articleCol', mapping.articleCol],
        ['brandCol', mapping.brandCol],
        ['nameCol', mapping.nameCol],
        ['quantityCol', mapping.quantityCol],
        ['priceCol', mapping.priceCol],
      ];
      for (const [key, val] of cols) {
        if (val != null && val > 0) fd.append(key, String(val));
      }
      return apiMultipartFetch<PreviewResponse>('/xlsx/import/preview', fd);
    },
  });
}

// ─── useApplyImport ───────────────────────────────────────────────────────

export function useApplyImport() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, ApplyImportVars>({
    mutationFn: ({ docType, docId, rows, mode }) =>
      apiFetch('/xlsx/import/apply', {
        method: 'POST',
        body: JSON.stringify({ docType, docId, rows, mode }),
      }),
    onSuccess: (_data, vars) => {
      if (vars.docType === 'PURCHASE_ORDER') {
        void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      } else {
        void qc.invalidateQueries({ queryKey: stockDocsKeys.all });
      }
    },
  });
}

// ─── Import mapping (per counterparty) ────────────────────────────────────

export const importMappingKeys = {
  all: ['import-mapping'] as const,
  detail: (counterpartyId: string) => [...importMappingKeys.all, counterpartyId] as const,
};

export function useCounterpartyImportMapping(counterpartyId?: string) {
  return useQuery<ImportMapping>({
    queryKey: importMappingKeys.detail(counterpartyId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<ImportMapping>(`/counterparties/${counterpartyId}/import-mapping`, { signal }),
    enabled: !!counterpartyId,
    staleTime: 30_000,
  });
}

export interface UpsertImportMappingVars {
  counterpartyId: string;
  mapping: ImportMapping;
}

export function useUpsertImportMapping() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, UpsertImportMappingVars>({
    mutationFn: ({ counterpartyId, mapping }) =>
      apiFetch(`/counterparties/${counterpartyId}/import-mapping`, {
        method: 'PUT',
        body: JSON.stringify({
          startRow: mapping.startRow,
          codeCol: mapping.codeCol,
          articleCol: mapping.articleCol,
          brandCol: mapping.brandCol,
          nameCol: mapping.nameCol,
          quantityCol: mapping.quantityCol,
          priceCol: mapping.priceCol,
        }),
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: importMappingKeys.detail(vars.counterpartyId) });
    },
  });
}
