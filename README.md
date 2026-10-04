# GitApp

Shared GitHub-native application shell for projects that need:

- GitHub OAuth identity;
- GitHub App installation and repository access;
- persisted user settings;
- encrypted LLM backend credentials;
- feature-to-backend bindings;
- HTTP and MCP access;
- a small configuration UI.

Initial consumers: VibeGuard and HackaTeam.

The first implementation intentionally extracts proven behavior from VibeGuard before attempting a reusable package abstraction.
