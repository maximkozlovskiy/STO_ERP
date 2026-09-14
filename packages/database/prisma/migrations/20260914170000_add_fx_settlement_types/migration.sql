-- Курсові різниці (мультивалюта Фаза 4): типи realized FX для взаєморозрахунків.
-- ОКРЕМА міграція — Postgres не дозволяє вживати нове enum-значення у тій самій транзакції,
-- де його додано (тож FX-проводки писатимуться наступними міграціями/рантаймом, не тут).
ALTER TYPE "SettlementTransactionType" ADD VALUE IF NOT EXISTS 'FX_GAIN';
ALTER TYPE "SettlementTransactionType" ADD VALUE IF NOT EXISTS 'FX_LOSS';
