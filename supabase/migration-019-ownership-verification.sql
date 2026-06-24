-- Migration 019: Ownership verification gate for admin review
-- Adds columns to track that an admin explicitly verified ownership before
-- approving a manual verification request. This closes the security gap where
-- an admin could rubber-stamp a request from a non-owner.

ALTER TABLE verification_requests
  ADD COLUMN IF NOT EXISTS ownership_verified_by UUID,
  ADD COLUMN IF NOT EXISTS ownership_verified_at TIMESTAMPTZ;
