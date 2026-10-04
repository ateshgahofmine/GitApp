import { describe, expect, it } from 'vitest';
import { defaultUserSettings, normalizeSettingsUpdate, toPublicSettings } from '../src/settings';

describe('settings', () => {
  it('supports named backends and arbitrary feature bindings without leaking credentials', () => {
    const settings = normalizeSettingsUpdate(defaultUserSettings(), {
      backends: [
        {
          id: 'planner',
          name: 'Planner',
          kind: 'openai',
          apiKey: 'sk-secret',
          model: 'gpt-6-sol',
          reasoningEffort: 'high',
        },
        {
          id: 'gemini',
          name: 'Gemini',
          kind: 'gemini',
          apiKey: 'gem-secret',
          model: 'gemini-3.8-flash',
          thinkingLevel: 'medium',
        },
      ],
      bindings: {
        'hacka.planner': 'planner',
        'vibeguard.capability-inference': 'gemini',
      },
    });

    expect(settings.bindings['hacka.planner']).toBe('planner');
    const publicSettings = toPublicSettings(settings);
    expect(publicSettings.backends).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'planner', credentialConfigured: true }),
      expect.objectContaining({ id: 'gemini', credentialConfigured: true }),
    ]));
    expect(JSON.stringify(publicSettings)).not.toContain('sk-secret');
    expect(JSON.stringify(publicSettings)).not.toContain('gem-secret');
  });

  it('preserves omitted credentials and rejects bindings to missing backends', () => {
    const initial = normalizeSettingsUpdate(defaultUserSettings(), {
      backends: [{
        id: 'planner',
        name: 'Planner',
        kind: 'openai',
        apiKey: 'secret',
        model: 'gpt-6-sol',
        reasoningEffort: 'high',
      }],
      bindings: { 'hacka.planner': 'planner' },
    });

    const updated = normalizeSettingsUpdate(initial, {
      backends: [{
        id: 'planner',
        name: 'Planner v2',
        kind: 'openai',
        model: 'gpt-6-sol',
        reasoningEffort: 'medium',
      }],
      bindings: { 'hacka.planner': 'planner' },
    });

    expect(updated.backends[0].kind).toBe('openai');
    if (updated.backends[0].kind === 'openai') expect(updated.backends[0].apiKey).toBe('secret');

    expect(() => normalizeSettingsUpdate(updated, {
      bindings: { 'hacka.review': 'missing' },
    })).toThrow(/configured backend/);
  });
});
