import type { Octokit } from '@octokit/rest';
import type { Endpoints } from '@octokit/types';
import type { RepositoryCoordinates } from './IssueRepository.ts';
import { ProjectV2Repository } from './ProjectV2Repository.ts';

export type FieldValue = string | number;
export interface FieldConfig {

  project?: Record<string, FieldValue>;
  issue?: Record<string, FieldValue>;
  force?: boolean;
}
export interface FieldTarget {

  repository: RepositoryCoordinates;
  issueNumber: number;
  project?: { owner: string; number: number; itemId: string };
}
export interface FieldReport {

  applied: string[];
  skipped: string[];
}
export class FieldUpdateError extends Error {

  readonly report: FieldReport;
  readonly uncertain: string[];
  constructor(message: string, report: FieldReport, uncertain: string[] = [], options?: ErrorOptions) {
    super(`${message}. Applied: ${report.applied.join(', ') || 'none'}. Outcome uncertain: ${uncertain.join(', ') || 'none'}`, options);
    this.name = 'FieldUpdateError';
    this.report = report;
    this.uncertain = uncertain;
  }
}

type ProjectField = Endpoints['GET /orgs/{org}/projectsV2/{project_number}/fields']['response']['data'][number];
type NativeField = NonNullable<Endpoints['GET /orgs/{org}/issue-fields']['response']['data'][number]>;
type NativeValue = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values']['response']['data'][number];
const headers = { 'X-GitHub-Api-Version': '2026-03-10' };

export class FieldController {

  private readonly github: Octokit;
  constructor(github: Octokit) { this.github = github; }

  async apply(config: FieldConfig, target: FieldTarget): Promise<FieldReport> {
    const report: FieldReport = { applied: [], skipped: [] };
    const projectUpdates: Array<{ id: number; value: FieldValue }> = [];
    const issueUpdates: Array<{ field_id: number; value: FieldValue }> = [];
    const projectNames: string[] = [];
    const issueNames: string[] = [];
    const coordinates = { ...target.repository, issue_number: target.issueNumber, headers };
    let projectOwnerIsOrg = false;
    let itemId = 0;

    if (Object.keys(config.issue ?? {}).length) {
      const issue = await this.github.rest.issues.get(coordinates);
      if (issue.data.pull_request) throw new Error('issue: native Issue Fields are not supported on pull requests');
      const fields = await this.github.paginate<NativeField | null>('GET /orgs/{org}/issue-fields', { org: target.repository.owner, headers });
      const current = await this.github.paginate<NativeValue>('GET /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', coordinates);
      for (const [name, value] of Object.entries(config.issue ?? {})) {
        const field = unique(fields.filter(field => field !== null), name, 'issue');
        scalarType(field.data_type, value, `issue.${name}`);
        if (field.data_type === 'single_select') unique(field.options ?? [], String(value), `issue.${name} option`);
        const previous = current.find(entry => entry.issue_field_id === field.id);
        const existing = previous?.single_select_option?.name ?? previous?.value ?? null;
        if (shouldWrite(existing, value, config.force)) {
          issueUpdates.push({ field_id: field.id, value });
          issueNames.push(`issue.${name}`);
        } else report.skipped.push(`issue.${name}`);
      }
    }
    if (Object.keys(config.project ?? {}).length) {
      const project = target.project;
      if (!project) throw new Error('project: a project and project item are required');
      projectOwnerIsOrg = (await this.github.rest.users.getByUsername({ username: project.owner })).data.type === 'Organization';
      const fields: ProjectField[] = projectOwnerIsOrg
        ? await this.github.paginate(this.github.rest.projects.listFieldsForOrg, { org: project.owner, project_number: project.number, per_page: 100, headers })
        : await this.github.paginate(this.github.rest.projects.listFieldsForUser, { username: project.owner, project_number: project.number, per_page: 100, headers });
      const resolved = await Promise.all(Object.entries(config.project ?? {}).map(async ([name, value]) => {
        const field = unique(fields, name, 'project');
        if (field.issue_field_id) throw new Error(`project.${name}: this is a native Issue Field; use issue scope`);
        if (field.data_type === 'iteration') {
          scalarType(field.data_type, value, `project.${name}`);
          const metadata = await new ProjectV2Repository(this.github).getIterationMetadata(project.owner, project.number, name);
          return { field, value: unique(metadata.iterations.map(entry => ({ name: entry.title, id: entry.id })), String(value), `project.${name} iteration`).id };
        }
        return { field, value: projectValue(field, value) };
      }));
      const node = await this.github.graphql<{ node: { databaseId: number } | null }>(
        'query($id: ID!) { node(id: $id) { ... on ProjectV2Item { databaseId } } }', { id: project.itemId },
      );
      if (!node.node?.databaseId) throw new Error('project: could not resolve the REST item ID');
      itemId = node.node.databaseId;
      const params = { project_number: project.number, item_id: itemId, fields: resolved.map(entry => String(entry.field.id)), headers };
      const item = projectOwnerIsOrg
        ? await this.github.rest.projects.getOrgItem({ ...params, org: project.owner })
        : await this.github.rest.projects.getUserItem({ ...params, username: project.owner });
      for (const { field, value } of resolved) {
        const existing = item.data.fields?.find(entry => entry.id === field.id)?.value;
        const normalized = existing && typeof existing === 'object' && 'id' in existing ? existing.id : existing;
        if (shouldWrite(normalized, value, config.force)) {
          projectUpdates.push({ id: field.id, value });
          projectNames.push(`project.${field.name}`);
        } else report.skipped.push(`project.${field.name}`);
      }
    }

    // Both scopes have been resolved before writing. The APIs do not share a transaction.
    for (const scope of ['project', 'issue'] as const) {
      const names = scope === 'project' ? projectNames : issueNames;
      if (!names.length) continue; // An empty native POST would clear unrelated values.
      try {
        if (scope === 'issue') {
          await this.github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/issue-field-values', { ...coordinates, issue_field_values: issueUpdates });
        } else {
          const project = target.project!;
          const params = { project_number: project.number, item_id: itemId, fields: projectUpdates, headers };
          if (projectOwnerIsOrg) await this.github.rest.projects.updateItemForOrg({ ...params, org: project.owner });
          else await this.github.rest.projects.updateItemForUser({ ...params, username: project.owner });
        }
        report.applied.push(...names);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new FieldUpdateError(`${scope} field update failed: ${message}`, report, names, { cause });
      }
    }
    return report;
  }
}

function unique<T extends { name: string }>(values: T[], name: string, scope: string): T {
  const matches = values.filter(value => value.name === name);
  if (matches.length !== 1) throw new Error(`${scope}: ${matches.length ? 'ambiguous' : 'unknown'} field or option "${name}"`);
  return matches[0]!;
}

function scalarType(type: string, value: FieldValue, field: string): void {
  if (!['text', 'number', 'date', 'single_select', 'iteration'].includes(type)) throw new Error(`${field}: unsupported type ${type}`);
  if (typeof value !== (type === 'number' ? 'number' : 'string')) throw new Error(`${field}: expected ${type === 'number' ? 'a number' : 'a string'}`);
}

function projectValue(field: ProjectField, value: FieldValue): FieldValue {
  scalarType(field.data_type, value, `project.${field.name}`);
  if (field.data_type === 'single_select') {
    return unique((field.options ?? []).map(option => ({ id: option.id, name: option.name.raw })), String(value), `project.${field.name} option`).id;
  }
  if (field.data_type === 'iteration') {
    return unique((field.configuration?.iterations ?? []).map(iteration => ({ id: iteration.id, name: iteration.title.raw })), String(value), `project.${field.name} iteration`).id;
  }
  return value;
}

function shouldWrite(current: unknown, value: FieldValue, force = false): boolean {
  return current !== value && (force || current === undefined || current === null || current === '');
}
