-- Widen exchange rate precision: Decimal(15,2) loses precision for low-value
-- currencies (e.g. 1 HUF ≈ 0.11 UAH, 1 IDR ≈ 0.0025 UAH). NBU publishes rates
-- with up to 6 fractional digits per coefficient-unit. Decimal(18,6) preserves
-- both large integer part and fine fractional precision.
ALTER TABLE "exchange_rates"
  ALTER COLUMN "rate"        TYPE DECIMAL(18,6),
  ALTER COLUMN "coefficient" TYPE DECIMAL(18,6);
