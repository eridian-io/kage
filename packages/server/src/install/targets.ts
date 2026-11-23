/**
 * The release targets and file names (phase 6, F4). A light module, built-ins free: `kage update`
 * (in the shipped bundle and the SEA) and the release build both read it, so esbuild, which only
 * release/build.ts needs, never reaches kage.mjs or the SEA through it.
 *
 * The names are what install.sh and `kage update` download, so they never change:
 * `kage-<target>.gz`, `eridian-io-kage-<version>.tgz`, `VERSION` and `SHA256SUMS`.
 */

export type Target = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';

/** Every target a release ships, in the order the release lists them. */
export const TARGETS: readonly Target[] = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
];

/** The npm package's name. */
export const NPM_NAME = '@eridian-io/kage';

/** The checksums file: `<sha256>  <name>` lines, the format `sha256sum -c` reads. */
export const SUMS_FILE = 'SHA256SUMS';

/** The release's version, one line: `<version>\n`. */
export const VERSION_FILE = 'VERSION';

/** The target this machine runs, or null where Kage ships no single executable (Windows). */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Target | null {
  if (platform !== 'linux' && platform !== 'darwin') return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  return `${platform}-${arch}`;
}

/** The single executable's release file: `kage-<target>.gz`. */
export function assetName(t: Target): string {
  return `kage-${t}.gz`;
}

/** The npm package's file as `npm pack` names it: `eridian-io-kage-<version>.tgz`. */
export function npmTarball(version: string): string {
  return `eridian-io-kage-${version}.tgz`;
}
