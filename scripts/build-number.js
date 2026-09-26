const fs = require('fs');
const path = require('path');

/**
 * Local build counter appended to the manifest version of dev builds
 * (`0.5.0` -> `0.5.0.42`), so a reloaded unpacked extension shows which
 * build it is running (popup header, edge://extensions). The counter lives
 * in a gitignored file and grows by one per build on this machine.
 *
 * Release packages (`package:release`, PG_RELEASE_BUILD=1) keep the plain
 * x.y.z version that the version checks and store listings expect.
 */

const BUILD_NUMBER_FILE = '.build-number';
/** Chrome caps each dotted version part at 65535. */
const MAX_BUILD_NUMBER = 65535;

function readBuildNumber(rootDir) {
  try {
    const value = Number.parseInt(fs.readFileSync(path.join(rootDir, BUILD_NUMBER_FILE), 'utf8').trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Increment the counter and return the new build number. */
function nextBuildNumber(rootDir) {
  const next = readBuildNumber(rootDir) + 1;
  if (next > MAX_BUILD_NUMBER) {
    throw new Error(`Build number ${next} exceeds Chrome's ${MAX_BUILD_NUMBER} limit; delete ${BUILD_NUMBER_FILE} to restart it.`);
  }
  fs.writeFileSync(path.join(rootDir, BUILD_NUMBER_FILE), `${next}\n`);
  return next;
}

function isReleaseBuild(env = process.env) {
  return env.PG_RELEASE_BUILD === '1';
}

/** The manifest version for this build: `base` for releases, `base.N` otherwise. */
function buildManifestVersion(baseVersion, rootDir, env = process.env) {
  if (isReleaseBuild(env)) return baseVersion;
  return `${baseVersion}.${nextBuildNumber(rootDir)}`;
}

module.exports = {
  BUILD_NUMBER_FILE,
  buildManifestVersion,
  isReleaseBuild,
  nextBuildNumber,
  readBuildNumber,
};
