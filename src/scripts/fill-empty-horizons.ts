import type { Octokit } from '@octokit/rest';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { required } from './environment.ts';

interface CandidatePage {
  node: { items: {
    nodes: Array<{ id: string; type: string } | null>;
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  } } | null;
}

interface HorizonItem {
  id: string;
  isArchived: boolean;
  fieldValueByName: { __typename: string } | null;
}

export async function run(github: Octokit): Promise<void> {
  const project = await new ProjectV2Repository(github).getStatusMetadata(
    required('PROJECT_OWNER'), Number(required('PROJECT_NUMBER')), 'Horizon',
  );
  const option = required('HORIZON_DEFAULT');
  const optionId = project.optionIdsByName.get(option);
  if (!optionId) throw new Error(`Option "${option}" is missing from Horizon in project "${project.projectTitle}".`);

  // Finish paging before writes change membership of the filtered connection.
  const candidates: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: CandidatePage = await github.graphql(`
      query($projectId: ID!, $after: String) {
        node(id: $projectId) { ... on ProjectV2 {
          items(first: 100, after: $after, query: "no:Horizon") {
            nodes { id type }
            pageInfo { endCursor hasNextPage }
          }
        } }
      }`, { projectId: project.projectId, after });
    if (!page.node) throw new Error(`Unable to read project ${project.projectId}.`);
    for (const item of page.node.items.nodes) {
      if (item?.type === 'ISSUE' || item?.type === 'PULL_REQUEST') candidates.push(item.id);
    }
    if (!page.node.items.pageInfo.hasNextPage) break;
    after = page.node.items.pageInfo.endCursor;
    if (!after) throw new Error('GitHub omitted the next project items cursor.');
  }

  let updated = 0;
  const batchSize = 20;
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    // The search index may lag, or someone may have set Horizon since the scan.
    const { nodes } = await github.graphql<{ nodes: Array<HorizonItem | null> }>(`
      query($ids: [ID!]!) {
        nodes(ids: $ids) { ... on ProjectV2Item {
          id isArchived fieldValueByName(name: "Horizon") { __typename }
        } }
      }`, { ids: candidates.slice(offset, offset + batchSize) });
    const empty = nodes.filter((item): item is HorizonItem =>
      item != null && !item.isArchived && item.fieldValueByName === null);
    if (!empty.length) continue;
    const ids = Object.fromEntries(empty.map((item, i) => [`item${i}`, item.id]));
    const parameters = empty.map((_, i) => `$item${i}: ID!`);
    const updates = empty.map((_, i) => `set${i}: updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $item${i}, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}
    }) { projectV2Item { id } }`);
    await github.graphql(`mutation($projectId: ID!, $fieldId: ID!, $optionId: String!, ${parameters.join(', ')}) {
      ${updates.join('\n')}
    }`, { projectId: project.projectId, fieldId: project.statusFieldId, optionId, ...ids });
    updated += empty.length;
  }
  console.log(`Set Horizon to "${option}" on ${updated} project item(s).`);
}
