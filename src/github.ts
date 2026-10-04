import { createPrivateKey, createSign } from 'node:crypto';
import type { Installation, User } from './store';

export type Repository = {
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  installationId: string;
};

export type GitHubConfig = {
  clientId: string;
  clientSecret: string;
  appId: string;
  privateKey: string;
  appSlug: string;
  appUrl: string;
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string {
  if (!appId || !privateKey) throw new Error('Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY');
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey)).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export class GitHubGateway {
  constructor(readonly config: GitHubConfig, private readonly http: typeof fetch = fetch) {}

  authorization(state: string): string {
    if (!this.config.clientId || !this.config.clientSecret) throw new Error('Configure GitHub App OAuth client ID and secret');
    return `https://github.com/login/oauth/authorize?${new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: `${this.config.appUrl}/api/auth/github/callback`,
      state,
    })}`;
  }

  installation(state: string): string {
    if (!this.config.appSlug) throw new Error('Configure GITHUB_APP_SLUG');
    return `https://github.com/apps/${encodeURIComponent(this.config.appSlug)}/installations/new?${new URLSearchParams({ state })}`;
  }

  private async request(path: string, token: string, init?: RequestInit): Promise<any> {
    const response = await this.http(`https://api.github.com${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'GitApp',
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.json();
  }

  async identify(code: string): Promise<{ user: Omit<User,'id'>; token: string }> {
    const response = await this.http('https://github.com/login/oauth/access_token', {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: `${this.config.appUrl}/api/auth/github/callback`,
      }),
    });
    const body = await response.json() as { access_token?: unknown };
    if (!response.ok || typeof body.access_token !== 'string') throw new Error('GitHub authorization code exchange failed');
    const user = await this.request('/user', body.access_token);
    if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') throw new Error('Invalid GitHub identity');
    return {
      token: body.access_token,
      user: {
        githubId: String(user.id),
        login: user.login,
        name: typeof user.name === 'string' ? user.name : null,
        avatar: typeof user.avatar_url === 'string' ? user.avatar_url : null,
      },
    };
  }

  private jwt(): string {
    return createGitHubAppJwt(this.config.appId, this.config.privateKey);
  }

  async verifyInstallation(id: string, userToken: string): Promise<Installation> {
    let accessible = false;
    for (let page = 1; ; page++) {
      const body = await this.request(`/user/installations?per_page=100&page=${page}`, userToken);
      const installations = Array.isArray(body.installations) ? body.installations : [];
      accessible ||= installations.some((item: {id?: number}) => String(item.id) === id);
      if (installations.length < 100) break;
    }
    if (!accessible) throw new Error('Installation is not accessible to the authenticated GitHub user');

    const installation = await this.request(`/app/installations/${id}`, this.jwt());
    if (installation.suspended_at || String(installation.app_id) !== this.config.appId) {
      throw new Error('Installation is inactive or belongs to another GitHub App');
    }
    if (!installation.account || !Number.isSafeInteger(installation.account.id) || typeof installation.account.login !== 'string') {
      throw new Error('Invalid GitHub installation metadata');
    }
    return {
      id,
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
    };
  }

  private async installationToken(id: string): Promise<string> {
    const body = await this.request(`/app/installations/${id}/access_tokens`, this.jwt(), { method: 'POST' });
    if (typeof body.token !== 'string') throw new Error('GitHub did not return an installation token');
    return body.token;
  }

  async repositories(installationId: string): Promise<Repository[]> {
    const token = await this.installationToken(installationId);
    const repositories: Repository[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request(`/installation/repositories?per_page=100&page=${page}`, token);
      const rows = Array.isArray(body.repositories) ? body.repositories : [];
      repositories.push(...rows.map((repo: {id:number;full_name:string;default_branch:string;private:boolean}) => ({
        repositoryId: String(repo.id),
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
        installationId,
      })));
      if (rows.length < 100) return repositories;
    }
  }
}
