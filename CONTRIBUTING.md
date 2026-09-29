# Contributing

Sparkore KB Reader is currently an internal Sparkore project.

## Development

1. Use Node.js 22 or newer.
2. Run `npm install`.
3. Run `npm run typecheck`.
4. Run `npm run build`.
5. Test both desktop and mobile behavior before release.

## Design constraints

- Mobile support is mandatory.
- Do not use Node.js, Electron, shell commands, or a Git executable in runtime code.
- GitHub access is read-only.
- Reader-managed vault folders are caches, not canonical sources.
- Never store GitHub tokens in plugin `data.json`.
- Keep repository, branch, KB root, and local folder configurable per project.
