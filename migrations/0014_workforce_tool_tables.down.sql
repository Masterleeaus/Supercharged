-- ============================================================
-- DOWN for migrations/0014_workforce_tool_tables.sql (issue #251).
--
-- Drops the 39 workforce tool tables that 0014 creates, children before parents.
-- Indexes, composite foreign keys and policies on these tables go with them.
--
-- NOT dropped here: companies. 0014 declares it with CREATE TABLE IF NOT EXISTS, so it may
-- predate this migration (DRAFT_companies_foundation.sql). Dropping it is a separate, explicit
-- decision. Run it by hand only if this database never had companies before 0014.
--
-- DATA LOSS: this removes every row in these tables. Run only on a disposable database or after a
-- verified backup. Not run by scripts/run-safe-migration.mjs.
-- ============================================================
DROP TABLE IF EXISTS water_test_results;
DROP TABLE IF EXISTS water_tests;
DROP TABLE IF EXISTS pool_equipment_faults;
DROP TABLE IF EXISTS pool_equipment;
DROP TABLE IF EXISTS pool_profiles;
DROP TABLE IF EXISTS compliance_documents;
DROP TABLE IF EXISTS compliance_certificates;
DROP TABLE IF EXISTS complaints;
DROP TABLE IF EXISTS feedback_responses;
DROP TABLE IF EXISTS review_alerts;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS collection_notes;
DROP TABLE IF EXISTS disputes;
DROP TABLE IF EXISTS opportunities;
DROP TABLE IF EXISTS quote_requests;
DROP TABLE IF EXISTS estimates;
DROP TABLE IF EXISTS maintenance_plans;
DROP TABLE IF EXISTS service_agreements;
DROP TABLE IF EXISTS business_hours;
DROP TABLE IF EXISTS staff_tasks;
DROP TABLE IF EXISTS timesheet_flags;
DROP TABLE IF EXISTS timesheets;
DROP TABLE IF EXISTS crew_rosters;
DROP TABLE IF EXISTS end_of_lease_checklists;
DROP TABLE IF EXISTS supplier_bills;
DROP TABLE IF EXISTS purchase_orders;
DROP TABLE IF EXISTS inventory_items;
DROP TABLE IF EXISTS job_material_lines;
DROP TABLE IF EXISTS job_signoffs;
DROP TABLE IF EXISTS job_notes;
DROP TABLE IF EXISTS visit_media;
DROP TABLE IF EXISTS visit_checklist_items;
DROP TABLE IF EXISTS visits;
DROP TABLE IF EXISTS work_orders;
DROP TABLE IF EXISTS property_issues;
DROP TABLE IF EXISTS property_contacts;
DROP TABLE IF EXISTS properties;
DROP TABLE IF EXISTS client_merge_suggestions;
DROP TABLE IF EXISTS clients;
