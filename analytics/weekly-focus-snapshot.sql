snapshot_fallback_items AS MATERIALIZED (
 SELECT i.*
 FROM obs_snapshot_items i JOIN obs_valid v USING(cutoff)
 WHERE i.cutoff=(SELECT max(cutoff) FROM obs_valid) AND NOT v.usable
), snapshot_fallback_focus(issue_id) AS (
 SELECT issue_id FROM snapshot_fallback_items
 WHERE direct_focus AND NOT archived AND keys_known AND parent_id IS NULL
 UNION
 SELECT i.issue_id FROM snapshot_fallback_focus f
 JOIN snapshot_fallback_items i ON i.parent_id=f.issue_id
), snapshot_fallback_ancestors(issue_id,ancestor_id) AS (
 SELECT issue_id,parent_id FROM snapshot_fallback_items WHERE parent_id IS NOT NULL
 UNION
 SELECT a.issue_id,p.parent_id FROM snapshot_fallback_ancestors a
 JOIN snapshot_fallback_items p ON p.issue_id=a.ancestor_id
 WHERE p.parent_id IS NOT NULL
), snapshot_fallback_uncertain AS (
 SELECT DISTINCT a.issue_id FROM snapshot_fallback_ancestors a
 LEFT JOIN snapshot_fallback_items p ON p.issue_id=a.ancestor_id
 WHERE p.issue_id IS NULL OR a.issue_id=a.ancestor_id
), snapshot_fallback_members AS (
 SELECT i.*,f.issue_id IS NOT NULL AS in_focus,u.issue_id IS NOT NULL AS uncertain_ancestry
 FROM snapshot_fallback_items i
 LEFT JOIN snapshot_fallback_focus f USING(issue_id)
 LEFT JOIN snapshot_fallback_uncertain u USING(issue_id)
), snapshot_fallback_totals AS (
 SELECT cutoff,max(asof_at) AS observed_at,
 count(*) FILTER(WHERE NOT keys_known) AS missing_keys,
 count(*) FILTER(WHERE uncertain_ancestry AND NOT in_focus AND NOT archived AND NOT cancelled AND NOT done) AS uncertain_open,
 count(*) FILTER(WHERE in_focus AND NOT archived AND NOT cancelled AND NOT done AND points IS NULL) AS unknown_points,
 COALESCE(sum(points) FILTER(WHERE in_focus AND NOT archived AND NOT cancelled AND NOT done),0)::double precision AS remaining,
 count(*) AS issues
 FROM snapshot_fallback_members GROUP BY cutoff
), snapshot_fallback AS (
 SELECT *,observed_at IS NOT NULL AND missing_keys=0 AND uncertain_open=0 AND issues>0 AS usable
 FROM snapshot_fallback_totals
)
