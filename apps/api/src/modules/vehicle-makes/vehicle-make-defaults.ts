/**
 * Стартовий довідник марок авто (рішення власника 2026-10-23, BR-VEH-012): марки, поширені в
 * Україні, без моделей — моделі заводять у роботі. Сіється при створенні організації
 * (`SetupService`) і міграцією `20261023180000_vehicle_makes_and_models` для наявних організацій.
 *
 * `aliases` — інші написання тієї ж марки (скорочення, кирилиця, без діакритики). Ними міграція
 * зводила вільний текст старих авто до однієї марки; список у SQL міграції має збігатися з цим
 * (стереже `vehicle-make-defaults.spec.ts`).
 */
export interface DefaultVehicleMake {
  name: string;
  aliases?: readonly string[];
}

export const DEFAULT_VEHICLE_MAKES: readonly DefaultVehicleMake[] = [
  { name: 'Acura' },
  { name: 'Alfa Romeo' },
  { name: 'Audi', aliases: ['Ауді', 'Ауди'] },
  { name: 'BMW', aliases: ['БМВ'] },
  { name: 'BYD' },
  { name: 'Cadillac' },
  { name: 'Chery', aliases: ['Чері', 'Чери'] },
  { name: 'Chevrolet', aliases: ['Шевроле'] },
  { name: 'Chrysler' },
  { name: 'Citroen', aliases: ['Citroën', 'Сітроен', 'Ситроен'] },
  { name: 'Cupra' },
  { name: 'Dacia', aliases: ['Дачія'] },
  { name: 'Daewoo', aliases: ['Деу', 'Дэу'] },
  { name: 'Dodge' },
  { name: 'Ferrari' },
  { name: 'Fiat', aliases: ['Фіат', 'Фиат'] },
  { name: 'Ford', aliases: ['Форд'] },
  { name: 'GAZ', aliases: ['ГАЗ'] },
  { name: 'Geely', aliases: ['Джилі', 'Джили'] },
  { name: 'Genesis' },
  { name: 'Great Wall' },
  { name: 'Haval' },
  { name: 'Honda', aliases: ['Хонда'] },
  { name: 'Hyundai', aliases: ['Хюндай', 'Хендай', 'Хундай'] },
  { name: 'Infiniti' },
  { name: 'Isuzu' },
  { name: 'Iveco' },
  { name: 'Jaguar' },
  { name: 'Jeep' },
  { name: 'Kia', aliases: ['Кіа', 'Киа'] },
  { name: 'Lada', aliases: ['ВАЗ', 'VAZ', 'Лада'] },
  { name: 'Land Rover' },
  { name: 'Lexus', aliases: ['Лексус'] },
  { name: 'Lincoln' },
  { name: 'Mazda', aliases: ['Мазда'] },
  { name: 'Mercedes-Benz', aliases: ['Mercedes', 'Mercedes Benz', 'Мерседес'] },
  { name: 'MG' },
  { name: 'Mini' },
  { name: 'Mitsubishi', aliases: ['Міцубісі', 'Мицубиси'] },
  { name: 'Moskvich', aliases: ['Москвич'] },
  { name: 'Nissan', aliases: ['Ніссан', 'Ниссан'] },
  { name: 'Opel', aliases: ['Опель'] },
  { name: 'Peugeot', aliases: ['Пежо'] },
  { name: 'Porsche', aliases: ['Порше'] },
  { name: 'Ravon' },
  { name: 'Renault', aliases: ['Рено'] },
  { name: 'Seat' },
  { name: 'Skoda', aliases: ['Škoda', 'Шкода'] },
  { name: 'Smart' },
  { name: 'SsangYong' },
  { name: 'Subaru', aliases: ['Субару'] },
  { name: 'Suzuki', aliases: ['Сузукі', 'Сузуки'] },
  { name: 'Tesla', aliases: ['Тесла'] },
  { name: 'Toyota', aliases: ['Тойота'] },
  { name: 'UAZ', aliases: ['УАЗ'] },
  { name: 'Volkswagen', aliases: ['VW', 'Фольксваген'] },
  { name: 'Volvo', aliases: ['Вольво'] },
  { name: 'ZAZ', aliases: ['ЗАЗ'] },
];
