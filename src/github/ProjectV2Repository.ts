import type { Octokit } from '@octokit/rest';

const API_HEADERS = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

const ORGANIZATION_PROJECT_QUERY = `
  query($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2IterationField {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const USER_PROJECT_QUERY = `
  query($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 50) {
          nodes {
            ... on ProjectV2IterationField {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const ISSUE_PROJECT_ITEMS_QUERY = `
  query($issueId: ID!, $fieldName: String!) {
    node(id: $issueId) {
      ... on Issue {
        projectItems(first: 100) {
          nodes {
            id
            project {
              id
            }
            fieldValueByName(name: $fieldName) {
              ... on ProjectV2ItemFieldIterationValue {
                iterationId
                title
              }
            }
          }
        }
      }
    }
  }
`;

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

const ORGANIZATION_SINGLE_SELECT_PROJECT_QUERY = `
  query($owner: String!, $number: Int!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        title
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField { options { id name } }
          }
        }
      }
    }
  }
`;

const USER_SINGLE_SELECT_PROJECT_QUERY = `
  query($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        id
        title
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name }
            ... on ProjectV2SingleSelectField { options { id name } }
          }
        }
      }
    }
  }
`;

const CONTENT_PROJECT_ITEMS_QUERY = `
  query($nodeId: ID!, $fieldName: String!) {
    node(id: $nodeId) {
      ... on PullRequest {
        projectItems(first: 100) {
          nodes {
            id
            project { id }
            fieldValueByName(name: $fieldName) {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
          }
        }
      }
      ... on Issue {
        projectItems(first: 100) {
          nodes {
            id
            project { id }
            fieldValueByName(name: $fieldName) {
              ... on ProjectV2ItemFieldSingleSelectValue { name optionId }
            }
          }
        }
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

interface ProjectQueryResult {
  organization?: { projectV2: ProjectNode | null } | null;
  user?: { projectV2: ProjectNode | null } | null;
}

interface ProjectNode {
  id: string;
  fields: {
    nodes: Array<{ id?: string; name?: string } | null>;
  };
}

interface IssueProjectItemsQueryResult {
  node?: {
    projectItems?: {
      nodes: Array<{
        id: string;
        project?: { id: string } | null;
        fieldValueByName?: { iterationId: string; title?: string | null } | null;
      } | null>;
    } | null;
  } | null;
}

interface AddIssueToProjectResult {
  addProjectV2ItemById: {
    item: { id: string };
  };
}

interface SingleSelectProjectQueryResult {
  organization?: { projectV2: SingleSelectProjectNode | null } | null;
  user?: { projectV2: SingleSelectProjectNode | null } | null;
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

interface ContentProjectItemsQueryResult {
  node?: {
    projectItems?: {
      nodes: Array<{
        id: string;
        project?: { id: string } | null;
        fieldValueByName?: { name?: string | null; optionId?: string | null } | null;
      } | null>;
    } | null;
  } | null;
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

export class ProjectV2Repository implements ProjectV2Gateway, ProjectStatusGateway {
  constructor(private readonly octokit: Octokit) {}

  async getProjectMetadata(owner: string, number: number, fieldName: string): Promise<ProjectMetadata> {
    const ownerType = await this.getProjectOwnerType(owner);
    const isOrganization = ownerType === 'Organization';
    const isUser = ownerType === 'User';

    if (!isOrganization && !isUser) {
      throw new Error(`Unsupported project owner type "${ownerType}" for ${owner}.`);
    }

    const data = await this.octokit.graphql<ProjectQueryResult>(
      isOrganization ? ORGANIZATION_PROJECT_QUERY : USER_PROJECT_QUERY,
      { owner, number },
    );
    const project = isOrganization ? data.organization?.projectV2 : data.user?.projectV2;

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
    const data = await this.octokit.graphql<IssueProjectItemsQueryResult>(ISSUE_PROJECT_ITEMS_QUERY, {
      issueId: issueNodeId,
      fieldName,
    });
    const item = data.node?.projectItems?.nodes.find((candidate) => candidate?.project?.id === projectId);

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
    const ownerType = await this.getProjectOwnerType(owner);
    const isOrganization = ownerType === 'Organization';
    if (!isOrganization && ownerType !== 'User') {
      throw new Error(`Unsupported project owner type "${ownerType}" for ${owner}.`);
    }

    const data = await this.octokit.graphql<SingleSelectProjectQueryResult>(
      isOrganization ? ORGANIZATION_SINGLE_SELECT_PROJECT_QUERY : USER_SINGLE_SELECT_PROJECT_QUERY,
      { owner, number },
    );
    const project = isOrganization ? data.organization?.projectV2 : data.user?.projectV2;
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
    const data = await this.octokit.graphql<ContentProjectItemsQueryResult>(CONTENT_PROJECT_ITEMS_QUERY, {
      nodeId,
      fieldName,
    });
    const item = data.node?.projectItems?.nodes.find((candidate) => candidate?.project?.id === projectId);
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

  private async getProjectOwnerType(owner: string): Promise<string> {
    const response = await this.octokit.request('GET /users/{username}', {
      username: owner,
      headers: API_HEADERS,
    });

    return response.data.type;
  }
}
