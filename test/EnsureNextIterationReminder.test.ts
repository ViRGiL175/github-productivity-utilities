import { describe, expect, it, vi } from 'vitest';
import { EnsureNextIterationReminder } from '../src/automations/ensure-next-iteration-reminder/EnsureNextIterationReminder.js';
import type { ProjectIterationGateway } from '../src/github/ProjectV2Repository.js';
import type { Logger } from '../src/runtime/Logger.js';

const input = {
  projectOwner: 'owner',
  projectNumber: 10,
  iterationFieldName: 'Iteration',
  reminderTitle: 'Plan next sprint',
  currentDateOverride: '2026-09-15',
};

function createProject(items: Awaited<ReturnType<ProjectIterationGateway['listProjectItems']>> = []) {
  const projects: ProjectIterationGateway = {
    getIterationMetadata: vi.fn().mockResolvedValue({
      projectId: 'PROJECT',
      projectTitle: 'Project',
      iterationFieldId: 'FIELD',
      iterations: [
        { id: 'CURRENT', title: 'Current', startDate: '2026-09-14', duration: 7 },
        { id: 'NEXT', title: 'Next', startDate: '2026-09-21', duration: 7 },
      ],
    }),
    listProjectItems: vi.fn().mockResolvedValue(items),
    createDraftIssue: vi.fn().mockResolvedValue('REMINDER'),
    updateDraftIssue: vi.fn().mockResolvedValue(undefined),
    setIteration: vi.fn().mockResolvedValue(undefined),
    deleteProjectItem: vi.fn().mockResolvedValue(undefined),
  };
  const logger: Logger = { info: vi.fn(), warning: vi.fn() };
  return { projects, logger };
}

describe('EnsureNextIterationReminder', () => {
  it('creates the reminder in an empty current iteration', async () => {
    const dependencies = createProject();
    await new EnsureNextIterationReminder(dependencies.projects, dependencies.logger).run(input);
    expect(dependencies.projects.createDraftIssue).toHaveBeenCalledWith('PROJECT', 'Plan next sprint');
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'REMINDER', 'FIELD', 'CURRENT');
  });

  it('moves the reminder to the next iteration when the current one has issues', async () => {
    const dependencies = createProject([
      { id: 'ISSUE_ITEM', contentType: 'Issue', contentId: 'ISSUE', title: 'Work', iterationId: 'CURRENT' },
      { id: 'REMINDER', contentType: 'DraftIssue', contentId: 'DRAFT', title: 'Plan next sprint', iterationId: 'CURRENT' },
    ]);
    await new EnsureNextIterationReminder(dependencies.projects, dependencies.logger).run(input);
    expect(dependencies.projects.setIteration).toHaveBeenCalledWith('PROJECT', 'REMINDER', 'FIELD', 'NEXT');
  });

  it('keeps one canonical reminder and deletes duplicates', async () => {
    const dependencies = createProject([
      { id: 'ONE', contentType: 'DraftIssue', contentId: 'D1', title: 'Plan next sprint', iterationId: 'CURRENT' },
      { id: 'TWO', contentType: 'DraftIssue', contentId: 'D2', title: 'Plan next sprint', iterationId: 'NEXT' },
    ]);
    await new EnsureNextIterationReminder(dependencies.projects, dependencies.logger).run(input);
    expect(dependencies.projects.deleteProjectItem).toHaveBeenCalledWith('PROJECT', 'TWO');
    expect(dependencies.projects.createDraftIssue).not.toHaveBeenCalled();
  });

  it('rejects an invalid date override', async () => {
    const dependencies = createProject();
    await expect(new EnsureNextIterationReminder(dependencies.projects, dependencies.logger).run({
      ...input,
      currentDateOverride: 'not-a-date',
    })).rejects.toThrow('Invalid current_date_override');
  });
});
