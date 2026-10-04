import express, { type Express, type Request, type Response } from 'express';
import type { GitHubGateway } from './github';
import { randomToken, type PlatformStore, type User } from './store';
import { toPublicSettings } from './settings';

function cookie(request: Request, name: string): string {
  return request.headers.cookie
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '';
}

export class SessionAuth {
  constructor(
    readonly store: PlatformStore,
    readonly appUrl: string,
    readonly production = false,
  ) {}

  user(request: Request): User | undefined {
    return this.store.session(cookie(request, 'ga_session'));
  }

  require(request: Request, response: Response): User | undefined {
    const user = this.user(request);
    if (!user) {
      response.status(401).json({ error: 'Sign in with GitHub first' });
      return;
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      const expectedOrigin = new URL(this.appUrl).origin;
      if (request.header('origin') !== expectedOrigin) {
        response.status(403).json({ error: 'Invalid request origin' });
        return;
      }
    }
    return user;
  }

  cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.production,
      path: '/',
    };
  }
}

type CreateApiOptions = {
  store: PlatformStore;
  github: Pick<
    GitHubGateway,
    'authorization' | 'installation' | 'identify' | 'verifyInstallation' | 'repositories'
  >;
  appUrl: string;
  production?: boolean;
};

export function createApiApp(options: CreateApiOptions): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const auth = new SessionAuth(options.store, options.appUrl, options.production ?? false);
  const route = (
    handler: (request: Request, response: Response) => unknown | Promise<unknown>,
  ) => async (request: Request, response: Response) => {
    try {
      await handler(request, response);
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : 'Request failed',
      });
    }
  };

  app.get('/api/live', (_request, response) => response.json({ status: 'ok' }));

  app.get('/api/session', (request, response) => {
    response.set('Cache-Control', 'no-store').json({ user: auth.user(request) ?? null });
  });

  app.get('/api/auth/github/start', route((request, response) => {
    const binding = randomToken();
    const state = options.store.startFlow('login', binding);
    response.cookie('ga_flow', binding, { ...auth.cookieOptions(), maxAge: 10 * 60_000 });
    response.redirect(options.github.authorization(state));
  }));

  app.get('/api/auth/github/callback', route(async (request, response) => {
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    const flow = options.store.consumeFlow(state, cookie(request, 'ga_flow'));
    response.clearCookie('ga_flow', auth.cookieOptions());
    if (!flow || !code) throw new Error('OAuth state mismatch, expired or already used');

    const identity = await options.github.identify(code);
    if (flow.kind.startsWith('install:')) {
      const user = auth.user(request);
      if (!user || user.id !== flow.userId || user.githubId !== identity.user.githubId) {
        throw new Error('Installation authorization must use the signed-in GitHub identity');
      }
      const installation = await options.github.verifyInstallation(flow.kind.slice(8), identity.token);
      options.store.linkInstallation(user.id, installation);
    } else {
      if (flow.kind !== 'login') throw new Error('Unexpected OAuth flow');
      const user = options.store.upsertUser(identity.user);
      options.store.logout(cookie(request, 'ga_session'));
      response.cookie('ga_session', options.store.createSession(user.id), {
        ...auth.cookieOptions(),
        maxAge: 7 * 86400000,
      });
    }
    response.redirect('/');
  }));

  app.post('/api/logout', route((request, response) => {
    if (!auth.require(request, response)) return;
    options.store.logout(cookie(request, 'ga_session'));
    response.clearCookie('ga_session', auth.cookieOptions()).json({ ok: true });
  }));

  app.get('/api/github/install', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    const state = options.store.startFlow('setup', cookie(request, 'ga_session'), user.id);
    response.redirect(options.github.installation(state));
  }));

  app.get('/api/github/setup/callback', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;

    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const installationId =
      typeof request.query.installation_id === 'string' ? request.query.installation_id : '';

    if (!/^[1-9][0-9]*$/.test(installationId)) {
      throw new Error('Invalid installation id');
    }
    const flow = options.store.consumeFlow(state, cookie(request, 'ga_session'), 'setup', user.id);
    if (!flow) throw new Error('Invalid or expired installation setup state');

    const binding = randomToken();
    const oauthState = options.store.startFlow(`install:${installationId}`, binding, user.id);
    response.cookie('ga_flow', binding, { ...auth.cookieOptions(), maxAge: 10 * 60_000 });
    response.redirect(options.github.authorization(oauthState));
  }));

  app.get('/api/installations', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    response.json({ installations: options.store.installations(user.id) });
  }));

  app.get('/api/repositories', route(async (request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    const installationId =
      typeof request.query.installationId === 'string' ? request.query.installationId : '';
    if (!options.store.installations(user.id).some((installation) => installation.id === installationId)) {
      response.status(403).json({ error: 'Installation is not associated with this user' });
      return;
    }
    response.json({ repositories: await options.github.repositories(installationId) });
  }));

  app.get('/api/settings', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    response.set('Cache-Control', 'no-store').json({
      settings: toPublicSettings(options.store.userSettings(user.id)),
    });
  }));

  app.put('/api/settings', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    const saved = options.store.saveUserSettings(user.id, request.body);
    response.set('Cache-Control', 'no-store').json({ settings: toPublicSettings(saved) });
  }));

  app.get('/api/context', route((request, response) => {
    const user = auth.require(request, response);
    if (!user) return;
    response.set('Cache-Control', 'no-store').json({
      user,
      installations: options.store.installations(user.id),
      settings: toPublicSettings(options.store.userSettings(user.id)),
    });
  }));

  return app;
}
