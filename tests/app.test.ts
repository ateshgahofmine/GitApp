import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApiApp } from '../src/app';
import { PlatformStore } from '../src/store';

describe('GitApp HTTP shell', () => {
  it('authenticates with GitHub, links an installation, discovers repositories and saves backends', async () => {
    const store = new PlatformStore(':memory:', 'test-key');
    const identity = {
      githubId: '123',
      login: 'alice',
      name: 'Alice',
      avatar: null,
    };
    const repository = {
      repositoryId: '77',
      fullName: 'alice/private',
      defaultBranch: 'main',
      private: true,
      installationId: '9',
    };

    const github = {
      authorization: (state: string) => 'https://github.test/oauth?state=' + encodeURIComponent(state),
      installation: (state: string) => 'https://github.test/install?state=' + encodeURIComponent(state),
      identify: async (_code: string) => ({ user: identity, token: 'human-token' }),
      verifyInstallation: async (id: string, token: string) => {
        expect(token).toBe('human-token');
        return { id, accountId: '123', accountLogin: 'alice' };
      },
      repositories: async (installationId: string) => [{ ...repository, installationId }],
    };

    const app = createApiApp({
      store,
      github,
      appUrl: 'http://localhost:3000',
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const jar = new Map<string,string>();

    const updateCookies = (response: Response) => {
      for (const value of response.headers.getSetCookie()) {
        const first = value.split(';')[0];
        const index = first.indexOf('=');
        if (index > 0) jar.set(first.slice(0, index), first.slice(index + 1));
      }
    };

    const cookieHeader = () => [...jar.entries()].map(([name, value]) => name + '=' + value).join('; ');

    const call = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookieHeader());
      if (init.method && !['GET','HEAD'].includes(init.method)) headers.set('Origin', 'http://localhost:3000');
      const response = await fetch(base + path, { ...init, headers, redirect: 'manual' });
      updateCookies(response);
      return response;
    };

    try {
      expect((await call('/api/session')).status).toBe(200);
      expect((await (await call('/api/session')).json()).user).toBeNull();

      const start = await call('/api/auth/github/start');
      expect(start.status).toBe(302);
      const loginState = new URL(start.headers.get('location')!).searchParams.get('state');
      expect(loginState).toBeTruthy();

      const login = await call('/api/auth/github/callback?state=' + encodeURIComponent(loginState!) + '&code=ok');
      expect(login.status).toBe(302);

      const context = await (await call('/api/context')).json();
      expect(context.user.login).toBe('alice');
      expect(context.installations).toEqual([]);
      expect(context.settings).toEqual({ backends: [], bindings: {} });

      const install = await call('/api/github/install');
      const setupState = new URL(install.headers.get('location')!).searchParams.get('state');
      const setup = await call('/api/github/setup/callback?state=' + encodeURIComponent(setupState!) + '&installation_id=9');
      expect(setup.status).toBe(302);
      const installationState = new URL(setup.headers.get('location')!).searchParams.get('state');
      const verified = await call('/api/auth/github/callback?state=' + encodeURIComponent(installationState!) + '&code=install');
      expect(verified.status).toBe(302);

      const installations = await (await call('/api/installations')).json();
      expect(installations.installations).toEqual([{ id: '9', accountId: '123', accountLogin: 'alice' }]);

      const repositories = await (await call('/api/repositories?installationId=9')).json();
      expect(repositories.repositories[0].fullName).toBe('alice/private');

      const saved = await call('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backends: [{
            id: 'planner',
            name: 'Planner',
            kind: 'openai',
            apiKey: 'sk-secret',
            model: 'gpt-6-sol',
            reasoningEffort: 'high',
          }],
          bindings: { 'hacka.planner': 'planner' },
        }),
      });
      expect(saved.status).toBe(200);
      const body = await saved.text();
      expect(body).not.toContain('sk-secret');
      expect(JSON.parse(body).settings.bindings['hacka.planner']).toBe('planner');

      const loggedOut = await call('/api/logout', { method: 'POST' });
      expect(loggedOut.status).toBe(200);
      jar.delete('ga_session');
      expect((await call('/api/context')).status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    }
  });
});
