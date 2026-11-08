-- Tables for the workforce tool handlers that had no company-scoped table.
-- Matches the Drizzle definitions in shared/schema.ts (section "Workforce tool tables").
-- Idempotent (IF NOT EXISTS) so a re-run is safe.
--
-- Tenant key: every table carries company_id NOT NULL, references companies(id), and has an
-- index on company_id. Parent tables expose UNIQUE (company_id, id); child tables use composite
-- foreign keys on (company_id, parent_id), so a row cannot point at another company's parent.
-- Column names and shapes follow Sorted's table of the same name where one exists, with
-- account_id replaced by company_id (Central plan: Masterleeaus/Sorted #26 and #28).
--
-- companies is created here only if missing. Central owns it; this is a guard for a fresh database.
-- Composite foreign keys use no ON DELETE SET NULL: it would also null company_id, which is NOT NULL.
-- A parent with children is protected by the default NO ACTION, or by CASCADE where the child is owned.

CREATE TABLE IF NOT EXISTS companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- customers and sites

CREATE TABLE IF NOT EXISTS clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  email        text,
  phone        text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_company_id_uidx UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS clients_company_id_idx ON clients (company_id);

CREATE TABLE IF NOT EXISTS client_merge_suggestions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id            uuid NOT NULL,
  duplicate_client_id  uuid NOT NULL,
  reason               text,
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'dismissed', 'merged')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_merge_suggestions_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT client_merge_suggestions_distinct_chk CHECK (client_id <> duplicate_client_id),
  CONSTRAINT client_merge_suggestions_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE CASCADE,
  CONSTRAINT client_merge_suggestions_duplicate_fk
    FOREIGN KEY (company_id, duplicate_client_id) REFERENCES clients (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS client_merge_suggestions_company_id_idx ON client_merge_suggestions (company_id);

CREATE TABLE IF NOT EXISTS properties (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL,
  name         text,
  address      text NOT NULL,
  city         text,
  state        text,
  zip          text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT properties_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT properties_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS properties_company_id_idx ON properties (company_id);

CREATE TABLE IF NOT EXISTS property_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id     uuid NOT NULL,
  client_id       uuid,
  external_name   text,
  external_email  text,
  external_phone  text,
  notes           text,
  role            text NOT NULL
                    CHECK (role IN ('owner', 'realtor', 'beneficiary', 'property_manager', 'tenant', 'other')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_contacts_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT property_contacts_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id) ON DELETE CASCADE,
  CONSTRAINT property_contacts_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT property_contacts_one_identity_chk CHECK (
    (client_id IS NOT NULL AND external_name IS NULL AND external_email IS NULL AND external_phone IS NULL)
    OR (client_id IS NULL AND external_name IS NOT NULL AND length(btrim(external_name)) > 0)
  )
);
CREATE INDEX IF NOT EXISTS property_contacts_company_id_idx ON property_contacts (company_id);

CREATE TABLE IF NOT EXISTS property_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id       uuid NOT NULL,
  area              text NOT NULL,
  item_key          text NOT NULL,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description       text,
  first_noted_at    timestamptz NOT NULL DEFAULT now(),
  last_noted_at     timestamptz NOT NULL DEFAULT now(),
  occurrence_count  integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'monitoring', 'resolved', 'referred')),
  resolved_at       timestamptz,
  resolved_note     text,
  severity          text NOT NULL DEFAULT 'minor'
                      CHECK (severity IN ('minor', 'moderate', 'major', 'critical')),
  auto_detected     boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_issues_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT property_issues_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS property_issues_company_id_idx ON property_issues (company_id);

-- ---------------------------------------------------------------- work, visits and job records

CREATE TABLE IF NOT EXISTS work_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL,
  property_id   uuid,
  title         text NOT NULL,
  scope         text,
  site_notes    text,
  safety_notes  text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  total_cents   integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes         text,
  completed_at  timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_orders_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT work_orders_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT work_orders_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS work_orders_company_id_idx ON work_orders (company_id);

CREATE TABLE IF NOT EXISTS visits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_order_id     uuid NOT NULL,
  assigned_user_id  uuid,
  status            text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'arrived', 'in_progress', 'completed', 'cancelled')),
  scheduled_start   timestamptz NOT NULL,
  scheduled_end     timestamptz NOT NULL,
  arrived_at        timestamptz,
  completed_at      timestamptz,
  tech_notes        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visits_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT visits_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS visits_company_id_idx ON visits (company_id);

CREATE TABLE IF NOT EXISTS visit_checklist_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_id    uuid NOT NULL,
  section     text NOT NULL,
  item_key    text NOT NULL,
  label       text NOT NULL,
  disposition text CHECK (disposition IN ('ok', 'fix_now', 'monitor', 'optional', 'refer')),
  note        text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_checklist_items_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT visit_checklist_items_visit_item_uniq UNIQUE (company_id, visit_id, item_key),
  CONSTRAINT visit_checklist_items_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS visit_checklist_items_company_id_idx ON visit_checklist_items (company_id);

CREATE TABLE IF NOT EXISTS visit_media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_id       uuid NOT NULL,
  category       text NOT NULL CHECK (category IN ('before', 'after', 'receipt')),
  filename       text NOT NULL,
  original_name  text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes >= 0),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_media_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT visit_media_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS visit_media_company_id_idx ON visit_media (company_id);

CREATE TABLE IF NOT EXISTS job_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_order_id   uuid,
  visit_id        uuid,
  body            text NOT NULL CHECK (length(btrim(body)) > 0),
  author_user_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_notes_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT job_notes_one_parent_chk CHECK (work_order_id IS NOT NULL OR visit_id IS NOT NULL),
  CONSTRAINT job_notes_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id) ON DELETE CASCADE,
  CONSTRAINT job_notes_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_notes_company_id_idx ON job_notes (company_id);

CREATE TABLE IF NOT EXISTS job_signoffs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_id     uuid NOT NULL,
  signer_name  text NOT NULL CHECK (length(btrim(signer_name)) > 0),
  signed_at    timestamptz NOT NULL DEFAULT now(),
  notes        text,
  recorded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_signoffs_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT job_signoffs_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_signoffs_company_id_idx ON job_signoffs (company_id);

CREATE TABLE IF NOT EXISTS job_material_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_order_id  uuid NOT NULL,
  name           text NOT NULL,
  quantity       numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_label     text,
  store_section  text,
  status         text NOT NULL DEFAULT 'needed'
                   CHECK (status IN ('needed', 'purchased', 'on_truck', 'not_needed')),
  source         text NOT NULL DEFAULT 'manual'
                   CHECK (source IN ('estimate', 'kit', 'ai', 'manual')),
  sku            text,
  notes          text,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_material_lines_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT job_material_lines_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_material_lines_company_id_idx ON job_material_lines (company_id);

-- ---------------------------------------------------------------- stock, purchasing and staff

CREATE TABLE IF NOT EXISTS inventory_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           text NOT NULL,
  sku            text,
  unit_label     text,
  store_section  text,
  quantity       numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level  numeric(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_items_company_id_uidx UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS inventory_items_company_id_idx ON inventory_items (company_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_name  text NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  total_cents    integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes          text,
  ordered_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_company_id_uidx UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS purchase_orders_company_id_idx ON purchase_orders (company_id);

CREATE TABLE IF NOT EXISTS supplier_bills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_order_id  uuid,
  supplier_name      text NOT NULL,
  bill_number        text,
  amount_cents       integer NOT NULL CHECK (amount_cents >= 0),
  due_date           date,
  status             text NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'matched', 'disputed', 'paid')),
  received_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_bills_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT supplier_bills_purchase_order_fk
    FOREIGN KEY (company_id, purchase_order_id) REFERENCES purchase_orders (company_id, id)
);
CREATE INDEX IF NOT EXISTS supplier_bills_company_id_idx ON supplier_bills (company_id);

CREATE TABLE IF NOT EXISTS end_of_lease_checklists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id  uuid,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete')),
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT end_of_lease_checklists_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT end_of_lease_checklists_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS end_of_lease_checklists_company_id_idx ON end_of_lease_checklists (company_id);

CREATE TABLE IF NOT EXISTS crew_rosters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  roster_date date NOT NULL,
  team_name   text NOT NULL,
  members     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_rosters_company_id_uidx UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS crew_rosters_company_id_idx ON crew_rosters (company_id);

CREATE TABLE IF NOT EXISTS timesheets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  work_date   date NOT NULL,
  started_at  timestamptz,
  ended_at    timestamptz,
  hours       numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'approved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timesheets_company_id_uidx UNIQUE (company_id, id)
);
CREATE INDEX IF NOT EXISTS timesheets_company_id_idx ON timesheets (company_id);

CREATE TABLE IF NOT EXISTS timesheet_flags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL,
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  raised_by    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_flags_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT timesheet_flags_timesheet_fk
    FOREIGN KEY (company_id, timesheet_id) REFERENCES timesheets (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS timesheet_flags_company_id_idx ON timesheet_flags (company_id);

CREATE TABLE IF NOT EXISTS staff_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff', 'technician')),
  title             text NOT NULL,
  description       text,
  assignee_user_id  uuid,
  work_order_id     uuid,
  visit_id          uuid,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  priority          text NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at            timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_tasks_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT staff_tasks_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id),
  CONSTRAINT staff_tasks_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id)
);
CREATE INDEX IF NOT EXISTS staff_tasks_company_id_idx ON staff_tasks (company_id);

CREATE TABLE IF NOT EXISTS business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      uuid,
  day_of_week  integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at     time NOT NULL,
  closes_at    time NOT NULL,
  capacity     integer NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT business_hours_window_chk CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS business_hours_company_id_idx ON business_hours (company_id);

-- ---------------------------------------------------------------- contracts and plans

CREATE TABLE IF NOT EXISTS service_agreements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL,
  property_id  uuid,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed', 'cancelled')),
  starts_on    date,
  ends_on      date,
  price_cents  integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_agreements_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT service_agreements_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT service_agreements_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS service_agreements_company_id_idx ON service_agreements (company_id);

CREATE TABLE IF NOT EXISTS maintenance_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id            uuid NOT NULL,
  property_id          uuid,
  name                 text NOT NULL,
  frequency            text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'biannual', 'annual')),
  services             text[] NOT NULL DEFAULT '{}',
  price_cents          integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  next_scheduled_date  date,
  notes                text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_plans_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT maintenance_plans_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE CASCADE,
  CONSTRAINT maintenance_plans_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS maintenance_plans_company_id_idx ON maintenance_plans (company_id);

CREATE TABLE IF NOT EXISTS estimates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL,
  property_id     uuid,
  work_order_id   uuid,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'approved', 'declined', 'expired')),
  subtotal_cents  integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents       integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents     integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes           text,
  internal_notes  text,
  sent_at         timestamptz,
  expires_at      timestamptz,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT estimates_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT estimates_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id) ON DELETE RESTRICT,
  CONSTRAINT estimates_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  CONSTRAINT estimates_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id)
);
CREATE INDEX IF NOT EXISTS estimates_company_id_idx ON estimates (company_id);

-- ---------------------------------------------------------------- sales, money follow-up and customer feedback

CREATE TABLE IF NOT EXISTS quote_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id     uuid,
  client_name   text NOT NULL,
  summary       text NOT NULL,
  status        text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'reviewed', 'converted', 'closed')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_requests_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT quote_requests_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS quote_requests_company_id_idx ON quote_requests (company_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    uuid,
  title        text NOT NULL,
  stage        text NOT NULL DEFAULT 'new'
                 CHECK (stage IN ('new', 'qualified', 'quoted', 'won', 'lost')),
  value_cents  integer NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
  source       text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunities_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT opportunities_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS opportunities_company_id_idx ON opportunities (company_id);

CREATE TABLE IF NOT EXISTS disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    uuid,
  invoice_ref  varchar(128),
  kind         text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'invoice')),
  summary      text NOT NULL,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'under_review', 'resolved', 'closed')),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disputes_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT disputes_invoice_ref_chk CHECK (kind = 'general' OR invoice_ref IS NOT NULL),
  CONSTRAINT disputes_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS disputes_company_id_idx ON disputes (company_id);

CREATE TABLE IF NOT EXISTS collection_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       uuid,
  invoice_ref     varchar(128) NOT NULL,
  body            text NOT NULL CHECK (length(btrim(body)) > 0),
  author_user_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_notes_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT collection_notes_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS collection_notes_company_id_idx ON collection_notes (company_id);

CREATE TABLE IF NOT EXISTS reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id    uuid,
  rating       integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      text,
  source       text,
  reviewed_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT reviews_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS reviews_company_id_idx ON reviews (company_id);

CREATE TABLE IF NOT EXISTS review_alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  review_id   uuid NOT NULL,
  summary     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_alerts_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT review_alerts_review_fk
    FOREIGN KEY (company_id, review_id) REFERENCES reviews (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS review_alerts_company_id_idx ON review_alerts (company_id);

CREATE TABLE IF NOT EXISTS feedback_responses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  visit_id      uuid,
  client_id     uuid,
  rating        integer CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment       text,
  responded_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_responses_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT feedback_responses_visit_fk
    FOREIGN KEY (company_id, visit_id) REFERENCES visits (company_id, id),
  CONSTRAINT feedback_responses_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id)
);
CREATE INDEX IF NOT EXISTS feedback_responses_company_id_idx ON feedback_responses (company_id);

CREATE TABLE IF NOT EXISTS complaints (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id      uuid,
  property_id    uuid,
  work_order_id  uuid,
  summary        text NOT NULL,
  category       text,
  status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  raised_by      uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complaints_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT complaints_client_fk
    FOREIGN KEY (company_id, client_id) REFERENCES clients (company_id, id),
  CONSTRAINT complaints_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  CONSTRAINT complaints_work_order_fk
    FOREIGN KEY (company_id, work_order_id) REFERENCES work_orders (company_id, id)
);
CREATE INDEX IF NOT EXISTS complaints_company_id_idx ON complaints (company_id);

-- ---------------------------------------------------------------- compliance

CREATE TABLE IF NOT EXISTS compliance_certificates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id       uuid,
  certificate_type  text NOT NULL,
  reference         text,
  issued_on         date,
  expires_on        date,
  status            text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'expiring', 'expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_certificates_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT compliance_certificates_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS compliance_certificates_company_id_idx ON compliance_certificates (company_id);

CREATE TABLE IF NOT EXISTS compliance_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id    uuid,
  title          text NOT NULL,
  document_type  text,
  expires_on     date,
  storage_ref    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_documents_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT compliance_documents_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS compliance_documents_company_id_idx ON compliance_documents (company_id);

-- ---------------------------------------------------------------- pools and water tests

CREATE TABLE IF NOT EXISTS pool_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  property_id    uuid,
  name           text NOT NULL,
  volume_litres  integer CHECK (volume_litres IS NULL OR volume_litres > 0),
  sanitiser      text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_profiles_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT pool_profiles_property_fk
    FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id)
);
CREATE INDEX IF NOT EXISTS pool_profiles_company_id_idx ON pool_profiles (company_id);

CREATE TABLE IF NOT EXISTS pool_equipment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pool_profile_id  uuid NOT NULL,
  kind             text NOT NULL,
  make             text,
  model            text,
  serial           text,
  installed_on     date,
  status           text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'fault', 'retired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_equipment_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT pool_equipment_pool_fk
    FOREIGN KEY (company_id, pool_profile_id) REFERENCES pool_profiles (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pool_equipment_company_id_idx ON pool_equipment (company_id);

CREATE TABLE IF NOT EXISTS pool_equipment_faults (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pool_equipment_id  uuid NOT NULL,
  summary            text NOT NULL,
  severity           text NOT NULL DEFAULT 'minor'
                       CHECK (severity IN ('minor', 'moderate', 'major', 'critical')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  reported_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_equipment_faults_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT pool_equipment_faults_equipment_fk
    FOREIGN KEY (company_id, pool_equipment_id) REFERENCES pool_equipment (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS pool_equipment_faults_company_id_idx ON pool_equipment_faults (company_id);

CREATE TABLE IF NOT EXISTS water_tests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  pool_profile_id  uuid NOT NULL,
  scheduled_for    timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT water_tests_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT water_tests_pool_fk
    FOREIGN KEY (company_id, pool_profile_id) REFERENCES pool_profiles (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS water_tests_company_id_idx ON water_tests (company_id);

CREATE TABLE IF NOT EXISTS water_test_results (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  water_test_id        uuid,
  pool_profile_id      uuid NOT NULL,
  tested_at            timestamptz NOT NULL DEFAULT now(),
  free_chlorine        numeric(5,2) CHECK (free_chlorine IS NULL OR free_chlorine >= 0),
  ph                   numeric(4,2) CHECK (ph IS NULL OR (ph >= 0 AND ph <= 14)),
  total_alkalinity_ppm integer CHECK (total_alkalinity_ppm IS NULL OR total_alkalinity_ppm >= 0),
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT water_test_results_company_id_uidx UNIQUE (company_id, id),
  CONSTRAINT water_test_results_test_fk
    FOREIGN KEY (company_id, water_test_id) REFERENCES water_tests (company_id, id),
  CONSTRAINT water_test_results_pool_fk
    FOREIGN KEY (company_id, pool_profile_id) REFERENCES pool_profiles (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS water_test_results_company_id_idx ON water_test_results (company_id);
