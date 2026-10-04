import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultUserSettings, normalizeSettingsUpdate, type LlmBackend, type UserSettings } from './settings';

export type User = {
  id: string;
  githubId: string;
  login: string;
  name: string | null;
  avatar: string | null;
};

export type Installation = {
  id: string;
  accountId: string;
  accountLogin: string;
};

export const randomToken = () => randomBytes(32).toString('base64url');
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

function keyFrom(value: string): Buffer | undefined {
  const normalized = value.trim();
  return normalized ? createHash('sha256').update(normalized).digest() : undefined;
}

function seal(value: string, key: Buffer | undefined): string {
  if (!value) return '';
  if (!key) throw new Error('GITAPP_CREDENTIALS_KEY must be configured before saving credentials');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function open(value: string, key: Buffer | undefined): string {
  if (!value) return '';
  if (!key) throw new Error('GITAPP_CREDENTIALS_KEY is required to read saved credentials');
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Saved credential is corrupted');
  try {
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Saved credential could not be decrypted');
  }
}

export class PlatformStore {
  readonly db: DatabaseSync;

  constructor(filename = '.data/gitapp.sqlite', private readonly credentialsKey = '') {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        github_id TEXT NOT NULL UNIQUE,
        login TEXT NOT NULL,
        name TEXT,
        avatar TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sessions(
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_states(
        state_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        user_id TEXT,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS github_installations(
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_login TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS installation_users(
        installation_id TEXT NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY(installation_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS user_settings(
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        settings_json TEXT NOT NULL DEFAULT '{"backends":[],"bindings":{}}',
        secrets_json TEXT NOT NULL DEFAULT '{}'
      );
    `);
  }

  close() { this.db.close(); }

  upsertUser(identity: Omit<User,'id'>): User {
    const id = `github:${identity.githubId}`;
    this.db.prepare(
      'INSERT INTO users(id,github_id,login,name,avatar) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,name=excluded.name,avatar=excluded.avatar,updated_at=CURRENT_TIMESTAMP'
    ).run(id, identity.githubId, identity.login, identity.name, identity.avatar);
    return { id, ...identity };
  }

  user(id: string): User | undefined {
    return this.db.prepare('SELECT id,github_id AS githubId,login,name,avatar FROM users WHERE id=?').get(id) as User | undefined;
  }

  createSession(userId: string, ttlMs = 7 * 86400000): string {
    if (!this.user(userId)) throw new Error('User not found');
    const token = randomToken();
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + ttlMs);
    return token;
  }

  session(token: string): User | undefined {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT user_id AS userId,expires_at AS expiresAt FROM sessions WHERE token_hash=?').get(hashToken(token)) as {userId:string;expiresAt:number}|undefined;
    if (!row) return undefined;
    if (row.expiresAt <= Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      return undefined;
    }
    return this.user(row.userId);
  }

  logout(token: string): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  }

  startFlow(kind: string, binding: string, userId?: string, ttlMs = 10 * 60_000): string {
    const state = randomToken();
    this.db.prepare('INSERT INTO flow_states(state_hash,kind,binding_hash,user_id,expires_at) VALUES(?,?,?,?,?)')
      .run(hashToken(state), kind, hashToken(binding), userId ?? null, Date.now() + ttlMs);
    return state;
  }

  consumeFlow(state: string, binding: string, expectedKind?: string, expectedUserId?: string): {kind:string;userId:string|null}|undefined {
    const row = this.db.prepare('SELECT kind,binding_hash AS bindingHash,user_id AS userId,expires_at AS expiresAt FROM flow_states WHERE state_hash=?')
      .get(hashToken(state)) as {kind:string;bindingHash:string;userId:string|null;expiresAt:number}|undefined;
    if (!row) return undefined;
    this.db.prepare('DELETE FROM flow_states WHERE state_hash=?').run(hashToken(state));
    if (row.expiresAt <= Date.now() || row.bindingHash !== hashToken(binding)) return undefined;
    if (expectedKind !== undefined && row.kind !== expectedKind) return undefined;
    if (expectedUserId !== undefined && row.userId !== expectedUserId) return undefined;
    return { kind: row.kind, userId: row.userId };
  }

  linkInstallation(userId: string, installation: Installation): void {
    if (!this.user(userId)) throw new Error('User not found');
    this.db.prepare(
      'INSERT INTO github_installations(id,account_id,account_login) VALUES(?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,account_login=excluded.account_login'
    ).run(installation.id, installation.accountId, installation.accountLogin);
    this.db.prepare('INSERT OR IGNORE INTO installation_users(installation_id,user_id) VALUES(?,?)').run(installation.id, userId);
  }

  installations(userId: string): Installation[] {
    return this.db.prepare(
      'SELECT i.id,i.account_id AS accountId,i.account_login AS accountLogin ' +
      'FROM github_installations i JOIN installation_users u ON u.installation_id=i.id WHERE u.user_id=? ORDER BY i.account_login,i.id'
    ).all(userId) as unknown as Installation[];
  }

  userSettings(userId: string): UserSettings {
    const row = this.db.prepare('SELECT settings_json AS settingsJson,secrets_json AS secretsJson FROM user_settings WHERE user_id=?').get(userId) as {settingsJson:string;secretsJson:string}|undefined;
    if (!row) return defaultUserSettings();

    let stored: {backends?: unknown;bindings?: unknown};
    let encrypted: Record<string,string>;
    try {
      stored = JSON.parse(row.settingsJson);
      encrypted = JSON.parse(row.secretsJson);
      if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !encrypted || typeof encrypted !== 'object' || Array.isArray(encrypted)) throw new Error('invalid');
    } catch {
      throw new Error('Saved settings are corrupted');
    }

    const key = keyFrom(this.credentialsKey);
    const rawBackends = Array.isArray(stored.backends) ? stored.backends : [];
    const hydrated = rawBackends.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Saved settings are corrupted');
      const backend = raw as Record<string,unknown>;
      const id = typeof backend.id === 'string' ? backend.id : '';
      const credential = open(typeof encrypted[id] === 'string' ? encrypted[id] : '', key);
      return backend.kind === 'local-worker' ? { ...backend, token: credential } : { ...backend, apiKey: credential };
    });

    return normalizeSettingsUpdate(defaultUserSettings(), { backends: hydrated, bindings: stored.bindings ?? {} });
  }

  saveUserSettings(userId: string, value: unknown): UserSettings {
    if (!this.user(userId)) throw new Error('User not found');
    const next = normalizeSettingsUpdate(this.userSettings(userId), value);
    const key = keyFrom(this.credentialsKey);
    const secrets: Record<string,string> = {};
    const publicBackends = next.backends.map((backend): Omit<LlmBackend,'apiKey'|'token'> & Record<string,unknown> => {
      if (backend.kind === 'local-worker') {
        secrets[backend.id] = seal(backend.token, key);
        const { token: _token, ...rest } = backend;
        return rest;
      }
      secrets[backend.id] = seal(backend.apiKey, key);
      const { apiKey: _apiKey, ...rest } = backend;
      return rest;
    });

    this.db.prepare(
      'INSERT INTO user_settings(user_id,settings_json,secrets_json) VALUES(?,?,?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,secrets_json=excluded.secrets_json'
    ).run(userId, JSON.stringify({ backends: publicBackends, bindings: next.bindings }), JSON.stringify(secrets));
    return next;
  }
}
