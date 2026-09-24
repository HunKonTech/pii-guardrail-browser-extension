import { findCodeRegions, type CodeRegion } from './code-region-finder';
import type { PiiSpan } from './message-types';
import { byteOffsetToStringIndex, stringIndexToByteOffset } from './text-offsets';

/**
 * Helpers that let the prose-trained Local AI model read source code, and
 * keep the replacements it produces valid code.
 *
 * The model reads `getAnnaMuellerInvoice` as one opaque token. Splitting
 * identifiers into words (`get Anna Mueller Invoice`) lets it recognize the
 * name inside; the spans it returns are mapped back onto the original text.
 */

const CODE_LINE_KEYWORD_RE =
  /^(?:import|from|export|package|using|#include|def|class|interface|enum|struct|impl|fn|func|function|const|let|var|val|public|private|protected|static|return|if|elif|else|for|while|switch|case|try|catch|except|finally|async|await|raise|throw)\b/;
const CODE_LINE_END_RE = /(?:[;{}]|\)\s*:|=>|\(\s*)$/;
const CODE_LINE_OPERATOR_RE = /=>|->|::|\(\);|!==|===|&&|\|\||^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*(?:=|\+=|:=)\s*[^=\s]/;
/** A line that is nothing but a call: `print(x)`, `app.run(debug=True);`. */
const CODE_LINE_CALL_RE = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\(.*\)\s*;?$/;

/**
 * Several `;`-terminated statements on one line: `int a = 1; var b = a;`.
 * Code pasted into a single-line box (a search field) arrives like this.
 */
const MULTI_STATEMENT_LINE_RE = /^[^;]*[\w)\]'"]\s*;\s*\S.*;\s*$/;

function isMultiStatementLine(line: string): boolean {
  const trimmed = line.trim();
  return MULTI_STATEMENT_LINE_RE.test(trimmed) && /[=(]/.test(trimmed);
}

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const IDENTIFIER_CHAR_RE = /[\p{L}\p{N}_$]/u;
const IDENTIFIER_TEXT_RE = /^[\p{L}\p{N}_$]+$/u;

function isCodeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return (
    CODE_LINE_KEYWORD_RE.test(trimmed) ||
    CODE_LINE_END_RE.test(trimmed) ||
    CODE_LINE_OPERATOR_RE.test(trimmed) ||
    CODE_LINE_CALL_RE.test(trimmed)
  );
}

/**
 * Fenced / `<pre>` regions plus runs of unfenced lines that look like code.
 * A run needs at least two code-looking lines — or one line holding several
 * statements; blank lines and indented continuation lines inside a run do
 * not break it.
 */
export function findCodeLikeRegions(text: string): CodeRegion[] {
  const regions = [...findCodeRegions(text)];

  let offset = 0;
  let runStart = -1;
  let runEnd = -1;
  let runCodeLines = 0;
  const closeRun = () => {
    if (runStart !== -1 && runCodeLines >= 2) regions.push({ start: runStart, end: runEnd });
    runStart = -1;
    runCodeLines = 0;
  };

  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    if (isCodeLine(line)) {
      if (runStart === -1) runStart = offset;
      runEnd = lineEnd;
      runCodeLines += isMultiStatementLine(line) ? 2 : 1;
    } else if (runStart !== -1 && line.trim() !== '' && !/^\s/.test(line)) {
      closeRun();
    }
    offset = lineEnd + 1;
  }
  closeRun();

  return mergeRegions(regions);
}

function mergeRegions(regions: CodeRegion[]): CodeRegion[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const merged: CodeRegion[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

function inRegions(regions: readonly CodeRegion[], start: number, end: number): boolean {
  return regions.some((region) => start >= region.start && end <= region.end);
}

/** Split an identifier into its words: `getHTTPResponse_v2` → `get`, `HTTP`, `Response`, `v2`. */
function identifierWordBreaks(identifier: string): { replace: Set<number>; insertBefore: Set<number> } {
  const replace = new Set<number>();
  const insertBefore = new Set<number>();
  for (let i = 0; i < identifier.length; i += 1) {
    const ch = identifier[i];
    if (ch === '_' || ch === '$') {
      replace.add(i);
      continue;
    }
    const prev = identifier[i - 1];
    const next = identifier[i + 1];
    if (i === 0 || prev === '_' || prev === '$') continue;
    const isUpper = /[A-Z]/.test(ch);
    if (isUpper && /[a-z0-9]/.test(prev)) insertBefore.add(i);
    else if (isUpper && /[A-Z]/.test(prev) && next !== undefined && /[a-z]/.test(next)) insertBefore.add(i);
  }
  return { replace, insertBefore };
}

export interface NerTextView {
  /** Text handed to the NER model. */
  text: string;
  /** For each UTF-16 index of `text`, the index in the original text. */
  toOriginal: number[];
}

/** Build the model-facing view of `text` with identifiers in code regions split into words. */
export function buildIdentifierSplitView(text: string, regions: readonly CodeRegion[]): NerTextView {
  let view = '';
  const toOriginal: number[] = [];
  let cursor = 0;

  const copy = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      view += text[i];
      toOriginal.push(i);
    }
  };

  for (const region of regions) {
    const segment = text.slice(region.start, region.end);
    IDENTIFIER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IDENTIFIER_RE.exec(segment)) !== null) {
      const start = region.start + match.index;
      const { replace, insertBefore } = identifierWordBreaks(match[0]);
      if (replace.size === 0 && insertBefore.size === 0) continue;

      copy(cursor, start);
      for (let i = 0; i < match[0].length; i += 1) {
        if (insertBefore.has(i)) {
          view += ' ';
          toOriginal.push(start + i);
        }
        view += replace.has(i) ? ' ' : match[0][i];
        toOriginal.push(start + i);
      }
      cursor = start + match[0].length;
    }
  }
  copy(cursor, text.length);
  toOriginal.push(text.length);

  return { text: view, toOriginal };
}

/** Map spans (byte offsets into `view.text`) back onto the original text. */
export function mapViewSpansToOriginal(
  spans: readonly PiiSpan[],
  view: NerTextView,
  originalText: string,
): PiiSpan[] {
  const mapped: PiiSpan[] = [];
  for (const span of spans) {
    const viewStart = byteOffsetToStringIndex(view.text, span.start);
    const viewEnd = byteOffsetToStringIndex(view.text, span.end);
    if (viewEnd <= viewStart) continue;

    let start = view.toOriginal[viewStart];
    let end = view.toOriginal[viewEnd - 1] + 1;
    // A word boundary `_` sits at the edge of the model's span as a space.
    while (start < end && originalText[start] === '_') start += 1;
    while (end > start && originalText[end - 1] === '_') end -= 1;
    if (end <= start) continue;

    mapped.push({
      ...span,
      start: stringIndexToByteOffset(originalText, start),
      end: stringIndexToByteOffset(originalText, end),
      text: originalText.slice(start, end),
    });
  }
  return mapped;
}

/** True when `start` begins a word of an identifier (camelCase, snake_case, or token start). */
function startsIdentifierWord(text: string, start: number): boolean {
  const before = text[start - 1];
  if (before === undefined || !IDENTIFIER_CHAR_RE.test(before) || before === '_' || before === '$') return true;
  return /[A-Z]/.test(text[start]) && /[a-z0-9]/.test(before);
}

/** True when `end` ends a word of an identifier. */
function endsIdentifierWord(text: string, end: number): boolean {
  const after = text[end];
  if (after === undefined || !IDENTIFIER_CHAR_RE.test(after) || after === '_' || after === '$') return true;
  return /[A-Z0-9]/.test(after) && /[a-z]/.test(text[end - 1]);
}

/**
 * Once the model flags a word inside one identifier, flag every other
 * occurrence of that word in identifiers across the code regions. The same
 * name must be replaced everywhere or the pasted code stops compiling.
 */
export function propagateIdentifierSpans(
  text: string,
  regions: readonly CodeRegion[],
  spans: readonly PiiSpan[],
): PiiSpan[] {
  const occupied = spans.map((span) => ({
    start: byteOffsetToStringIndex(text, span.start),
    end: byteOffsetToStringIndex(text, span.end),
  }));
  const added: PiiSpan[] = [];

  const seeds = new Map<string, PiiSpan>();
  for (const span of spans) {
    if (span.source !== 'ner' || !IDENTIFIER_TEXT_RE.test(span.text)) continue;
    const start = byteOffsetToStringIndex(text, span.start);
    if (!inRegions(regions, start, start + span.text.length)) continue;
    const existing = seeds.get(span.text);
    if (!existing || span.score > existing.score) seeds.set(span.text, span);
  }

  for (const [needle, seed] of seeds) {
    for (const region of regions) {
      let from = region.start;
      while (true) {
        const start = text.indexOf(needle, from);
        if (start === -1 || start + needle.length > region.end) break;
        from = start + 1;
        const end = start + needle.length;
        if (!startsIdentifierWord(text, start) || !endsIdentifierWord(text, end)) continue;
        if (occupied.some((o) => start < o.end && end > o.start)) continue;
        occupied.push({ start, end });
        added.push({
          ...seed,
          start: stringIndexToByteOffset(text, start),
          end: stringIndexToByteOffset(text, end),
          text: needle,
        });
      }
    }
  }

  return [...spans, ...added];
}

/**
 * Whether the line prefix before `index` leaves it inside a string literal
 * or a line comment. Conservative: when unsure, answer false, because the
 * bracket-less placeholder is valid everywhere while `[TYPE_N]` is only
 * valid inside strings and comments.
 */
function insideStringOrComment(text: string, lineStart: number, index: number): boolean {
  let quote: string | null = null;
  for (let i = lineStart; i < index; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && text[i + 1] === '/') return true;
    else if (ch === '#' && (i === lineStart || /\s/.test(text[i - 1]))) return true;
  }
  if (!quote) return false;
  // Only trust the string when it also closes after the span on this line.
  const lineEnd = text.indexOf('\n', index);
  return text.slice(index, lineEnd === -1 ? undefined : lineEnd).includes(quote);
}

/**
 * Returns a predicate telling whether a replacement at [start, end) (UTF-16
 * indices) sits in identifier position — inside code, outside strings and
 * comments, or glued to identifier characters. There a bracketed
 * placeholder would break the code, so the caller emits `TYPE_N` instead.
 */
export function createIdentifierPositionCheck(
  text: string,
): (start: number, end: number) => boolean {
  let regions: CodeRegion[] | null = null;
  return (start, end) => {
    regions ??= findCodeLikeRegions(text);
    if (!inRegions(regions, start, end)) return false;
    const before = text[start - 1];
    const after = text[end];
    if ((before && IDENTIFIER_CHAR_RE.test(before)) || (after && IDENTIFIER_CHAR_RE.test(after))) {
      return true;
    }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    return !insideStringOrComment(text, lineStart, start);
  };
}

/** `[PERSON_1]` → `PERSON_1`; other replacements are returned unchanged. */
export function bareIdentifierPlaceholder(placeholder: string): string {
  return /^\[[A-Z][A-Z_]*_\d+\]$/.test(placeholder) ? placeholder.slice(1, -1) : placeholder;
}
