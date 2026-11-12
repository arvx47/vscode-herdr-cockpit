# README images

The images in `docs/images` are rendered from a throwaway Herdr session. Herdr's screen, the terminal tab and the
sidebar are real: the Herdr TUI is captured from a pty, the tab is a frame from Herdr's terminal stream, and the
sidebar is `media/sidebar.js` (the React sidebar, built from `webview/sidebar`) drawing the view state that `buildViewState` builds from the session. The repos, the
agents' screens (shell panes printing canned text, marked as agents with `pane.report_agent`) and the usage
numbers are made up. The VS Code window around them is drawn in HTML (`vscode.html`, `chrome.css`).

```bash
docs/screenshots/render.sh
```

This needs Herdr, Python 3 and Chrome or Chromium (set `CHROME` if it isn't found). It compiles the extension, starts
the demo session (`demo-session.js`: session `hb-demo` in a temporary folder, never your own session), captures it
(`tuicap.py`, `make-state.js` → `build/`), renders the pages with headless Chrome and then stops the session and
deletes the folder. Paths in the images read `~/code/<repo>`.

| Page | Image |
|---|---|
| `vscode.html` | `vscode.png`: a space in VS Code with the sidebar |
| `flow.html` | `terminal-to-vscode.png`: Herdr's terminal, the plugin key, the same space in VS Code |
| `sidebar-feature.html` | `sidebar.png`: the sidebar with what each part is for |

To work on a page, run the first steps of `render.sh` by hand (`node demo-session.js`, `python3 tuicap.py
build/tui.raw`, `node make-state.js`), stop the session (`node demo-session.js stop`) and open the page in a browser:
it only reads `build/`.
