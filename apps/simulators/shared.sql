CREATE TABLE IF NOT EXISTS operation_receipt (
  operation_key text PRIMARY KEY,
  fingerprint text NOT NULL,
  receipt jsonb NOT NULL,
  body jsonb
);
