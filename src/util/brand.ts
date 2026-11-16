// The names and prefixes people see, in one place. Write them through these constants, never spelled out, so a
// rename is this file plus package.nls.json (package.json's titles and descriptions) and the docs.
// test/hubTest.ts checks EXTENSION_NAME equals package.nls.json's displayName.
// No imports: the sidebar's webview bundle uses it too.

/** The extension's name: dialogs, the output channel, the sidebar footer, generated files. */
export const EXTENSION_NAME = 'Herdr Cockpit';

/** What notifications and status-bar messages start with: "Herdr: no spaces yet." */
export const MESSAGE_PREFIX = 'Herdr';

/** What every Herdr terminal tab's name starts with: "Herdr: Fix login", "Herdr: Tab 2". */
export const TAB_PREFIX = 'Herdr:';
