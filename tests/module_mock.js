// node:test replaced mock.module()'s defaultExport/namedExports with a single
// exports option. Releases without it accept the new option but silently drop
// it, leaving the mock with no exports at all, so the call has to be shaped up
// front rather than feature-detected from the result.
//
// The option reached each release line separately, so a plain "newer than"
// comparison does not hold: 24.15.0 has it while the earlier-branched 25.0.0
// does not. Every line needs its own floor.
const [major, minor] = process.versions.node.split('.').map(Number);
const supportsExports = major >= 26 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);

// Callers keep invoking mock.module() themselves so that relative specifiers
// still resolve against the test file rather than this module.
export function mockExports(exports) {
  if (supportsExports) return { exports };

  const { default: defaultExport, ...namedExports } = exports;
  const options = {};
  if (defaultExport !== undefined) options.defaultExport = defaultExport;
  if (Object.keys(namedExports).length > 0) options.namedExports = namedExports;
  return options;
}
