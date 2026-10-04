import { describe, expect, it } from 'vitest';
import { InvocationBroker, parseInvocationRequest } from '../src/invoke';
import { PlatformStore } from '../src/store';

const request = {
  instructions: 'Return a tiny structured result.',
  input: { repository: 'example/repo' },
  output: {
    name: 'tiny_result',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function configuredStore(kind: 'openai' | 'gemini') {
  const store = new PlatformStore(':memory:', 'test-key');
  const user = store.upsertUser({ githubId: '123', login: 'alice', name: null, avatar: null });

  const backend = kind === 'openai'
    ? {
        id: 'primary',
        name: 'Primary',
        kind: 'openai' as const,
        apiKey: 'openai-secret',
        model: 'gpt-6-sol',
        reasoningEffort: 'high' as const,
      }
    : {
        id: 'primary',
        name: 'Primary',
        kind: 'gemini' as const,
        apiKey: 'gemini-secret',
        model: 'gemini-3.8-flash',
        thinkingLevel: 'medium' as const,
      };

  store.saveUserSettings(user.id, {
    backends: [backend],
    bindings: {
      'hacka.planner': 'primary',
      'vibeguard.capability-inference': 'primary',
    },
  });
  return store;
}

describe('InvocationBroker', () => {
  it('invokes a bound OpenAI backend without exposing the credential in the result', async () => {
    const store = configuredStore('openai');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        status: 'completed',
        model: 'gpt-6-sol',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ items: ['a'] }) }],
        }],
        usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const result = await new InvocationBroker(store, http).invoke('123', 'hacka.planner', request);
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.value).toEqual({ items: ['a'] });
      expect(result.metadata).toEqual(expect.objectContaining({
        backendId: 'primary',
        provider: 'openai',
        model: 'gpt-6-sol',
        inputTokens: 11,
        outputTokens: 3,
        totalTokens: 14,
      }));

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
      expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer openai-secret');
      expect(JSON.stringify(result)).not.toContain('openai-secret');

      const body = JSON.parse(String(calls[0].init?.body));
      expect(body.metadata.gitapp_feature).toBe('hacka.planner');
      expect(body.text.format.name).toBe('tiny_result');
    } finally {
      store.close();
    }
  });

  it('uses the same request contract with Gemini', async () => {
    const store = configuredStore('gemini');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const http = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        status: 'completed',
        model: 'gemini-3.8-flash',
        steps: [{
          type: 'model_output',
          content: [{ type: 'text', text: JSON.stringify({ items: ['vibeguard'] }) }],
        }],
        usage: { total_input_tokens: 7, total_output_tokens: 2, total_tokens: 9 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const result = await new InvocationBroker(store, http).invoke(
        '123',
        'vibeguard.capability-inference',
        request,
      );
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.value).toEqual({ items: ['vibeguard'] });
      expect(result.metadata.provider).toBe('gemini');
      expect(new Headers(calls[0].init?.headers).get('x-goog-api-key')).toBe('gemini-secret');
      expect(JSON.stringify(result)).not.toContain('gemini-secret');
    } finally {
      store.close();
    }
  });

  it('fails closed when output violates the declared schema', async () => {
    const store = configuredStore('openai');
    const http = (async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ wrong: true }) }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    try {
      const result = await new InvocationBroker(store, http).invoke('123', 'hacka.planner', request);
      expect(result.status).toBe('incomplete');
      if (result.status === 'incomplete') expect(result.reason).toMatch(/schema_validation_failed/);
    } finally {
      store.close();
    }
  });

  it('returns an explicit unavailable result for an unbound feature', async () => {
    const store = configuredStore('openai');
    try {
      const result = await new InvocationBroker(store).invoke('123', 'hacka.unknown', request);
      expect(result).toEqual({ status: 'unavailable', reason: 'feature_unbound' });
    } finally {
      store.close();
    }
  });

  it('validates the ingress contract before provider invocation', () => {
    expect(parseInvocationRequest(request)).toEqual(request);
    expect(() => parseInvocationRequest({ instructions: '', output: {} })).toThrow();
    expect(() => parseInvocationRequest({
      ...request,
      output: { name: 'bad name', schema: {} },
    })).toThrow(/output name/);
  });
});
