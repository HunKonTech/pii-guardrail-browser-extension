const fs = require('fs');
const os = require('os');
const path = require('path');

const { BUILD_NUMBER_FILE, buildManifestVersion, readBuildNumber } = require('../../scripts/build-number');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-build-number-'));
}

describe('buildManifestVersion', () => {
  test('appends a build number that grows by one per build', () => {
    const root = tempRoot();
    expect(buildManifestVersion('0.5.0', root, {})).toBe('0.5.0.1');
    expect(buildManifestVersion('0.5.0', root, {})).toBe('0.5.0.2');
    expect(readBuildNumber(root)).toBe(2);
  });

  test('keeps counting from an existing counter file', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, BUILD_NUMBER_FILE), '41\n');
    expect(buildManifestVersion('0.5.0', root, {})).toBe('0.5.0.42');
  });

  test('release builds keep the plain version and leave the counter alone', () => {
    const root = tempRoot();
    expect(buildManifestVersion('0.5.0', root, { PG_RELEASE_BUILD: '1' })).toBe('0.5.0');
    expect(fs.existsSync(path.join(root, BUILD_NUMBER_FILE))).toBe(false);
  });
});
