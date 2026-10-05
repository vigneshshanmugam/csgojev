import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import type { JevRequest } from '@xstate/jev';

/** POST /api/jev: forwards {state, questions} to TypeSafe System One. Key stays server-side. Mock if no key. */
export function jevApi(): Plugin {
  return {
    name: 'jev-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '');
      const key = env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY;
      let client: import('@typesafe-ai/sdk').TypeSafeClient | null = null;
      server.middlewares.use('/api/jev', async (req, res) => {
        const send = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET') return send(200, { live: Boolean(key) });
        try {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const request = JSON.parse(raw) as JevRequest;
          if (!key) {
            const { mockAnswers } = (await server.ssrLoadModule('@xstate/jev')) as typeof import('@xstate/jev');
            return send(200, mockAnswers(request));
          }
          const { TypeSafeClient } = await import('@typesafe-ai/sdk');
          client ??= new TypeSafeClient({ apiKey: key, timeout: 30_000 });
          const result = await client.systemOne({ state: request.state as never, questions: request.questions as never });
          send(200, { answers: result.answers });
        } catch (e) {
          send(500, { error: String(e) });
        }
      });
    },
  };
}
