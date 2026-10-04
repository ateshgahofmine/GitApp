import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApiApp } from '../src/api';
import { PlatformStore } from '../src/store';

describe('GitApp trusted service API', () => {
  it('requires the service token and forwards stable GitHub user + feature to the broker', async () => {
    const store = new PlatformStore(':memory:', 'test-key');
    store.upsertUser({ githubId: '123', login: 'alice', name: null, avatar: null });

    const seen: Array<{ githubUserId: string; feature: string; request: unknown }> = [];
    const invoker = {
      invoke: async (githubUserId: string, feature: string, request: unknown) => {
        seen.push({ githubUserId, feature, request });
        return {
          status: 'complete' as const,
          value: { tasks: [] },
          metadata: {
            backendId: 'planner',
            provider: 'openai' as const,
            model: 'gpt-6-sol',
            latencyMs: 1,
          },
        };
      },
    };

    const github = {
      authorization: () => '',
      installation: () => '',
      identify: async () => { throw new Error('unused'); },
      verifyInstallation: async () => { throw new Error('unused'); },
      repositories: async () => [],
    };

    const app = createApiApp({
      store,
      github,
      appUrl: 'http://localhost:3000',
      invoker,
      serviceToken: 'service-secret',
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const payload = {
      instructions: 'Plan it',
      input: { issue: 1 },
      output: {
        name: 'plan',
        schema: {
          type: 'object',
          required: ['tasks'],
          properties: { tasks: { type: 'array' } },
        },
      },
    };

    try {
      const unauthorized = await fetch(base + '/api/service/users/123/invoke/hacka.planner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
        body: JSON.stringify(payload),
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(base + '/api/service/users/123/invoke/hacka.planner', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer service-secret',
        },
        body: JSON.stringify(payload),
      });
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual(expect.objectContaining({
        status: 'complete',
        value: { tasks: [] },
      }));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(expect.objectContaining({
        githubUserId: '123',
        feature: 'hacka.planner',
      }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    }
  });
});
