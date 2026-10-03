import type { Octokit } from '@octokit/rest';
import { ensureNextIterationReminder } from '../automations/ensure-next-iteration-reminder/EnsureNextIterationReminder.ts';
import { ProjectV2Repository } from '../github/ProjectV2Repository.ts';
import { logger, required } from './environment.ts';

export async function run(github: Octokit): Promise<void> {
  await ensureNextIterationReminder({
    projectOwner: required('PROJECT_OWNER'),
    projectNumber: Number(required('PROJECT_NUMBER')),
    iterationFieldName: required('ITERATION_FIELD_NAME'),
    reminderTitle: required('REMINDER_TITLE'),
    currentDateOverride: process.env.CURRENT_DATE_OVERRIDE ?? '',
  }, new ProjectV2Repository(github), logger);
}
