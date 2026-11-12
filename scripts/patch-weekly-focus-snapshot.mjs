import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fallbackName = 'Остаток · снимок, данные неполны';
const statusName = 'Состояние остатка';
const snapshotName = 'Остаток · снимки';
const fallbackSql = readFileSync(new URL('../analytics/weekly-focus-snapshot.sql', import.meta.url), 'utf8').trim();

function replaceOnce(text, before, after) {
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) {
    throw new Error('Unsupported weekly query: expected one ' + before.slice(0, 80));
  }
  return text.slice(0, index) + after + text.slice(index + before.length);
}

export function patchWeeklyFocusSnapshot(dashboard) {
  const result = structuredClone(dashboard);
  const panels = result.panels?.filter(panel => panel.id === 205);
  if (panels?.length !== 1 || panels[0].type !== 'timeseries') {
    throw new Error('Expected one existing weekly time series panel with id 205.');
  }
  const panel = panels[0];
  const targets = panel.targets?.filter(target => target.refId === 'A');
  if (targets?.length !== 1 || typeof targets[0].rawSql !== 'string') {
    throw new Error('Expected the existing weekly query A.');
  }
  let sql = targets[0].rawSql;
  if (sql.includes('snapshot_fallback_items')) throw new Error('Snapshot fallback is already present.');
  for (const expected of [
    'FROM obs_snapshot_items',
    'SELECT cutoff,issue_id FROM obs_items WHERE direct_focus AND NOT archived AND keys_known AND parent_id IS NULL',
    "SELECT w.starts_at+interval '7 days' AS time,",
  ]) {
    if (!sql.includes(expected)) throw new Error('Unsupported weekly query: root focus or weekly spacing differs.');
  }
  sql = replaceOnce(sql, '), obs_weekly AS (', '), ' + fallbackSql + ', obs_weekly AS (');
  sql = replaceOnce(sql,
    'CASE WHEN o.usable THEN o.unknown_points END::double precision',
    'CASE WHEN o.usable THEN o.unknown_points WHEN f.usable THEN f.unknown_points END::double precision');
  sql = replaceOnce(sql,
    'CASE WHEN o.usable THEN extract(epoch FROM o.observed_at)*1000 END::double precision',
    'CASE WHEN o.usable THEN extract(epoch FROM o.observed_at)*1000 WHEN f.usable THEN extract(epoch FROM f.observed_at)*1000 END::double precision');
  sql = replaceOnce(sql,
    'w.outside_done AS "Выполнено · вне нынешнего фокуса",',
    `w.outside_done AS "Выполнено · вне нынешнего фокуса",
 CASE WHEN NOT COALESCE(o.usable,false) AND f.usable THEN f.remaining END AS "${fallbackName}",
 CASE WHEN w.time=(SELECT max(cutoff) FROM obs_valid) THEN
 CASE WHEN o.usable THEN 0
 WHEN f.usable AND w.time-f.observed_at>interval '2 hours' THEN 2
 WHEN f.usable THEN 1 ELSE 3 END END::double precision AS "${statusName}",`);
  sql = replaceOnce(sql,
    'LEFT JOIN obs_weekly o USING(time) JOIN ev_quality q ON q.cutoff=w.time',
    'LEFT JOIN obs_weekly o USING(time) JOIN ev_quality q ON q.cutoff=w.time LEFT JOIN snapshot_fallback f ON f.cutoff=w.time');
  targets[0].rawSql = sql;

  const overrides = panel.fieldConfig?.overrides;
  if (!Array.isArray(overrides)) throw new Error('Expected weekly field overrides.');
  const snapshotProperties = overrides
    .filter(override => override.matcher?.id === 'byName' && override.matcher.options === snapshotName)
    .flatMap(override => override.properties);
  if (!snapshotProperties.some(property => property.id === 'custom.transform' && property.value === 'negative-Y') ||
      !snapshotProperties.some(property => property.id === 'color') ||
      !snapshotProperties.some(property => property.id === 'custom.stacking' && property.value.group === 'remaining')) {
    throw new Error('Expected the existing remaining bar style.');
  }
  overrides.push({
    matcher: { id: 'byName', options: fallbackName },
    properties: [
      ...structuredClone(snapshotProperties).filter(property => property.id !== 'custom.fillOpacity'),
      { id: 'custom.fillOpacity', value: 35 },
    ],
  }, {
    matcher: { id: 'byName', options: statusName },
    properties: [
      { id: 'custom.hideFrom', value: { legend: true, tooltip: false, viz: true } },
      { id: 'custom.stacking', value: { group: 'metadata', mode: 'none' } },
      { id: 'unit', value: 'none' },
      { id: 'decimals', value: 0 },
      { id: 'mappings', value: [{ type: 'value', options: {
        0: { text: 'Полный снимок и известные события' },
        1: { text: 'Текущее состояние неполно; показан полный снимок' },
        2: { text: 'Снимок старше двух часов; текущее состояние неизвестно' },
        3: { text: 'Нет достоверного остатка' },
      } }] },
    ],
  });
  panel.description = replaceOnce(panel.description,
    'Если состав неясен или снимок устарел, точка пропускается.',
    'Если текущие данные неполны, бледный столбец показывает последний полный снимок, а не текущее состояние; его время — в подсказке. Без надёжного снимка столбца нет.');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output, ...extra] = process.argv;
  if (!input || !output || extra.length || resolve(input) === resolve(output)) {
    throw new Error('Usage: node scripts/patch-weekly-focus-snapshot.mjs <exported-dashboard.json> <new-dashboard.json>');
  }
  const dashboard = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const patched = patchWeeklyFocusSnapshot(dashboard);
  // Write a separate artifact. Saving it to Grafana is a separate operation.
  writeFileSync(output, JSON.stringify(patched, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Prepared weekly snapshot fallback; no dashboard was deployed.');
}
