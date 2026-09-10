import type { Warehouse, Unit, Employee } from '@/hooks/useReferenceData';

export type { Warehouse, Unit, Employee };

export interface LocalLine {
  _key: string;
  id?: string; // present for rows already persisted in DB (edit mode)
  workId: string;
  workName: string;
  employeeId: string;
  normoHours: string;
  actualHours: string;
  price: string;
}

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
