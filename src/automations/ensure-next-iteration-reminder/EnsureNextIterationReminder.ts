import type {
  IterationDefinition,
  IterationProjectItem,
  ProjectIterationGateway,
} from '../../github/ProjectV2Repository.js';
import type { Logger } from '../../runtime/Logger.js';

export interface EnsureNextIterationReminderInput {
  projectOwner: string;
  projectNumber: number;
  iterationFieldName: string;
  reminderTitle: string;
  currentDateOverride: string;
}

export class EnsureNextIterationReminder {
  constructor(
    private readonly projects: ProjectIterationGateway,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: EnsureNextIterationReminderInput): Promise<void> {
    const today = parseCurrentDate(input.currentDateOverride, this.now());
    const todayIso = today.toISOString().slice(0, 10);
    const project = await this.projects.getIterationMetadata(
      input.projectOwner,
      input.projectNumber,
      input.iterationFieldName,
    );
    const items = await this.projects.listProjectItems(project.projectId, project.iterationFieldId);
    const currentIteration = findCurrentIteration(project.iterations, today);
    const nextIteration = findNextIteration(project.iterations, currentIteration, today);

    if (!currentIteration) {
      this.logger.info(`No active iteration found for ${todayIso}. Will use the first future iteration as next if available.`);
    } else {
      this.logger.info(`Current iteration: ${currentIteration.title} (${currentIteration.startDate})`);
    }
    if (nextIteration) this.logger.info(`Next iteration: ${nextIteration.title} (${nextIteration.startDate})`);

    const currentHasIssues = currentIteration
      ? items.some((item) => item.contentType === 'Issue' && item.iterationId === currentIteration.id)
      : false;
    const targetIteration = currentIteration && !currentHasIssues ? currentIteration : nextIteration;
    if (!targetIteration) {
      this.logger.info(
        `No target iteration found in field "${input.iterationFieldName}" for project ${input.projectOwner}#${input.projectNumber}. Nothing to do.`,
      );
      return;
    }

    this.logger.info(`Target iteration for reminder: ${targetIteration.title} (${targetIteration.startDate})`);
    const reminders = items.filter(
      (item) => item.contentType === 'DraftIssue' && item.title === input.reminderTitle,
    );
    const canonical = reminders.find((item) => item.iterationId === targetIteration.id) ?? reminders[0];

    if (!canonical) {
      const itemId = await this.projects.createDraftIssue(project.projectId, input.reminderTitle);
      await this.projects.setIteration(project.projectId, itemId, project.iterationFieldId, targetIteration.id);
      this.logger.info(`Created reminder draft item in target iteration "${targetIteration.title}".`);
      return;
    }

    await this.reconcileCanonical(canonical, project.projectId, project.iterationFieldId, targetIteration, input);
    for (const duplicate of reminders.filter((item) => item.id !== canonical.id)) {
      await this.projects.deleteProjectItem(project.projectId, duplicate.id);
      this.logger.info(`Deleted duplicate reminder item ${duplicate.id}.`);
    }
    this.logger.info(`Reminder reconciled successfully in project "${project.projectTitle}".`);
  }

  private async reconcileCanonical(
    item: IterationProjectItem,
    projectId: string,
    fieldId: string,
    target: IterationDefinition,
    input: EnsureNextIterationReminderInput,
  ): Promise<void> {
    if (item.contentType !== 'DraftIssue' || !item.contentId) {
      throw new Error('Canonical reminder item is not a draft issue.');
    }
    if (item.title !== input.reminderTitle) {
      await this.projects.updateDraftIssue(item.contentId, input.reminderTitle);
      this.logger.info(`Updated reminder draft title for item ${item.id}.`);
    }
    if (item.iterationId !== target.id) {
      await this.projects.setIteration(projectId, item.id, fieldId, target.id);
      this.logger.info(`Moved reminder draft to target iteration "${target.title}".`);
    }
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
