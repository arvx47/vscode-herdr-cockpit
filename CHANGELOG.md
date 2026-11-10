# Changelog

Herdr Cockpit (the editor extension) and its Herdr plugin (`plugin/`) are released together from this repository.
Versions up to 0.1.2 were published as **Herdr Hub** (`sriharirao.herdr-hub`).

## Unreleased

- **Tabs come back with the window**: close a window (or quit the editor) and open it again, and it reopens the Herdr tabs it had, in the same order, for the panes that still exist in Herdr. Turn it off with `herdr.restoreTabs`.

## 0.2.6 (2026-10-19)

- **A tab whose pane is taken over stays live.** Herdr lets one client control a pane. When another one takes it (a Cockpit window in another editor, `herdr attach`), the tab used to end with "the stream ended (terminal attach taken over)". Now it keeps showing the pane, read-only, with a note on its bottom row saying who has it ("Kiro is using this pane · type here to take it back"). The first key you press takes control back, without sending that key. Selecting and copying still work.
- A notification says which panes another client took, with **Take Back** (`herdr.notifyOnTakeover`). Cockpit windows record the panes they take in `~/.herdr-cockpit/claims`, since Herdr doesn't say who has a pane; other clients show as "another Herdr client".
- Cockpit windows in several editors can follow Herdr together: following a space switch, a pane another window already has stays with it and shows read-only, instead of the windows taking panes from each other.

- **Delete selected text.** Select part of the line you're typing in a terminal tab (a shell command, or the input of Claude Code or Codex) and press Backspace or Delete to erase it. One line at a time.
- **Selecting scrolls.** Drag past the top or bottom of a terminal tab and it scrolls the pane's scrollback, selecting as it goes (faster the longer you hold), for as long as you hold it there. It also works in full-screen programs that scroll themselves (less, an agent's transcript). The copied text includes the rows that scrolled away.

- **Find in the whole history** (⌘F / Ctrl+F in a Herdr tab). Searches everything Herdr keeps for the pane, not just the screen: a bar with the count, every match highlighted, Enter / ↑ for older and ↓ for newer (⌘G / ⇧⌘G, F3 / Shift+F3), each one scrolled to the middle. Tab lists every matching line to filter and jump. Smart case, `/regex/`.
- **Typing replaces a selection** on the line you're typing; **Option+click** moves the cursor there; **Shift+click** extends a selection.
- **Scroll the history from the keyboard**: Shift+PageUp / PageDown, ⌘Home / ⌘End (Ctrl+Home / End).
- **Open Terminal Output in Editor**: the pane's whole history as a document (right-click in the tab, or the Command Palette).
- **⌘+click a file path** printed in a pane (`src/app.ts:42`) to open it at that line, beside the tab; paths resolve from the pane's folder.

- **Busy and recent spaces first.** The sidebar puts spaces with an agent working or waiting on you at the top, then the most recently active ones (an agent changed state, or you switched to the space). Remembered across reloads; `herdr.spaceOrder` = `herdr` keeps Herdr's order.
- The bottom of the sidebar shows the versions: **Herdr Cockpit v0.2.6 · Herdr 0.9.3**.

## 0.2.1 (2026-10-08)

- README and store page: images of moving from Herdr's terminal to the same space in VS Code with the plugin, the Cockpit window, and the sidebar (from a demo session; `docs/screenshots/render.sh` rebuilds them).
- Release workflow: Open VSX Trusted Publishing when the repository variable `OVSX_TRUSTED_PUBLISHING` is `true` (see RELEASING.md).

## 0.2.0 (2026-10-08)

- **Renamed to Herdr Cockpit.** Another Herdr plugin is already called "Herdr Hub", so the extension is now **Herdr Cockpit** (`sriharirao.herdr-cockpit`, a new Marketplace listing: uninstall Herdr Hub and install Herdr Cockpit) and the Herdr plugin is **Herdr Cockpit for VS Code** (`sriharirao.vscode-herdr-cockpit`; install with `herdr plugin install sriharirao92/vscode-herdr-cockpit/plugin`). The repository is `sriharirao92/vscode-herdr-cockpit`. The "hub window" is now the **Cockpit window**.
- Settings (`herdr.*`) carry over. Files move to `~/.herdr-cockpit`; a Cockpit window set up before the rename (`~/.herdr-hub`) is still recognized, and the Claude plan-limits status line set up before it keeps working.
- README, store and plugin descriptions lead with what it's for: one VS Code window instead of several Herdr plugins and windows, every VS Code extension next to your agents, and agent usage across Claude Code, Codex and Kiro.
- Release workflow: publishes to the Marketplace with Microsoft Entra ID (personal access tokens stop working on 2026-12-01; see RELEASING.md), re-runs are safe, and actions are pinned and kept current by Dependabot.

## 0.1.2 (2026-10-06)

- A window opened without a folder (a new window, or the editor's first launch) offers **Open Herdr Hub**, which turns it into the hub window (`herdr.offerHubOnStartup`: `emptyWindows`, `allWindows`, `never`). It stays quiet when Herdr isn't installed or a hub window is already open.
- Opening a space closes the editor's Welcome page, and the hub window opens without one (`workbench.startupEditor` = `none` for the hub workspace, unless you set it).
- Help page: a Getting started section, and coverage of Split Terminal, tab renames, closing tabs in Herdr and copy feedback.

## 0.1.0 (2026-10-06)

First public release. Tested with Herdr 0.9.3 on macOS: in VS Code by hand and with an automated real-editor test, in Positron by hand, and started in Cursor. Kiro installs it but hasn't been tried by hand yet. Unit tests run on macOS and Linux.

### Extension
- **Links from Herdr**: `<editor>://sriharirao.herdr-hub/open|review|file`, used by the Herdr plugin. Links act in the hub window; a link that reaches another window is handed over to it (and the hub window is created or focused).
- **Get started walkthrough**: connect to Herdr, open the hub window, find the sidebar, install the Herdr plugin, plan limits, the guide.
- **Install the Herdr Plugin** command.
- **Agents left, shells right**: `herdr.terminalLocation` = `editorSplit`.
- Terminal tabs show just their name in any saved or untitled workspace you've switched spaces from, not only the hub window.
- **Terminal tabs work like the Herdr TUI**: Herdr Hub draws each tab from Herdr's live stream of the pane (instead of running `herdr attach` in it). Drag, double-click or triple-click selects and copies, with a "Copied to clipboard" note; the wheel scrolls Herdr's scrollback; a click goes to the program in the pane (Herdr 0.9.2+). The terminal "+" opens the same kind of tab.
- **Tabs and Herdr stay in sync**: closing a tab with its X closes the pane in Herdr (`herdr.closeTabInHerdr`: idle shells at once; agents, busy shells and a space's last tab ask first). Switching spaces and closing the window only detach. Verified in a real VS Code by `npm run test:vscode`.
- **Split Terminal** on a Herdr tab splits that pane in Herdr (same Herdr tab); **renaming** a tab renames the pane (or agent) in Herdr, and Herdr renames update the tab without taking focus.
- Herdr tabs stay in one editor group (the one already showing them, else the last one used) instead of following the active group.
- Tested with Herdr 0.9.3 (protocol 22, unchanged from 0.9.1).
- Clicking a space outside the hub window asks first: **Open Hub Window** (the space and pane open there) or **Use This Window** (remembered per window). A window with no folder goes straight to the hub window.
- **Linux**: Herdr, git and Codex are found in Linux install locations (`~/.local/bin`, Linuxbrew, `/usr/bin`, Nix, Snap); help shows Ctrl+Shift+P on Linux.
- **Remote**: the extension runs where your workspace is (`extensionKind: workspace`), so with Remote-SSH it runs on the server next to Herdr.
- Publisher is now `sriharirao` (extension id `sriharirao.herdr-hub`). Uninstall the earlier `srihari-local.herdr-hub` build.

### Plugin (new)
- **Open in editor**, **Open selected file in editor** (`path:line:col`, `path(line,col)`, `path#L42`, Python tracebacks), **Review changes in editor**, **Status** and **Set up editor** actions.
- Setup finds VS Code, Cursor, Kiro and Positron (and VS Code Insiders, VSCodium, Windsurf), installs the extension, and can add Herdr keybindings.
- Optional: open an agent's changes when it finishes (`review_on_done`).

## 0.0.26
- Herdr not installed, not running, crashed or incompatible: each has its own screen; **Start Herdr** runs the server in the background; reconnects with backoff and offers to reopen the space's tabs when Herdr is back. Setting `herdr.startServer`.
- Started servers get a terminal-like environment, so Kiro's shell integration no longer hides agents.
- Live updates: agent status changes now arrive as events (they silently fell back to polling before).
- The hub window opens the sidebar the first time (Cursor hides extension icons behind an overflow menu).

## 0.0.20
- Git safety fails closed: no lazy fetches, no hooks, every repository-defined filter disabled; git runs only in trusted windows.

## 0.0.19
- Repository-defined programs (clean filters, gpg) can't run from the sidebar's git calls.
- Help page: header, privacy and troubleshooting sections.

## 0.0.18
- Renamed from Herdr Bridge to Herdr Hub. Tidier header. `herdr.binaryPath` and `herdr.socketPath` are machine-scoped.

## 0.0.2 – 0.0.17
- Sidebar of spaces, agents and shells with live status, shell activity, agent logos, usage (Claude Code, Codex, Kiro), create/rename/close spaces and tabs, the terminal **+** creating Herdr tabs, follow mode, the hub window and a help page.
