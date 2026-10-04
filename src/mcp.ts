import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

export function createGitAppMcpHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'gitapp', version: '0.1.0' });

    server.registerTool(
      'health',
      { description: 'Check whether the GitApp MCP endpoint is alive.' },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', service: 'gitapp' }) }],
      }),
    );

    server.registerTool(
      'about',
      { description: 'Describe GitApp and the common capabilities it owns.' },
      async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: 'GitApp',
            owns: [
              'github-identity',
              'github-app-installations',
              'repository-discovery',
              'llm-backend-preferences',
              'feature-backend-bindings',
            ],
            consumers: ['VibeGuard', 'HackaTeam'],
          }),
        }],
      }),
    );

    return server;
  }, { responseMode: 'json' });
}
