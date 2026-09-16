const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PROVIDERS = new Set(['chatgpt', 'claude', 'gemini']);
// Claude is only run on request: its signed-out surface sits behind a Cloudflare bot check.
const DEFAULT_PROVIDERS = ['chatgpt', 'gemini'];

function usage() {
  return [
    'Usage: npm run test:e2e:live -- [options]',
    '',
    'Options:',
    '  --provider <name>       Run chatgpt, claude, or gemini (repeatable; default: chatgpt, gemini)',
    '  --headless              Diagnostic headless run (not authoritative)',
    '  --deep-diagnostics      Include page snapshots and sources in failure traces',
    '  --skip-build            Reuse dist/ (not authoritative)',
    '  --help                  Show this help',
  ].join('\n');
}

function parse(args) {
  const options = { providers: [], headless: false, deepDiagnostics: false, skipBuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { help: true, ...options };
    if (argument === '--headless') options.headless = true;
    else if (argument === '--deep-diagnostics') options.deepDiagnostics = true;
    else if (argument === '--skip-build') options.skipBuild = true;
    else if (argument === '--provider') {
      const provider = args[++index];
      if (!PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider || '(missing)'}`);
      options.providers.push(provider);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const executable = path.resolve('node_modules', '.bin', 'playwright');
  const config = path.resolve('e2e', 'live', 'playwright.config.ts');
  const result = spawnSync(executable, ['test', '--config', config], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PG_LIVE_PROVIDERS: (options.providers.length ? options.providers : DEFAULT_PROVIDERS).join(','),
      PG_LIVE_HEADLESS: options.headless ? '1' : '0',
      PG_LIVE_DEEP_DIAGNOSTICS: options.deepDiagnostics ? '1' : '0',
      PG_LIVE_SKIP_BUILD: options.skipBuild ? '1' : '0',
    },
  });
  return result.status ?? 1;
}

process.exitCode = main();
