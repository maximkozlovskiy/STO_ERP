/**
 * Стартовий список марок для dev/CI-організації (`seed.ts`, BR-VEH-012) — ті самі назви й порядок,
 * що `DEFAULT_VEHICLE_MAKES` в `apps/api/src/modules/vehicle-makes/vehicle-make-defaults.ts`
 * (його сіє `SetupService` для організації з `/setup`).
 *
 * Чому копія, а не імпорт (Bug #956): пакет бази нижчий за застосунок і не імпортує `apps/api`
 * (`rootDir: "."` пакета — імпорт дає TS6059 у його `tsc --noEmit`), а `@sto/shared` у CI
 * збирається ПІСЛЯ кроку seed. Розбіжність ловить `vehicle-make-defaults.spec.ts` в api — він
 * читає цей файл і звіряє назви з кодом, як і SQL міграції.
 */
export const SEED_VEHICLE_MAKES: readonly string[] = [
  'Acura',
  'Alfa Romeo',
  'Audi',
  'BMW',
  'BYD',
  'Cadillac',
  'Chery',
  'Chevrolet',
  'Chrysler',
  'Citroen',
  'Cupra',
  'Dacia',
  'Daewoo',
  'Dodge',
  'Ferrari',
  'Fiat',
  'Ford',
  'GAZ',
  'Geely',
  'Genesis',
  'Great Wall',
  'Haval',
  'Honda',
  'Hyundai',
  'Infiniti',
  'Isuzu',
  'Iveco',
  'Jaguar',
  'Jeep',
  'Kia',
  'Lada',
  'Land Rover',
  'Lexus',
  'Lincoln',
  'Mazda',
  'Mercedes-Benz',
  'MG',
  'Mini',
  'Mitsubishi',
  'Moskvich',
  'Nissan',
  'Opel',
  'Peugeot',
  'Porsche',
  'Ravon',
  'Renault',
  'Seat',
  'Skoda',
  'Smart',
  'SsangYong',
  'Subaru',
  'Suzuki',
  'Tesla',
  'Toyota',
  'UAZ',
  'Volkswagen',
  'Volvo',
  'ZAZ',
];

/** Ключ назви — як `vehicleNameKey` у `@sto/shared` і SQL міграції (BR-VEH-006). */
export function seedVehicleNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}
