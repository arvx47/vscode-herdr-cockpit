# Herdr Cockpit

Run your [Herdr](https://herdr.dev) agents and do everything around them in **one VS Code window**.

Herdr keeps your coding agents (Claude Code, Codex, Kiro, Cursor Agent, Copilot, Gemini and more) running in its terminal multiplexer. Herdr Cockpit brings its spaces, agents and shells into VS Code, so the editor around them is the real one.

![Herdr Cockpit: a Herdr space in VS Code, with its agents as terminal tabs, the files they changed, and the Herdr Cockpit sidebar on the right](docs/images/vscode.png)

## Why Herdr Cockpit

- **One window instead of a stack of plugins and windows.** No need to add separate Herdr plugins for a file explorer, a web UI or a git reviewer, or to juggle a terminal and several VS Code windows. Switch a space and its folder, files, Source Control, diffs and every agent and shell (as terminal tabs) are right there.
- **Everything VS Code can do, next to your agents.** Your extensions, language servers, debuggers, notebooks, Markdown preview, image and PDF viewers, and side-by-side diffs work on the files your agents are changing.
- **Agent usage in one place.** Plan limits for Claude Code, Codex and Kiro side by side: 5-hour and weekly windows with reset times, tokens in the current session, and Kiro credits.
- **Terminal tabs that behave like Herdr.** Drag to select and copy, scroll Herdr's scrollback, and keep tabs and Herdr in sync: **+** and **Split** create panes, renames go both ways, and closing a tab closes it in Herdr (it asks first for agents), and **Reopen Closed Tab** brings it back (bind it to ⇧⌘T; it still reopens files). **Find (⌘F) searches the pane's whole history** with every match highlighted and a list to jump through; drag past the edge to keep selecting, Backspace or typing replaces a selection on the line you're typing, Option+click moves the cursor, ⌘+click opens `file:line`, and Shift+PageUp / ⌘Home / ⌘End scroll the history. Cockpit windows in several editors can share a session: a pane another window or `herdr attach` is using stays visible read-only, says who has it, and typing takes it back.

**From Herdr's terminal to VS Code in one keystroke.** The companion [Herdr plugin](#the-herdr-plugin) opens the space you're on, with its folder and every agent and shell as a tab:

![The same Herdr space, in Herdr's terminal and in VS Code. The Herdr Cockpit plugin's Open in editor key (ctrl+b, then shift+E) takes you from one to the other](docs/images/terminal-to-vscode.png)

**The sidebar** shows what every agent is doing, what each agent's plan has left, who is waiting for you, and each space's git state:

![The Herdr Cockpit sidebar: agent counters, usage for Claude Code, Codex and Kiro, a Needs you list with the end of each agent's screen, and spaces with their branch and changes](docs/images/sidebar.png)

<sub>Images from a demo session (`docs/screenshots`): real Herdr and the real sidebar, with made-up repos, agent screens and usage numbers.</sub>

Works in **VS Code, Cursor, Kiro and Positron** on **macOS and Linux**. A community project, not affiliated with Herdr.

## Features

- **Spaces & Agents sidebar**, live from Herdr: each space is a card with its branch and changes, with this window's spaces on top and the rest under a folded **Other spaces**; agents show a colored status (working, blocked, done, idle), time in state and a one-line summary of what they last said. **Needs you** lists this window's blocked and done agents with a preview of their screen (turn it on with `herdr.showNeedsYou`; off, the default, they're highlighted in their space). **Shells** show what is running, or the last command and its output.
- **Open panes and spaces**: click an agent or shell to open it as a tab, or right-click a space and pick **Switch to Space** to open it with its folder (Explorer, Search and Source Control follow) and its agents and shells as tabs, most urgent first. By default each space gets a window of its own: a space another window has opens there, and for a new one you pick its own window or this workspace (right-click a space or pane for either). `herdr.windowMode` = `workspace` keeps all spaces as folders of one window. Put agents and shells side by side with `herdr.terminalLocation` = `editorSplit`.
- **Create from the editor**: new spaces (a folder or a new git worktree), new tabs with a shell or an agent (bind `herdr.newTab` to a key); the terminal **+** creates Herdr tabs in the Cockpit window. Rename and close in Herdr.
- **Usage**: Claude Code, Codex and Kiro plan limits (5-hour and weekly windows, reset times, Kiro credits) while their agents run.
- **Talk to agents from the editor**: **Prompt Agent…** (right-click an agent) sends it a prompt; **Send to Agent…** (right-click in a file or the Explorer) sends a prompt about the file or the selected lines (`src/app.ts:12-30`). **Go to Agent or Shell…** jumps to any pane, and **Jump to Agent Needing Attention** (the status bar) goes through blocked and done agents one after the other.
- **Review changes**: an agent's diffs, offered when it finishes. In a git worktree space, the whole branch since it left the main branch.
- **Follow mode** (`herdr.followMode`, off by default): switch spaces in Herdr's terminal and the Cockpit window follows.
- **When Herdr isn't running**: says why (not installed, not running, crashed, incompatible), starts it in the background on request, and reconnects when it's back.

## Requirements

- Herdr 0.9 (socket protocol 22; tested with 0.9.1), running on the same machine as the extension. A newer protocol shows an "incompatible" screen until Herdr Cockpit is updated. With Remote-SSH, the extension runs on the server next to Herdr.
- macOS or Linux.

## Get started

1. Install **Herdr Cockpit** from the Extensions view (VS Code Marketplace; Open VSX for Cursor, Kiro and Positron), or download the `.vsix` from [Releases](https://github.com/sriharirao92/vscode-herdr-cockpit/releases) and run `code --install-extension herdr-cockpit.vsix` (or `cursor`, `kiro`, `positron`).
2. Run Herdr as usual, or click **Start Herdr** in the sidebar.
3. Run **Herdr Cockpit: Set Up Cockpit Window**. The Cockpit window's first folder (`~/.herdr-cockpit`) never changes, so switching spaces never restarts your extensions.
4. Click an agent or shell in a space (or right-click the space and pick **Switch to Space** to open all of its panes).

The **Get started with Herdr Cockpit** walkthrough covers the same steps (Command Palette: **Welcome: Open Walkthrough…**).

**Can't see the sidebar?** In Cursor the activity bar is a row of icons across the top of the sidebar, and Herdr Cockpit may be behind the **⌄** arrow at its end. The Command Palette always works: **Herdr Cockpit: Focus on Spaces & Agents View**.

## The Herdr plugin

Working in Herdr's terminal? The companion plugin jumps from Herdr to the editor:

```bash
herdr plugin install sriharirao92/vscode-herdr-cockpit/plugin
```

- **Open in editor**: the space and pane you're on, in the Cockpit window.
- **Open selected file in editor**: select `src/app.ts:42:7` (or `app.py", line 12`, `file.ts(42,7)`, `file.ts#L42`) in any pane.
- **Review changes in editor**, **Status**, and **Set up editor** (finds your editors, installs the extension, offers keybindings).

See [plugin/README.md](plugin/README.md).

## Settings

All settings start with `herdr.`; the guide (`?` in the sidebar) lists them. Most used:

| Setting | |
|---|---|
| `herdr.terminalLocation` | `editor`, `editorSplit` (agents left, shells right) or `panel` |
| `herdr.autoAttach` | Which panes open as tabs when switching spaces: `all`, `agents` or `none` |
| `herdr.closeTabInHerdr` | Closing a tab's X closes it in Herdr: `never` (default: only detaches), `ask` (idle shells close at once; agents and busy shells ask), `always` |
| `herdr.offerHubOnStartup` | Offer to open Herdr Cockpit when a window opens: `emptyWindows` (default), `allWindows`, `never` |
| `herdr.startServer` | Start Herdr when the Cockpit window opens: `ask`, `always`, `never` |
| `herdr.binaryPath`, `herdr.socketPath` | A herdr binary or socket (named session) Herdr Cockpit doesn't find itself |

## Privacy and security

Nothing leaves your machine. Herdr Cockpit talks to your local Herdr server, runs read-only git in trusted windows, and reads usage from your agents' local files (never credentials). See [SECURITY.md](SECURITY.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` needs no editor.

## License

[MIT](LICENSE). Agent logos: see [media/THIRD_PARTY_NOTICES.md](media/THIRD_PARTY_NOTICES.md).
