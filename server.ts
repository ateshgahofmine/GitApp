import { loadEnvFile } from 'node:process';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createApiApp } from './src/app';
import { GitHubGateway } from './src/github';
import { createGitAppMcpHandler } from './src/mcp';
import { PlatformStore } from './src/store';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

async function start() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';
  const appUrl = process.env.APP_URL ?? ('http://localhost:' + port);
  const production = process.env.NODE_ENV === 'production';

  const store = new PlatformStore(
    process.env.DATABASE_PATH?.trim() || '.data/gitapp.sqlite',
    process.env.GITAPP_CREDENTIALS_KEY ?? '',
  );

  const github = new GitHubGateway({
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
    appId: process.env.GITHUB_APP_ID ?? '',
    appSlug: process.env.GITHUB_APP_SLUG ?? '',
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? '').replaceAll('\\n', '\n'),
    appUrl,
  });

  const app = createApiApp({ store, github, appUrl, production });

  const mcp = createGitAppMcpHandler();
  const mcpNode = toNodeHandler(mcp);
  app.all('/mcp', (request, response) => void mcpNode(request, response, request.body));

  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  if (!production) {
    vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_request, response) => response.sendFile(path.join(distPath, 'index.html')));
  }

  const server = app.listen(port, host, () => {
    console.log('GitApp listening on ' + appUrl);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await mcp.close();
    await vite?.close();
    store.close();
    server.close();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void start().catch((error) => {
  console.error('GitApp startup failed', error);
  process.exitCode = 1;
});
