published_run AS MATERIALIZED (
 SELECT id, observed_at, completed_at FROM analytics.sync_runs
 WHERE status='complete' AND id::text=${focusSnapshot:sqlstring}
), published_runs AS MATERIALIZED (
 SELECT r.* FROM analytics.sync_runs r CROSS JOIN published_run p
 WHERE r.status='complete' AND r.observed_at<=p.observed_at AND r.completed_at<=p.completed_at
), published_versions AS MATERIALIZED (
 SELECT DISTINCT ON (h.item_id) h.item_id,h.snapshot,h.kind
 FROM analytics.item_history h JOIN published_runs r ON r.id=h.run_id
 ORDER BY h.item_id,h.observed_at DESC,h.revision DESC
), published_items AS MATERIALIZED (
 SELECT item_id,snapshot,snapshot->>'type' AS item_type,
 (snapshot->>'isArchived')::boolean AS archived,kind='observed' AS present,
 snapshot->'content'->>'stateReason' AS state_reason,
 snapshot->'content'->'parent'->>'id' AS parent_issue_id,
 snapshot->'content'->>'id' AS content_id
 FROM published_versions
)
