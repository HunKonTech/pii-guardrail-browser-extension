import ts from 'typescript';
import { anonymize, anonymizeWithVault, previewIdentifierRenames } from '../../src/shared/anonymizer';
import { buildConversationScope } from '../../src/shared/conversation-scope';
import { EntityMap } from '../../src/shared/entity-map';
import { emptyVaultData } from '../../src/shared/identity-vault';
import type { PiiSpan } from '../../src/shared/message-types';
import { resolveText } from '../../src/shared/placeholder-resolver';
import { stringIndexToByteOffset } from '../../src/shared/text-offsets';

const PYTHON = `class Alma:
    def __init__(self, nev):
        self.nev = nev

alma = Alma("piros")
print(alma.nev)`;

const TYPESCRIPT = `import { readFile } from 'fs/promises';

interface InvoiceRow { customerId: string; amount: number }

export async function loadInvoices(path: string): Promise<InvoiceRow[]> {
  const raw = await readFile(path, 'utf8');
  const rows = JSON.parse(raw) as InvoiceRow[];
  return rows.filter((row) => row.amount > 0);
}`;

const RENAME = { renameIdentifiers: true };

function personSpan(text: string, needle: string, from = 0): PiiSpan {
  const start = text.indexOf(needle, from);
  return {
    start: stringIndexToByteOffset(text, start),
    end: stringIndexToByteOffset(text, start + needle.length),
    entity_type: 'PERSON',
    score: 0.9,
    text: needle,
    source: 'ner',
  };
}

function syntaxErrors(code: string): string[] {
  const output = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return (output.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('anonymize with renameIdentifiers', () => {
  test('renames a class, its field and the instance consistently', () => {
    const { text, renamedIdentifiers } = anonymize(PYTHON, [], new EntityMap(), RENAME);

    expect(text).toBe(`class Class1:
    def __init__(self, field2):
        self.field2 = field2

var3 = Class1("piros")
print(var3.field2)`);
    expect(renamedIdentifiers).toBe(3);
  });

  test('restores the original names in a reply that reuses and extends the code', () => {
    const { text, entityMap } = anonymize(PYTHON, [], new EntityMap(), RENAME);
    expect(text).toContain('var3.field2');

    const reply = 'Add a method:\n```python\ndef leiras(var3: Class1) -> str:\n    return var3.field2.upper()\n```';
    expect(resolveText(reply, entityMap).deAnonText).toBe(
      'Add a method:\n```python\ndef leiras(alma: Alma) -> str:\n    return alma.nev.upper()\n```',
    );
  });

  test('round-trips exactly', () => {
    const { text, entityMap } = anonymize(TYPESCRIPT, [], new EntityMap(), RENAME);

    expect(text).not.toContain('InvoiceRow');
    expect(text).not.toContain('loadInvoices');
    expect(text).toContain("from 'fs/promises'");
    expect(text).toContain('readFile(');
    expect(resolveText(text, entityMap).deAnonText).toBe(TYPESCRIPT);
  });

  test('renamed TypeScript still parses', () => {
    const { text } = anonymize(TYPESCRIPT, [], new EntityMap(), RENAME);

    expect(syntaxErrors(text)).toEqual([]);
  });

  test('a name the model flagged keeps its typed placeholder instead of a neutral alias', () => {
    const code = 'function getAnnaMuellerInvoice(id) {\n  return load(id);\n}\nconst x1 = getAnnaMuellerInvoice(1);';
    const spans = [personSpan(code, 'AnnaMueller'), personSpan(code, 'AnnaMueller', 40)];

    const { text } = anonymize(code, spans, new EntityMap(), RENAME);

    expect(text).toBe('function getPERSON_1Invoice(param1) {\n  return func3(param1);\n}\nconst var2 = getPERSON_1Invoice(1);');
  });

  test('aliases never collide with names already in the code', () => {
    const code = 'const var1 = 1;\nconst alma = var1 + 1;';
    const { text } = anonymize(code, [], new EntityMap(), RENAME);

    expect(text).toBe('const var2 = 1;\nconst var3 = var2 + 1;');
  });

  test('prose is left alone', () => {
    const prose = 'Anna said the alma = apple joke again.';
    expect(anonymize(prose, [], new EntityMap(), RENAME).text).toBe(prose);
  });
});

describe('anonymizeWithVault with renameIdentifiers', () => {
  test('stores aliases in the vault and reuses them in the next paste', () => {
    const vault = emptyVaultData();

    const first = anonymizeWithVault(PYTHON, [], vault, 'placeholder', new EntityMap(), RENAME);
    const second = anonymizeWithVault('alma = Alma("zold")\nalma.nev = 1\nalma.nev += 1', [], vault, 'placeholder', new EntityMap(), RENAME);

    expect(vault.records.filter((r) => r.entityType === 'IDENTIFIER').map((r) => [r.originalText, r.syntheticValue])).toEqual([
      ['Alma', 'Class1'],
      ['nev', 'field2'],
      ['alma', 'var3'],
    ]);
    expect(first.text).toContain('var3 = Class1("piros")');
    expect(second.text).toBe('var3 = Class1("zold")\nvar3.field2 = 1\nvar3.field2 += 1');
  });

  test('a conversation filed with the aliases resolves them after a reload', () => {
    const vault = emptyVaultData();
    const { text } = anonymizeWithVault(PYTHON, [], vault, 'placeholder', new EntityMap(), RENAME);

    // After a reload only the filed tokens and the vault remain.
    const scope = buildConversationScope({
      recordTokens: ['Class1', 'field2', 'var3'],
      recordOriginals: {},
      ledger: {},
      observed: [],
      vault,
      vaultEnabled: true,
    });

    expect(scope.resolve(text).deAnonText).toBe(PYTHON);
  });
});

describe('previewIdentifierRenames', () => {
  const apply = (text: string, renames: { start: number; end: number; alias: string }[]) => {
    let out = '';
    let cursor = 0;
    for (const r of renames) {
      out += text.slice(cursor, r.start) + r.alias;
      cursor = r.end;
    }
    return out + text.slice(cursor);
  };

  test('matches what anonymize pastes, without touching the EntityMap', () => {
    const entityMap = new EntityMap();
    const renames = previewIdentifierRenames(PYTHON, [], { entityMap });

    expect(apply(PYTHON, renames)).toBe(anonymize(PYTHON, [], new EntityMap(), RENAME).text);
    expect(entityMap.size).toBe(0);
  });

  test('matches what anonymizeWithVault pastes, without touching the vault', () => {
    const vaultData = emptyVaultData();
    const renames = previewIdentifierRenames(TYPESCRIPT, [], { vaultData });

    expect(apply(TYPESCRIPT, renames)).toBe(anonymizeWithVault(TYPESCRIPT, [], emptyVaultData(), 'placeholder', undefined, RENAME).text);
    expect(vaultData.records).toHaveLength(0);
  });

  test('renames generic names too', () => {
    const code = `def total(values, e):
    for i in range(len(values)):
        value = values[i]
        err = check(value)
    return value`;
    const text = apply(code, previewIdentifierRenames(code, []));

    expect(text).not.toMatch(/\b(?:values|value|err|e|i)\b/);
  });

  test('renames code pasted as one line', () => {
    const query = 'public const string ClientName = "github"; private readonly SiteOptions _opt = options;';

    expect(apply(query, previewIdentifierRenames(query, []))).toBe(
      'public const string Field1 = "github"; private readonly Class3 _field2 = var4;',
    );
  });

  test('renames names the code only uses, but not library names', () => {
    const line = 'public string? Description => (L.IsHu ? DescriptionHu : DescriptionEn) ?? DescriptionEn ?? DescriptionHu;\n}';

    expect(apply(line, previewIdentifierRenames(line, []))).toBe(
      'public string? Field1 => (Class2.Field3 ? Field4 : Field5) ?? Field5 ?? Field4;\n}',
    );
    const js = 'const total = Math.max(computeTotal(rows), 0);\nconsole.log(JSON.stringify(total));';
    expect(apply(js, previewIdentifierRenames(js, []))).toBe(
      'const var1 = Math.max(func2(var3), 0);\nconsole.log(JSON.stringify(var1));',
    );
  });
});
