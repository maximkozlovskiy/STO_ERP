---
name: sto-mobile
description: >
  Create Expo/React Native screens and features for STO ERP mechanic tablet app. Use when the user says "мобільний екран", "планшет механіка", "expo", "react native", or building the mobile layer. Produces Feature-Sliced Design structure with offline support via WatermelonDB, TanStack Query, and Expo Router.
model: claude-sonnet-5
bypassPermissions: true
---

# sto-mobile — Expo Mechanic App Skill

## Before Starting

1. Read `MemoryManual.md` — current project state, gotchas, recent changes
2. Read `sto-context` — understand domain and offline-first requirements
3. Read `sto-dev` — coding standards (React, Tailwind patterns) — prevents sto-review findings
4. Check existing similar screen for patterns

---

## Context

The mobile app is used by **mechanics on tablets** in the workshop. Key requirements:

- Works offline (weak WiFi in bays)
- Shows mechanic's personal work queue
- Timer per work line
- Photo capture for work reports
- QR/barcode scan (VIN, parts)

---

## App Structure (Feature-Sliced Design)

```
apps/mobile/
├── app/                              ← Expo Router pages
│   ├── (auth)/login.tsx
│   ├── (mechanic)/
│   │   ├── _layout.tsx               ← bottom tab navigator
│   │   ├── queue.tsx                 ← my work queue
│   │   ├── work-order/[id].tsx       ← WO detail
│   │   └── profile.tsx
├── features/
│   ├── work-queue/
│   │   ├── ui/WorkQueueScreen.tsx
│   │   ├── ui/WorkOrderCard.tsx
│   │   ├── api/workQueueApi.ts       ← TanStack Query hooks
│   │   └── model/useWorkTimer.ts
│   ├── photo-report/
│   │   ├── ui/PhotoCapture.tsx
│   │   └── model/usePhotoUpload.ts
│   └── scanner/
│       └── ui/BarcodeScanner.tsx
├── entities/
│   ├── work-order/
│   │   ├── model/workOrderModel.ts   ← WatermelonDB model
│   │   └── ui/WorkOrderStatusBadge.tsx
│   └── employee/
├── shared/
│   ├── api/client.ts
│   ├── ui/                           ← base components
│   └── lib/watermelon.ts             ← DB setup
└── watermelon/
    ├── schema.ts                     ← WatermelonDB schema
    └── migrations.ts
```

---

## WatermelonDB Setup (Offline-First)

```typescript
// shared/lib/watermelon.ts
import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from '../../watermelon/schema';
import { WorkOrderModel } from '../../entities/work-order/model/workOrderModel';

const adapter = new SQLiteAdapter({ schema, migrations, jsi: true });
export const database = new Database({ adapter, modelClasses: [WorkOrderModel] });

// watermelon/schema.ts
import { appSchema, tableSchema } from '@nozbe/watermelondb';
export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'work_orders',
      columns: [
        { name: 'server_id', type: 'string', isOptional: true },
        { name: 'number', type: 'string' },
        { name: 'status', type: 'string' },
        { name: 'vehicle_make', type: 'string' },
        { name: 'vehicle_model', type: 'string' },
        { name: 'description', type: 'string', isOptional: true },
        { name: 'synced_at', type: 'number', isOptional: true },
      ],
    }),
  ],
});
```

---

## Screen Pattern

```typescript
// features/work-queue/ui/WorkQueueScreen.tsx
import { View, FlatList, RefreshControl } from 'react-native';
import { useMyQueue } from '../api/workQueueApi';
import { WorkOrderCard } from './WorkOrderCard';
import { useRouter } from 'expo-router';

export function WorkQueueScreen() {
  const { data, isLoading, refetch } = useMyQueue();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: '#f5f5f5' }}>
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <WorkOrderCard
            workOrder={item}
            onPress={() => router.push(`/work-order/${item.id}`)}
          />
        )}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={refetch} />}
        contentContainerStyle={{ padding: 16, gap: 12 }}
      />
    </View>
  );
}
```

---

## Work Timer Hook

```typescript
// features/work-queue/model/useWorkTimer.ts
import { useState, useEffect, useRef } from 'react';
import { useUpdateWorkOrderLine } from '../api/workQueueApi';
import { useMMKVObject } from 'react-native-mmkv';

export function useWorkTimer(lineId: string) {
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [timers, setTimers] = useMMKVObject<Record<string, number>>('work_timers');
  const intervalRef = useRef<NodeJS.Timeout>();
  const { mutate: updateLine } = useUpdateWorkOrderLine();

  useEffect(() => {
    if (timers?.[lineId]) setElapsed(timers[lineId]);
  }, [lineId]);

  const start = () => {
    setRunning(true);
    intervalRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    updateLine({ lineId, startedAt: new Date().toISOString() });
  };

  const stop = () => {
    setRunning(false);
    clearInterval(intervalRef.current);
    setTimers({ ...timers, [lineId]: elapsed });
  };

  const complete = () => {
    stop();
    updateLine({ lineId, completedAt: new Date().toISOString(), actualSeconds: elapsed });
  };

  const formatted = `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;

  return { elapsed, running, formatted, start, stop, complete };
}
```

---

## Photo Capture Pattern

```typescript
// features/photo-report/ui/PhotoCapture.tsx
import { useState } from 'react';
import { View, Image, TouchableOpacity, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useUploadPhoto } from '../model/usePhotoUpload';

interface Props {
  workOrderId: string;
  onUploaded: (url: string) => void;
}

export function PhotoCapture({ workOrderId, onUploaded }: Props) {
  const [photos, setPhotos] = useState<string[]>([]);
  const { mutate: upload } = useUploadPhoto();

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Потрібен дозвіл на камеру');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      allowsEditing: false,
    });
    if (!result.canceled) {
      const uri = result.assets[0].uri;
      setPhotos(p => [...p, uri]);
      upload({ workOrderId, uri }, { onSuccess: ({ url }) => onUploaded(url) });
    }
  };

  return (
    <View>
      <TouchableOpacity onPress={takePhoto} style={{ padding: 16, backgroundColor: '#007AFF', borderRadius: 8 }}>
        {/* Camera icon + "Зробити фото" */}
      </TouchableOpacity>
      {/* Photos grid */}
    </View>
  );
}
```

---

## Barcode/QR Scanner Pattern

```typescript
// features/scanner/ui/BarcodeScanner.tsx
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useState } from 'react';

interface Props {
  onScanned: (data: string) => void;
}

export function BarcodeScanner({ onScanned }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  if (!permission?.granted) {
    return <Button onPress={requestPermission} title="Дозволити камеру" />;
  }

  return (
    <CameraView
      style={{ flex: 1 }}
      onBarcodeScanned={scanned ? undefined : ({ data }) => {
        setScanned(true);
        onScanned(data);
        setTimeout(() => setScanned(false), 2000);
      }}
      barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'ean13'] }}
    />
  );
}
```

---

## Checklist

- [ ] Screen works offline (data from WatermelonDB, sync on reconnect)
- [ ] Loading + error states handled
- [ ] Timer state persisted via MMKV (survives app background)
- [ ] Photo upload queued if offline (retry on reconnect)
- [ ] Works on Android tablets (primary target)
- [ ] `pnpm --filter @sto/mobile start` works in Expo Go

---

## Ukrainian UI & Windows Dev Notes for Mobile

### Ukrainian Strings in React Native

```typescript
// features/work-queue/ui/WorkQueueScreen.tsx — all Ukrainian
<Text style={styles.title}>Моя черга</Text>
<Text style={styles.empty}>Немає призначених робіт</Text>

// Status labels — import from @sto/shared
import { WORK_ORDER_STATUS_LABELS } from '@sto/shared';
<Text>{WORK_ORDER_STATUS_LABELS[workOrder.status]}</Text>
// Output: "В роботі", "Виконано" etc.
```

### Ukrainian Date/Time in Mobile

```typescript
import { format } from 'date-fns';
import { uk } from 'date-fns/locale';

// Display dates in Ukrainian
format(new Date(slot.startAt), 'dd MMMM yyyy, HH:mm', { locale: uk });
// Output: "21 травня 2026, 14:30"

format(new Date(), 'EEEE', { locale: uk });
// Output: "середа"
```

### Ukrainian Alert/Confirm Dialogs

```typescript
import { Alert } from 'react-native';

// Always Ukrainian
Alert.alert('Підтвердження', 'Ви впевнені, що хочете завершити роботу?', [
  { text: 'Скасувати', style: 'cancel' },
  { text: 'Завершити', onPress: handleComplete },
]);
```

### Testing on Windows (Physical Tablet Recommended)

```powershell
# Expo Go on Android tablet — easiest setup on Windows
pnpm --filter @sto/mobile start

# Scan QR code with Expo Go app on tablet
# Ensure PC and tablet are on same WiFi network

# For Android Emulator (optional, needs Android Studio):
# Start emulator → press 'a' in Expo CLI

# USB debugging (faster):
# Enable Developer Options on tablet → USB Debugging
# Connect via USB → press 'a' in Expo CLI
```

### Cyrillic Input on Tablet

```typescript
// React Native handles Cyrillic keyboard natively on Android
// Ensure TextInput has correct keyboard type:
<TextInput
  keyboardType="default"       // shows Cyrillic keyboard on UA Android
  autoCapitalize="words"       // for names
  placeholder="Опис роботи"
/>
```
