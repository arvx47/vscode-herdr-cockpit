// File references in a terminal line (`src/foo.ts:42:7`, `./a/b.py(12)`, `~/x.md`), for the Herdr tabs' link
// provider: ⌘/Ctrl+click opens the file at that line. The editor's own detection doesn't know a Herdr pane's
// folder, so relative paths an agent prints didn't resolve. Which candidates are real files is decided by the
// caller (it checks them against the pane's folder). No vscode imports.

export interface FileRef {
  /** Where the link is in the line (UTF-16 index and length, including the line/column suffix). */
  start: number;
  length: number;
  path: string;
  line?: number;
  col?: number;
}

const REF =
  /(?<![\w/.~@+-])((?:~\/|\.{1,2}\/|\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*)(?::(\d+)(?::(\d+))?|\((\d+)(?:, ?(\d+))?\)|#L(\d+))?/g;

/** Path-like tokens: with a slash, or a name with an extension (`README.md`). */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(REF)) {
    let path = m[1];
    let length = m[0].length;
    if (!m[2] && !m[4] && !m[6]) {
      // Sentence punctuation after a path isn't part of it.
      const trimmed = path.replace(/[.]+$/, '');
      length -= path.length - trimmed.length;
      path = trimmed;
    }
    if (!path || path === '.' || path === '..' || /^\d+(\.\d+)*$/.test(path)) continue; // versions, numbers
    if (!path.includes('/') && !/\.[A-Za-z][\w-]{0,9}$/.test(path)) continue;
    if (/^[a-z]\.[a-z]$/i.test(path)) continue; // e.g, i.e
    if (/^[\w.-]+\.(com|org|net|io|dev|ai)$/.test(path) && !path.includes('/')) continue; // a host name
    const line = Number(m[2] ?? m[4] ?? m[6]) || undefined;
    const col = Number(m[3] ?? m[5]) || undefined;
    out.push({ start: m.index!, length, path, ...(line && { line }), ...(col && { col }) });
  }
  return out;
}
