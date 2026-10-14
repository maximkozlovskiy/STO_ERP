-- Реквізити організації для друку документів (рішення власника 2026-10-15).

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN "phone" TEXT,
ADD COLUMN "email" TEXT,
ADD COLUMN "ipn" TEXT;
