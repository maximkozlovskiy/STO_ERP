-- B1 session revocation + B2 brute-force lockout на auth_accounts. Additive/idempotent, deploy-safe.
-- tokenVersion: bump при logout-all/зміні пароля → усі старі JWT мертві (jwt.strategy порівнює).
-- failedAttempts/lockedUntil: rate-based account lockout поверх IP-throttle.
ALTER TABLE "auth_accounts"
  ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
