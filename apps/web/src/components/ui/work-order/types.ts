import type { Warehouse, Unit } from '@/hooks/useReferenceData';

export type { Warehouse, Unit };

export interface LocalPart {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  goodId: string;
  goodName: string;
  goodInternalCode?: string | null;
  goodSku?: string | null;
  goodBrandName?: string | null;
  warehouseId: string;
  quantity: string;
  costPrice?: number | null;
  price: string;
  unitOfMeasureId: string;
  unitShortName: string;
}
