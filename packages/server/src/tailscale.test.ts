import { describe, expect, it } from 'vitest';
import { MAC_APP_TAILSCALE, tailscaleCommand } from './tailscale.ts';

/** A fake file system: the executable files that exist. */
const fs =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

describe('tailscaleCommand (R115)', () => {
  it('Linux and others: always the name, nothing looked up', () => {
    const asked: string[] = [];
    const isExecutable = (f: string) => {
      asked.push(f);
      return true;
    };
    expect(tailscaleCommand({ platform: 'linux', path: '/usr/bin', isExecutable })).toBe(
      'tailscale',
    );
    expect(asked).toEqual([]);
  });

  it('macOS with tailscale on PATH: the name', () => {
    expect(
      tailscaleCommand({
        platform: 'darwin',
        path: '/usr/bin:/opt/homebrew/bin',
        isExecutable: fs('/opt/homebrew/bin/tailscale', MAC_APP_TAILSCALE),
      }),
    ).toBe('tailscale');
  });

  it("macOS without it on PATH: the app's CLI when the app is there", () => {
    expect(
      tailscaleCommand({
        platform: 'darwin',
        path: '/usr/bin:/bin',
        isExecutable: fs(MAC_APP_TAILSCALE),
      }),
    ).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  });

  it('macOS with neither: the name (so the caller reports it missing)', () => {
    expect(tailscaleCommand({ platform: 'darwin', path: '/usr/bin', isExecutable: fs() })).toBe(
      'tailscale',
    );
  });

  it('relative PATH entries are skipped', () => {
    expect(
      tailscaleCommand({
        platform: 'darwin',
        path: 'bin:/usr/bin',
        isExecutable: fs('bin/tailscale', MAC_APP_TAILSCALE),
      }),
    ).toBe(MAC_APP_TAILSCALE);
  });
});
