import type { Octokit } from '@octokit/rest';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

const PROJECT_ITERATION_FIELDS = `
  id
  fields(first: 100) {
    nodes { ... on ProjectV2IterationField { id name } }
  }
`;

const PROJECT_STATUS_FIELDS = `
  id
  title
  fields(first: 100) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name }
      ... on ProjectV2SingleSelectField { options { id name } }
    }
  }
`;

const PROJECT_ITERATION_CONFIGURATION_FIELDS = `
  id
  title
  fields(first: 100) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name }
      ... on ProjectV2IterationField {
        configuration {
          duration
          startDay
          completedIterations { id title startDate duration }
          iterations { id title startDate duration }
        }
      }
    }
  }
`;

// Only fixed selections above are interpolated; owner and number remain GraphQL variables.
function projectQuery(ownerType: 'Organization' | 'User', fields: string): string {
  const root = ownerType === 'Organization' ? 'organization' : 'user';
  return `query($owner: String!, $number: Int!) {
    ${root}(login: $owner) { projectV2(number: $number) { ${fields} } }
  }`;
}

const ADD_ISSUE_TO_PROJECT_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item {
        id
      }
    }
  }
`;

const SET_ITERATION_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { iterationId: $iterationId }
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

const CONTENT_PROJECT_ITEMS_QUERY = `
  query($nodeId: ID!, $fieldName: String!) {
    node(id: $nodeId) {
      ... on PullRequest {
        projectItems(first: 100) {
          ...ProjectItems
        }
      }
      ... on Issue {
        projectItems(first: 100) {
          ...ProjectItems
        }
      }
    }
  }
  fragment ProjectItems on ProjectV2ItemConnection {
    nodes {
      id
      project { id }
      fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldIterationValue { iterationId title }
        ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
      }
    }
  }
`;

const SET_SINGLE_SELECT_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) {
      projectV2Item { id }
    }
  }
`;


const PROJECT_ITEMS_QUERY = `
  query($projectId: ID!, $after: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            content {
              __typename
              ... on DraftIssue { id title }
              ... on Issue { id number title }
              ... on PullRequest { id number title }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldIterationValue {
                  iterationId
                  title
                  startDate
                  duration
                  field { ... on ProjectV2FieldCommon { id name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const PROJECT_ISSUES_BY_FIELD_QUERY = `
  query($projectId: ID!, $fieldName: String!, $after: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            fieldValueByName(name: $fieldName) {
              ... on ProjectV2ItemFieldIterationValue { iterationId title }
            }
            content {
              ... on Issue {
                id number state
                repository { nameWithOwner }
                subIssuesSummary { total }
              }
            }
          }
        }
      }
    }
  }
`;

const ADD_DRAFT_MUTATION = `
  mutation($input: AddProjectV2DraftIssueInput!) {
    addProjectV2DraftIssue(input: $input) { projectItem { id } }
  }
`;

const UPDATE_DRAFT_MUTATION = `
  mutation($input: UpdateProjectV2DraftIssueInput!) {
    updateProjectV2DraftIssue(input: $input) { draftIssue { id } }
  }
`;

const DELETE_ITEM_MUTATION = `
  mutation($input: DeleteProjectV2ItemInput!) {
    deleteProjectV2Item(input: $input) { deletedItemId }
  }
`;

interface ProjectQueryResult<T> {
  organization?: { projectV2: T | null } | null;
  user?: { projectV2: T | null } | null;
}

interface ProjectNode {
  id: string;
  fields: {
    nodes: Array<{ id?: string; name?: string } | null>;
  };
}

interface ContentProjectItem {
  id: string;
  project?: { id: string } | null;
  fieldValueByName?: {
    iterationId?: string | null;
    title?: string | null;
    name?: string | null;
    optionId?: string | null;
  } | null;
}

interface ContentProjectItemsQueryResult {
  node?: { projectItems?: { nodes?: Array<ContentProjectItem | null> | null } | null } | null;
}

interface AddIssueToProjectResult {
  addProjectV2ItemById: {
    item: { id: string };
  };
}

interface SingleSelectProjectNode {
  id: string;
  title: string;
  fields: {
    nodes: Array<{
      __typename?: string;
      id?: string;
      name?: string;
      options?: Array<{ id: string; name: string }>;
    } | null>;
  };
}

interface IterationDefinitionNode {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}

interface IterationProjectNode {
  id: string;
  title: string;
  fields: {
    nodes: Array<{
      __typename?: string;
      id?: string;
      name?: string;
      configuration?: {
        duration: number;
        startDay: number;
        completedIterations?: IterationDefinitionNode[];
        iterations?: IterationDefinitionNode[];
      } | null;
    } | null>;
  };
}

interface ProjectItemsQueryResult {
  node?: {
    items?: {
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      nodes: Array<{
        id: string;
        content?: {
          __typename?: string;
          id?: string;
          number?: number;
          title?: string | null;
        } | null;
        fieldValues?: {
          nodes: Array<{
            __typename?: string;
            iterationId?: string;
            field?: { id?: string; name?: string } | null;
          } | null>;
        } | null;
      } | null>;
    } | null;
  } | null;
}

interface AddDraftResult {
  addProjectV2DraftIssue: { projectItem: { id: string } };
}

export interface ProjectMetadata {
  projectId: string;
  iterationFieldId: string;
}

export interface ProjectItem {
  id: string;
  iterationId: string | null;
  iterationTitle: string;
}

export interface ProjectV2Gateway {
  getProjectMetadata(owner: string, number: number, fieldName: string): Promise<ProjectMetadata>;
  getIssueProjectItem(issueNodeId: string, projectId: string, fieldName: string): Promise<ProjectItem | null>;
  addIssueToProject(projectId: string, issueNodeId: string): Promise<string>;
  setIteration(projectId: string, itemId: string, fieldId: string, iterationId: string): Promise<void>;
}

export interface ProjectIssueWithField {
  nodeId: string;
  number: number;
  repositoryNameWithOwner: string;
  iterationId: string | null;
  subIssueCount: number;
}

export interface ProjectIssueScanGateway {
  listOpenIssuesWithField(projectId: string, fieldName: string): Promise<ProjectIssueWithField[]>;
}

export interface ProjectStatusMetadata {
  projectId: string;
  projectTitle: string;
  statusFieldId: string;
  optionIdsByName: ReadonlyMap<string, string>;
}

export interface ProjectStatusItem {
  id: string;
  statusName: string | null;
  statusOptionId: string | null;
}

export interface ProjectStatusGateway {
  getStatusMetadata(owner: string, number: number, fieldName: string): Promise<ProjectStatusMetadata>;
  getContentProjectItem(nodeId: string, projectId: string, fieldName: string): Promise<ProjectStatusItem | null>;
  addContentToProject(projectId: string, nodeId: string): Promise<string>;
  setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>;
}

export interface IterationDefinition {
  id: string;
  title: string;
  startDate: string;
  duration: number;
}

export interface IterationProjectMetadata {
  projectId: string;
  projectTitle: string;
  iterationFieldId: string;
  iterations: IterationDefinition[];
  iterationDuration: number;
  iterationStartDay: number;
}

export interface IterationProjectItem {
  id: string;
  contentType: string;
  contentId: string | null;
  title: string;
  iterationId: string | null;
}

export interface ProjectIterationGateway {
  getIterationMetadata(owner: string, number: number, fieldName: string): Promise<IterationProjectMetadata>;
  listProjectItems(projectId: string, iterationFieldId: string): Promise<IterationProjectItem[]>;
  appendIteration(fieldId: string, iteration: Omit<IterationDefinition, 'id'>): Promise<IterationDefinition>;
  createDraftIssue(projectId: string, title: string): Promise<string>;
  updateDraftIssue(draftIssueId: string, title: string): Promise<void>;
  setIteration(projectId: string, itemId: string, fieldId: string, iterationId: string): Promise<void>;
  deleteProjectItem(projectId: string, itemId: string): Promise<void>;
}

export class ProjectV2Repository implements ProjectV2Gateway, ProjectStatusGateway, ProjectIterationGateway, ProjectIssueScanGateway {
  private readonly octokit: Octokit;
  constructor(octokit: Octokit) { this.octokit = octokit; }

  async getProjectMetadata(owner: string, number: number, fieldName: string): Promise<ProjectMetadata> {
    const project = await this.getProject<ProjectNode>(owner, number, PROJECT_ITERATION_FIELDS);

    if (!project) {
      throw new Error(`Project V2 #${number} was not found for owner ${owner}.`);
    }

    const iterationField = project.fields.nodes.find((field) => field?.name === fieldName);
    if (!iterationField?.id) {
      throw new Error(`Iteration field "${fieldName}" was not found in project ${owner}#${number}.`);
    }

    return {
      projectId: project.id,
      iterationFieldId: iterationField.id,
    };
  }

  async getIssueProjectItem(issueNodeId: string, projectId: string, fieldName: string): Promise<ProjectItem | null> {
    const item = await this.getContentProjectItemById(issueNodeId, projectId, fieldName);

    if (!item) {
      return null;
    }

    return {
      id: item.id,
      iterationId: item.fieldValueByName?.iterationId ?? null,
      iterationTitle: item.fieldValueByName?.title ?? '',
    };
  }

  async addIssueToProject(projectId: string, issueNodeId: string): Promise<string> {
    const data = await this.octokit.graphql<AddIssueToProjectResult>(ADD_ISSUE_TO_PROJECT_MUTATION, {
      projectId,
      contentId: issueNodeId,
    });

    return data.addProjectV2ItemById.item.id;
  }

  async setIteration(projectId: string, itemId: string, fieldId: string, iterationId: string): Promise<void> {
    await this.octokit.graphql(SET_ITERATION_MUTATION, {
      projectId,
      itemId,
      fieldId,
      iterationId,
    });
  }

  async getStatusMetadata(owner: string, number: number, fieldName: string): Promise<ProjectStatusMetadata> {
    const project = await this.getProject<SingleSelectProjectNode>(owner, number, PROJECT_STATUS_FIELDS);
    if (!project) {
      throw new Error(`Project ${owner}#${number} was not found.`);
    }
    const field = project.fields.nodes.find(
      (candidate) => candidate?.__typename === 'ProjectV2SingleSelectField' && candidate.name === fieldName,
    );
    if (!field?.id) {
      throw new Error(`Status field "${fieldName}" was not found in project ${owner}#${number}.`);
    }

    return {
      projectId: project.id,
      projectTitle: project.title,
      statusFieldId: field.id,
      optionIdsByName: new Map((field.options ?? []).map((option) => [option.name, option.id])),
    };
  }

  async getContentProjectItem(nodeId: string, projectId: string, fieldName: string): Promise<ProjectStatusItem | null> {
    const item = await this.getContentProjectItemById(nodeId, projectId, fieldName);
    return item
      ? {
          id: item.id,
          statusName: item.fieldValueByName?.name ?? null,
          statusOptionId: item.fieldValueByName?.optionId ?? null,
        }
      : null;
  }

  async addContentToProject(projectId: string, nodeId: string): Promise<string> {
    return this.addIssueToProject(projectId, nodeId);
  }

  async setSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await this.octokit.graphql(SET_SINGLE_SELECT_MUTATION, { projectId, itemId, fieldId, optionId });
  }

  async getIterationMetadata(owner: string, number: number, fieldName: string): Promise<IterationProjectMetadata> {
    const project = await this.getProject<IterationProjectNode>(owner, number, PROJECT_ITERATION_CONFIGURATION_FIELDS);
    if (!project) throw new Error(`Project ${owner}#${number} was not found.`);
    const field = project.fields.nodes.find(
      (candidate) => candidate?.__typename === 'ProjectV2IterationField' && candidate.name === fieldName,
    );
    if (!field?.id) throw new Error(`Iteration field "${fieldName}" was not found in project ${owner}#${number}.`);
    if (!field.configuration) throw new Error(`Missing configuration for iteration field ${field.id}.`);
    const iterations = [
      ...(field.configuration?.completedIterations ?? []),
      ...(field.configuration?.iterations ?? []),
    ].sort((left, right) => left.startDate.localeCompare(right.startDate) || left.title.localeCompare(right.title));
    return {
      projectId: project.id,
      projectTitle: project.title,
      iterationFieldId: field.id,
      iterations,
      iterationDuration: field.configuration.duration,
      iterationStartDay: field.configuration.startDay,
    };
  }

  // Callers must serialize writes to this field. GitHub has no conditional update for this configuration.
  async appendIteration(fieldId: string, iteration: Omit<IterationDefinition, 'id'>): Promise<IterationDefinition> {
    const readConfiguration = async () => {
      const data = await this.octokit.graphql<{
        node?: { configuration?: {
          duration: number; startDay: number;
          completedIterations: IterationDefinition[]; iterations: IterationDefinition[];
        } };
      }>(`query($fieldId: ID!) {
        node(id: $fieldId) { ... on ProjectV2IterationField { configuration {
          duration startDay
          completedIterations { id title startDate duration }
          iterations { id title startDate duration }
        } } }
      }`, { fieldId });
      const config = data.node?.configuration;
      if (!config) throw new Error(`Missing configuration for iteration field ${fieldId}.`);
      return {
        duration: config.duration, startDay: config.startDay,
        iterations: [...config.completedIterations, ...config.iterations]
          .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id)),
      };
    };
    // Re-read immediately before replacement, including completed iterations and their IDs.
    const before = await readConfiguration();
    const existing = before.iterations.find(candidate => candidate.startDate >= iteration.startDate);
    if (existing) return existing;
    // The API reads a weekday but accepts a date; retain that weekday in the replacement input.
    const anchor = new Date(`${before.iterations[0]?.startDate ?? iteration.startDate}T00:00:00Z`);
    anchor.setUTCDate(anchor.getUTCDate() - (anchor.getUTCDay() - before.startDay % 7 + 7) % 7);
    let mutationError: unknown;
    try {
      await this.octokit.graphql(`mutation($input: UpdateProjectV2FieldInput!) {
        updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2IterationField { id } } }
      }`, { input: { fieldId, iterationConfiguration: {
        duration: before.duration, startDate: anchor.toISOString().slice(0, 10),
        iterations: [...before.iterations, iteration],
      } } });
    } catch (error) {
      // A lost response may still mean a committed write. Check it; never blindly retry replacement.
      mutationError = error;
    }
    const after = await readConfiguration();
    const sameIteration = (a: Omit<IterationDefinition, 'id'>, b: Omit<IterationDefinition, 'id'>) =>
      a.title === b.title && a.startDate === b.startDate && a.duration === b.duration;
    if (before.duration !== after.duration || before.startDay !== after.startDay ||
      before.iterations.some(old => !after.iterations.some(current => current.id === old.id && sameIteration(old, current)))) {
      throw new Error(`Iteration configuration changed unexpectedly for ${fieldId}; inspect the field before retrying.`);
    }
    const added = after.iterations.filter(candidate => !before.iterations.some(old => old.id === candidate.id));
    const created = added[0];
    if (added.length !== 1 || !created || !sameIteration(created, iteration)) {
      throw mutationError ?? new Error(`Unable to verify appended iteration for ${fieldId}; inspect the field before retrying.`);
    }
    return created;
  }

  async listProjectItems(projectId: string, iterationFieldId: string): Promise<IterationProjectItem[]> {
    const result: IterationProjectItem[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    while (hasNextPage) {
      const data: ProjectItemsQueryResult = await this.octokit.graphql<ProjectItemsQueryResult>(PROJECT_ITEMS_QUERY, {
        projectId,
        after: cursor,
      });
      const connection = data.node?.items;
      if (!connection) throw new Error(`Unable to read items for project ${projectId}.`);
      for (const item of connection.nodes) {
        if (!item) continue;
        const iteration = item.fieldValues?.nodes.find(
          (value) => value?.__typename === 'ProjectV2ItemFieldIterationValue' && value.field?.id === iterationFieldId,
        );
        result.push({
          id: item.id,
          contentType: item.content?.__typename ?? '',
          contentId: item.content?.id ?? null,
          title: item.content?.title ?? '',
          iterationId: iteration?.iterationId ?? null,
        });
      }
      hasNextPage = connection.pageInfo.hasNextPage;
      cursor = connection.pageInfo.endCursor ?? null;
    }
    return result;
  }

  async listOpenIssuesWithField(projectId: string, fieldName: string): Promise<ProjectIssueWithField[]> {
    const result: ProjectIssueWithField[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: {
        node?: { items?: {
          pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          nodes?: Array<{
            fieldValueByName?: { iterationId?: string | null } | null;
            content?: {
              id?: string; number?: number; state?: string;
              repository?: { nameWithOwner?: string } | null;
              subIssuesSummary?: { total: number } | null;
            } | null;
          } | null> | null;
        } | null } | null;
      } = await this.octokit.graphql(PROJECT_ISSUES_BY_FIELD_QUERY, { projectId, fieldName, after: cursor });
      const connection = data.node?.items;
      if (!connection) throw new Error(`Unable to read items for project ${projectId}.`);
      for (const item of connection.nodes ?? []) {
        const issue = item?.content;
        if (!issue?.id || !issue.number || issue.state !== 'OPEN' || !issue.repository?.nameWithOwner) continue;
        result.push({
          nodeId: issue.id,
          number: issue.number,
          repositoryNameWithOwner: issue.repository.nameWithOwner,
          iterationId: item?.fieldValueByName?.iterationId ?? null,
          subIssueCount: issue.subIssuesSummary?.total ?? 0,
        });
      }
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor) throw new Error(`Missing pagination cursor for project ${projectId}.`);
      cursor = connection.pageInfo.endCursor;
    }
  }

  async createDraftIssue(projectId: string, title: string): Promise<string> {
    const data = await this.octokit.graphql<AddDraftResult>(ADD_DRAFT_MUTATION, { input: { projectId, title } });
    return data.addProjectV2DraftIssue.projectItem.id;
  }

  async updateDraftIssue(draftIssueId: string, title: string): Promise<void> {
    await this.octokit.graphql(UPDATE_DRAFT_MUTATION, { input: { draftIssueId, title } });
  }

  async deleteProjectItem(projectId: string, itemId: string): Promise<void> {
    await this.octokit.graphql(DELETE_ITEM_MUTATION, { input: { projectId, itemId } });
  }

  private async getProject<T>(owner: string, number: number, fields: string): Promise<T | null> {
    const ownerType = await this.getProjectOwnerType(owner);
    if (ownerType !== 'Organization' && ownerType !== 'User') {
      throw new Error(`Unsupported project owner type "${ownerType}" for ${owner}.`);
    }

    const data = await this.octokit.graphql<ProjectQueryResult<T>>(projectQuery(ownerType, fields), { owner, number });
    return (ownerType === 'Organization' ? data.organization?.projectV2 : data.user?.projectV2) ?? null;
  }

  private async getContentProjectItemById(nodeId: string, projectId: string, fieldName: string): Promise<ContentProjectItem | null> {
    const data = await this.octokit.graphql<ContentProjectItemsQueryResult>(CONTENT_PROJECT_ITEMS_QUERY, { nodeId, fieldName });
    return data.node?.projectItems?.nodes?.find((item) => item?.project?.id === projectId) ?? null;
  }

  private async getProjectOwnerType(owner: string): Promise<string> {
    const response = await this.octokit.request('GET /users/{username}', {
      username: owner,
      headers: API_HEADERS,
    });

    return response.data.type;
  }
}
