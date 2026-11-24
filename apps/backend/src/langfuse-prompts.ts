import { z } from 'zod';

const TextVersion = z.object({
  name: z.string(), type: z.literal('text'), prompt: z.string().max(4000),
  version: z.number().int().positive().safe()
});
export type LangfuseTextVersion = z.infer<typeof TextVersion>;

type LangfuseOptions = { base: string; publicKey: string; secretKey: string; demo?: boolean; request?: typeof fetch };

export function createLangfuseConnection(options: LangfuseOptions) {
  const base = new URL(options.base);
  const local = base.protocol === 'http:' && (
    (base.hostname === 'langfuse-web' && base.port === '3000') ||
    (options.demo && ['127.0.0.1', 'localhost'].includes(base.hostname))
  );
  if ((!local && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid_langfuse_url');
  }
  const authorization = 'Basic ' + Buffer.from(options.publicKey + ':' + options.secretKey).toString('base64');
  return { base, authorization };
}

export function createLangfusePromptClient(options: LangfuseOptions) {
  const { base, authorization } = createLangfuseConnection(options);
  const request = options.request ?? fetch;
  const path = '/api/public/v2/prompts';

  async function load(url: URL, name: string, init: RequestInit = {}) {
    const response = await request(url, {
      ...init, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(3500)
    });
    if (response.status === 404 && !init.method) return null;
    if (!response.ok) throw new Error('langfuse_request_failed');
    const item = TextVersion.parse(await response.json());
    if (item.name !== name) throw new Error('langfuse_response_mismatch');
    return item;
  }

  return {
    async get(name: string, selector: { version: number } | { label: 'bootstrap' }) {
      const url = new URL(path + '/' + encodeURIComponent(name), base);
      if ('version' in selector) url.searchParams.set('version', String(selector.version));
      else url.searchParams.set('label', selector.label);
      const item = await load(url, name);
      if (item && 'version' in selector && item.version !== selector.version) throw new Error('langfuse_response_mismatch');
      return item;
    },
    async create(name: string, prompt: string, label?: 'bootstrap') {
      const item = await load(new URL(path, base), name, {
        method: 'POST', body: JSON.stringify({ name, type: 'text', prompt, labels: label ? [label] : [] })
      });
      if (!item || item.prompt !== prompt) throw new Error('langfuse_response_mismatch');
      return item;
    }
  };
}

export function langfusePromptClient() {
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_BASE_URL: base } = process.env;
  if (!publicKey && !secretKey) return null;
  if (!publicKey || !secretKey || !base) throw new Error('langfuse_not_configured');
  return createLangfusePromptClient({ publicKey, secretKey, base, demo: process.env.DEMO_MODE === 'true' });
}
