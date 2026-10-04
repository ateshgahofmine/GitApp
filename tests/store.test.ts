import { describe, expect, it } from 'vitest';
import { PlatformStore } from '../src/store';
import { toPublicSettings } from '../src/settings';

describe('PlatformStore', () => {
  it('persists per-user encrypted backend settings and opaque sessions', () => {
    const store = new PlatformStore(':memory:', 'deployment-secret');
    try {
      const alice = store.upsertUser({ githubId: '1', login: 'alice', name: null, avatar: null });
      const bob = store.upsertUser({ githubId: '2', login: 'bob', name: null, avatar: null });

      const token = store.createSession(alice.id);
      expect(store.session(token)?.login).toBe('alice');
      expect(JSON.stringify(store.db.prepare('SELECT * FROM sessions').all())).not.toContain(token);

      const saved = store.saveUserSettings(alice.id, {
        backends: [{
          id: 'deep',
          name: 'Deep',
          kind: 'openai',
          apiKey: 'sk-private',
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
        }],
        bindings: { 'hacka.planner': 'deep' },
      });

      expect(toPublicSettings(saved).backends[0].credentialConfigured).toBe(true);
      const raw = store.db.prepare('SELECT settings_json AS settings,secrets_json AS secrets FROM user_settings WHERE user_id=?').get(alice.id) as {settings:string;secrets:string};
      expect(raw.settings).not.toContain('sk-private');
      expect(raw.secrets).not.toContain('sk-private');
      expect(store.userSettings(alice.id).bindings['hacka.planner']).toBe('deep');
      expect(store.userSettings(bob.id)).toEqual({ backends: [], bindings: {} });

      store.logout(token);
      expect(store.session(token)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('binds installations to users', () => {
    const store = new PlatformStore(':memory:', 'key');
    try {
      const user = store.upsertUser({ githubId: '1', login: 'alice', name: null, avatar: null });
      store.linkInstallation(user.id, { id: '9', accountId: '42', accountLogin: 'alice' });
      expect(store.installations(user.id)).toEqual([{ id: '9', accountId: '42', accountLogin: 'alice' }]);
    } finally {
      store.close();
    }
  });
});
