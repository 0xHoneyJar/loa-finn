-- Custom migration: updated_at trigger for finn_api_keys (Sprint 1 T1.3)
-- Drizzle doesn't generate triggers, so this is a manual migration.

CREATE OR REPLACE FUNCTION finn.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER trg_finn_api_keys_updated_at
  BEFORE UPDATE ON finn.finn_api_keys
  FOR EACH ROW
  EXECUTE FUNCTION finn.set_updated_at();
