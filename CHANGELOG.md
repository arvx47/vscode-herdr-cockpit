# Changelog

Herdr Cockpit (the editor extension) and its Herdr plugin (`plugin/`) are released together from this repository.
Versions up to 0.1.2 were published as **Herdr Hub** (`sriharirao.herdr-hub`).

## Unreleased

- **New Worktree…, for one ticket per checkout.** A repository's space card has a New worktree icon (and a right-click entry, and **Herdr Cockpit: New Worktree…** in the Command Palette). It asks one thing, the branch name: a ticket key, the ticket's link (its key is used) or any name. The branch starts from the repository's main branch, not from whatever the space has checked out, and the new space is named after it. Setting `herdr.newWorktreeStartsWith`: a shell (default), an agent, or ask.
- **Usage shows today's work** under each agent: tokens since midnight and the share read from the prompt cache, and for Claude Code its cost at API prices and the lines it added and removed. Codex also shows its credits balance when the account has credits.
- Space cards are evenly spaced: the colored status bar on a card's left edge no longer covers its content, and the name line has as much room below as above.
- **Working agents stand out**: framed in blue in their space, like done agents in green and blocked ones in orange. Hovering rows and headers also highlights them more clearly.
- **Each space card shows its folder** under its name (the full path on hover), and a worktree space says which repository it's a checkout of.
- **A redesigned sidebar, rebuilt in React.** Spaces come first, under the counters (and Needs you, when it's on), and Usage moved to the bottom. A space that isn't open in this window has an **Open** button; before, opening a whole space was only in the right-click menu. **New tab** and **New worktree** are small icons on each card's name line (they work with the card folded too), the shells toggle moved to the `⋯` menu (**Show Shell Panes**), and expanded rows no longer repeat the agent's name as a tab chip or the space's folder. The sidebar now updates only what changed, so selected text in an output box, hover and focus survive the updates every few seconds. It stays clickable while reconnecting, the connecting screen has Help and Copy diagnostics links, rows and headings work with screen readers, and a new blocked or done agent is announced to them.
- An agent whose terminal title is a shell prompt (`user@host:~/path`) no longer shows it as its task line.
- Fixes: **Start Herdr** could stay on "Starting Herdr…" for good when starting failed early, and connected twice when Herdr came up while it was starting; two editor windows could both start a Herdr server for the same session (now one starts it and the other waits); a new git worktree space failed on Herdr 0.9.5 ("only one of workspace_id or cwd may be supplied"), and the worktree picker offered spaces that are themselves worktrees (it now offers each repo's own space); one failing screen update stopped selection, find and autoscroll in a Herdr tab for good; reopened tabs with the same name could be put back in the wrong order, and putting them in order could move the wrong tab; a notification clicked minutes later acted on an agent as it was then; **Show Shell Panes** did nothing while the workspace set `herdr.showShellPanes`; Herdr installed by Homebrew in your home folder (`~/brew`, `~/homebrew`) or under `$HOMEBREW_PREFIX` wasn't found when the editor started from the Dock.
- **Settings a repository can't change**: `herdr.closeTabInHerdr`, `herdr.startServer` and `herdr.followMode` are now read from your user settings only, so a repository's `.vscode/settings.json` can't make the tab's X stop agents or start servers.
- **A window with no space says so.** A window with a folder open but no Herdr space for it used to list every space with nothing marking this window. Now the sidebar shows **This window** with a "No Herdr space for *my-repo*" card, **Create space here** (a new space in this window's folder; also **New Space in This Window's Folder…** in the Command Palette) and **Add a space…** (pick an existing space to open here), and **Other spaces** below it, unfolded. The Cockpit window and empty windows keep the plain list.
- **Safer links.** A link opened from a web page no longer opens the Cockpit window without asking when none is open; a link for another Herdr session asks in a dialog before changing `herdr.socketPath`; file links from a pane in your home folder's hidden folders (`~/.ssh`, `~/.aws`) or from your home folder itself ask before opening.
- **Ask Where to Open Spaces Again** also forgets "Use This Window" (`herdr.windowMode` = `workspace`). Turning follow mode off in a window stops it from following there, and the toggle writes where the setting is set. The settings `herdr.autoAttachOnSwitch` and `herdr.autoAttachShells`, still read until `herdr.autoAttach` is set, show again in Settings, marked as replaced.
- Fixes: in a window that was still starting, switching to a space could mount its folder but open no tabs (VS Code took more than 4s to confirm the folder); switching spaces while follow mode switched too could leave follow mode thinking no switch was running; a space or pane picked after a slow placement choice used the old snapshot; **Open in Its Own Window / Add to This Window** on a pane asked where to put it twice; a "+" tab whose pane failed to create stayed in memory; a kick or Herdr's socket appearing during a failing reconnect waited for the next retry; a hand-off link could be run by the wrong window; a bad pid could make a Cockpit window look open.
- Terminal tabs: lighter selection repaints and find memory, find re-reads a busy pane's history at most once a second (and again after a width change), stream processes always stop on close, the name poll runs only while tabs are open.
- Lighter on the machine: the sidebar's 15s redraw (git line) only runs while it's visible; git runs 3 processes per space refresh instead of 4 and ignores the editor's `GIT_*` environment; Claude transcripts are read incrementally; file links in a terminal line are checked in parallel.
- The sidebar looks right when you drag it to the bottom panel: its header and the agents' status dots no longer use the side bar's background color.
- The Claude status line (Show plan limits…) keeps only the plan limits, in a file only you can read, and quotes its paths properly.
- **Tabs come back in the order you left them.** Reloading a window reopened its Herdr tabs in the order they were first opened, not the order you'd dragged them into, and a tab the editor had to redraw while starting moved to the end (and stayed there on the next reload). The order is now taken from the tab bar, and reopened tabs are put back in it once they're all drawn.
- **A done agent stops being "done" when you open its tab yourself** (tab bar, keyboard), not only when you click it in the sidebar: Herdr is told you've seen it, so its green highlight goes away.
- **New Herdr Tab…** and **Split Herdr Pane…** in the Command Palette: a new tab in the space of the Herdr tab you're in, or a new pane next to it in the same Herdr tab, running a shell or an agent.
- **Selecting no longer copies by default**: in a Herdr tab the selection stays highlighted and **⌘C** (Ctrl+Shift+C) copies it. Turn on `herdr.copyOnSelect` to copy as soon as you select, like the Herdr TUI.
- **Every Herdr tab's name starts with `Herdr:`**, shells too (`Herdr: Tab 2`), not only agents, so they stand apart from the editor's own terminals. Renaming a tab still sends Herdr only the part after `Herdr:`.
- **New defaults**: closing a tab only detaches it (`herdr.closeTabInHerdr` = `never`), follow mode is off (`herdr.followMode`), the **Needs you** section is off (`herdr.showNeedsYou`), and there's no notification when another client takes a pane (`herdr.notifyOnTakeover`). Set them back in Settings if you want them on.

## 0.3.0 (2026-11-10)

- **Talk to agents from the editor.** **Prompt Agent…** (right-click an agent) sends it a prompt as if you typed it in its tab. **Send to Agent…** (right-click in a file or in the Explorer) asks what the agent should do and sends it with the file or the selected lines (`src/app.ts:12-30`).
- **Go to Agent or Shell…** picks any pane of any space, agents waiting on you first. **Jump to Agent Needing Attention** (the status bar's agent count) goes to the next waiting agent each time, and around.
- **Needs you lists only this window's agents**: those of the spaces open here, or whose tab is open here. `herdr.showNeedsYou` turns the section off; blocked and done agents are then highlighted in their space.
- **One notification per change.** With several editor windows open, each one used to show the same "Claude is done" notification. Now one window shows it: the one you're in, else one that has the agent's space.
- **Reopen Closed Tab** (`herdr.reopenClosedTab`; bind it to ⇧⌘T): brings back a Herdr tab you closed, and still reopens files. A pane that's still in Herdr is attached again; a closed one is recreated where it was, and an agent restarts with its name, resuming its conversation when Herdr stored one.
- **Review changes on a worktree space** covers the whole branch since it left the main branch, committed or not, with an option to see only what's uncommitted.
- Agent pickers list every agent Herdr knows, not only the ones Herdr Cockpit names.
- Settings: `herdr.autoAttach` (`all`, `agents`, `none`) replaces `herdr.autoAttachOnSwitch` and `herdr.autoAttachShells`, whose values are still used until you set it. `herdr.hubWindow` is gone (the Cockpit window is known by its workspace file). **Mount Space Alongside (Pin)** left the right-click menu (**Add to This Window** does it); **Show Raw Herdr Record** and **Show Raw Session Snapshot** moved to the Command Palette.
- Fixes: Start Herdr could say it failed while Herdr was up; a pane opened even when the editor refused to add its space's folder; setting up Claude plan limits could undo a change Claude Code saved while the question was open; changing `herdr.socketPath` kept the old session's events.
- **Tabs come back with the window**: close a window (or quit the editor) and open it again, and it reopens the Herdr tabs it had, in the same order, for the panes that still exist in Herdr. Turn it off with `herdr.restoreTabs`. A tab the editor breaks while the window is still starting (empty, named after a long id like `e7ab…bf1`) is closed and opened again a few seconds later.
- **New Tab… from a keybinding**: run `herdr.newTab` from a shortcut or the Command Palette and it opens the shell/agent picker for the space you're working in (the space of the Herdr tab you're in, the one mounted space, or Herdr's focused space; it asks only when none applies). It has no default key; bind one in Keyboard Shortcuts, e.g. `{ "key": "cmd+t", "command": "herdr.newTab", "when": "herdr.connected" }`.

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
