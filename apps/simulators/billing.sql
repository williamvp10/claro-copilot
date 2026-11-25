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
CREATE SEQUENCE IF NOT EXISTS demo_invoice_number START 100000;
CREATE TABLE IF NOT EXISTS billing_discount (
  offer_ref text PRIMARY KEY,
  customer_ref text NOT NULL REFERENCES billing_customer(ref),
  service_id text NOT NULL,
  start_period text NOT NULL,
  end_period text NOT NULL,
  terms jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_discount_customer ON billing_discount(customer_ref,service_id,end_period);
