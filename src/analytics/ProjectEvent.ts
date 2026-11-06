import type { Json, Target } from './model.ts';

type ObjectValue = { [key: string]: Json };

export interface ProjectEvent {

  event: string;
  action: string;
  itemId: string | null;
  contentId: string;
  sourceUpdatedAt: string | null;
  repository: string | null;
  data: ObjectValue;
}

export class InvalidProjectEvent extends Error {

}

function object(value: Json | undefined): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidProjectEvent('Expected an object.');
  }
  return value;
}

function text(value: Json | undefined): string {
  if (typeof value !== 'string' || !value) throw new InvalidProjectEvent('Expected a nonempty string.');
  return value;
}

function timestamp(value: Json | undefined): string | null {
  if (value === null || value === undefined) return null;
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new InvalidProjectEvent('Invalid source timestamp.');
  return result;
}

function select(source: ObjectValue, keys: string[]): ObjectValue {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]!]));
}

function fieldValue(value: Json): Json {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  return select(object(value), ['id', 'name', 'title', 'start_date', 'duration']);
}

export function projectEvent(name: string, payload: Json, target: Target, projectId: string, repositories: string[]): ProjectEvent | null {
  if (!['projects_v2_item', 'issues', 'sub_issues'].includes(name)) return null;
  const body = object(payload);
  if (text(object(body.organization).login).toLowerCase() !== target.owner.toLowerCase()) return null;
  const action = text(body.action);
  if (name === 'projects_v2_item') {
    if (!['created', 'deleted', 'archived', 'restored', 'converted', 'edited'].includes(action)) return null;
    const item = object(body.projects_v2_item);
    if (text(item.project_node_id) !== projectId) return null;
    const data = select(item, ['content_type', 'created_at', 'updated_at', 'archived_at']);
    if (action === 'edited') {
      const changes = object(body.changes);
      if (!Object.hasOwn(changes, 'field_value')) return null;
      const field = object(changes.field_value);
      if (!['number', 'single_select', 'iteration'].includes(text(field.field_type))) return null;
      const change = select(field, ['field_node_id', 'field_name', 'field_type']);
      text(change.field_node_id);
      // An omitted endpoint is unknown, not an explicit clearing of the value.
      for (const key of ['from', 'to']) {
        if (Object.hasOwn(field, key)) change[key] = fieldValue(field[key]!);
      }
      data.field = change;
    } else if (action === 'archived' || action === 'restored') {
      data.archived = action === 'archived';
    } else if (action === 'created' || action === 'deleted') {
      data.present = action === 'created';
    } else if (action === 'converted') {
      data.content_type_change = select(object(object(body.changes).content_type), ['from', 'to']);
    }
    return {
      event: name, action, itemId: text(item.node_id), contentId: text(item.content_node_id),
      sourceUpdatedAt: timestamp(item.updated_at), repository: null, data,
    };
  }

  const repository = text(object(body.repository).full_name);
  const allowed = new Set(repositories.map(repo => `${target.owner}/${repo}`.toLowerCase()));
  if (!allowed.has(repository.toLowerCase())) return null;
  if (name === 'issues') {
    if (!['opened', 'closed', 'reopened', 'edited', 'deleted', 'transferred'].includes(action)) return null;
    const issue = object(body.issue);
    if (issue.pull_request) return null;
    const data = select(issue, ['state', 'state_reason', 'closed_at']);
    const changes = body.changes ? object(body.changes) : {};
    // GitHub does not always include a state-reason diff. Preserve the small
    // state observation on edits without retaining the issue title or body.
    for (const key of ['state', 'state_reason']) {
      if (Object.hasOwn(changes, key)) data[`${key}_change`] = select(object(changes[key]), ['from', 'to']);
    }
    return {
      event: name, action, itemId: null, contentId: text(issue.node_id),
      sourceUpdatedAt: timestamp(issue.updated_at), repository, data,
    };
  }

  if (!['parent_issue_added', 'parent_issue_removed', 'sub_issue_added', 'sub_issue_removed'].includes(action)) return null;
  const child = object(body.sub_issue);
  const parent = body.parent_issue ? object(body.parent_issue) : null;
  return {
    event: name, action, itemId: null, contentId: text(child.node_id),
    sourceUpdatedAt: null, repository,
    data: {
      parent_id: parent ? text(parent.node_id) : null,
      parent_database_id: body.parent_issue_id ?? null,
      child_database_id: body.sub_issue_id ?? null,
      linked: action.endsWith('_added'),
    },
  };
}
