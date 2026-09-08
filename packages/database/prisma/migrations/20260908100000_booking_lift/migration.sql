-- Booking per-lift (CAL-H3/H4): BookingRequest отримує обраний ліфт, щоб CONFIRMED-заявка
-- блокувала саме цей ліфт, а не всі одразу. Additive/idempotent.
ALTER TABLE "booking_requests" ADD COLUMN IF NOT EXISTS "liftId" UUID;
