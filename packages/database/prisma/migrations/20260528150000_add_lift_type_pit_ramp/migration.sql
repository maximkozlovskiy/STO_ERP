-- Add PIT (Яма) and RAMP (Естакада) to LiftType enum.
-- IF NOT EXISTS keeps the migration idempotent and safe on already-patched DBs.
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'PIT';
ALTER TYPE "LiftType" ADD VALUE IF NOT EXISTS 'RAMP';
