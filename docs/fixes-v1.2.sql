-- NeoKidsPro EMR v1.2 — Run this if upgrading from v1.1
-- Safe to run multiple times (uses IF NOT EXISTS)

USE neokidspro;

-- No schema changes needed for these fixes.
-- All bugs were logic/code bugs, not schema bugs.

-- Fix stuck PENDING slots from testing (run once to clean up dev data):
-- UPDATE appointments
--   SET status = 'CANCELLED', paymentStatus = 'FAILED',
--       cancelledAt = NOW(), notes = 'Manually cleared during v1.2 upgrade'
--   WHERE status = 'PENDING'
--     AND paymentStatus = 'UNPAID'
--     AND (expiresAt IS NULL OR expiresAt < NOW());

-- Recalculate all doctor revenue from scratch (run once after upgrade):
-- This fixes any revenue that was 0 due to the bug.
UPDATE doctors d
SET revenue = (
  SELECT COALESCE(SUM(a.feeAtBooking), 0)
  FROM appointments a
  WHERE a.doctorId = d.id
    AND a.status = 'COMPLETED'
    AND a.paymentStatus = 'PAID'
),
consults = (
  SELECT COUNT(*)
  FROM appointments a
  WHERE a.doctorId = d.id
    AND a.status = 'COMPLETED'
);

SELECT 'Revenue recalculated for all doctors' AS result;
