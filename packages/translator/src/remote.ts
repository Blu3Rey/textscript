// A translator that runs on apps/server, for the browser: the API key stays
// on the server (ROADMAP.md S7).

import type { Translation, TranslationContext, Translator } from './translator';
import { parseTranslation } from './wire';

export class RemoteTranslatorError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RemoteTranslatorError';
    this.status = status;
  }
}

export interface RemoteTranslatorOptions {
  /** The server's translate endpoint, such as `/api/translate`. */
  url: string;
  /** Defaults to the global `fetch`. */
  fetch?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export function createRemoteTranslator(options: RemoteTranslatorOptions): Translator {
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    name: 'remote',
    async translate(context: TranslationContext): Promise<Translation> {
      const response = await send(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(context),
      });
      const body = await response.json();
      if (!response.ok) {
        const message =
          typeof body === 'object' &&
          body !== null &&
          'error' in body &&
          typeof body.error === 'string'
            ? body.error
            : `The server answered ${String(response.status)}`;
        throw new RemoteTranslatorError(response.status, message);
      }
      const parsed = parseTranslation(body);
      if (!parsed.ok)
        throw new RemoteTranslatorError(502, `Bad translation: ${parsed.issues.join('; ')}`);
      return parsed.value;
    },
  };
}
