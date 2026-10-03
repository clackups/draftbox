// Node.js entry point. The application itself (createApp) only uses web
// standard Request/Response objects, so other runtimes need only their
// own server adapter and a GitBackend implementation that loads there.

import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { Context } from './services/context.ts';
import { NodegitBackend } from './git/nodegit.ts';
import { createApp, createServices } from './http/app.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await Context.create(config, new NodegitBackend());
  const app = createApp(createServices(ctx));

  if (config.oauth.dev?.enabled) {
    console.warn('WARNING: development login is enabled; anyone can sign in as any email address.');
  }
  if (config.mail.transport === 'log') {
    console.warn('WARNING: no mail transport configured; emails are written to the log instead of being sent.');
  }
  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`Draftbox listening on http://${info.address}:${info.port} (public URL ${config.baseUrl})`);
    console.log(`Data directory: ${ctx.dataDir}; git backend: ${ctx.git.name}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
