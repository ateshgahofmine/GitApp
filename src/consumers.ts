export type ConsumerCallbacks = Record<string, string>;

export function parseConsumerCallbacks(raw: string | undefined): ConsumerCallbacks {
  if (!raw?.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('GITAPP_CONSUMERS_JSON must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GITAPP_CONSUMERS_JSON must be an object');
  }

  const result: ConsumerCallbacks = {};
  for (const [consumerId, callbackValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(consumerId)) {
      throw new Error(`Invalid GitApp consumer id "${consumerId}"`);
    }
    if (typeof callbackValue !== 'string') {
      throw new Error(`GitApp consumer "${consumerId}" callback must be a URL`);
    }
    let callback: URL;
    try {
      callback = new URL(callbackValue);
    } catch {
      throw new Error(`GitApp consumer "${consumerId}" callback must be a valid URL`);
    }
    if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password || callback.hash) {
      throw new Error(`GitApp consumer "${consumerId}" callback must be a plain http(s) URL`);
    }
    result[consumerId] = callback.toString();
  }
  return result;
}
