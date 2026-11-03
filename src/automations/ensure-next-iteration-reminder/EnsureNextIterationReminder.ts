import type {
  IterationDefinition,
  IterationProjectItem,
  ProjectIterationGateway,
} from '../../github/ProjectV2Repository.ts';
import type { Logger } from '../../runtime/Logger.ts';

export interface EnsureNextIterationReminderInput {
  projectOwner: string;
  projectNumber: number;
  iterationFieldName: string;
  reminderTitle: string;
  currentDateOverride: string;
}

export async function ensureNextIterationReminder(
input: EnsureNextIterationReminderInput,
projects: ProjectIterationGateway,
logger: Logger,
now: () => Date = () => new Date(),
): Promise<void> {
  const today = parseCurrentDate(input.currentDateOverride, now());
  const todayIso = today.toISOString().slice(0, 10);
  const project = await projects.getIterationMetadata(
    input.projectOwner,
    input.projectNumber,
    input.iterationFieldName,
  );
  const items = await projects.listProjectItems(project.projectId, project.iterationFieldId);
  const currentIteration = findCurrentIteration(project.iterations, today);
  let nextIteration = findNextIteration(project.iterations, currentIteration, today);
  if (!nextIteration) {
    const duration = project.iterationDuration;
    if (!Number.isInteger(duration) || duration <= 0) throw new Error('Iteration duration must be a positive number of days.');
    const last = project.iterations.at(-1);
    const start = toUtcDate(last?.startDate ?? todayIso);
    if (last) {
      start.setUTCDate(start.getUTCDate() + last.duration);
    } else {
      const daysUntilStart = (project.iterationStartDay % 7 - start.getUTCDay() + 7) % 7 || 7;
      start.setUTCDate(start.getUTCDate() + daysUntilStart);
    }
    // After a gap, resume the configured cadence at the first future boundary without backfilling history.
    if (start <= today) {
      const periods = Math.floor((today.getTime() - start.getTime()) / (duration * 86_400_000)) + 1;
      start.setUTCDate(start.getUTCDate() + periods * duration);
    }
    const startDate = start.toISOString().slice(0, 10);
    const numberedTitle = last?.title.match(/^(.*?)(\d+)$/);
    const title = numberedTitle
      ? numberedTitle[1] + String(BigInt(numberedTitle[2]!) + 1n).padStart(numberedTitle[2]!.length, '0')
      : `${input.iterationFieldName} ${startDate}`;
    nextIteration = await projects.appendIteration(project.iterationFieldId, { title, startDate, duration });
    logger.info(`Ensured next iteration: ${nextIteration.title} (${nextIteration.startDate})`);
  }

  if (!currentIteration) {
    logger.info(`No active iteration found for ${todayIso}. Will use the first future iteration as next if available.`);
  } else {
    logger.info(`Current iteration: ${currentIteration.title} (${currentIteration.startDate})`);
  }
  if (nextIteration) logger.info(`Next iteration: ${nextIteration.title} (${nextIteration.startDate})`);

  const currentHasIssues = currentIteration
    ? items.some((item) => item.contentType === 'Issue' && item.iterationId === currentIteration.id)
    : false;
  const targetIteration = currentIteration && !currentHasIssues ? currentIteration : nextIteration;
  if (!targetIteration) {
    logger.info(
      `No target iteration found in field "${input.iterationFieldName}" for project ${input.projectOwner}#${input.projectNumber}. Nothing to do.`,
    );
    return;
  }

  logger.info(`Target iteration for reminder: ${targetIteration.title} (${targetIteration.startDate})`);
  const reminders = items.filter(
    (item) => item.contentType === 'DraftIssue' && item.title === input.reminderTitle,
  );
  const canonical = reminders.find((item) => item.iterationId === targetIteration.id) ?? reminders[0];

  if (!canonical) {
    const itemId = await projects.createDraftIssue(project.projectId, input.reminderTitle);
    await projects.setIteration(project.projectId, itemId, project.iterationFieldId, targetIteration.id);
    logger.info(`Created reminder draft item in target iteration "${targetIteration.title}".`);
    return;
  }

  await reconcileCanonical(canonical, project.projectId, project.iterationFieldId, targetIteration, input, projects, logger);
  for (const duplicate of reminders.filter((item) => item.id !== canonical.id)) {
    await projects.deleteProjectItem(project.projectId, duplicate.id);
    logger.info(`Deleted duplicate reminder item ${duplicate.id}.`);
  }
  logger.info(`Reminder reconciled successfully in project "${project.projectTitle}".`);
}

async function reconcileCanonical(
    item: IterationProjectItem,
    projectId: string,
    fieldId: string,
    target: IterationDefinition,
    input: EnsureNextIterationReminderInput,
    projects: ProjectIterationGateway,
    logger: Logger,
  ): Promise<void> {
    if (item.contentType !== 'DraftIssue' || !item.contentId) {
      throw new Error('Canonical reminder item is not a draft issue.');
    }
    if (item.title !== input.reminderTitle) {
      await projects.updateDraftIssue(item.contentId, input.reminderTitle);
      logger.info(`Updated reminder draft title for item ${item.id}.`);
    }
    if (item.iterationId !== target.id) {
      await projects.setIteration(projectId, item.id, fieldId, target.id);
      logger.info(`Moved reminder draft to target iteration "${target.title}".`);
    }
}

export function parseCurrentDate(value: string, now: Date): Date {
  if (!value) return now;
  const parsed = new Date(value.includes('T') ? value : `${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid current_date_override value: ${value}`);
  return parsed;
}

export function findCurrentIteration(iterations: IterationDefinition[], today: Date): IterationDefinition | undefined {
  return iterations.find((iteration) => {
    const start = toUtcDate(iteration.startDate);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + iteration.duration);
    return today >= start && today < end;
  });
}

export function findNextIteration(
  iterations: IterationDefinition[],
  current: IterationDefinition | undefined,
  today: Date,
): IterationDefinition | undefined {
  const boundary = current ? toUtcDate(current.startDate) : today;
  return iterations.find((iteration) => toUtcDate(iteration.startDate) > boundary);
}

function toUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
