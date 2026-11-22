// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// mend applies an edit that an AI model wrote to a tree of text files, in four
// formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
// the V4A patch format, and text-editor tool calls as JSON. Every file is changed
// or nothing is. SPEC.md is the whole contract; every sentence in it is a
// requirement, including the obscure ones (empty-O inserts, backslash lines,
// tier-2 re-indentation, V4A anchors and cursors, JSON CRLF handling).
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set: keep
// them and runner.ts as they are, and write the CLI above them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed each, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Detect the patch's format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in `lines` at `tier`, at or after `from`; only ones ending at the last line when `endAtLast`. */
function occurrences(lines: string[], O: string[], tier: number, from: number, endAtLast: boolean): number[] {
  const res: number[] = [];
  if (O.length === 0) return res;
  const want = O.map((l) => normLine(l, tier));
  const normed = lines.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    if (endAtLast && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normed[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once (tier 0 only with `--strict`), with its occurrences. */
function findTier(lines: string[], O: string[], strict: boolean, from: number, endAtLast = false): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, O, t, from, endAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}

type BodyLine = { kind: 'ctx' | 'del' | 'add' | 'backslash'; text: string };

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function buildON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === 'del') O.push(b.text);
    else if (b.kind === 'add') N.push({ text: b.text, ctx: null });
  }
  return { O, N };
}

/**
 * Render N against the file's matched lines at `pos`: context lines are the
 * file's own lines; at tier 2 every other non-blank line is re-indented, its
 * leading P (O's first line) replaced by F (the file's first matched line),
 * and F prepended when the line carries no P at all.
 */
function renderN(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2) {
    F = leadingWs(lines[pos] ?? '');
    P = leadingWs(O[0] ?? '');
  }
  for (const n of N) {
    if (n.ctx !== null) {
      out.push(lines[pos + n.ctx]!);
      continue;
    }
    const t = n.text;
    if (tier === 2 && t.trim() !== '') out.push(F + (t.startsWith(P) ? t.slice(P.length) : t));
    else out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
  O: string[];
  N: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  pair: { old: string | null; new: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  mode: 'new' | 'deleted' | null;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A `--- `/`+++ ` path: after the four characters, up to the first tab, trimmed; `a/`/`b/` stripped, `/dev/null` is no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerDone = false;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const finishHunk = (h: Hunk): void => {
    const built = buildON(h.body);
    h.O = built.O;
    h.N = built.N;
    let j = -1;
    for (let k = h.body.length - 1; k >= 0; k--) {
      if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'add') {
        j = k;
        break;
      }
    }
    h.noEol = j >= 0 && j + 1 < h.body.length && h.body[j + 1]!.kind === 'backslash';
  };

  const closeBody = (): void => {
    if (curHunk === null) return;
    // Empty lines at the end of a body are not part of it.
    while (curHunk.body.length > 0) {
      const b = curHunk.body[curHunk.body.length - 1]!;
      if (b.kind === 'ctx' && b.text === '') curHunk.body.pop();
      else break;
    }
    finishHunk(curHunk);
    curHunk = null;
    inBody = false;
  };

  const newSection = (diffOld: string | null, diffNew: string | null): Section => {
    const s: Section = { pair: null, renameFrom: null, renameTo: null, diffOld, diffNew, mode: null, hunks: [] };
    sections.push(s);
    cur = s;
    headerDone = false;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      // A `--- ` line followed by a `+++ ` line ends the body; it is not a body line.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        const kind: BodyLine['kind'] = line === '' || line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : 'backslash';
        curHunk!.body.push({ kind, text: kind === 'backslash' || line === '' ? line : line.slice(1) });
        i++;
        continue;
      }
      closeBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        if (cur !== null && !headerDone && cur.pair === null) cur.pair = { old: oldP, new: newP };
        else newSection(null, null).pair = { old: oldP, new: newP };
        i += 2;
        continue;
      }
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), body: [], O: [], N: [], noEol: false };
      cur.hunks.push(h);
      curHunk = h;
      headerDone = true;
      inBody = true;
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.mode = 'new';
      else if (line.startsWith('deleted file mode')) cur.mode = 'deleted';
    }
    i++;
  }
  if (inBody) closeBody();
  return sections;
}

/** Apply one hunk to a file's state; `d` is the section's length drift so far. */
function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { lines, br, final } = state;
  if (h.O.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const ins = h.N.map((n) => n.text);
    const out = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
    const touchesEnd = at === lines.length;
    return { lines: out, br, final: touchesEnd ? !h.noEol : final };
  }
  const found = findTier(lines, h.O, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  for (const pos of found.occ) {
    if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
  }
  const rendered = renderN(lines, best, h.O, h.N, found.tier);
  const out = [...lines.slice(0, best), ...rendered, ...lines.slice(best + h.O.length)];
  const touchesEnd = best + h.O.length === lines.length;
  return { lines: out, br, final: touchesEnd ? !h.noEol : final };
}

function unifiedSectionEdit(sec: Section, strict: boolean, moves: Array<[string, string]>): Edit {
  const oldPath = sec.pair !== null ? sec.pair.old : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.pair !== null ? sec.pair.new : (sec.renameTo ?? sec.diffNew);
  const kind: 'create' | 'delete' | 'move' | 'change' =
    oldPath === null || sec.mode === 'new'
      ? 'create'
      : newPath === null || sec.mode === 'deleted'
        ? 'delete'
        : oldPath !== newPath
          ? 'move'
          : 'change';
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (kind === 'create') {
      const p = newPath!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'add') {
            plus.push(h.body[j]!.text);
            noEol = j + 1 < h.body.length && h.body[j + 1]!.kind === 'backslash';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    const p = oldPath!;
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    if (kind === 'delete') {
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move' && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let state = splitFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      state = applyHunk(state, h, d, strict, p);
      d += h.N.length - h.O.length;
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newPath!, out);
      moves.push([p, newPath!]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict, moves));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const state = splitFile(text);
    const found = findTier(state.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rendered = renderN(state.lines, pos, oldLines, N, found.tier);
    const out = [...state.lines.slice(0, pos), ...rendered, ...state.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, state.br, state.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let state: 'old' | 'new' = 'old';
    let closed = false;
    i = searchAt + 1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (state === 'old' && l.trimEnd() === '=======') {
        state = 'new';
        i++;
        continue;
      }
      if (state === 'new' && l.trimEnd() === '>>>>>>> REPLACE') {
        closed = true;
        i++;
        break;
      }
      if (state === 'old') oldLines.push(l);
      else newLines.push(l);
      i++;
    }
    if (!closed) throw new Exit2(`error: parse ${searchAt + 1}`);
    prevEnd = i;
    prevPath = path;
    edits.push(srBlockEdit(path, oldLines, newLines, strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

const isV4aSectionStart = (line: string): boolean =>
  line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');

function stripTrailingBlanks(raw: string[]): void {
  while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
  O: string[];
  N: NLine[];
}

function v4aUpdateEdit(path: string, raw: string[], rawStart0: number, updateLineNo: number, strict: boolean, moves: Array<[string, string]>): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const lineNo = (k: number): number => rawStart0 + k + 1;
  let j = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    j = 1;
  }
  for (; j < raw.length; j++) {
    const l = raw[j]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo(j)}`);
        cur = { anchor: null, body: [], eof: false, O: [], N: [] };
        chunks.push(cur);
      }
      const kind: BodyLine['kind'] = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'del' : 'add';
      cur.body.push({ kind, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(j)}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false, O: [], N: [] };
      chunks.push(cur);
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(j)}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  for (const c of chunks) {
    const built = buildON(c.body);
    c.O = built.O;
    c.N = built.N;
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = splitFile(text);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const f = findTier(state.lines, [c.anchor], strict, cursor);
        if (f === null) throw new Fail('no-match', path);
        cursor = f.occ[0]! + 1;
      }
      if (c.O.length === 0) {
        const at = c.eof ? state.lines.length : cursor;
        const ins = c.N.map((n) => n.text);
        state = { ...state, lines: [...state.lines.slice(0, at), ...ins, ...state.lines.slice(at)] };
        cursor = at + ins.length;
      } else {
        const f = findTier(state.lines, c.O, strict, cursor, c.eof);
        if (f === null) throw new Fail('no-match', path);
        const pos = f.occ[0]!;
        const rendered = renderN(state.lines, pos, c.O, c.N, f.tier);
        state = { ...state, lines: [...state.lines.slice(0, pos), ...rendered, ...state.lines.slice(pos + c.O.length)] };
        cursor = pos + rendered.length;
      }
    }
    const out = joinFile(state.lines, state.br, state.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const start = i;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      stripTrailingBlanks(raw);
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k]!;
        if (l === '') addLines.push('');
        else if (l.startsWith('+')) addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${start + k + 2}`);
      }
      edits.push(v4aAddEdit(path, addLines));
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const start = i;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      stripTrailingBlanks(raw);
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${start + k + 2}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const updateLineNo = i + 1;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      stripTrailingBlanks(raw);
      edits.push(v4aUpdateEdit(path, raw, i - raw.length, updateLineNo, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One row per path whose state changed, in byte order of the paths; a move
  // that succeeded is one `R` line sorting by its new path, replacing its `D`
  // and `A` lines, and only when the old path is gone and the new one is there.
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const rows: Array<{ key: string; text: string }> = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o !== undefined && o.was !== null && o.now === null && n !== undefined && n.was === null && n.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const [p, { was, now }] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
