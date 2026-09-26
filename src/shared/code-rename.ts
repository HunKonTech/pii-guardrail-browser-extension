import { findCodeLikeRegions } from './code-identifiers';
import type { CodeRegion } from './code-region-finder';
import type { IdentifierVerdict } from './identifier-classifier-constants';

/**
 * Consistent renaming of a pasted snippet's own identifiers: the names it
 * declares, and the names it uses without declaring or importing them that
 * are not well-known library names (they are declared elsewhere in the
 * user's project).
 *
 * The analysis is lexical and language-agnostic (C-family, Python, JS/TS,
 * Java, C#, Go, Rust, Kotlin, PHP shapes). It only has to be good enough to
 * pick the snippet's *own* names: correctness of the round trip does not
 * depend on it, because every alias is restored to exactly the name it
 * replaced. A missed name leaks that name; a wrongly renamed library name
 * only confuses the model until the reply is restored.
 */

export type IdentifierRole = 'class' | 'function' | 'variable' | 'field' | 'param' | 'constant';

export interface RenameOccurrence {
  /** UTF-16 index into the analysed text. */
  start: number;
  end: number;
  name: string;
}

export interface RenamePlan {
  /** Every renamed name with the role of its first declaration. */
  roles: Map<string, IdentifierRole>;
  occurrences: RenameOccurrence[];
  /** Every identifier-shaped word in the code, for alias collision checks. */
  identifiersInText: Set<string>;
}

type TokenKind = 'ident' | 'string' | 'comment' | 'number' | 'punct' | 'newline';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
}

const KEYWORDS = new Set(
  (
    'abstract and as assert async await base begin break case catch class const constructor continue ' +
    'crate debugger declare def default defer del delete do dyn elif else end enum except explicit export ' +
    'extends extern fallthrough final finally fn for foreach from fun func function get global go goto if ' +
    'impl implements import in init inline instanceof interface internal is lambda let loop match mod ' +
    'module mut namespace native new nonlocal not object of operator or out override package params partial ' +
    'pass private protected pub public raise readonly record ref register require return sealed select self ' +
    'set sizeof static struct super switch synchronized template then this throw throws trait transient try ' +
    'type typedef typeof typename union unsafe use using val var virtual volatile when where while ' +
    'with yield true false null nil none None True False undefined NaN Infinity cls it ' +
    'lateinit suspend tailrec vararg crossinline noinline reified'
  ).split(' '),
);

/** Built-in type names: they precede a declared name in typed declarations. */
const TYPE_KEYWORDS = new Set(
  (
    'void int uint long ulong short ushort byte sbyte char bool boolean double float decimal string ' +
    'object dynamic auto var let val const signed unsigned size_t i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 ' +
    'usize isize str any unknown never number bigint symbol'
  ).split(' '),
);

/**
 * Names renaming would break: receivers, entry points and the members a
 * runtime calls by name. Every other name the code declares is renamed,
 * however generic (`value`, `i`, `args`) — a generic name costs nothing to
 * rename and the user asked for all of them.
 */
const RESERVED_NAMES = new Set(
  (
    '_ main Main self this cls super base constructor prototype toString equals hashCode ToString Equals ' +
    'GetHashCode Dispose DisposeAsync'
  ).split(' '),
);

/**
 * Standard-library and runtime names a snippet uses without declaring or
 * importing them. Every other undeclared name is taken to be the user's own
 * (declared elsewhere in their project) and renamed.
 */
const LIBRARY_NAMES = new Set(
  (
    // Python
    'print len range str int float bool list dict set tuple frozenset bytes bytearray open input isinstance ' +
    'issubclass enumerate zip map filter sorted reversed sum min max abs round any all iter next hasattr ' +
    'getattr setattr delattr callable repr hash id format vars dir globals locals staticmethod classmethod ' +
    'property Exception ValueError TypeError KeyError IndexError RuntimeError AttributeError StopIteration ' +
    'NotImplementedError OSError IOError FileNotFoundError ZeroDivisionError AssertionError ' +
    // JavaScript / TypeScript
    'console Math JSON Object Array String Number Boolean Promise Date Error RegExp Map Set WeakMap WeakSet ' +
    'Symbol BigInt Reflect Proxy Intl window document globalThis navigator location localStorage ' +
    'sessionStorage fetch setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone ' +
    'parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI require ' +
    'module exports process Buffer URL URLSearchParams Headers Request Response FormData Blob File Event ' +
    'Element HTMLElement Node AbortController TextEncoder TextDecoder Record Partial Required Readonly Pick ' +
    'Omit Exclude Extract ReturnType Parameters Awaited NonNullable Uint8Array ArrayBuffer ' +
    // C# / .NET
    'Console Task ValueTask List Dictionary HashSet IEnumerable IList ICollection IDictionary IReadOnlyList ' +
    'IReadOnlyCollection IReadOnlyDictionary IQueryable Func Action Predicate DateTime DateTimeOffset TimeSpan ' +
    'Guid Int32 Int64 Double Decimal Convert Environment Enumerable Nullable Lazy Tuple ValueTuple ' +
    'CancellationToken StringBuilder Encoding Path Directory Stream Uri HttpClient ILogger IServiceCollection ' +
    'IConfiguration ArgumentException ArgumentNullException InvalidOperationException NotSupportedException ' +
    'NotImplementedException IDisposable Attribute nameof Regex Thread Debug Trace IOptions ConcurrentDictionary ' +
    'ConcurrentQueue StringComparer StringComparison CultureInfo JsonSerializer IActionResult ActionResult ' +
    'ControllerBase Controller HttpContext IHostedService BackgroundService ILoggerFactory IServiceProvider ' +
    // Java / Kotlin
    'System Integer Long Short Byte Character Float Optional ArrayList LinkedList HashMap TreeMap ' +
    'Collections Arrays Objects Stream Collectors Override Deprecated FunctionalInterface Thread Runnable ' +
    'RuntimeException IllegalArgumentException IllegalStateException NullPointerException IOException ' +
    'println listOf mutableListOf mapOf mutableMapOf setOf arrayOf lazy require check ' +
    // Go / Rust
    'fmt make append cap copy panic recover error errors strings strconv context time ' +
    'Some Ok Err Option Result Vec Box Rc Arc RefCell Cell HashMap BTreeMap HashSet Default Clone Debug ' +
    'Copy PartialEq Eq Hash Iterator IntoIterator From Into Display ToString Send Sync Sized vec ' +
    'format_args assert_eq assert_ne unwrap expect'
  ).split(' '),
);

const DECLARING_KEYWORDS: Record<string, IdentifierRole> = {
  class: 'class',
  struct: 'class',
  interface: 'class',
  enum: 'class',
  record: 'class',
  trait: 'class',
  type: 'class',
  object: 'class',
  def: 'function',
  function: 'function',
  fn: 'function',
  func: 'function',
  fun: 'function',
  let: 'variable',
  var: 'variable',
  val: 'variable',
  const: 'variable',
  auto: 'variable',
};

const ROLE_PRIORITY: Record<IdentifierRole, number> = {
  param: 0,
  variable: 1,
  constant: 2,
  field: 3,
  function: 4,
  class: 5,
};

const MODIFIERS = new Set(
  'public private protected internal static readonly const final volatile transient abstract sealed virtual override async unsafe extern partial required lateinit open'.split(' '),
);

const IDENT_START_RE = /[\p{L}_$]/u;
const IDENT_PART_RE = /[\p{L}\p{N}_$]/u;

// --- Lexer -----------------------------------------------------------------

const TWO_CHAR_PUNCT = new Set(['=>', '->', '::', '?.', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', ':=', '&&', '||', '??', '**']);

class Lexer {
  readonly tokens: Token[] = [];

  constructor(private readonly text: string) {}

  lex(start: number, end: number): void {
    let i = start;
    while (i < end) {
      i = this.lexOne(i, end);
    }
  }

  /** Lex one token at `i`; returns the next index. */
  private lexOne(i: number, end: number): number {
    const text = this.text;
    const ch = text[i];

    if (ch === '\n') {
      this.push('newline', i, i + 1);
      return i + 1;
    }
    if (/\s/.test(ch)) return i + 1;

    if (ch === '/' && text[i + 1] === '/') return this.lineComment(i, end);
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 || close + 2 > end ? end : close + 2;
      this.push('comment', i, stop);
      return stop;
    }
    if (ch === '#') {
      const before = text[i - 1];
      // `this.#field`, `#[attr]` are code; everything else (`# comment`,
      // `#include`, `#region`) is a comment or a directive.
      if (before === '.' || text[i + 1] === '[' || (before && IDENT_PART_RE.test(before))) {
        this.push('punct', i, i + 1);
        return i + 1;
      }
      return this.lineComment(i, end);
    }

    if (IDENT_START_RE.test(ch)) {
      let j = i + 1;
      while (j < end && IDENT_PART_RE.test(text[j])) j += 1;
      const word = text.slice(i, j);
      const quote = text[j];
      if ((quote === '"' || quote === "'") && /^(?:[rRbBuUfF]{1,2}|[$@]{1,2})$/.test(word)) {
        return this.string(i, j, end, /[fF$]/.test(word), word.includes('@'));
      }
      this.push('ident', i, j);
      return j;
    }
    if ((ch === '$' || ch === '@') && (text[i + 1] === '"' || (text[i + 1] === '@' || text[i + 1] === '$') && text[i + 2] === '"')) {
      const quoteAt = text[i + 1] === '"' ? i + 1 : i + 2;
      return this.string(i, quoteAt, end, text.slice(i, quoteAt).includes('$'), text.slice(i, quoteAt).includes('@'));
    }
    if (ch === '"' || ch === '`') return this.string(i, i, end, ch === '`', false);
    if (ch === "'") {
      // A char literal or string when it closes on this line; otherwise a
      // Rust lifetime or an apostrophe.
      const lineEnd = text.indexOf('\n', i);
      const closeAt = this.findClosingQuote(i + 1, lineEnd === -1 ? end : Math.min(lineEnd, end), "'");
      if (closeAt !== -1) return this.string(i, i, end, false, false);
      this.push('punct', i, i + 1);
      return i + 1;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < end && /[0-9A-Za-z_.]/.test(text[j])) j += 1;
      this.push('number', i, j);
      return j;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.has(two)) {
      this.push('punct', i, i + 2);
      return i + 2;
    }
    this.push('punct', i, i + 1);
    return i + 1;
  }

  private lineComment(i: number, end: number): number {
    const lineEnd = this.text.indexOf('\n', i);
    const stop = lineEnd === -1 || lineEnd > end ? end : lineEnd;
    this.push('comment', i, stop);
    return stop;
  }

  private findClosingQuote(from: number, to: number, quote: string): number {
    for (let k = from; k < to; k += 1) {
      if (this.text[k] === '\\') {
        k += 1;
        continue;
      }
      if (this.text[k] === quote) return k;
    }
    return -1;
  }

  /**
   * Lex a string literal whose opening quote is at `quoteAt` (prefix from
   * `start`). Interpolated parts (`${x}`, `{x}` in f-strings and C# `$""`)
   * are lexed as code so identifiers inside them are renamed too.
   */
  private string(start: number, quoteAt: number, end: number, interpolated: boolean, verbatim: boolean): number {
    const text = this.text;
    const quote = text[quoteAt];
    const triple = text.slice(quoteAt, quoteAt + 3) === quote.repeat(3);
    const delimiter = triple ? quote.repeat(3) : quote;
    const multiline = triple || quote === '`' || verbatim;
    let segmentStart = start;
    let k = quoteAt + delimiter.length;

    while (k < end) {
      const c = text[k];
      if (!multiline && c === '\n') break;
      if (c === '\\' && !verbatim) {
        k += 2;
        continue;
      }
      if (verbatim && c === quote && text[k + 1] === quote) {
        k += 2;
        continue;
      }
      if (text.startsWith(delimiter, k)) {
        k += delimiter.length;
        break;
      }
      const opensInterpolation =
        interpolated &&
        ((quote === '`' && c === '$' && text[k + 1] === '{') || (quote !== '`' && c === '{' && text[k + 1] !== '{'));
      if (interpolated && quote !== '`' && c === '{' && text[k + 1] === '{') {
        k += 2;
        continue;
      }
      if (opensInterpolation) {
        const bodyStart = quote === '`' ? k + 2 : k + 1;
        this.push('string', segmentStart, bodyStart);
        k = this.interpolation(bodyStart, end);
        segmentStart = k;
        continue;
      }
      k += 1;
    }
    this.push('string', segmentStart, Math.min(k, end));
    return Math.min(k, end);
  }

  /** Lex code up to the `}` that closes an interpolation; returns the index after it. */
  private interpolation(from: number, end: number): number {
    let depth = 0;
    let k = from;
    while (k < end) {
      const c = this.text[k];
      if (c === '}') {
        if (depth === 0) return k + 1;
        depth -= 1;
      } else if (c === '{') {
        depth += 1;
      }
      if (c === '{' || c === '}') {
        this.push('punct', k, k + 1);
        k += 1;
        continue;
      }
      k = this.lexOne(k, end);
    }
    return k;
  }

  private push(kind: TokenKind, start: number, end: number): void {
    if (end > start) this.tokens.push({ kind, start, end, text: this.text.slice(start, end) });
  }
}

// --- Analysis ----------------------------------------------------------------

/** Code tokens without comments; newlines kept for statement starts. */
function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => token.kind !== 'comment');
}

function isName(token: Token | undefined): boolean {
  return token?.kind === 'ident' && !KEYWORDS.has(token.text);
}

function isTypeLike(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'ident') return !KEYWORDS.has(token.text) || TYPE_KEYWORDS.has(token.text);
  return token.text === '>' || token.text === ']' || token.text === '?' || token.text === '*' || token.text === '&';
}

class Analyzer {
  private readonly code: Token[];
  readonly roles = new Map<string, IdentifierRole>();
  readonly external = new Set<string>();
  private readonly overrides = new Set<string>();
  private readonly classifications?: ReadonlyMap<string, IdentifierVerdict>;

  constructor(tokens: readonly Token[], classifications?: ReadonlyMap<string, IdentifierVerdict>) {
    this.code = significant(tokens);
    this.classifications = classifications;
  }

  /**
   * Whether an undeclared name is a library/framework name. Consults the
   * identifier-classifier model's verdict first (when it had an opinion on
   * this exact name); falls back to the hardcoded `LIBRARY_NAMES` list when
   * the model is unavailable or did not see this name.
   */
  private isLibraryName(name: string): boolean {
    const verdict = this.classifications?.get(name);
    if (verdict) return verdict === 'LIB';
    return LIBRARY_NAMES.has(name);
  }

  /** Index of the previous non-newline token. */
  private prevIndex(i: number): number {
    let j = i - 1;
    while (j >= 0 && this.code[j].kind === 'newline') j -= 1;
    return j;
  }

  private nextIndex(i: number): number {
    let j = i + 1;
    while (j < this.code.length && this.code[j].kind === 'newline') j += 1;
    return j;
  }

  private prev(i: number): Token | undefined {
    return this.code[this.prevIndex(i)];
  }

  private next(i: number): Token | undefined {
    return this.code[this.nextIndex(i)];
  }

  /**
   * Whether the token before i can end a type. A `?` only does when glued to
   * it (`string? name`); a spaced one is a ternary (`c ? a : b`).
   */
  private typeLikeBefore(i: number): boolean {
    const beforeIndex = this.prevIndex(i);
    const before = this.code[beforeIndex];
    if (!isTypeLike(before)) return false;
    if (before.text !== '?') return true;
    const typeEnd = this.code[beforeIndex - 1];
    return typeEnd !== undefined && typeEnd.end === before.start && typeEnd.kind !== 'newline';
  }

  /** True when token i starts a statement (line start, or after `;`/`{`/`}`). */
  private startsStatement(i: number): boolean {
    const before = this.code[i - 1];
    return !before || before.kind === 'newline' || [';', '{', '}'].includes(before.text);
  }

  /** Record a declaration; a name seen in several roles keeps the most specific one. */
  private declare(name: string, role: IdentifierRole): void {
    const current = this.roles.get(name);
    if (!current || ROLE_PRIORITY[role] > ROLE_PRIORITY[current]) this.roles.set(name, role);
  }

  analyze(): void {
    const code = this.code;
    for (let i = 0; i < code.length; i += 1) {
      const token = code[i];
      if (token.text === '=>') {
        this.declareArrowParams(i);
        continue;
      }
      if (token.kind !== 'ident') continue;

      if (this.collectImports(i)) continue;

      const declaring = DECLARING_KEYWORDS[token.text];
      if (declaring) {
        this.declareAfterKeyword(i, declaring);
        continue;
      }
      if (!isName(token)) continue;

      const before = this.prev(i);
      const after = this.next(i);
      const afterIndex = this.nextIndex(i);

      // `self.x = …` / `this.x = …` → field
      if (before?.text === '.' && ['self', 'this'].includes(this.prev(this.prevIndex(i))?.text ?? '')) {
        if (after && ['=', ':'].includes(after.text)) this.declare(token.text, 'field');
        continue;
      }
      if (before && ['.', '?.', '->', '::'].includes(before.text)) continue;

      // Typed declaration: `Type name =|;|,|)|{|=>|:`, `Type name(` (method).
      if (this.typeLikeBefore(i) && after) {
        const typeToken = before!;
        const isModifierOnly = typeToken.kind === 'ident' && MODIFIERS.has(typeToken.text);
        if (!isModifierOnly && !(typeToken.kind === 'ident' && ['return', 'new', 'await', 'yield', 'throw', 'else', 'case', 'in', 'is', 'as', 'of'].includes(typeToken.text))) {
          if (after.text === '(') {
            if (this.hasModifier(i, 'override')) this.overrides.add(token.text);
            else this.declare(token.text, 'function');
            this.declareParams(afterIndex);
            continue;
          }
          const context = ['=', ';', ',', ')', '{', '=>', ':'].includes(after.text)
            ? this.typedDeclarationContext(i)
            : null;
          if (context === 'parens') {
            this.declare(token.text, 'param');
            continue;
          }
          if (context === 'statement') {
            this.declare(token.text, this.inClassBody(i) || this.hasAnyModifier(i) ? 'field' : 'variable');
            continue;
          }
        }
      }

      // Members declared by annotation inside a type body: `customerId: string;`
      // (TypeScript, Kotlin, Swift).
      if (this.startsStatement(i) && after && [':', '?:', '?'].includes(after.text) && this.inClassBody(i)) {
        this.declare(token.text, 'field');
        continue;
      }

      // Python / JS / Go statement-level assignment: `name = …`, `name := …`,
      // and `for name in …`.
      if (this.startsStatement(i) && after && ['=', ':='].includes(after.text)) {
        this.declare(token.text, isScreamingCase(token.text) ? 'constant' : 'variable');
        continue;
      }
      if (before?.text === 'for' && after && ['in', 'of', ',', ':'].includes(after.text)) {
        this.declare(token.text, 'variable');
      }
    }
  }

  /** `x => …` and `(a, b) => …` (JS/TS, C#, Java `->` is not handled). */
  private declareArrowParams(arrowIndex: number): void {
    const beforeIndex = this.prevIndex(arrowIndex);
    const before = this.code[beforeIndex];
    if (isName(before)) {
      this.declare(before!.text, 'param');
      return;
    }
    if (before?.text !== ')') return;
    let depth = 0;
    for (let j = beforeIndex; j >= 0; j -= 1) {
      if (this.code[j].text === ')') depth += 1;
      if (this.code[j].text === '(' && --depth === 0) {
        this.declareParams(j);
        return;
      }
    }
  }

  /** `import …`, `from … import …`, `using …;`, `require(…)` names stay untouched. */
  private collectImports(i: number): boolean {
    const token = this.code[i];
    if (!['import', 'from', 'using', 'require', 'package', 'namespace', 'use'].includes(token.text)) return false;
    if (!this.startsStatement(i) && token.text !== 'require') return false;
    let j = i + 1;
    while (j < this.code.length && this.code[j].kind !== 'newline' && this.code[j].text !== ';') {
      if (this.code[j].kind === 'ident') this.external.add(this.code[j].text);
      j += 1;
    }
    return true;
  }

  private declareAfterKeyword(i: number, role: IdentifierRole): void {
    const nextIndex = this.nextIndex(i);
    const name = this.code[nextIndex];
    // `const string X = …` (C#) — the typed-declaration rule finds X.
    if (!isName(name) || TYPE_KEYWORDS.has(name!.text)) return;
    const keyword = this.code[i].text;
    // `type` / `object` / `record` are only declarations at statement level.
    if (['type', 'object', 'record'].includes(keyword) && !this.startsStatement(i) && !this.hasAnyModifier(i)) return;
    this.declare(name!.text, role === 'variable' && isScreamingCase(name!.text) ? 'constant' : role);
    const after = this.next(nextIndex);
    if (role === 'function' && after?.text === '(') this.declareParams(this.nextIndex(nextIndex));
    if (role === 'class' && after?.text === '(') this.declareParams(this.nextIndex(nextIndex));
  }

  /**
   * Parameters inside the parentheses opened at `openIndex`: the name right
   * before `,` `)` `=` `:` — untyped (`def f(a, b=1)`, `(a: number)`) or
   * after a type (`string name`, `IOptions<T> options`).
   */
  private declareParams(openIndex: number): void {
    let depth = 0;
    for (let j = openIndex; j < this.code.length; j += 1) {
      const token = this.code[j];
      if (['(', '[', '<', '{'].includes(token.text)) depth += 1;
      if ([')', ']', '>', '}'].includes(token.text)) {
        depth -= 1;
        if (depth === 0) return;
      }
      if (depth !== 1 || !isName(token)) continue;
      const after = this.next(j);
      const before = this.prev(j);
      if (!after || ![',', ')', '=', ':'].includes(after.text) || !before) continue;
      if (['(', ',', '*', '**', '&', '...'].includes(before.text) || this.typeLikeBefore(j)) {
        this.declare(token.text, 'param');
      }
    }
  }

  /**
   * Where a `Type name` pair sits: at the start of a statement (a variable or
   * field), inside parentheses (a parameter or tuple element), or neither.
   */
  private typedDeclarationContext(i: number): 'statement' | 'parens' | null {
    let j = this.prevIndex(i);
    let depth = 0;
    while (j >= 0) {
      const token = this.code[j];
      if (token.text === '>' || token.text === ']' || token.text === ')') depth += 1;
      else if (token.text === '<' || token.text === '[' || token.text === '(') {
        if (depth === 0) return token.text === '(' ? 'parens' : null;
        depth -= 1;
      } else if (depth === 0) {
        if (token.kind === 'newline' || [';', '{', '}'].includes(token.text)) return 'statement';
        if (token.text === ',') return 'parens';
        if (token.kind !== 'ident' && !['?', '*', '&', '.', '::'].includes(token.text)) return null;
      }
      j -= 1;
    }
    return 'statement';
  }

  private hasModifier(i: number, modifier: string): boolean {
    let j = this.prevIndex(i);
    while (j >= 0 && this.code[j].kind === 'ident') {
      if (this.code[j].text === modifier) return true;
      j = this.prevIndex(j);
    }
    return false;
  }

  private hasAnyModifier(i: number): boolean {
    let j = this.prevIndex(i);
    while (j >= 0 && this.code[j].kind !== 'newline' && ![';', '{', '}'].includes(this.code[j].text)) {
      if (MODIFIERS.has(this.code[j].text)) return true;
      j -= 1;
    }
    return false;
  }

  /** Whether the innermost `{` around token i was opened by a type declaration. */
  private inClassBody(i: number): boolean {
    let depth = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const token = this.code[j];
      if (token.text === '}') depth += 1;
      if (token.text !== '{') continue;
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      for (let k = j - 1; k >= 0 && ![';', '{', '}'].includes(this.code[k].text); k -= 1) {
        if (['class', 'struct', 'interface', 'record', 'enum', 'object', 'trait', 'impl'].includes(this.code[k].text)) {
          return true;
        }
      }
      return false;
    }
    return false;
  }

  /**
   * Names the code uses without declaring them: the user's own classes,
   * properties and helpers from elsewhere in their project. Library and
   * runtime names stay. A member is included when its receiver is such a
   * name (`L.IsHu`); members of the snippet's local objects are not, since
   * they are as likely a library's (`rows.filter`).
   */
  usedNames(): Map<string, IdentifierRole> {
    const used = new Map<string, IdentifierRole>();
    const note = (name: string, role: IdentifierRole) => {
      const current = used.get(name);
      if (!current || ROLE_PRIORITY[role] > ROLE_PRIORITY[current]) used.set(name, role);
    };
    const candidate = (token: Token) =>
      isName(token) && !this.roles.has(token.text) && !this.isLibraryName(token.text) && !this.excluded(token.text);

    for (let i = 0; i < this.code.length; i += 1) {
      const token = this.code[i];
      if (!candidate(token)) continue;
      const before = this.prev(i);
      if (before?.text === '@') continue;
      if (before && ['.', '?.', '->', '::'].includes(before.text)) {
        const receiver = this.prev(this.prevIndex(i));
        if (receiver?.kind === 'ident' && used.has(receiver.text)) {
          note(token.text, this.next(i)?.text === '(' ? 'function' : 'field');
        }
        continue;
      }
      note(token.text, this.usedRole(i));
    }
    return used;
  }

  /** Best guess at what an undeclared name is, from how it is used. */
  private usedRole(i: number): IdentifierRole {
    const name = this.code[i].text;
    const before = this.prev(i);
    const after = this.next(i);
    if (isScreamingCase(name)) return 'constant';
    const pascal = /^_*[A-Z]/.test(name);
    const typePosition =
      isName(after) || ['<', '>', '.', '::'].includes(after?.text ?? '') || before?.text === '<';
    if (before?.text === 'new' || (pascal && typePosition)) {
      return 'class';
    }
    if (after?.text === '(') return 'function';
    return pascal ? 'field' : 'variable';
  }

  /** Names that must never be renamed. */
  excluded(name: string): boolean {
    return (
      KEYWORDS.has(name) ||
      TYPE_KEYWORDS.has(name) ||
      RESERVED_NAMES.has(name) ||
      this.external.has(name) ||
      this.overrides.has(name) ||
      /^__.*__$/.test(name)
    );
  }

  /** Occurrences of renamed names in code tokens. */
  occurrences(renamed: ReadonlySet<string>): RenameOccurrence[] {
    const out: RenameOccurrence[] = [];
    const code = this.code;
    for (let i = 0; i < code.length; i += 1) {
      const token = code[i];
      if (token.kind !== 'ident' || !renamed.has(token.text)) continue;
      const before = this.prev(i);
      if (before && ['.', '?.', '->', '::'].includes(before.text)) {
        // Member access follows the receiver: `alma.nev` and `self.nev` are
        // the snippet's own, `response.status_code` belongs to a library.
        const receiver = this.prev(this.prevIndex(i));
        const receiverIsOwn =
          receiver !== undefined &&
          (['this', 'self', 'cls', ')', ']'].includes(receiver.text) || renamed.has(receiver.text));
        if (!receiverIsOwn) continue;
      }
      out.push({ start: token.start, end: token.end, name: token.text });
    }
    return out;
  }
}

function isScreamingCase(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name) && name.length > 1;
}

/** Strip a fenced block's ``` lines; other regions are analysed whole. */
function codeBody(text: string, region: CodeRegion): CodeRegion {
  let { start, end } = region;
  if (text.startsWith('```', start)) {
    const firstLineEnd = text.indexOf('\n', start);
    start = firstLineEnd === -1 ? end : firstLineEnd + 1;
    const lastLineStart = text.lastIndexOf('\n', end - 1) + 1;
    if (lastLineStart >= start && /^`{3,}\s*$/.test(text.slice(lastLineStart, end))) end = lastLineStart;
  }
  return { start, end: Math.max(start, end) };
}

/**
 * Word-boundary occurrences of renamed names inside comments. Declared names
 * need four letters or an identifier shape; undeclared ones need the shape
 * (`DescriptionEn`, `user_id`), so a free name like `data` leaves prose alone.
 */
function commentOccurrences(
  text: string,
  comments: readonly Token[],
  renamed: ReadonlySet<string>,
  undeclared: ReadonlySet<string>,
): RenameOccurrence[] {
  const out: RenameOccurrence[] = [];
  const identifierShaped = (name: string) => /[_A-Z0-9]/.test(name.slice(1));
  const candidates = [...renamed].filter((name) =>
    undeclared.has(name) ? identifierShaped(name) : name.length >= 4 || identifierShaped(name),
  );
  if (candidates.length === 0) return out;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_$])(?:${candidates.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_$])`,
    'gu',
  );
  for (const comment of comments) {
    for (const match of comment.text.matchAll(pattern)) {
      const start = comment.start + (match.index ?? 0);
      out.push({ start, end: start + match[0].length, name: match[0] });
    }
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RenamePlanOptions {
  /** Code regions to analyse; found automatically when omitted. */
  regions?: CodeRegion[];
  /**
   * Names renamed in earlier pastes. They are renamed here too, even when
   * this snippet only uses them, so a name keeps one alias throughout.
   */
  knownNames?: Iterable<string>;
  /**
   * OWN/LIB verdicts from the identifier-classifier model, keyed by exact
   * name. Only consulted for undeclared (used-but-not-declared) names — the
   * snippet's own declarations are always renamed regardless. A name absent
   * from the map falls back to the hardcoded `LIBRARY_NAMES` list, so a
   * missing or unavailable model degrades to the previous behaviour.
   */
  classifications?: ReadonlyMap<string, IdentifierVerdict>;
}

/** Matches every identifier-shaped word in a text, code or comment. */
export const IDENTIFIER_WORD_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

/**
 * The trimmed text of every code-like region in `text` (fenced ``` markers
 * stripped) — the same regions and bodies `planIdentifierRenames` analyses.
 * Used to build the identifier-classifier model's input: it needs the
 * surrounding code as context, not isolated names.
 */
export function extractCodeRegionTexts(text: string, regions?: CodeRegion[]): string[] {
  return (regions ?? findCodeLikeRegions(text))
    .map((region) => {
      const body = codeBody(text, region);
      return text.slice(body.start, body.end);
    })
    .filter((body) => body.trim().length > 0);
}

/**
 * Find the identifiers the code in `text` declares and every place they
 * occur, across all code regions (so a class declared in one block and used
 * in another is renamed in both).
 */
export function planIdentifierRenames(text: string, options: RenamePlanOptions = {}): RenamePlan {
  const regions = options.regions ?? findCodeLikeRegions(text);
  const lexer = new Lexer(text);
  for (const region of regions) {
    const body = codeBody(text, region);
    lexer.lex(body.start, body.end);
    lexer.tokens.push({ kind: 'newline', start: body.end, end: body.end, text: '\n' });
  }

  const analyzer = new Analyzer(lexer.tokens, options.classifications);
  analyzer.analyze();

  const roles = new Map<string, IdentifierRole>();
  for (const [name, role] of analyzer.roles) {
    if (!analyzer.excluded(name)) roles.set(name, role);
  }
  const usedNames = new Set(lexer.tokens.filter((token) => token.kind === 'ident').map((token) => token.text));
  for (const name of options.knownNames ?? []) {
    if (!roles.has(name) && usedNames.has(name) && !analyzer.excluded(name)) roles.set(name, 'variable');
  }
  const undeclared = new Set<string>();
  for (const [name, role] of analyzer.usedNames()) {
    if (roles.has(name)) continue;
    roles.set(name, role);
    undeclared.add(name);
  }
  const renamed = new Set(roles.keys());

  const comments = lexer.tokens.filter((token) => token.kind === 'comment');
  const occurrences = [
    ...analyzer.occurrences(renamed),
    ...commentOccurrences(text, comments, renamed, undeclared),
  ].sort(
    (a, b) => a.start - b.start,
  );

  const identifiersInText = new Set<string>();
  for (const match of text.matchAll(/[\p{L}_$][\p{L}\p{N}_$]*/gu)) identifiersInText.add(match[0]);

  return { roles, occurrences, identifiersInText };
}

// --- Aliases -----------------------------------------------------------------

const ROLE_WORD: Record<IdentifierRole, string> = {
  class: 'Class',
  function: 'func',
  variable: 'var',
  field: 'field',
  param: 'param',
  constant: 'CONST',
};

/** Matches every alias this module can produce. */
export const IDENTIFIER_ALIAS_RE = /^_*(?:Class|[Ff]unc|[Vv]ar|[Ff]ield|[Pp]aram|CONST|Const|VAR|FUNC|FIELD|PARAM|CLASS)_?(\d+)$/;

/**
 * Alias for `name` in the role it was declared in, keeping its naming
 * convention so the code still reads idiomatically: `alma` → `var1`,
 * `_etags` → `_field2`, `ClientName` → `Field3`, `MAX_SIZE` → `CONST_4`,
 * `load_user` → `func_5`.
 */
export function aliasFor(name: string, role: IdentifierRole, index: number): string {
  const underscores = /^_*/.exec(name)![0];
  const bare = name.slice(underscores.length);
  const word = ROLE_WORD[role];
  let alias: string;
  if (role === 'class') alias = `Class${index}`;
  else if (isScreamingCase(bare) && bare.length > 1) alias = `${word.toUpperCase()}_${index}`;
  else if (/^[A-Z]/.test(bare)) alias = `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}${index}`;
  else if (bare.includes('_')) alias = `${word.toLowerCase()}_${index}`;
  else alias = `${word.toLowerCase()}${index}`;
  return underscores + alias;
}
