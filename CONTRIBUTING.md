# Contributing

Issues and pull requests are welcome.

```bash
npm install
npm run compile      # TypeScript -> out/
npm test             # no editor needed: fake Herdr server, fake herdr/editor binaries, a real temporary git repo
npm run lint
npm run test:vscode  # integration test in a real VS Code against a throwaway Herdr session (needs herdr + VS Code)
npm run package      # -> herdr-cockpit-<version>.vsix
```

Press F5 in VS Code to run the extension in an Extension Development Host.

- `src/drivers/herdr/herdrTypes.ts` is generated from `herdr api schema --json` (`npm run gen:types`). Don't edit it by hand.
- Keep `herdrClient.ts`, `model.ts`, `connection.ts`, `hubFiles.ts` and the other modules without `vscode` imports testable with plain Node.
- The plugin (`plugin/herdr-cockpit.sh`) is POSIX `sh`: test it with `npm test`, which runs it under `/bin/sh` and `dash` when installed.
- To try mutating Herdr calls, use a throwaway session (`herdr --session test server`), never your real one.
- Releases: see [RELEASING.md](RELEASING.md).
- Changes should work on macOS and Linux, and in VS Code, Cursor, Kiro and Positron.
