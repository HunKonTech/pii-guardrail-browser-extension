const fs = require('fs');
const path = require('path');

const SUPPORTED_HOST_PERMISSIONS = [
  'https://chat.openai.com/*',
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
];

// `scripting` registers the web search content script, and only while the
// user has switched search protection on and granted the search sites.
const REQUIRED_PERMISSIONS = ['storage', 'offscreen', 'tabs', 'scripting'];

// Optional: requested at runtime from the options page, never at install.
// Keep in sync with SEARCH_ENGINE_ORIGINS in src/shared/search-engines.ts.
const SEARCH_HOST_PERMISSIONS = [
  'https://www.bing.com/*',
  'https://duckduckgo.com/*',
  'https://www.ecosia.org/*',
  'https://search.brave.com/*',
  'https://www.startpage.com/*',
  ...['com', 'hu', 'de', 'at', 'ch', 'co.uk', 'fr', 'it', 'es', 'nl', 'be', 'pl', 'cz', 'sk', 'ro', 'se', 'dk', 'fi', 'no', 'pt', 'ie', 'gr']
    .map((tld) => `https://www.google.${tld}/*`),
];

function readManifest(rootDir = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function describeMismatch(label, actual, expected) {
  return `${label} must be exactly ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`;
}

function checkExtensionPermissions(manifest) {
  const errors = [];

  if (!sameStringSet(manifest.permissions, REQUIRED_PERMISSIONS)) {
    errors.push(describeMismatch('permissions', manifest.permissions, REQUIRED_PERMISSIONS));
  }

  if (manifest.permissions?.includes('activeTab')) {
    errors.push('activeTab is not used by the extension and must not be declared.');
  }

  if (!sameStringSet(manifest.host_permissions, SUPPORTED_HOST_PERMISSIONS)) {
    errors.push(describeMismatch('host_permissions', manifest.host_permissions, SUPPORTED_HOST_PERMISSIONS));
  }

  if (!sameStringSet(manifest.optional_host_permissions, SEARCH_HOST_PERMISSIONS)) {
    errors.push(
      describeMismatch('optional_host_permissions', manifest.optional_host_permissions, SEARCH_HOST_PERMISSIONS)
    );
  }

  for (const [index, entry] of (manifest.content_scripts || []).entries()) {
    if (!sameStringSet(entry.matches, SUPPORTED_HOST_PERMISSIONS)) {
      errors.push(describeMismatch(`content_scripts[${index}].matches`, entry.matches, SUPPORTED_HOST_PERMISSIONS));
    }
  }

  for (const [index, entry] of (manifest.web_accessible_resources || []).entries()) {
    if (!sameStringSet(entry.matches, SUPPORTED_HOST_PERMISSIONS)) {
      errors.push(
        describeMismatch(`web_accessible_resources[${index}].matches`, entry.matches, SUPPORTED_HOST_PERMISSIONS)
      );
    }
  }

  return errors;
}

function main() {
  const errors = checkExtensionPermissions(readManifest());
  if (errors.length > 0) {
    console.error(['Chrome permission audit failed:', ...errors.map((error) => `- ${error}`)].join('\n'));
    process.exitCode = 1;
    return;
  }

  console.log('Chrome permission audit passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_PERMISSIONS,
  SEARCH_HOST_PERMISSIONS,
  SUPPORTED_HOST_PERMISSIONS,
  checkExtensionPermissions,
};
