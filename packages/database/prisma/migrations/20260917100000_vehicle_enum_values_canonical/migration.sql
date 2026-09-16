-- Канонізація vehicle-«enum» значень (fuelType/transmissionType/driveType/bodyType).
--
-- Контекст: раніше 3 фронт-форми (vehicles/new, vehicles/[id], counterparty vehicle-tab) зберігали
-- ці поля як РІЗНІ вільні рядки — укр. «Бензин», lowercase 'manual'/'sedan' тощо (бек — просто String?,
-- без enum). Фаза 2b виносить спільний VehicleForm зі спільними константами @sto/shared (канонічні
-- коди: PETROL/MANUAL/SEDAN…). Ця міграція мапить наявні значення у канонічні, щоб старі авто
-- коректно відображались у нових Select-ах.
--
-- Ідемпотентна: кожен UPDATE торкає лише рядки зі старим значенням (case-insensitive через lower()),
-- вже-канонічні не чіпає. deletedAt не фільтруємо — канонізуємо і видалені (консистентність при restore).

-- ── fuelType: укр. → код ─────────────────────────────────────────────
UPDATE "vehicles" SET "fuelType" = 'PETROL'   WHERE lower("fuelType") IN ('бензин', 'petrol', 'gasoline');
UPDATE "vehicles" SET "fuelType" = 'DIESEL'   WHERE lower("fuelType") IN ('дизель', 'diesel');
UPDATE "vehicles" SET "fuelType" = 'GAS'      WHERE lower("fuelType") IN ('газ', 'lpg', 'gas', 'пропан', 'метан');
UPDATE "vehicles" SET "fuelType" = 'HYBRID'   WHERE lower("fuelType") IN ('гібрид', 'hybrid');
UPDATE "vehicles" SET "fuelType" = 'ELECTRIC' WHERE lower("fuelType") IN ('електро', 'електрика', 'electric', 'ev');

-- ── transmissionType: lowercase → код ────────────────────────────────
UPDATE "vehicles" SET "transmissionType" = 'MANUAL'    WHERE lower("transmissionType") IN ('manual', 'механічна', 'мкпп');
UPDATE "vehicles" SET "transmissionType" = 'AUTOMATIC' WHERE lower("transmissionType") IN ('automatic', 'автоматична', 'акпп');
UPDATE "vehicles" SET "transmissionType" = 'CVT'       WHERE lower("transmissionType") IN ('variator', 'cvt', 'варіатор');
UPDATE "vehicles" SET "transmissionType" = 'ROBOT'     WHERE lower("transmissionType") IN ('robot', 'робот');

-- ── driveType: lowercase → код (4wd → AWD) ───────────────────────────
UPDATE "vehicles" SET "driveType" = 'FWD' WHERE lower("driveType") IN ('fwd', 'передній');
UPDATE "vehicles" SET "driveType" = 'RWD' WHERE lower("driveType") IN ('rwd', 'задній');
UPDATE "vehicles" SET "driveType" = 'AWD' WHERE lower("driveType") IN ('awd', '4wd', 'повний');

-- ── bodyType: lowercase → код (VAN — окремий канонічний код "Фургон", НЕ MINIVAN;
-- truck/convertible → OTHER, немає власного канонічного коду) ──
UPDATE "vehicles" SET "bodyType" = 'SEDAN'     WHERE lower("bodyType") IN ('sedan', 'седан');
UPDATE "vehicles" SET "bodyType" = 'HATCHBACK' WHERE lower("bodyType") IN ('hatchback', 'хетчбек');
UPDATE "vehicles" SET "bodyType" = 'WAGON'     WHERE lower("bodyType") IN ('wagon', 'універсал');
UPDATE "vehicles" SET "bodyType" = 'SUV'       WHERE lower("bodyType") IN ('suv', 'позашляховик');
UPDATE "vehicles" SET "bodyType" = 'CROSSOVER' WHERE lower("bodyType") IN ('crossover', 'кросовер');
UPDATE "vehicles" SET "bodyType" = 'COUPE'     WHERE lower("bodyType") IN ('coupe', 'купе');
UPDATE "vehicles" SET "bodyType" = 'MINIVAN'   WHERE lower("bodyType") IN ('minivan', 'мінівен');
UPDATE "vehicles" SET "bodyType" = 'PICKUP'    WHERE lower("bodyType") IN ('pickup', 'пікап');
UPDATE "vehicles" SET "bodyType" = 'VAN'       WHERE lower("bodyType") IN ('van', 'фургон');
UPDATE "vehicles" SET "bodyType" = 'OTHER'     WHERE lower("bodyType") IN ('truck', 'вантажівка', 'convertible', 'кабріолет');
