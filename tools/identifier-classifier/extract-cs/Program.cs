// Label every identifier in C# repositories.
//
//   OWN  the name binds to a symbol declared in the repository's source
//   LIB  it binds to a referenced assembly (the .NET shared frameworks, and
//        restored NuGet packages), overrides / implements such a member
//        (`ToString`, `Dispose`), or it does not bind and the repository
//        declares no such name (a package that was not restored)
//   IGN  it does not bind but the repository declares the name; the trainer
//        ignores these
//
// The whole repository is compiled as one ad-hoc compilation: no MSBuild,
// so no repository code runs. Output: one JSON line per source file
//   {"repo","lang","path","text","ids":[[start,end,label],...]}
// with UTF-16 offsets into `text`.
//
// Usage: dotnet run -c Release -- --repos <dir-of-repos> --out <file.jsonl>

using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

const int MaxFileBytes = 150_000;
const int MaxFilesPerRepo = 4000;

string? reposDir = null, outPath = null;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--repos") reposDir = args[++i];
    else if (args[i] == "--out") outPath = args[++i];
}
if (reposDir is null || outPath is null)
{
    Console.Error.WriteLine("Usage: IdentifierExtractor --repos <dir> --out <file.jsonl>");
    return 2;
}

Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
using var writer = new StreamWriter(outPath, append: false, new System.Text.UTF8Encoding(false));
var frameworkReferences = FrameworkReferences();
Console.WriteLine($"[cs] {frameworkReferences.Count} framework assemblies");

foreach (var repo in Directory.GetDirectories(reposDir).OrderBy(d => d, StringComparer.Ordinal))
{
    var started = DateTime.UtcNow;
    try
    {
        var count = LabelRepo(repo, frameworkReferences, writer);
        Console.WriteLine($"[cs] {Path.GetFileName(repo)}: {count} files in {(DateTime.UtcNow - started).TotalSeconds:F1}s");
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"[cs] {Path.GetFileName(repo)} failed: {error.Message}");
    }
}
return 0;

static int LabelRepo(string root, IReadOnlyList<string> frameworkReferences, StreamWriter writer)
{
    var parseOptions = new CSharpParseOptions(LanguageVersion.Preview);
    var files = SourceFiles(root).Take(MaxFilesPerRepo).ToList();
    if (files.Count == 0) return 0;

    var trees = new ConcurrentBag<SyntaxTree>();
    Parallel.ForEach(files, file =>
    {
        var text = File.ReadAllText(file);
        if (!LooksGenerated(text)) trees.Add(CSharpSyntaxTree.ParseText(text, parseOptions, path: file));
    });
    var implicitUsings = CSharpSyntaxTree.ParseText(ImplicitUsings, parseOptions, path: "<implicit-usings>");

    var references = frameworkReferences
        .Concat(PackageReferences(root))
        .GroupBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
        .Select(group => MetadataReference.CreateFromFile(group.First()))
        .ToList();
    var compilation = CSharpCompilation.Create(
        "repo",
        trees.Append(implicitUsings),
        references,
        new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, nullableContextOptions: NullableContextOptions.Enable));

    var declared = new HashSet<string>(StringComparer.Ordinal);
    foreach (var tree in trees)
    {
        foreach (var token in tree.GetRoot().DescendantTokens())
        {
            if (!token.IsKind(SyntaxKind.IdentifierToken)) continue;
            if (token.Parent is not SimpleNameSyntax || token.Parent.Ancestors().Any(a => a is BaseNamespaceDeclarationSyntax ns && ns.Name.Span.Contains(token.Span)))
            {
                declared.Add(token.ValueText);
            }
        }
    }

    var lines = new ConcurrentBag<string>();
    Parallel.ForEach(trees, tree =>
    {
        var model = compilation.GetSemanticModel(tree);
        var ids = new List<object[]>();
        foreach (var token in tree.GetRoot().DescendantTokens())
        {
            if (!token.IsKind(SyntaxKind.IdentifierToken)) continue;
            var label = Label(token, model, declared);
            if (label is not null) ids.Add([token.Span.Start, token.Span.End, label]);
        }
        if (ids.Count == 0) return;
        lines.Add(JsonSerializer.Serialize(new
        {
            repo = Path.GetFileName(root),
            lang = "csharp",
            path = Path.GetRelativePath(root, tree.FilePath).Replace('\\', '/'),
            text = tree.GetText().ToString(),
            ids,
        }));
    });
    foreach (var line in lines) writer.WriteLine(line);
    writer.Flush();
    return lines.Count;
}

static string? Label(SyntaxToken token, SemanticModel model, HashSet<string> declared)
{
    ISymbol? symbol;
    if (token.Parent is SimpleNameSyntax name && !IsNamespaceDeclarationName(name))
    {
        // `var`, `nameof`, `dynamic` are keywords in disguise.
        if (name is IdentifierNameSyntax { IsVar: true } || token.ValueText is "nameof" or "dynamic" or "unmanaged" or "notnull") return null;
        var info = model.GetSymbolInfo(name);
        symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
    }
    else if (token.Parent is SimpleNameSyntax nsName)
    {
        symbol = model.GetSymbolInfo(nsName).Symbol;
    }
    else
    {
        symbol = token.Parent is null ? null : model.GetDeclaredSymbol(token.Parent);
        if (symbol is null) return "OWN"; // a declaration in the repository's own source
        return ImplementsLibraryMember(symbol) ? "LIB" : "OWN";
    }

    if (symbol is null || symbol.Kind == SymbolKind.ErrorType || symbol is IErrorTypeSymbol)
    {
        return declared.Contains(token.ValueText) ? "IGN" : "LIB";
    }
    return IsOwn(symbol) ? "OWN" : "LIB";
}

static bool IsNamespaceDeclarationName(SimpleNameSyntax name) =>
    name.Ancestors().OfType<BaseNamespaceDeclarationSyntax>().Any(ns => ns.Name.Span.Contains(name.Span));

static bool IsOwn(ISymbol symbol)
{
    symbol = symbol switch
    {
        IAliasSymbol alias => alias.Target,
        IMethodSymbol { ReducedFrom: { } reduced } => reduced,
        _ => symbol,
    };
    symbol = symbol.OriginalDefinition;
    if (symbol is INamespaceSymbol ns)
    {
        // `Microsoft` in `namespace Microsoft.eShopWeb` is shared with the
        // framework; only a namespace no referenced assembly has is the repository's.
        return !ns.IsGlobalNamespace &&
            ns.ConstituentNamespaces.All(part => part.Locations.All(location => location.IsInSource));
    }
    if (ImplementsLibraryMember(symbol)) return false;
    return symbol.Locations.Any(location => location.IsInSource);
}

/** A member whose name is fixed by a library: an override or an interface implementation. */
static bool ImplementsLibraryMember(ISymbol symbol)
{
    var root = symbol switch
    {
        IMethodSymbol { IsOverride: true } method => RootOverridden(method, m => m.OverriddenMethod),
        IPropertySymbol { IsOverride: true } property => RootOverridden(property, p => p.OverriddenProperty),
        IEventSymbol { IsOverride: true } evt => RootOverridden(evt, e => e.OverriddenEvent),
        _ => null,
    };
    if (root is not null && !root.Locations.Any(l => l.IsInSource)) return true;

    if (symbol.ContainingType is not { } type || symbol is INamedTypeSymbol) return false;
    foreach (var iface in type.AllInterfaces)
    {
        if (iface.Locations.Any(l => l.IsInSource)) continue;
        foreach (var member in iface.GetMembers(symbol.Name))
        {
            if (SymbolEqualityComparer.Default.Equals(type.FindImplementationForInterfaceMember(member), symbol)) return true;
        }
    }
    return false;
}

static ISymbol RootOverridden<T>(T symbol, Func<T, T?> overridden) where T : class, ISymbol
{
    var current = symbol;
    for (var depth = 0; depth < 32 && overridden(current) is { } next; depth++) current = next;
    return current.OriginalDefinition;
}

static IEnumerable<string> SourceFiles(string root)
{
    var skip = new[] { "bin", "obj", ".git", "node_modules", "packages", "artifacts" };
    var stack = new Stack<string>([root]);
    while (stack.Count > 0)
    {
        var dir = stack.Pop();
        IEnumerable<string> entries;
        try { entries = Directory.EnumerateFileSystemEntries(dir).ToList(); }
        catch { continue; }
        foreach (var entry in entries)
        {
            var name = Path.GetFileName(entry);
            if (Directory.Exists(entry))
            {
                if (!skip.Contains(name, StringComparer.OrdinalIgnoreCase) && !name.StartsWith('.')) stack.Push(entry);
            }
            else if (name.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) &&
                     !name.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase) &&
                     !name.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase) &&
                     !name.EndsWith(".generated.cs", StringComparison.OrdinalIgnoreCase) &&
                     new FileInfo(entry).Length <= MaxFileBytes)
            {
                yield return entry;
            }
        }
    }
}

static bool LooksGenerated(string text)
{
    var head = text.Length > 600 ? text[..600] : text;
    return head.Contains("<auto-generated", StringComparison.OrdinalIgnoreCase) ||
           text.Split('\n').Any(line => line.Length > 400);
}

/** The running runtime's shared frameworks: Microsoft.NETCore.App plus ASP.NET Core and Windows Desktop when present. */
static List<string> FrameworkReferences()
{
    var netCoreDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
    var sharedDir = Path.GetDirectoryName(Path.GetDirectoryName(netCoreDir))!;
    var version = new DirectoryInfo(netCoreDir).Name;
    var major = version.Split('.')[0] + ".";
    var dirs = new List<string> { netCoreDir };
    foreach (var framework in new[] { "Microsoft.AspNetCore.App", "Microsoft.WindowsDesktop.App" })
    {
        var frameworkDir = Path.Combine(sharedDir, framework);
        if (!Directory.Exists(frameworkDir)) continue;
        var best = Directory.GetDirectories(frameworkDir)
            .Where(d => Path.GetFileName(d).StartsWith(major, StringComparison.Ordinal))
            .OrderByDescending(d => d, StringComparer.Ordinal)
            .FirstOrDefault() ?? Directory.GetDirectories(frameworkDir).OrderByDescending(d => d, StringComparer.Ordinal).FirstOrDefault();
        if (best is not null) dirs.Add(best);
    }
    return dirs.SelectMany(d => Directory.GetFiles(d, "*.dll")).Where(IsManagedAssembly).ToList();
}

static bool IsManagedAssembly(string path)
{
    try
    {
        using var stream = File.OpenRead(path);
        using var reader = new System.Reflection.PortableExecutable.PEReader(stream);
        return reader.HasMetadata;
    }
    catch
    {
        return false;
    }
}

/** Compile-time assemblies of NuGet packages, from the `obj/project.assets.json` files a `dotnet restore` left. */
static IEnumerable<string> PackageReferences(string root)
{
    var found = new List<string>();
    foreach (var assets in Directory.EnumerateFiles(root, "project.assets.json", SearchOption.AllDirectories))
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(assets));
            var folders = doc.RootElement.GetProperty("packageFolders").EnumerateObject().Select(p => p.Name).ToList();
            var libraries = doc.RootElement.GetProperty("libraries");
            var target = doc.RootElement.GetProperty("targets").EnumerateObject().FirstOrDefault();
            if (target.Value.ValueKind != JsonValueKind.Object) continue;
            foreach (var package in target.Value.EnumerateObject())
            {
                if (!package.Value.TryGetProperty("compile", out var compile)) continue;
                if (!libraries.TryGetProperty(package.Name, out var library) || !library.TryGetProperty("path", out var libPath)) continue;
                foreach (var item in compile.EnumerateObject())
                {
                    if (item.Name.EndsWith("_._", StringComparison.Ordinal)) continue;
                    foreach (var folder in folders)
                    {
                        var full = Path.Combine(folder, libPath.GetString()!, item.Name);
                        if (File.Exists(full))
                        {
                            found.Add(full);
                            break;
                        }
                    }
                }
            }
        }
        catch
        {
            // A malformed or partial assets file just contributes nothing.
        }
    }
    return found;
}

partial class Program
{
    /** What `<ImplicitUsings>enable</ImplicitUsings>` adds for SDK, Web and Worker projects. */
    const string ImplicitUsings = """
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Net.Http;
        global using System.Net.Http.Json;
        global using System.Threading;
        global using System.Threading.Tasks;
        global using Microsoft.AspNetCore.Builder;
        global using Microsoft.AspNetCore.Hosting;
        global using Microsoft.AspNetCore.Http;
        global using Microsoft.AspNetCore.Routing;
        global using Microsoft.Extensions.Configuration;
        global using Microsoft.Extensions.DependencyInjection;
        global using Microsoft.Extensions.Hosting;
        global using Microsoft.Extensions.Logging;
        """;
}
