#!/usr/bin/env node
/**
 * Label every identifier in TypeScript / JavaScript repositories.
 *
 *   OWN  the name resolves to a declaration inside the repository
 *   LIB  it resolves to lib.d.ts, @types or node_modules, or it does not
 *        resolve and the repository declares no such name (an uninstalled
 *        package: `express()`, `res.status`)
 *   IGN  it does not resolve but the repository declares the name, so it
 *        could be either; the trainer ignores these
 *
 * Output: one JSON line per source file
 *   {"repo","lang","path","text","ids":[[start,end,label],...]}
 * with UTF-16 offsets into `text`.
 *
 * Usage: node extract.mjs --repos <dir-of-repos> --out <file.jsonl>
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', 'vendor', 'lib-cov']);
const MAX_FILE_BYTES = 150_000;
const MAX_FILES_PER_REPO = 4000;

function parseArgs(argv) {
  const args = { repos: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--repos') args.repos = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.repos || !args.out) {
    console.error('Usage: node extract.mjs --repos <dir> --out <file.jsonl>');
    process.exit(2);
  }
  return args;
}

function listSources(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_FILES_PER_REPO) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts') && !entry.name.includes('.min.')) {
        try {
          if (fs.statSync(full).size <= MAX_FILE_BYTES) files.push(full);
        } catch {
          // unreadable: skip
        }
      }
    }
  }
  return files;
}

/** A generated or minified file teaches nothing about hand-written code. */
function looksGenerated(text) {
  const lines = text.split('\n');
  return lines.some((line) => line.length > 400) || /@generated|auto-generated|DO NOT EDIT/i.test(text.slice(0, 500));
}

const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration, ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature, ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment, ts.SyntaxKind.ShorthandPropertyAssignment, ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor, ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement, ts.SyntaxKind.TypeParameter, ts.SyntaxKind.ModuleDeclaration,
]);

function isInside(file, root) {
  const rel = path.relative(root, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('node_modules');
}

function labelRepo(root, repoName, out) {
  const files = listSources(root);
  if (files.length === 0) return 0;

  const program = ts.createProgram(files, {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.Preserve,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    experimentalDecorators: true,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  });
  const checker = program.getTypeChecker();
  const repoFiles = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && isInside(sf.fileName, root));

  // Every name the repository declares (imports excluded: they name
  // something else's declaration).
  const declared = new Set();
  for (const sf of repoFiles) {
    const visit = (node) => {
      if (DECLARATION_KINDS.has(node.kind) && node.name && ts.isIdentifier(node.name)) declared.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const labelOf = (node) => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && node.parent && ts.isShorthandPropertyAssignment(node.parent)) {
      symbol = checker.getShorthandAssignmentValueSymbol(node.parent) ?? symbol;
    }
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        symbol = undefined;
      }
    }
    const declarations = symbol?.declarations ?? [];
    if (declarations.length > 0) {
      return declarations.some((d) => isInside(d.getSourceFile().fileName, root)) ? 'OWN' : 'LIB';
    }
    return declared.has(node.text) ? 'IGN' : 'LIB';
  };

  let written = 0;
  for (const sf of repoFiles) {
    const text = sf.text;
    if (looksGenerated(text)) continue;
    const ids = [];
    const visit = (node) => {
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const start = node.getStart(sf);
        ids.push([start, node.getEnd(), ts.isPrivateIdentifier(node) ? 'OWN' : labelOf(node)]);
      }
      ts.forEachChild(node, visit);
    };
    try {
      visit(sf);
    } catch (error) {
      console.error(`  ! ${sf.fileName}: ${error.message}`);
      continue;
    }
    if (ids.length === 0) continue;
    out.write(
      JSON.stringify({
        repo: repoName,
        lang: 'typescript',
        path: path.relative(root, sf.fileName).split(path.sep).join('/'),
        text,
        ids,
      }) + '\n',
    );
    written += 1;
  }
  return written;
}

const args = parseArgs(process.argv);
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
const out = fs.createWriteStream(args.out);
for (const entry of fs.readdirSync(args.repos, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = path.resolve(args.repos, entry.name);
  const started = Date.now();
  try {
    const count = labelRepo(root, entry.name, out);
    console.log(`[ts] ${entry.name}: ${count} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    console.error(`[ts] ${entry.name} failed: ${error.message}`);
  }
}
out.end();
