/**
 * Web search engines covered by the optional "Protect web searches" setting.
 *
 * These origins are optional host permissions: the browser asks the user for
 * them when the setting is switched on, and the search content script is
 * registered only while both the setting and the permission are in place.
 * Keep in sync with `optional_host_permissions` in manifest.json and
 * `SEARCH_HOST_PERMISSIONS` in scripts/check-extension-permissions.js.
 */
export const SEARCH_ENGINE_ORIGINS: readonly string[] = [
  'https://www.bing.com/*',
  'https://duckduckgo.com/*',
  'https://www.ecosia.org/*',
  'https://search.brave.com/*',
  'https://www.startpage.com/*',
  'https://www.google.com/*',
  'https://www.google.hu/*',
  'https://www.google.de/*',
  'https://www.google.at/*',
  'https://www.google.ch/*',
  'https://www.google.co.uk/*',
  'https://www.google.fr/*',
  'https://www.google.it/*',
  'https://www.google.es/*',
  'https://www.google.nl/*',
  'https://www.google.be/*',
  'https://www.google.pl/*',
  'https://www.google.cz/*',
  'https://www.google.sk/*',
  'https://www.google.ro/*',
  'https://www.google.se/*',
  'https://www.google.dk/*',
  'https://www.google.fi/*',
  'https://www.google.no/*',
  'https://www.google.pt/*',
  'https://www.google.ie/*',
  'https://www.google.gr/*',
];

/** The query box on every covered engine. */
export const SEARCH_INPUT_SELECTOR = [
  'textarea[name="q"]',
  'input[name="q"]',
  'input[name="query"]',
  'input[type="search"]',
].join(', ');

/** Id of the dynamically registered search content script. */
export const SEARCH_CONTENT_SCRIPT_ID = 'pg-search-protection';
