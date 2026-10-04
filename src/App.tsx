import { useEffect, useMemo, useState } from 'react';

type User = {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatar: string | null;
};

type Installation = {
  id: string;
  accountId: string;
  accountLogin: string;
};

type Repository = {
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  installationId: string;
};

type Backend = {
  id: string;
  name: string;
  kind: 'openai' | 'gemini' | 'local-worker';
  credentialConfigured: boolean;
  model?: string;
  reasoningEffort?: string;
  thinkingLevel?: string;
  baseUrl?: string;
};

type Settings = {
  backends: Backend[];
  bindings: Record<string, string | null>;
};

type Context = {
  user: User;
  installations: Installation[];
  settings: Settings;
};

const emptySettings: Settings = { backends: [], bindings: {} };

async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || 'Request failed');
  return body as T;
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [context, setContext] = useState<Context | null>(null);
  const [repositories, setRepositories] = useState<Record<string, Repository[]>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [backendKind, setBackendKind] = useState<Backend['kind']>('openai');
  const [backendId, setBackendId] = useState('');
  const [backendName, setBackendName] = useState('');
  const [backendModel, setBackendModel] = useState('');
  const [backendCredential, setBackendCredential] = useState('');
  const [bindingKey, setBindingKey] = useState('');
  const [bindingBackendId, setBindingBackendId] = useState('');

  const settings = context?.settings ?? emptySettings;

  const loadContext = async () => {
    setError('');
    try {
      const response = await fetch('/api/context');
      if (response.status === 401) {
        setContext(null);
        return;
      }
      setContext(await json<Context>(response));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load GitApp context');
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const session = await json<{ user: User | null }>(await fetch('/api/session'));
        setUser(session.user);
        if (session.user) await loadContext();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to load session');
        setUser(null);
      }
    })();
  }, []);

  const saveSettings = async (next: unknown) => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Origin: window.location.origin,
        },
        body: JSON.stringify(next),
      });
      const body = await json<{ settings: Settings }>(response);
      setContext((current) => current ? { ...current, settings: body.settings } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save settings');
    } finally {
      setSaving(false);
    }
  };

  const addBackend = async () => {
    if (!backendId.trim() || !backendName.trim()) {
      setError('Backend id and name are required');
      return;
    }

    let backend: Record<string, unknown>;
    if (backendKind === 'openai') {
      backend = {
        id: backendId.trim(),
        name: backendName.trim(),
        kind: 'openai',
        apiKey: backendCredential,
        model: backendModel.trim() || 'gpt-6-luna',
        reasoningEffort: 'medium',
      };
    } else if (backendKind === 'gemini') {
      backend = {
        id: backendId.trim(),
        name: backendName.trim(),
        kind: 'gemini',
        apiKey: backendCredential,
        model: backendModel.trim() || 'gemini-3.8-flash',
        thinkingLevel: 'medium',
      };
    } else {
      backend = {
        id: backendId.trim(),
        name: backendName.trim(),
        kind: 'local-worker',
        baseUrl: backendModel.trim() || 'http://127.0.0.1:4318',
        token: backendCredential,
      };
    }

    await saveSettings({
      backends: [...settings.backends, backend],
      bindings: settings.bindings,
    });

    setBackendId('');
    setBackendName('');
    setBackendModel('');
    setBackendCredential('');
  };

  const removeBackend = async (id: string) => {
    const bindings = Object.fromEntries(
      Object.entries(settings.bindings).map(([feature, backend]) => [
        feature,
        backend === id ? null : backend,
      ]),
    );
    await saveSettings({
      backends: settings.backends.filter((backend) => backend.id !== id),
      bindings,
    });
  };

  const addBinding = async () => {
    const key = bindingKey.trim();
    if (!key || !bindingBackendId) {
      setError('Binding key and backend are required');
      return;
    }
    await saveSettings({
      backends: settings.backends,
      bindings: { ...settings.bindings, [key]: bindingBackendId },
    });
    setBindingKey('');
  };

  const loadRepositories = async (installationId: string) => {
    setError('');
    try {
      const body = await json<{ repositories: Repository[] }>(
        await fetch('/api/repositories?installationId=' + encodeURIComponent(installationId)),
      );
      setRepositories((current) => ({ ...current, [installationId]: body.repositories }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load repositories');
    }
  };

  const backendOptions = useMemo(
    () => settings.backends.map((backend) => (
      <option key={backend.id} value={backend.id}>{backend.name} ({backend.id})</option>
    )),
    [settings.backends],
  );

  if (user === undefined) {
    return <div className="shell"><div className="card">Loading GitApp…</div></div>;
  }

  if (!user) {
    return (
      <div className="shell">
        <div className="card stack">
          <div className="brand">
            <h1>GitApp</h1>
            <div className="muted">GitHub-native identity, repositories and LLM backend preferences.</div>
          </div>
          <div>
            <a className="button primary" href="/api/auth/github/start">Sign in with GitHub</a>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <h1>GitApp</h1>
          <div className="muted">Shared GitHub + LLM configuration for VibeGuard and Hacka.</div>
        </div>
        <div className="row">
          {user.avatar && <img src={user.avatar} alt="" width={32} height={32} style={{ borderRadius: 999 }} />}
          <span>@{user.login}</span>
          <button onClick={() => void fetch('/api/logout', {
            method: 'POST',
            headers: { Origin: window.location.origin },
          }).then(() => window.location.reload())}>Sign out</button>
        </div>
      </div>

      {error && <div className="card error">{error}</div>}

      <section className="card stack">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>GitHub App</h2>
            <div className="muted">Install GitApp once, then expose only repositories available through that installation.</div>
          </div>
          <a className="button" href="/api/github/install">Install / configure GitHub App</a>
        </div>

        {context?.installations.length ? context.installations.map((installation) => (
          <div key={installation.id} className="card" style={{ marginBottom: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{installation.accountLogin}</strong>
                <div className="muted">installation {installation.id}</div>
              </div>
              <button onClick={() => void loadRepositories(installation.id)}>Load repositories</button>
            </div>
            {repositories[installation.id]?.length ? (
              <div className="stack" style={{ marginTop: 12 }}>
                {repositories[installation.id].map((repo) => (
                  <div key={repo.repositoryId} className="repo">
                    {repo.fullName} · {repo.defaultBranch}{repo.private ? ' · private' : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )) : <div className="muted">No GitHub App installations linked yet.</div>}
      </section>

      <section className="card stack">
        <div>
          <h2>LLM backends</h2>
          <div className="muted">Named user-owned backends. Credentials stay encrypted server-side and are never returned to the UI.</div>
        </div>

        <div className="grid">
          {settings.backends.map((backend) => (
            <div className="card stack" key={backend.id} style={{ marginBottom: 0 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <h3>{backend.name}</h3>
                  <div className="muted">{backend.kind} · {backend.id}</div>
                </div>
                <span className="status">{backend.credentialConfigured ? 'credential set' : 'no credential'}</span>
              </div>
              <div className="muted">
                {backend.kind === 'local-worker' ? backend.baseUrl : backend.model}
              </div>
              <button className="danger" onClick={() => void removeBackend(backend.id)}>Remove</button>
            </div>
          ))}
        </div>

        <div className="grid">
          <label>
            Type
            <select value={backendKind} onChange={(event) => setBackendKind(event.target.value as Backend['kind'])}>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="local-worker">Local worker</option>
            </select>
          </label>
          <label>
            ID
            <input value={backendId} onChange={(event) => setBackendId(event.target.value)} placeholder="planner-deep" />
          </label>
          <label>
            Name
            <input value={backendName} onChange={(event) => setBackendName(event.target.value)} placeholder="Planner deep" />
          </label>
          <label>
            {backendKind === 'local-worker' ? 'Base URL' : 'Model'}
            <input
              value={backendModel}
              onChange={(event) => setBackendModel(event.target.value)}
              placeholder={backendKind === 'local-worker' ? 'http://127.0.0.1:4318' : 'model id'}
            />
          </label>
          <label>
            {backendKind === 'local-worker' ? 'Token' : 'API key'}
            <input type="password" value={backendCredential} onChange={(event) => setBackendCredential(event.target.value)} />
          </label>
        </div>

        <div>
          <button className="primary" disabled={saving} onClick={() => void addBackend()}>
            Add backend
          </button>
        </div>
      </section>

      <section className="card stack">
        <div>
          <h2>Feature bindings</h2>
          <div className="muted">Consumers use stable feature keys; GitApp maps each key to a named backend instance.</div>
        </div>

        <div className="grid">
          {Object.entries(settings.bindings).map(([feature, backend]) => (
            <div key={feature} className="card" style={{ marginBottom: 0 }}>
              <div className="repo">{feature}</div>
              <div className="muted">{backend ?? 'unbound'}</div>
            </div>
          ))}
        </div>

        <div className="grid">
          <label>
            Feature key
            <input value={bindingKey} onChange={(event) => setBindingKey(event.target.value)} placeholder="hacka.planner" />
          </label>
          <label>
            Backend
            <select value={bindingBackendId} onChange={(event) => setBindingBackendId(event.target.value)}>
              <option value="">Choose backend</option>
              {backendOptions}
            </select>
          </label>
        </div>
        <div>
          <button disabled={saving || !settings.backends.length} onClick={() => void addBinding()}>
            Bind feature
          </button>
        </div>
      </section>

      <section className="card">
        <h2>MCP</h2>
        <div className="muted">
          Streamable HTTP endpoint: <span className="repo">/mcp</span>. Initial tools: <span className="repo">health</span> and <span className="repo">about</span>.
        </div>
      </section>
    </div>
  );
}
