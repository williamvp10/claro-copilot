CREATE TABLE IF NOT EXISTS customer (
  ref text PRIMARY KEY,
  document_kind text NOT NULL,
  document_number text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text NOT NULL UNIQUE,
  profile jsonb NOT NULL,
  UNIQUE (document_kind,document_number)
);
CREATE TABLE IF NOT EXISTS crm_ticket (
  ref text PRIMARY KEY,
  customer_ref text NOT NULL REFERENCES customer(ref),
  business_date date NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_ticket_customer_date ON crm_ticket(customer_ref,business_date DESC);
CREATE TABLE IF NOT EXISTS crm_offer (
  ref text PRIMARY KEY,
  customer_ref text NOT NULL REFERENCES customer(ref),
  business_date date NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_offer_customer_date ON crm_offer(customer_ref,business_date DESC);

ALTER TABLE customer ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
