import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/analytics/model.ts';
import { projectEvent } from '../src/analytics/ProjectEvent.ts';
import { webhookServer } from '../src/analytics/webhooks.ts';

const target = { owner: 'example', number: 1 };
const projectId = 'PVT_example';
const repositories = ['backlog'];
const organization = { login: target.owner };
const repository = { full_name: 'example/backlog' };
const sourceTime = '2026-01-02T03:04:05Z';

function fieldPayload(field: Record<string, Json>): Record<string, Json> {
  return {
    action: 'edited', organization,
    projects_v2_item: {
      node_id: 'PVTI_example', project_node_id: projectId, content_node_id: 'I_example',
      content_type: 'Issue', created_at: sourceTime, updated_at: sourceTime, archived_at: null,
    },
    changes: { field_value: { field_node_id: 'PVTF_points', field_name: 'Points', field_type: 'number', ...field } },
  };
}

const normalize = (name: string, payload: Json) => projectEvent(name, payload, target, projectId, repositories);

describe('Project event collection', () => {
  it('rejects forged signatures and oversized fixed-length or chunked requests before recording', async () => {
    const secret = 'test-secret-with-at-least-32-characters';
    const recorded: Json[] = [];
    const server = webhookServer(secret, {
      async record(_id, _name, payload) { recorded.push(payload); return 'stored'; },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify(fieldPayload({ from: 3, to: 0 }));
    const sign = (value: string) => `sha256=${createHmac('sha256', secret).update(value).digest('hex')}`;
    function send(value: string, signature: string, chunked = false): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/github/webhooks', method: 'POST', headers: {
          'content-type': 'application/json', 'x-github-event': 'projects_v2_item', 'x-github-delivery': randomUUID(),
          'x-hub-signature-256': signature,
          ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(value) }),
        } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        req.setTimeout(3000, () => req.destroy(new Error('Webhook test timed out')));
        req.end(value);
      });
    }
    try {
      expect(await send(body.replace('"to":0', '"to":9'), sign(body))).toBe(401);
      const oversized = JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) });
      expect(await send(oversized, sign(oversized))).toBe(413);
      expect(await send(oversized, sign(oversized), true)).toBe(413);
      expect(recorded).toEqual([]);
      expect(await send(body, sign(body))).toBe(204);
      expect(recorded).toEqual([JSON.parse(body)]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('accepts the configured source and ignores other organizations, projects and repositories', () => {
    const payload = fieldPayload({ from: 1, to: 2 });
    expect(normalize('projects_v2_item', payload)?.contentId).toBe('I_example');
    expect(normalize('projects_v2_item', { ...payload, organization: { login: 'elsewhere' } })).toBeNull();
    expect(normalize('projects_v2_item', { ...payload,
      projects_v2_item: { ...payload.projects_v2_item as Record<string, Json>, project_node_id: 'PVT_other' },
    })).toBeNull();
    const issue = { action: 'closed', organization, repository, issue: { node_id: 'I_example', state: 'closed' } };
    expect(normalize('issues', issue)?.contentId).toBe('I_example');
    expect(normalize('issues', { ...issue, repository: { full_name: 'example/unselected' } })).toBeNull();
    expect(normalize('sub_issues', { ...issue, action: 'parent_issue_added',
      repository: { full_name: 'elsewhere/backlog' }, sub_issue: { node_id: 'I_example' },
    })).toBeNull();
    expect(normalize('issues', { ...issue, organization: { login: 'EXAMPLE' },
      repository: { full_name: 'EXAMPLE/Backlog' },
    })?.contentId).toBe('I_example');
  });

  it('preserves explicit zero and clearing, select changes and unknown omitted endpoints', () => {
    const field = (changes: Record<string, Json>) => normalize('projects_v2_item', fieldPayload(changes))!.data.field;
    expect(field({ from: 3, to: 0 })).toMatchObject({ from: 3, to: 0 });
    expect(field({ from: 0, to: null })).toMatchObject({ from: 0, to: null });
    expect(field({ to: null })).toEqual({ field_node_id: 'PVTF_points', field_name: 'Points', field_type: 'number', to: null });
    expect(field({})).toEqual({ field_node_id: 'PVTF_points', field_name: 'Points', field_type: 'number' });
    for (const field_name of ['Horizon', 'Status']) {
      expect(field({ field_name, field_type: 'single_select',
        from: { id: 'old', name: 'Old', description: 'Not needed' }, to: { id: 'new', name: 'New' },
      })).toEqual({ field_node_id: 'PVTF_points', field_name, field_type: 'single_select',
        from: { id: 'old', name: 'Old' }, to: { id: 'new', name: 'New' } });
    }
  });

  it('preserves closing reasons, reopening and both directions of parent relationship changes', () => {
    for (const state_reason of ['completed', 'not_planned', 'duplicate']) {
      expect(normalize('issues', { action: 'closed', organization, repository,
        issue: { node_id: 'I_example', state: 'closed', state_reason, closed_at: sourceTime,
          updated_at: sourceTime, title: 'Private title', body: 'Private body' },
      })).toMatchObject({ contentId: 'I_example', sourceUpdatedAt: sourceTime,
        data: { state: 'closed', state_reason, closed_at: sourceTime } });
    }
    expect(normalize('issues', { action: 'reopened', organization, repository,
      issue: { node_id: 'I_example', state: 'open', state_reason: 'reopened', closed_at: null,
        title: 'Private title', body: 'Private body' },
    })!.data).toEqual({ state: 'open', state_reason: 'reopened', closed_at: null });
    expect(normalize('issues', { action: 'edited', organization, repository,
      issue: { node_id: 'I_example', state: 'closed', state_reason: 'not_planned' }, changes: {},
    })!.data).toEqual({ state: 'closed', state_reason: 'not_planned' });
    for (const action of ['parent_issue_added', 'parent_issue_removed', 'sub_issue_added', 'sub_issue_removed']) {
      expect(normalize('sub_issues', { action, organization, repository,
        sub_issue: { node_id: 'I_child', body: 'Private body', updated_at: sourceTime },
        parent_issue: { node_id: 'I_parent', title: 'Private title' }, parent_issue_id: 1, sub_issue_id: 2,
      })).toEqual({ event: 'sub_issues', action, itemId: null, contentId: 'I_child', sourceUpdatedAt: null,
        repository: 'example/backlog', data: { parent_id: 'I_parent', parent_database_id: 1, child_database_id: 2,
          linked: action.endsWith('_added') } });
    }
  });
});
