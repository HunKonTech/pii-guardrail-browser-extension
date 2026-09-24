import { aliasFor, planIdentifierRenames } from '../../src/shared/code-rename';

function renamedNames(text: string): Record<string, string> {
  const plan = planIdentifierRenames(text);
  return Object.fromEntries(plan.roles);
}

function renamedOccurrences(text: string): string[] {
  return planIdentifierRenames(text).occurrences.map((o) => `${o.name}@${o.start}`);
}

const CSHARP = `public sealed class GitHubClient(IOptions<SiteOptions> options)
{
    public const string ClientName = "github";

    private readonly SiteOptions _opt = options.Value;
    private readonly ConcurrentDictionary<string, (string ETag, string Body)> _etags = new();

    /// <summary>Last known commits, used when _knownCommits is stale.</summary>
    private Dictionary<string, CommitInfo> _knownCommits = new(StringComparer.OrdinalIgnoreCase);

    public async Task<CommitInfo?> LoadCommitAsync(string repoName, CancellationToken ct)
    {
        var cached = _knownCommits.GetValueOrDefault(repoName);
        Console.WriteLine($"Loading {repoName} for {_opt.Owner}");
        return cached;
    }
}`;

const PYTHON = `import requests
from dataclasses import dataclass

class Alma:
    def __init__(self, nev, suly):
        self.nev = nev
        self.suly = suly

    def leiras(self):
        return f"{self.nev} ({self.suly} g)"

alma = Alma("piros", 120)
print(alma.nev, alma.leiras())
response = requests.get("https://example.com")
print(response.status_code)`;

const TYPESCRIPT = `import { readFile } from 'fs/promises';

interface InvoiceRow { customerId: string; amount: number }

export async function loadInvoices(path: string): Promise<InvoiceRow[]> {
  const raw = await readFile(path, 'utf8');
  const rows = JSON.parse(raw) as InvoiceRow[];
  return rows.filter((row) => row.amount > 0);
}`;

describe('planIdentifierRenames — C#', () => {
  const names = renamedNames(CSHARP);

  test('renames the snippet’s own declarations', () => {
    expect(names).toEqual(
      expect.objectContaining({
        GitHubClient: 'class',
        ClientName: 'field',
        _opt: 'field',
        _etags: 'field',
        ETag: 'param',
        Body: 'param',
        _knownCommits: 'field',
        LoadCommitAsync: 'function',
        repoName: 'param',
        cached: 'variable',
        options: 'param',
      }),
    );
  });

  test("renames the project's own types the snippet only uses", () => {
    expect(names).toMatchObject({ SiteOptions: 'class', CommitInfo: 'class' });
  });

  test('leaves library and external names alone', () => {
    for (const external of [
      'IOptions', 'ConcurrentDictionary', 'Dictionary', 'StringComparer',
      'OrdinalIgnoreCase', 'Value', 'Task', 'Console', 'WriteLine', 'GetValueOrDefault', 'Owner', 'string',
    ]) {
      expect(names).not.toHaveProperty(external);
    }
  });

  test('finds occurrences in code, interpolations and doc comments but not in string text', () => {
    const plan = planIdentifierRenames(CSHARP);
    const count = (name: string) => plan.occurrences.filter((o) => o.name === name).length;

    expect(count('repoName')).toBe(3); // parameter, call argument, interpolation
    expect(count('_opt')).toBe(2); // declaration, interpolation
    expect(count('_knownCommits')).toBe(3); // doc comment, declaration, use
    expect(CSHARP.slice(0, CSHARP.indexOf('"github"'))).toContain('ClientName');
  });
});

describe('planIdentifierRenames — Python', () => {
  test('renames the class, its fields, methods and the instance', () => {
    expect(renamedNames(PYTHON)).toEqual({
      Alma: 'class',
      nev: 'field',
      suly: 'field',
      leiras: 'function',
      alma: 'variable',
      response: 'variable',
    });
  });

  test('member access on an own object is renamed, on a library object it is not', () => {
    const occurrences = planIdentifierRenames(PYTHON).occurrences.map((o) => PYTHON.slice(o.start - 5, o.end));

    expect(occurrences).toContain('alma.nev');
    expect(occurrences).toContain('self.nev');
    // parameter, `self.nev = nev` (twice), the f-string, `alma.nev`
    expect(planIdentifierRenames(PYTHON).occurrences.filter((o) => o.name === 'nev')).toHaveLength(5);
    expect(renamedNames(PYTHON)).not.toHaveProperty('status_code');
    expect(renamedNames(PYTHON)).not.toHaveProperty('requests');
    expect(renamedNames(PYTHON)).not.toHaveProperty('__init__');
  });
});

describe('planIdentifierRenames — TypeScript', () => {
  test('renames interfaces, functions, params and locals but not imports or built-ins', () => {
    const names = renamedNames(TYPESCRIPT);

    expect(names).toEqual(
      expect.objectContaining({
        InvoiceRow: 'class',
        loadInvoices: 'function',
        path: 'param',
        raw: 'variable',
        rows: 'variable',
        row: 'param',
        customerId: 'field',
        amount: 'field',
      }),
    );
    for (const external of ['readFile', 'JSON', 'parse', 'filter', 'Promise']) {
      expect(names).not.toHaveProperty(external);
    }
  });
});

describe('planIdentifierRenames — prose', () => {
  test('text that is not code renames nothing', () => {
    expect(renamedOccurrences('Anna asked whether alma = apple in Hungarian.')).toEqual([]);
  });
});

describe('aliasFor', () => {
  test('keeps the naming convention of the original', () => {
    expect(aliasFor('alma', 'variable', 1)).toBe('var1');
    expect(aliasFor('_etags', 'field', 2)).toBe('_field2');
    expect(aliasFor('ClientName', 'field', 3)).toBe('Field3');
    expect(aliasFor('MAX_SIZE', 'constant', 4)).toBe('CONST_4');
    expect(aliasFor('load_user', 'function', 5)).toBe('func_5');
    expect(aliasFor('GitHubClient', 'class', 6)).toBe('Class6');
    expect(aliasFor('LoadCommitAsync', 'function', 7)).toBe('Func7');
  });
});
