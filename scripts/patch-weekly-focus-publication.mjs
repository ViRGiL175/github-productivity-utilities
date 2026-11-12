import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4 || resolve(input) === resolve(output)) {
  throw new Error('Usage: node scripts/patch-weekly-focus-publication.mjs INPUT.json NEW-OUTPUT.json');
}
const exported = JSON.parse(await readFile(input, 'utf8'));
const dashboard = exported.dashboard ?? exported;
const panel = dashboard.panels?.find(panel => panel.id === 205);
if (!panel || panel.targets?.length !== 3 || ['A', 'B', 'C'].some(id => !panel.targets.find(t => t.refId === id)?.rawSql)) {
  throw new Error('Expected weekly focus panel 205 with queries A, B and C.');
}
if (dashboard.templating?.list?.some(v => v.name === 'focusSnapshot')) {
  throw new Error('The publication variable already exists; inspect the dashboard before patching.');
}
const fragment = (await readFile(new URL('../analytics/weekly-focus-publication.sql', import.meta.url), 'utf8')).trim();
// Read fields from the already selected item, avoiding repeated joins across the full snapshot.
const fields = `LATERAL (SELECT i.item_id,f->'field'->>'id' AS field_id,f->'field'->>'name' AS field_name,
 COALESCE(f->>'text',f->>'name',f->>'title',f->>'date',f->>'number') AS display_value,f AS value
 FROM jsonb_array_elements(i.snapshot->'fields')f)`;
const iterations = `LATERAL (SELECT i.item_id,f->'field'->>'name' AS field_name,
 (f->>'startDate')::date AS start_date,(f->>'duration')::integer AS duration_days
 FROM jsonb_array_elements(i.snapshot->'fields')f WHERE f->'field'->>'dataType'='ITERATION')`;
function replaceOnce(sql, before, after) {
  if (sql.split(before).length !== 2) throw new Error(`Unexpected weekly query around ${before.slice(0, 60)}.`);
  return sql.replace(before, after);
}
const obsolete = ['Учтено доставок · после снимка', 'Неизвестных значений · события',
  'Без исходного снимка · историй', 'Получено событие · UTC'];
for (const target of panel.targets) {
  let sql = target.rawSql.replaceAll('\r\n', '\n');
  if (/obs_enrichment_batches|snapshot_fallback|published_run/.test(sql)) {
    throw new Error('A different patch is already present; inspect the query before patching.');
  }
  if (target.refId === 'A') {
    const start = sql.indexOf('), ev_window AS MATERIALIZED (');
    const end = sql.indexOf(', obs_focus(cutoff,issue_id) AS (', start);
    if (start < 0 || end < 0) throw new Error('Unexpected event overlay; inspect query A before patching.');
    // Keep snapshot ancestry/quality checks, but events cannot mutate or invalidate a published collection.
    sql = sql.slice(0, start) + '), obs_items AS MATERIALIZED (\n SELECT * FROM obs_snapshot_items\n)\n' + sql.slice(end);
    sql = replaceOnce(sql,
      'SELECT t.*,q.relevant_deliveries,q.unknown_attributes,q.last_event_received,q.unanchored_issues,observed_at IS NOT NULL AND cutoff-observed_at<=interval \'2 hours\' AND missing_keys=0 AND uncertain_open=0 AND issues>0 AND q.unanchored_issues=0 AS usable\n FROM obs_totals t JOIN ev_quality q USING(cutoff)',
      'SELECT t.*,observed_at IS NOT NULL AND cutoff-observed_at<=interval \'2 hours\' AND missing_keys=0 AND uncertain_open=0 AS usable\n FROM obs_totals t');
    sql = replaceOnce(sql, ' JOIN ev_quality q ON q.cutoff=w.time', '');
    const metadataStart = sql.indexOf(',\n q.relevant_deliveries::double precision');
    const metadataEnd = sql.indexOf('\n FROM weekly w', metadataStart);
    if (metadataStart < 0 || metadataEnd < 0) throw new Error('Unexpected event metadata.');
    sql = sql.slice(0, metadataStart) + sql.slice(metadataEnd);
  }
  sql = replaceOnce(sql, "WITH RECURSIVE params AS (\n SELECT now() AS today,\n date_trunc('week',now()-interval '6 months') AS start_at\n)",
    `WITH RECURSIVE ${fragment}, params AS (\n SELECT observed_at AS today,\n date_trunc('week',observed_at-interval '6 months') AS start_at FROM published_run\n)`);
  // Pin the cohort, history and model clock to the same immutable full collection.
  sql = sql.replaceAll('analytics.items', 'published_items')
    .replaceAll('analytics.item_fields', fields)
    .replaceAll('analytics.item_iterations', iterations)
    .replaceAll('now()', '(SELECT today FROM params)');
  // The prefix alone reads sync_runs; all later history is bounded by the selected publication.
  const prefixEnd = sql.indexOf(', params AS (');
  sql = sql.slice(0, prefixEnd) + sql.slice(prefixEnd).replaceAll('analytics.sync_runs', 'published_runs');
  if (/analytics\.(items|item_fields|item_iterations|project_events)|\bev_\w+/.test(sql)) {
    throw new Error('An unpinned data source remains in the weekly query.');
  }
  target.rawSql = sql;
}
const query = `SELECT id::text AS __value,
 to_char(observed_at AT TIME ZONE 'UTC','DD.MM.YYYY HH24:MI:SS') || ' UTC' AS __text
FROM analytics.sync_runs WHERE status='complete'
ORDER BY observed_at DESC,completed_at DESC LIMIT 1`;
dashboard.templating ??= { list: [] };
dashboard.templating.list ??= [];
dashboard.templating.list.push({ name: 'focusSnapshot', type: 'query', label: 'Полный снимок',
  datasource: panel.targets[0].datasource ?? panel.datasource, definition: query, query,
  current: {}, options: [], refresh: 2, hide: 2, multi: false, includeAll: false, skipUrlSync: true });
panel.title = 'Неделя: выполнено и остаток фокуса · снимок ${focusSnapshot:text}';
panel.description = (panel.description ?? '').replace('по снимкам и полученным событиям', 'по полным снимкам')
  .replace('Если состав неясен или снимок устарел, точка пропускается.',
    'При неизвестном составе или пробеле в исторических снимках точка пропускается.') +
  '\n\nВся панель использует последний завершённый полный сбор; его время указано в заголовке. Новые события появятся после следующего полного сбора. При сбое сбора сохраняется прежний снимок с его временем.';
panel.fieldConfig.overrides = panel.fieldConfig.overrides.filter(o => !obsolete.includes(o.matcher?.options));
await writeFile(output, JSON.stringify(exported, null, 2) + '\n', { flag: 'wx' });
console.log('Prepared panel 205 queries A/B/C with a shared full snapshot and visible timestamp. No dashboard was deployed.');
