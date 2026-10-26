CREATE TABLE IF NOT EXISTS analytics.source_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner text NOT NULL,
  project_number integer NOT NULL CHECK (project_number > 0),
  project_id text
);

CREATE TABLE IF NOT EXISTS analytics.sync_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  observed_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  item_count integer,
  changed_count integer,
  missing_count integer,
  failure_code text
);

CREATE TABLE IF NOT EXISTS analytics.project_current (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot jsonb NOT NULL,
  fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics.project_history (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES analytics.sync_runs(id),
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  fingerprint text NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics.item_current (
  item_id text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  fingerprint text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  missing_since timestamptz
);

CREATE TABLE IF NOT EXISTS analytics.item_history (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id text NOT NULL,
  run_id uuid NOT NULL REFERENCES analytics.sync_runs(id),
  observed_at timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('observed', 'missing')),
  snapshot jsonb NOT NULL,
  fingerprint text NOT NULL,
  UNIQUE (run_id, item_id)
);

CREATE INDEX IF NOT EXISTS item_history_item_observed ON analytics.item_history(item_id, observed_at);

CREATE OR REPLACE VIEW analytics.items AS
SELECT item_id,
       snapshot->>'type' AS item_type,
       snapshot->'content'->>'title' AS title,
       snapshot->'content'->>'url' AS url,
       snapshot->'content'->'repository'->>'nameWithOwner' AS repository,
       snapshot->'content'->>'state' AS state,
       (snapshot->>'isArchived')::boolean AS archived,
       missing_since IS NULL AS present,
       first_observed_at, observed_at, missing_since,
       (snapshot->>'createdAt')::timestamptz AS source_created_at,
       (snapshot->>'updatedAt')::timestamptz AS source_updated_at,
       snapshot,
       snapshot->'content'->'issueType'->>'name' AS issue_type
FROM analytics.item_current;

CREATE OR REPLACE VIEW analytics.item_fields AS
SELECT item_id,
       field->'field'->>'id' AS field_id,
       field->'field'->>'name' AS field_name,
       field->'field'->>'dataType' AS field_type,
       COALESCE(field->>'text', field->>'name', field->>'title', field->>'date', field->>'number') AS display_value,
       field AS value
FROM analytics.item_current
CROSS JOIN LATERAL jsonb_array_elements(snapshot->'fields') AS field;

CREATE OR REPLACE VIEW analytics.item_iterations AS
SELECT item_id, field_id, field_name,
       value->>'iterationId' AS iteration_id,
       value->>'title' AS iteration_title,
       (value->>'startDate')::date AS start_date,
       (value->>'duration')::integer AS duration_days
FROM analytics.item_fields
WHERE field_type = 'ITERATION';
