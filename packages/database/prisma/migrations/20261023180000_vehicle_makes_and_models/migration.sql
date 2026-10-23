-- Довідники марок і моделей авто (рішення власника 2026-10-23, BR-VEH-006…013).
--
-- До цього марка й модель були вільним текстом у `vehicles.make` / `vehicles.model`. Тепер авто
-- посилається на довідник (`makeId`, `modelId`), а текстові колонки лишаються знімком назви, який
-- пише сервіс, — їх читають PDF, наряди, календар, шаблони повідомлень, зарплата й звіти.
--
-- Перенесення старих даних (рішення «міграція з чисткою»):
--   * ключ назви — без крайніх пробілів, пробіли всередині стиснуто, нижній регістр;
--   * написання зі списку аліасів (VW, Мерседес, ВАЗ…) зводяться до марки стартового списку;
--   * назва марки — зі стартового списку, інакше найчастіше написання серед авто організації;
--   * усе, що не впізнано («ferari», «Майота»), стає окремою маркою — для ручного злиття.
-- Переносяться всі авто, разом із видаленими: колонки `makeId` / `modelId` стають NOT NULL.
--
-- Стартовий список і аліаси мусять збігатися з `apps/api/src/modules/vehicle-makes/
-- vehicle-make-defaults.ts` (стереже `vehicle-make-defaults.spec.ts`).

-- CreateTable
CREATE TABLE "vehicle_makes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "vehicle_makes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "makeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "syncVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "vehicle_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_makes_orgId_deletedAt_idx" ON "vehicle_makes"("orgId", "deletedAt");
CREATE INDEX "vehicle_makes_orgId_syncVersion_idx" ON "vehicle_makes"("orgId", "syncVersion");
CREATE UNIQUE INDEX "vehicle_makes_orgId_nameKey_key" ON "vehicle_makes"("orgId", "nameKey");
CREATE INDEX "vehicle_models_orgId_makeId_deletedAt_idx" ON "vehicle_models"("orgId", "makeId", "deletedAt");
CREATE INDEX "vehicle_models_orgId_syncVersion_idx" ON "vehicle_models"("orgId", "syncVersion");
CREATE UNIQUE INDEX "vehicle_models_orgId_makeId_nameKey_key" ON "vehicle_models"("orgId", "makeId", "nameKey");

-- AddForeignKey
ALTER TABLE "vehicle_makes" ADD CONSTRAINT "vehicle_makes_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_makeId_fkey" FOREIGN KEY ("makeId") REFERENCES "vehicle_makes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Стартовий список і аліаси (тимчасові таблиці живуть до кінця сесії міграції).
CREATE TEMP TABLE "_vm_default" ("name" TEXT NOT NULL);
INSERT INTO "_vm_default" ("name") VALUES
('Acura'),
('Alfa Romeo'),
('Audi'),
('BMW'),
('BYD'),
('Cadillac'),
('Chery'),
('Chevrolet'),
('Chrysler'),
('Citroen'),
('Cupra'),
('Dacia'),
('Daewoo'),
('Dodge'),
('Ferrari'),
('Fiat'),
('Ford'),
('GAZ'),
('Geely'),
('Genesis'),
('Great Wall'),
('Haval'),
('Honda'),
('Hyundai'),
('Infiniti'),
('Isuzu'),
('Iveco'),
('Jaguar'),
('Jeep'),
('Kia'),
('Lada'),
('Land Rover'),
('Lexus'),
('Lincoln'),
('Mazda'),
('Mercedes-Benz'),
('MG'),
('Mini'),
('Mitsubishi'),
('Moskvich'),
('Nissan'),
('Opel'),
('Peugeot'),
('Porsche'),
('Ravon'),
('Renault'),
('Seat'),
('Skoda'),
('Smart'),
('SsangYong'),
('Subaru'),
('Suzuki'),
('Tesla'),
('Toyota'),
('UAZ'),
('Volkswagen'),
('Volvo'),
('ZAZ');

CREATE TEMP TABLE "_vm_alias" ("alias" TEXT NOT NULL, "name" TEXT NOT NULL);
INSERT INTO "_vm_alias" ("alias", "name") VALUES
('Ауді', 'Audi'),
('Ауди', 'Audi'),
('БМВ', 'BMW'),
('Чері', 'Chery'),
('Чери', 'Chery'),
('Шевроле', 'Chevrolet'),
('Citroën', 'Citroen'),
('Сітроен', 'Citroen'),
('Ситроен', 'Citroen'),
('Дачія', 'Dacia'),
('Деу', 'Daewoo'),
('Дэу', 'Daewoo'),
('Фіат', 'Fiat'),
('Фиат', 'Fiat'),
('Форд', 'Ford'),
('ГАЗ', 'GAZ'),
('Джилі', 'Geely'),
('Джили', 'Geely'),
('Хонда', 'Honda'),
('Хюндай', 'Hyundai'),
('Хендай', 'Hyundai'),
('Хундай', 'Hyundai'),
('Кіа', 'Kia'),
('Киа', 'Kia'),
('ВАЗ', 'Lada'),
('VAZ', 'Lada'),
('Лада', 'Lada'),
('Лексус', 'Lexus'),
('Мазда', 'Mazda'),
('Mercedes', 'Mercedes-Benz'),
('Mercedes Benz', 'Mercedes-Benz'),
('Мерседес', 'Mercedes-Benz'),
('Міцубісі', 'Mitsubishi'),
('Мицубиси', 'Mitsubishi'),
('Москвич', 'Moskvich'),
('Ніссан', 'Nissan'),
('Ниссан', 'Nissan'),
('Опель', 'Opel'),
('Пежо', 'Peugeot'),
('Порше', 'Porsche'),
('Рено', 'Renault'),
('Škoda', 'Skoda'),
('Шкода', 'Skoda'),
('Субару', 'Subaru'),
('Сузукі', 'Suzuki'),
('Сузуки', 'Suzuki'),
('Тесла', 'Tesla'),
('Тойота', 'Toyota'),
('УАЗ', 'UAZ'),
('VW', 'Volkswagen'),
('Фольксваген', 'Volkswagen'),
('Вольво', 'Volvo'),
('ЗАЗ', 'ZAZ');

-- 1. Стартовий список — кожній організації (BR-VEH-012).
INSERT INTO "vehicle_makes" ("orgId", "name", "nameKey", "updatedAt")
SELECT o."id", d."name", lower(regexp_replace(btrim(d."name"), '\s+', ' ', 'g')), now()
FROM "organisations" AS o
CROSS JOIN "_vm_default" AS d
ON CONFLICT ("orgId", "nameKey") DO NOTHING;

-- 2. Ключ марки кожного авто: аліас → ключ марки стартового списку.
ALTER TABLE "vehicles" ADD COLUMN "makeId" UUID, ADD COLUMN "modelId" UUID;

CREATE TEMP TABLE "_vm_vehicle" AS
SELECT v."id",
       v."orgId",
       COALESCE(NULLIF(regexp_replace(btrim(v."make"), '\s+', ' ', 'g'), ''), '—') AS "makeName",
       COALESCE(NULLIF(regexp_replace(btrim(v."model"), '\s+', ' ', 'g'), ''), '—') AS "modelName"
FROM "vehicles" AS v;

ALTER TABLE "_vm_vehicle" ADD COLUMN "makeKey" TEXT, ADD COLUMN "modelKey" TEXT;
UPDATE "_vm_vehicle" SET "makeKey" = lower("makeName"), "modelKey" = lower("modelName");
UPDATE "_vm_vehicle" AS t
SET "makeKey" = lower(regexp_replace(btrim(a."name"), '\s+', ' ', 'g'))
FROM "_vm_alias" AS a
WHERE t."makeKey" = lower(regexp_replace(btrim(a."alias"), '\s+', ' ', 'g'));

-- 3. Марки, яких немає в стартовому списку: назва — найчастіше написання в організації.
INSERT INTO "vehicle_makes" ("orgId", "name", "nameKey", "updatedAt")
SELECT t."orgId", mode() WITHIN GROUP (ORDER BY t."makeName"), t."makeKey", now()
FROM "_vm_vehicle" AS t
GROUP BY t."orgId", t."makeKey"
ON CONFLICT ("orgId", "nameKey") DO NOTHING;

UPDATE "vehicles" AS v
SET "makeId" = m."id"
FROM "_vm_vehicle" AS t
JOIN "vehicle_makes" AS m ON m."orgId" = t."orgId" AND m."nameKey" = t."makeKey"
WHERE v."id" = t."id";

-- 4. Моделі в межах марки.
INSERT INTO "vehicle_models" ("orgId", "makeId", "name", "nameKey", "updatedAt")
SELECT t."orgId", v."makeId", mode() WITHIN GROUP (ORDER BY t."modelName"), t."modelKey", now()
FROM "_vm_vehicle" AS t
JOIN "vehicles" AS v ON v."id" = t."id"
GROUP BY t."orgId", v."makeId", t."modelKey"
ON CONFLICT ("orgId", "makeId", "nameKey") DO NOTHING;

UPDATE "vehicles" AS v
SET "modelId" = mo."id"
FROM "_vm_vehicle" AS t
JOIN "vehicle_models" AS mo ON mo."orgId" = t."orgId" AND mo."nameKey" = t."modelKey"
WHERE v."id" = t."id" AND mo."makeId" = v."makeId";

-- 5. Знімок назви — канонічна назва довідника (BR-VEH-008); syncVersion лише там, де вона змінилась.
UPDATE "vehicles" AS v
SET "make" = m."name",
    "model" = mo."name",
    "updatedAt" = now(),
    "syncVersion" = v."syncVersion" + 1
FROM "vehicle_makes" AS m, "vehicle_models" AS mo
WHERE m."id" = v."makeId" AND mo."id" = v."modelId"
  AND (v."make" IS DISTINCT FROM m."name" OR v."model" IS DISTINCT FROM mo."name");

-- 6. Кожне авто тепер має марку й модель.
ALTER TABLE "vehicles" ALTER COLUMN "makeId" SET NOT NULL, ALTER COLUMN "modelId" SET NOT NULL;

CREATE INDEX "vehicles_orgId_makeId_idx" ON "vehicles"("orgId", "makeId");
CREATE INDEX "vehicles_orgId_modelId_idx" ON "vehicles"("orgId", "modelId");
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_makeId_fkey" FOREIGN KEY ("makeId") REFERENCES "vehicle_makes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "vehicle_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TABLE "_vm_vehicle";
DROP TABLE "_vm_alias";
DROP TABLE "_vm_default";
