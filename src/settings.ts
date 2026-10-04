export type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type GeminiThinkingLevel = 'low' | 'medium' | 'high';
export type BackendKind = 'openai' | 'gemini' | 'local-worker';

export type OpenAIBackend = {
  id: string;
  name: string;
  kind: 'openai';
  apiKey: string;
  model: string;
  reasoningEffort: OpenAIReasoningEffort;
};

export type GeminiBackend = {
  id: string;
  name: string;
  kind: 'gemini';
  apiKey: string;
  model: string;
  thinkingLevel: GeminiThinkingLevel;
};

export type LocalWorkerBackend = {
  id: string;
  name: string;
  kind: 'local-worker';
  baseUrl: string;
  token: string;
};

export type LlmBackend = OpenAIBackend | GeminiBackend | LocalWorkerBackend;

export type PublicLlmBackend =
  | (Omit<OpenAIBackend, 'apiKey'> & { credentialConfigured: boolean })
  | (Omit<GeminiBackend, 'apiKey'> & { credentialConfigured: boolean })
  | (Omit<LocalWorkerBackend, 'token'> & { credentialConfigured: boolean });

export type UserSettings = {
  backends: LlmBackend[];
  bindings: Record<string, string | null>;
};

export type PublicUserSettings = {
  backends: PublicLlmBackend[];
  bindings: Record<string, string | null>;
};

export function defaultUserSettings(): UserSettings {
  return { backends: [], bindings: {} };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, fallback: string, max = 240): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} is too long`);
  return normalized;
}

function requiredText(value: unknown, label: string, fallback: string, max = 240): string {
  const normalized = text(value, label, fallback, max);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function secret(section: Record<string, unknown>, key: string, label: string, fallback: string): string {
  if (!(key in section) || section[key] === undefined || section[key] === '') return fallback;
  if (section[key] === null) return '';
  if (typeof section[key] !== 'string') throw new Error(`${label} must be a string or null`);
  const normalized = section[key].trim();
  if (normalized.length > 4096) throw new Error(`${label} is too long`);
  return normalized;
}

function oneOf<T extends string>(value: unknown, label: string, fallback: T, allowed: readonly T[]): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is invalid`);
  return value as T;
}

function backendId(value: unknown, label: string, fallback = ''): string {
  const normalized = requiredText(value, label, fallback, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

function workerBaseUrl(value: unknown, fallback: string): string {
  const normalized = text(value, 'Local worker URL', fallback, 500);
  if (!normalized) return '';
  let url: URL;
  try { url = new URL(normalized); } catch { throw new Error('Local worker URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Local worker URL must be an http(s) URL without embedded credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
  if (!loopback) throw new Error('Local worker URL must use a loopback host');
  return url.toString().replace(/\/$/, '');
}

function normalizeBackends(current: UserSettings, value: unknown): LlmBackend[] {
  if (value === undefined) return current.backends.map((backend) => ({ ...backend }));
  if (!Array.isArray(value)) throw new Error('Backends must be an array');
  if (value.length > 20) throw new Error('At most 20 backends can be configured');

  const currentById = new Map(current.backends.map((backend) => [backend.id, backend]));
  const ids = new Set<string>();
  const names = new Set<string>();

  return value.map((raw, index) => {
    const section = record(raw, `Backend ${index + 1}`);
    const id = backendId(section.id, `Backend ${index + 1} id`);
    if (ids.has(id)) throw new Error(`Backend id "${id}" is duplicated`);
    ids.add(id);

    const name = requiredText(section.name, `Backend ${index + 1} name`, '', 80);
    const normalizedName = name.toLocaleLowerCase();
    if (names.has(normalizedName)) throw new Error(`Backend name "${name}" is duplicated`);
    names.add(normalizedName);

    const kind = oneOf(section.kind, `Backend ${name} type`, 'openai' as BackendKind, ['openai','gemini','local-worker'] as const);
    const previous = currentById.get(id);
    const sameKind = previous?.kind === kind ? previous : undefined;

    if (kind === 'openai') {
      const old = sameKind?.kind === 'openai' ? sameKind : undefined;
      return {
        id, name, kind,
        apiKey: secret(section, 'apiKey', `${name} API key`, old?.apiKey ?? ''),
        model: requiredText(section.model, `${name} model`, old?.model ?? 'gpt-6-luna'),
        reasoningEffort: oneOf(section.reasoningEffort, `${name} reasoning effort`, old?.reasoningEffort ?? 'medium', ['none','low','medium','high','xhigh'] as const),
      };
    }

    if (kind === 'gemini') {
      const old = sameKind?.kind === 'gemini' ? sameKind : undefined;
      return {
        id, name, kind,
        apiKey: secret(section, 'apiKey', `${name} API key`, old?.apiKey ?? ''),
        model: requiredText(section.model, `${name} model`, old?.model ?? 'gemini-3.8-flash'),
        thinkingLevel: oneOf(section.thinkingLevel, `${name} thinking level`, old?.thinkingLevel ?? 'medium', ['low','medium','high'] as const),
      };
    }

    const old = sameKind?.kind === 'local-worker' ? sameKind : undefined;
    return {
      id, name, kind,
      baseUrl: workerBaseUrl(section.baseUrl, old?.baseUrl ?? ''),
      token: secret(section, 'token', `${name} worker token`, old?.token ?? ''),
    };
  });
}

function normalizeBindings(current: UserSettings, value: unknown, configured: Set<string>): Record<string, string | null> {
  if (value === undefined) {
    return Object.fromEntries(Object.entries(current.bindings).filter(([,backendId]) => backendId === null || configured.has(backendId)));
  }
  const input = record(value, 'Bindings');
  if (Object.keys(input).length > 100) throw new Error('At most 100 feature bindings can be configured');
  const result: Record<string, string | null> = {};
  for (const [feature, backendId] of Object.entries(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(feature)) throw new Error(`Binding key "${feature}" is invalid`);
    if (backendId === null || backendId === '') { result[feature] = null; continue; }
    if (typeof backendId !== 'string' || !configured.has(backendId)) {
      throw new Error(`Binding "${feature}" must reference a configured backend or null`);
    }
    result[feature] = backendId;
  }
  return result;
}

export function normalizeSettingsUpdate(current: UserSettings, value: unknown): UserSettings {
  const root = record(value, 'Settings');
  const backends = normalizeBackends(current, root.backends);
  const configured = new Set(backends.map((backend) => backend.id));
  return { backends, bindings: normalizeBindings(current, root.bindings, configured) };
}

export function toPublicSettings(settings: UserSettings): PublicUserSettings {
  return {
    bindings: { ...settings.bindings },
    backends: settings.backends.map((backend): PublicLlmBackend => {
      if (backend.kind === 'openai') {
        const { apiKey, ...rest } = backend;
        return { ...rest, credentialConfigured: Boolean(apiKey) };
      }
      if (backend.kind === 'gemini') {
        const { apiKey, ...rest } = backend;
        return { ...rest, credentialConfigured: Boolean(apiKey) };
      }
      const { token, ...rest } = backend;
      return { ...rest, credentialConfigured: Boolean(token) };
    }),
  };
}
