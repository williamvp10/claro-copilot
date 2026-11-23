CREATE TABLE IF NOT EXISTS billing_customer (ref text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS invoice (
  ref text PRIMARY KEY,
  customer_ref text NOT NULL REFERENCES billing_customer(ref),
  business_period text NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_customer_period ON invoice(customer_ref,business_period DESC);
CREATE TABLE IF NOT EXISTS credit (
  ref text PRIMARY KEY,
  invoice_ref text NOT NULL REFERENCES invoice(ref),
  amount integer NOT NULL CHECK (amount>0),
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_invoice ON credit(invoice_ref);
