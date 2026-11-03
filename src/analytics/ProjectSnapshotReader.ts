import type { Octokit } from '@octokit/rest';
import type { IterationDefinition } from '../github/ProjectV2Repository.ts';
import type { Json, ProjectSnapshot, SnapshotReader, Target } from './model.ts';

export class SnapshotReadError extends Error {
  readonly details: Record<string, string | number | boolean>;

  constructor(message: string, details: Record<string, string | number | boolean> = {}) {
    super(message);
    this.name = 'SnapshotReadError';
    this.details = details;
  }
}

interface Connection<T> {

  totalCount: number;
  nodes: Array<T | null> | null;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface Definition {

  id: string;
  name: string;
  dataType: string;
  configuration?: { iterations: IterationDefinition[]; completedIterations: IterationDefinition[] };
}

interface FieldValue {

  __typename: string;
  field?: { id: string; name: string; dataType: string };
  [key: string]: unknown;
}

interface Item {

  id: string;
  fieldValues: Connection<FieldValue>;
  [key: string]: unknown;
}

const FIELD = 'field { ... on ProjectV2FieldCommon { id name dataType } }';
const PAGE = 'totalCount pageInfo { hasNextPage endCursor }';
const LIST_FIELDS = {

  ProjectV2ItemFieldLabelValue: { key: 'labels', selection: 'id name color' },
  ProjectV2ItemFieldUserValue: { key: 'users', selection: 'id login' },
  ProjectV2ItemFieldPullRequestValue: { key: 'pullRequests', selection: 'id number title url state' },
  ProjectV2ItemFieldReviewerValue: {
    key: 'reviewers',
    selection: '__typename ... on Node { id } ... on User { login } ... on Bot { login } ... on Team { slug } ... on Mannequin { login }',
  },
} as const;

const VALUES = `
  __typename
  ... on ProjectV2ItemFieldDateValue { ${FIELD} date }
  ... on ProjectV2ItemFieldNumberValue { ${FIELD} number }
  ... on ProjectV2ItemFieldTextValue { ${FIELD} text }
  ... on ProjectV2ItemFieldSingleSelectValue { ${FIELD} optionId name }
  ... on ProjectV2ItemFieldMultiSelectValue { ${FIELD} options { id name } }
  ... on ProjectV2ItemFieldIterationValue { ${FIELD} iterationId title startDate duration }
  ... on ProjectV2ItemFieldRepositoryValue { ${FIELD} repository { id nameWithOwner url } }
  ... on ProjectV2ItemFieldMilestoneValue { ${FIELD} milestone { id title dueOn } }
  ... on ProjectV2ItemIssueFieldValue { ${FIELD} issueFieldValue {
    __typename
    ... on IssueFieldDateValue { date: value }
    ... on IssueFieldNumberValue { number: value }
    ... on IssueFieldTextValue { text: value }
    ... on IssueFieldSingleSelectValue { optionId name }
    ... on IssueFieldMultiSelectValue { options { id name } }
  } }
  ${Object.entries(LIST_FIELDS).map(([type, list]) => `
    ... on ${type} { ${FIELD} ${list.key}(first: 10) { ${PAGE} nodes { ${list.selection} } } }
  `).join('\n')}
`;

const DEFINITIONS = `
  __typename
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name } }
  ... on ProjectV2MultiSelectField { multiSelectOptions { id name } }
  ... on ProjectV2IterationField {
    configuration {
      iterations { id title startDate duration }
      completedIterations { id title startDate duration }
    }
  }
`;

const METADATA_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) { projectV2(number: $number) {
    id title number url closed public updatedAt
    fields(first: 100, after: $after) { ${PAGE} nodes { ${DEFINITIONS} } }
  } }
}`;

const ITEMS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $after) { ${PAGE} nodes {
      id type isArchived createdAt updatedAt
      content {
        __typename
        ... on DraftIssue { id title createdAt updatedAt }
        ... on Issue { id number title url state createdAt updatedAt closedAt issueType { id name } repository { id nameWithOwner } }
        ... on PullRequest { id number title url state createdAt updatedAt closedAt mergedAt repository { id nameWithOwner } }
      }
      fieldValues(first: 20) { ${PAGE} nodes { ${VALUES} } }
    } }
  } }
}`;

const FIELDS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) { ... on ProjectV2Item {
    fieldValues(first: 100, after: $after) { ${PAGE} nodes { ${VALUES} } }
  } }
}`;

function nextCursor<T>(connection: Connection<T>, cursors: Set<string>): string | null {
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursors.has(cursor)) throw new SnapshotReadError('Invalid pagination cursor.');
  cursors.add(cursor);
  return cursor;
}

function append<T>(target: T[], connection: Connection<T>, expected: number): void {
  if (connection.totalCount !== expected || !Array.isArray(connection.nodes) || connection.nodes.some(node => node === null)) {
    throw new SnapshotReadError('Incomplete or changing connection.', {
      expected, totalCount: connection.totalCount, nodesAvailable: Array.isArray(connection.nodes),
      nullNodes: connection.nodes?.filter(node => node === null).length ?? 0,
    });
  }
  target.push(...connection.nodes as T[]);
}

function assertCount<T>(rows: T[], expected: number, key: (row: T) => string, connection: string): void {
  if (rows.length !== expected || new Set(rows.map(key)).size !== expected) {
    throw new SnapshotReadError('Connection count or unique IDs do not match.', {
      connection, expected, rows: rows.length, unique: new Set(rows.map(key)).size,
    });
  }
}

export class ProjectSnapshotReader implements SnapshotReader {

  private readonly github: Pick<Octokit, 'graphql'>;

  constructor(github: Pick<Octokit, 'graphql'>) {
    this.github = github;
  }

  async read(target: Target): Promise<ProjectSnapshot> {
    const startedAt = new Date();
    const definitions: Definition[] = [];
    let project: (Record<string, unknown> & { id: string }) | undefined;
    let expectedFields: number | undefined;
    let after: string | null = null;
    const fieldCursors = new Set<string>();
    do {
      const response: { organization?: { projectV2?: Record<string, unknown> & { id: string; fields: Connection<Definition> } } } =
        await this.github.graphql(METADATA_QUERY, { ...target, after });
      const current = response.organization?.projectV2;
      if (!current?.fields) throw new SnapshotReadError('Project metadata is unavailable.');
      if (project && (project.id !== current.id || project.updatedAt !== current.updatedAt)) {
        throw new SnapshotReadError('Project changed while reading metadata.');
      }
      project ??= current;
      expectedFields ??= current.fields.totalCount;
      append(definitions, current.fields, expectedFields);
      after = nextCursor(current.fields, fieldCursors);
    } while (after);
    assertCount(definitions, expectedFields!, row => row.id, 'project_fields');

    const items: Item[] = [];
    const itemCursors = new Set<string>();
    let expectedCount: number | undefined;
    after = null;
    do {
      const response: { node?: { items?: Connection<Item> } } = await this.github.graphql(ITEMS_QUERY, { id: project!.id, after });
      const connection = response.node?.items;
      if (!connection) throw new SnapshotReadError('Project items are unavailable.');
      expectedCount ??= connection.totalCount;
      append(items, connection, expectedCount);
      after = nextCursor(connection, itemCursors);
    } while (after);
    assertCount(items, expectedCount!, row => row.id, 'project_items');

    const snapshots: ProjectSnapshot['items'] = [];
    for (const item of items) {
      if (!item.content || item.type === 'REDACTED') {
        throw new SnapshotReadError('An item is inaccessible. Check the selected repositories before reconciling.');
      }
      const fields: FieldValue[] = [];
      const expected = item.fieldValues.totalCount;
      append(fields, item.fieldValues, expected);
      const cursors = new Set<string>();
      after = nextCursor(item.fieldValues, cursors);
      while (after) {
        const response: { node?: { fieldValues?: Connection<FieldValue> } } = await this.github.graphql(FIELDS_QUERY, { id: item.id, after });
        if (!response.node?.fieldValues) throw new SnapshotReadError('Item field values are unavailable.');
        append(fields, response.node.fieldValues, expected);
        after = nextCursor(response.node.fieldValues, cursors);
      }
      for (const value of fields) {
        if (!value.field?.id) throw new SnapshotReadError('Unsupported or unreadable project field value.');
        await this.completeList(item.id, value);
      }
      assertCount(fields, expected, value => value.field!.id, 'item_fields');
      const { fieldValues: ignored, ...identity } = item;
      snapshots.push({ ...identity, fields: fields.sort((left, right) => left.field!.id.localeCompare(right.field!.id)) } as ProjectSnapshot['items'][number]);
    }

    const final: { node?: { items: { totalCount: number }; updatedAt: string } } = await this.github.graphql(`
      query($id: ID!) { node(id: $id) { ... on ProjectV2 { updatedAt items(first: 1) { totalCount } } } }
    `, { id: project!.id });
    if (final.node?.items.totalCount !== expectedCount || final.node.updatedAt !== project!.updatedAt) {
      throw new SnapshotReadError('Project changed during collection; retry with a fresh observation.');
    }
    return {
      target, startedAt, observedAt: new Date(), complete: true, expectedCount: expectedCount!,
      project: { ...project!, fields: definitions.sort((a, b) => a.id.localeCompare(b.id)) } as unknown as ProjectSnapshot['project'],
      items: snapshots,
    };
  }

  private async completeList(itemId: string, value: FieldValue): Promise<void> {
    const list = LIST_FIELDS[value.__typename as keyof typeof LIST_FIELDS];
    if (!list) return;
    const connection = value[list.key] as Connection<{ id: string; [key: string]: Json }> | undefined;
    if (!connection) throw new SnapshotReadError('Nested field connection is unavailable.');
    const rows: Array<{ id: string; [key: string]: Json }> = [];
    const expected = connection.totalCount;
    append(rows, connection, expected);
    const cursors = new Set<string>();
    let after = nextCursor(connection, cursors);
    while (after) {
      const query = `query($id: ID!, $name: String!, $after: String) {
        node(id: $id) { ... on ProjectV2Item { fieldValueByName(name: $name) {
          ... on ${value.__typename} { ${FIELD} ${list.key}(first: 100, after: $after) { ${PAGE} nodes { ${list.selection} } } }
        } } }
      }`;
      const response: { node?: { fieldValueByName?: FieldValue } } = await this.github.graphql(query, { id: itemId, name: value.field!.name, after });
      const field = response.node?.fieldValueByName;
      const page = field?.[list.key] as typeof connection;
      if (!page || field?.field?.id !== value.field!.id) throw new SnapshotReadError('Nested field changed during collection.');
      append(rows, page, expected);
      after = nextCursor(page, cursors);
    }
    // Nested connections count edges, not distinct people/entities. GitHub can
    // return the same reviewer more than once; preserve all returned entries.
    if (rows.length !== expected || rows.some(row => !row.id)) {
      throw new SnapshotReadError('Nested connection is incomplete or contains an unidentified node.', {
        connection: value.__typename, expected, rows: rows.length,
      });
    }
    value[list.key] = rows.sort((left, right) => left.id.localeCompare(right.id));
  }
}
