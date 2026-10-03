import type { IssueReopenGateway, RepositoryCoordinates } from '../../github/IssueRepository.ts';
import { hasClosingIssueReference } from '../../github/ClosingReferenceParser.ts';
import type { Logger } from '../../runtime/Logger.ts';

export interface ReopenIssueIfPrOpenInput {
  repository: RepositoryCoordinates;
  issueNumber: number;
}

export async function reopenIssueIfPrOpen(
input: ReopenIssueIfPrOpenInput,
issues: IssueReopenGateway,
logger: Logger,
): Promise<void> {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new Error('A valid issue_number input or github.event.issue.number is required.');
  }

  const pullRequests = await issues.listCrossReferencedPullRequests(input.repository, input.issueNumber);
  const openPullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.state === 'OPEN' && hasClosingIssueReference(
      pullRequest.body,
      input.repository,
      input.issueNumber,
      parseRepositoryNameWithOwner(pullRequest.repositoryNameWithOwner),
    ),
  );

  if (openPullRequests.length === 0) {
    logger.info('No open linked PRs with closing keywords. Issue stays closed.');
    return;
  }

  const pullRequestLines = openPullRequests.map(
    (pullRequest) =>
      `- ${pullRequest.repositoryNameWithOwner}#${pullRequest.number} — ${pullRequest.title}`,
  );
  logger.info(`Open linked PRs found:\n${pullRequestLines.join('\n')}`);

  await issues.reopenIssue(input.repository, input.issueNumber);
  await issues.addIssueComment(
    input.repository,
    input.issueNumber,
    [
      '🔁 **Issue переоткрыта автоматически.**',
      '',
      'К ней привязаны открытые PR:',
      '',
      ...pullRequestLines,
      '',
      'Чтобы закрыть Issue, выберите один из вариантов для каждого PR:',
      '1. **Мёрдж PR** — Issue закроется сама через `Closes`.',
      '2. **Закрыть PR без мёрджа** — Issue больше не будет переоткрываться из-за него.',
      `3. **Отвязать PR от Issue** — уберите closing-ссылку на ${input.repository.owner}/${input.repository.repo}#${input.issueNumber} из тела PR, затем закройте Issue вручную.`,
    ].join('\n'),
  );

  logger.info(`Issue #${input.issueNumber} was reopened and commented successfully.`);
}

function parseRepositoryNameWithOwner(value: string): RepositoryCoordinates | undefined {
  const [owner, repo, ...rest] = value.split('/');
  return owner && repo && rest.length === 0 ? { owner, repo } : undefined;
}
