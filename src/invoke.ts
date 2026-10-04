import Ajv from 'ajv';
import type { LlmBackend } from './settings';
import type { PlatformStore } from './store';

export type StructuredInvocationRequest = {
  instructions: string;
  input: unknown;
  output: {
    name: string;
    schema: Record<string, unknown>;
  };
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type InvocationMetadata = {
  backendId: string;
  provider: LlmBackend['kind'];
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type StructuredInvocationResult =
  | { status: 'complete'; value: unknown; metadata: InvocationMetadata }
  | { status: 'incomplete'; reason: string; metadata?: InvocationMetadata }
  | { status: 'unavailable'; reason: string; metadata?: InvocationMetadata };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseInvocationRequest(value: unknown): StructuredInvocationRequest {
  const root = object(value, 'Invocation request');
  if (typeof root.instructions !== 'string' || !root.instructions.trim()) {
    throw new Error('Invocation instructions are required');
  }
  if (root.instructions.length > 50_000) throw new Error('Invocation instructions are too long');

  const output = object(root.output, 'Invocation output');
  if (typeof output.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(output.name)) {
    throw new Error('Invocation output name is invalid');
  }
  const schema = object(output.schema, 'Invocation output schema');

  const maxOutputTokens = root.maxOutputTokens === undefined ? undefined : Number(root.maxOutputTokens);
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 100_000)) {
    throw new Error('maxOutputTokens must be an integer between 1 and 100000');
  }

  const timeoutMs = root.timeoutMs === undefined ? undefined : Number(root.timeoutMs);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)) {
    throw new Error('timeoutMs must be an integer between 1000 and 300000');
  }

  return {
    instructions: root.instructions.trim(),
    input: root.input,
    output: { name: output.name, schema },
    maxOutputTokens,
    timeoutMs,
  };
}

type OpenAIResponse = {
  status?: string;
  model?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

type GeminiInteraction = {
  status?: string;
  model?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_tokens?: number;
  };
};

function asInputText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseOutput(text: string | undefined, request: StructuredInvocationRequest): { value?: unknown; reason?: string } {
  if (!text) return { reason: 'missing_structured_output' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: 'invalid_json_output' };
  }

  const ajv = new Ajv({ strict: false, allErrors: true });
  let validate;
  try {
    validate = ajv.compile(request.output.schema);
  } catch (error) {
    return { reason: error instanceof Error ? `invalid_output_schema: ${error.message}` : 'invalid_output_schema' };
  }
  if (!validate(value)) {
    const detail = ajv.errorsText(validate.errors, { separator: '; ' }).slice(0, 500);
    return { reason: `schema_validation_failed: ${detail}` };
  }
  return { value };
}

function providerReason(provider: string, status: number): string {
  if (status === 401 || status === 403) return `${provider}_auth_or_model_access`;
  if (status === 429) return `${provider}_quota_or_rate_limit`;
  if (status >= 500) return `${provider}_transient_failure`;
  return `${provider}_http_${status}`;
}

function openAIText(response: OpenAIResponse): string | undefined {
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text;
      if (content.type === 'refusal') return undefined;
    }
  }
  return undefined;
}

function geminiText(response: GeminiInteraction): string | undefined {
  for (const step of response.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const content of step.content ?? []) {
      if (content.type === 'text' && typeof content.text === 'string') return content.text;
    }
  }
  return undefined;
}

function timeoutSignal(milliseconds: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function invokeOpenAI(
  backend: Extract<LlmBackend, { kind: 'openai' }>,
  feature: string,
  request: StructuredInvocationRequest,
  http: typeof fetch,
): Promise<StructuredInvocationResult> {
  if (!backend.apiKey.trim()) return { status: 'unavailable', reason: 'missing_openai_api_key' };
  const started = Date.now();
  const timeout = timeoutSignal(request.timeoutMs ?? 45_000);
  try {
    const response = await http('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: backend.model,
        reasoning: { effort: backend.reasoningEffort },
        input: [
          { role: 'system', content: request.instructions },
          { role: 'user', content: asInputText(request.input) },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: request.output.name,
            strict: true,
            schema: request.output.schema,
          },
        },
        max_output_tokens: request.maxOutputTokens ?? 4_000,
        store: false,
        tools: [],
        metadata: { gitapp_feature: feature },
      }),
      signal: timeout.signal,
    });
    if (!response.ok) return { status: 'unavailable', reason: providerReason('openai', response.status) };

    let payload: OpenAIResponse;
    try {
      payload = await response.json() as OpenAIResponse;
    } catch {
      return { status: 'incomplete', reason: 'openai_invalid_json_response' };
    }

    const metadata: InvocationMetadata = {
      backendId: backend.id,
      provider: 'openai',
      model: payload.model ?? backend.model,
      latencyMs: Date.now() - started,
      inputTokens: payload.usage?.input_tokens,
      outputTokens: payload.usage?.output_tokens,
      totalTokens: payload.usage?.total_tokens,
    };
    if (payload.status === 'incomplete') return { status: 'incomplete', reason: 'openai_response_incomplete', metadata };
    const parsed = parseOutput(openAIText(payload), request);
    return parsed.reason
      ? { status: 'incomplete', reason: parsed.reason, metadata }
      : { status: 'complete', value: parsed.value, metadata };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error && error.name === 'AbortError' ? 'openai_timeout' : 'openai_network_failure',
    };
  } finally {
    timeout.clear();
  }
}

async function invokeGemini(
  backend: Extract<LlmBackend, { kind: 'gemini' }>,
  feature: string,
  request: StructuredInvocationRequest,
  http: typeof fetch,
): Promise<StructuredInvocationResult> {
  if (!backend.apiKey.trim()) return { status: 'unavailable', reason: 'missing_gemini_api_key' };
  const started = Date.now();
  const timeout = timeoutSignal(request.timeoutMs ?? 45_000);
  try {
    const response = await http('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'x-goog-api-key': backend.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: backend.model,
        store: false,
        system_instruction: request.instructions,
        input: asInputText(request.input),
        generation_config: {
          thinking_level: backend.thinkingLevel,
          max_output_tokens: request.maxOutputTokens ?? 4_000,
        },
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: request.output.schema,
        },
        metadata: { gitapp_feature: feature },
      }),
      signal: timeout.signal,
    });
    if (!response.ok) return { status: 'unavailable', reason: providerReason('gemini', response.status) };

    let payload: GeminiInteraction;
    try {
      payload = await response.json() as GeminiInteraction;
    } catch {
      return { status: 'incomplete', reason: 'gemini_invalid_json_response' };
    }

    const metadata: InvocationMetadata = {
      backendId: backend.id,
      provider: 'gemini',
      model: payload.model ?? backend.model,
      latencyMs: Date.now() - started,
      inputTokens: payload.usage?.total_input_tokens,
      outputTokens: payload.usage?.total_output_tokens,
      totalTokens: payload.usage?.total_tokens,
    };
    if (payload.status === 'incomplete') return { status: 'incomplete', reason: 'gemini_response_incomplete', metadata };
    const parsed = parseOutput(geminiText(payload), request);
    return parsed.reason
      ? { status: 'incomplete', reason: parsed.reason, metadata }
      : { status: 'complete', value: parsed.value, metadata };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error && error.name === 'AbortError' ? 'gemini_timeout' : 'gemini_network_failure',
    };
  } finally {
    timeout.clear();
  }
}

async function invokeLocalWorker(
  backend: Extract<LlmBackend, { kind: 'local-worker' }>,
  feature: string,
  request: StructuredInvocationRequest,
  http: typeof fetch,
): Promise<StructuredInvocationResult> {
  if (!backend.baseUrl.trim()) return { status: 'unavailable', reason: 'missing_local_worker_url' };
  if (!backend.token.trim()) return { status: 'unavailable', reason: 'missing_local_worker_token' };
  const started = Date.now();
  const timeout = timeoutSignal(request.timeoutMs ?? 45_000);
  try {
    const response = await http(`${backend.baseUrl}/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${backend.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ feature, request }),
      signal: timeout.signal,
    });
    if (!response.ok) return { status: 'unavailable', reason: providerReason('local_worker', response.status) };

    const payload = await response.json() as StructuredInvocationResult;
    if (!payload || !['complete','incomplete','unavailable'].includes(payload.status)) {
      return { status: 'incomplete', reason: 'local_worker_invalid_response' };
    }
    if (payload.status !== 'complete') return payload;
    const parsed = parseOutput(JSON.stringify(payload.value), request);
    const metadata: InvocationMetadata = {
      backendId: backend.id,
      provider: 'local-worker',
      model: payload.metadata?.model ?? 'local-worker',
      latencyMs: Date.now() - started,
      inputTokens: payload.metadata?.inputTokens,
      outputTokens: payload.metadata?.outputTokens,
      totalTokens: payload.metadata?.totalTokens,
    };
    return parsed.reason
      ? { status: 'incomplete', reason: parsed.reason, metadata }
      : { status: 'complete', value: parsed.value, metadata };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error && error.name === 'AbortError' ? 'local_worker_timeout' : 'local_worker_network_failure',
    };
  } finally {
    timeout.clear();
  }
}

export class InvocationBroker {
  constructor(
    private readonly store: PlatformStore,
    private readonly http: typeof fetch = fetch,
  ) {}

  async invoke(githubUserId: string, feature: string, request: StructuredInvocationRequest): Promise<StructuredInvocationResult> {
    const user = this.store.userByGithubId(githubUserId);
    if (!user) return { status: 'unavailable', reason: 'gitapp_user_not_found' };

    const settings = this.store.userSettings(user.id);
    const backendId = settings.bindings[feature];
    if (!backendId) return { status: 'unavailable', reason: 'feature_unbound' };

    const backend = settings.backends.find((candidate) => candidate.id === backendId);
    if (!backend) return { status: 'unavailable', reason: 'bound_backend_missing' };

    if (backend.kind === 'openai') return invokeOpenAI(backend, feature, request, this.http);
    if (backend.kind === 'gemini') return invokeGemini(backend, feature, request, this.http);
    return invokeLocalWorker(backend, feature, request, this.http);
  }
}
