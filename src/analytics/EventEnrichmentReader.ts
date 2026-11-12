import type { Octokit } from '@octokit/rest';
import type { EventEnrichment, Json, PendingEvents, ProjectSnapshot } from './model.ts';
import { ProjectSnapshotReader, SnapshotReadError } from './ProjectSnapshotReader.ts';

interface Page<T> {

  totalCount: number;
  nodes: Array<T | null>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface Issue {

  __typename: string;
  id: string;
  state: string;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  parent: { id: string } | null;
  repository: { nameWithOwner: string };
  projectItems: Page<{ id: string; updatedAt: string; isArchived: boolean; project: { id: string } }>;
}

interface ParentEvent {

  __typename: 'ParentIssueAddedEvent' | 'ParentIssueRemovedEvent';
  id: string;
  createdAt: string;
  parent: { id: string } | null;
}

const ISSUE = `query($id: ID!, $after: String) {
  node(id: $id) { __typename ... on Issue {
    id state stateReason createdAt updatedAt closedAt parent { id } repository { nameWithOwner }
    projectItems(first: 100, after: $after, includeArchived: true) {
      totalCount nodes { id updatedAt isArchived project { id } } pageInfo { hasNextPage endCursor }
    }
  } }
}`;

function cursor<T>(page: Page<T>, seen: Set<string>): string | null {
  if (!page.pageInfo.hasNextPage) return null;
  const next = page.pageInfo.endCursor;
  if (!next || seen.has(next)) throw new SnapshotReadError('Invalid event enrichment pagination.');
  seen.add(next);
  return next;
}

function state(issue: Issue): string {
  const { projectItems, ...content } = issue;
  return JSON.stringify({ ...content, items: [...projectItems.nodes].sort((a, b) => a!.id.localeCompare(b!.id)) });
}

function compact(item: ProjectSnapshot['items'][number]): Json {
  const content = item.content as Record<string, Json>;
  // Keep the snapshot shape consumed by analytics, without titles, bodies or people.
  const fields = (item.fields as Array<Record<string, Json>>).filter(value =>
    ['ProjectV2ItemFieldNumberValue', 'ProjectV2ItemFieldSingleSelectValue', 'ProjectV2ItemFieldIterationValue'].includes(String(value.__typename)));
  return {
    id: item.id, type: item.type!, isArchived: item.isArchived!, createdAt: item.createdAt!, updatedAt: item.updatedAt!,
    content: Object.fromEntries(['id', '__typename', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt', 'parent']
      .filter(key => Object.hasOwn(content, key)).map(key => [key, key === 'parent' && content.parent
        ? { id: (content.parent as Record<string, Json>).id! } : content[key]!])),
    fields,
  };
}

export class EventEnrichmentReader {

  private readonly github: Pick<Octokit, 'graphql'>;
  private readonly snapshots: ProjectSnapshotReader;
  private readonly repositories: Set<string>;

  constructor(github: Pick<Octokit, 'graphql'>, owner: string, repositories: string[]) {
    this.github = github;
    this.snapshots = new ProjectSnapshotReader(github);
    this.repositories = new Set(repositories.map(repository => `${owner}/${repository}`.toLowerCase()));
  }

  private async issue(id: string): Promise<Issue | null> {
    let issue: Issue | undefined;
    let after: string | null = null;
    const cursors = new Set<string>();
    const items: Issue['projectItems']['nodes'] = [];
    do {
      const response: { node?: Issue | null } = await this.github.graphql(ISSUE, { id, after });
      const current = response.node;
      if (!current) throw new SnapshotReadError('Issue is unavailable during event enrichment.');
      if (current.__typename !== 'Issue') return null;
      if (!this.repositories.has(current.repository.nameWithOwner.toLowerCase())) {
        throw new SnapshotReadError('An ancestor is outside the configured repositories.');
      }
      if (!current.projectItems || current.projectItems.nodes.some(item => !item) ||
          (issue && (issue.updatedAt !== current.updatedAt || issue.parent?.id !== current.parent?.id ||
            issue.projectItems.totalCount !== current.projectItems.totalCount))) {
        throw new SnapshotReadError('Issue changed during event enrichment.');
      }
      issue ??= current;
      items.push(...current.projectItems.nodes);
      after = cursor(current.projectItems, cursors);
    } while (after);
    if (items.length !== issue!.projectItems.totalCount || new Set(items.map(item => item!.id)).size !== items.length) {
      throw new SnapshotReadError('Incomplete project memberships during event enrichment.');
    }
    return { ...issue!, projectItems: { ...issue!.projectItems, nodes: items } };
  }

  private async parentEvents(id: string): Promise<Array<Record<string, Json>>> {
    const rows: ParentEvent[] = [];
    let after: string | null = null;
    let expected: number | undefined;
    const cursors = new Set<string>();
    do {
      const response: { node?: { timelineItems: Page<ParentEvent> } } = await this.github.graphql(`
        query($id: ID!, $after: String) { node(id: $id) { ... on Issue {
          timelineItems(first: 100, after: $after, itemTypes: [PARENT_ISSUE_ADDED_EVENT, PARENT_ISSUE_REMOVED_EVENT]) {
            totalCount pageInfo { hasNextPage endCursor } nodes { __typename
              ... on ParentIssueAddedEvent { id createdAt parent { id } }
              ... on ParentIssueRemovedEvent { id createdAt parent { id } }
            }
          }
        } } }
      `, { id, after });
      const page = response.node?.timelineItems;
      expected ??= page?.totalCount;
      if (!page || page.totalCount !== expected || page.nodes.some(row => !row || !row.id || !Number.isFinite(Date.parse(row.createdAt)))) {
        throw new SnapshotReadError('Incomplete parent relationship history.');
      }
      rows.push(...page.nodes as ParentEvent[]);
      after = cursor(page, cursors);
    } while (after);
    if (rows.length !== expected || new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new SnapshotReadError('Parent relationship history changed during enrichment.');
    }
    return rows.map(row => ({ id: row.id, created_at: row.createdAt, parent_id: row.parent?.id ?? null,
      linked: row.__typename === 'ParentIssueAddedEvent' }));
  }

  async read(events: PendingEvents): Promise<EventEnrichment> {
    const startedAt = new Date();
    const observations: Json[] = [];
    const issues = new Map<string, Issue>();
    let id: string | null = events.contentId;
    while (id) {
      if (issues.has(id)) throw new SnapshotReadError('Cycle in the issue ancestry.');
      const issue = await this.issue(id);
      if (!issue) break;
      issues.set(id, issue);
      const memberships = issue.projectItems.nodes.filter(item => item!.project.id === events.projectId);
      if (memberships.length > 1) throw new SnapshotReadError('Ambiguous project membership.');
      const itemId = memberships[0]?.id;
      const snapshot = itemId ? await this.snapshots.readItem(itemId, events.projectId) : null;
      if (snapshot) {
        const content = snapshot.content as Record<string, Json>;
        if (content.id !== id || content.updatedAt !== issue.updatedAt || content.state !== issue.state ||
            content.stateReason !== issue.stateReason ||
            (content.parent as { id: string } | null)?.id !== issue.parent?.id ||
            snapshot.updatedAt !== memberships[0]!.updatedAt || snapshot.isArchived !== memberships[0]!.isArchived) {
          throw new SnapshotReadError('Project item content changed during enrichment.');
        }
      }
      observations.push({ content_id: id, item_id: itemId ?? null, present: Boolean(itemId),
        parent_id: issue.parent?.id ?? null, snapshot: snapshot ? compact(snapshot) : null });
      id = issue.parent?.id ?? null;
    }
    const parentEvents = events.needsParentHistory && issues.has(events.contentId) ? await this.parentEvents(events.contentId) : [];
    if (events.needsParentHistory && issues.has(events.contentId)) {
      const latest = parentEvents.at(-1);
      const parentId = issues.get(events.contentId)!.parent?.id ?? null;
      if (!latest || !latest.parent_id || (latest.linked ? latest.parent_id !== parentId : parentId !== null)) {
        throw new SnapshotReadError('Parent history has not caught up with the current relationship.');
      }
    }
    for (const [contentId, issue] of issues) {
      const current = await this.issue(contentId);
      if (!current || state(current) !== state(issue)) throw new SnapshotReadError('Issue changed while enriching its events.');
    }
    return { startedAt, observedAt: new Date(), observations, parentEvents };
  }
}
