import { describe, expect, it } from 'vitest';
import {
  markedPathLines,
  PATH_MARKER,
  pathAdvice,
  pathLine,
  pathRcFiles,
  rcCandidates,
} from './path-rc.ts';

describe('pathRcFiles (R114)', () => {
  const base = { home: '/home/u', hasBashProfile: false };

  it('zsh: ~/.zshrc, or $ZDOTDIR/.zshrc', () => {
    expect(pathRcFiles({ ...base, shell: '/bin/zsh' })).toEqual(['/home/u/.zshrc']);
    expect(pathRcFiles({ ...base, shell: '/bin/zsh', zdotdir: '/home/u/.config/zsh' })).toEqual([
      '/home/u/.config/zsh/.zshrc',
    ]);
  });

  it('bash: ~/.bashrc plus ~/.bash_profile when there is one, else ~/.profile', () => {
    expect(pathRcFiles({ ...base, shell: '/usr/bin/bash' })).toEqual([
      '/home/u/.bashrc',
      '/home/u/.profile',
    ]);
    expect(pathRcFiles({ ...base, shell: '/bin/bash', hasBashProfile: true })).toEqual([
      '/home/u/.bashrc',
      '/home/u/.bash_profile',
    ]);
  });

  it('any other shell, or none: ~/.profile', () => {
    for (const shell of ['/usr/bin/fish', '/bin/sh', '/bin/dash', '', undefined]) {
      expect(pathRcFiles({ ...base, shell })).toEqual(['/home/u/.profile']);
    }
  });

  it('R120: every candidate file, and the marked lines in one', () => {
    expect(rcCandidates('/home/u')).toEqual([
      '/home/u/.zshrc',
      '/home/u/.bashrc',
      '/home/u/.bash_profile',
      '/home/u/.profile',
    ]);
    expect(rcCandidates('/home/u', '/z')[0]).toBe('/z/.zshrc');
    expect(rcCandidates('/home/u', '/z')).toHaveLength(5);
    const text = [
      'a',
      PATH_MARKER,
      pathLine('/d'),
      PATH_MARKER,
      'echo not ours',
      '',
      PATH_MARKER,
      pathLine('/e'),
    ].join('\n');
    expect(markedPathLines(text)).toEqual([
      [2, 3],
      [7, 8],
    ]);
    expect(markedPathLines(text.replaceAll('\n', '\r\n'))).toEqual([
      [2, 3],
      [7, 8],
    ]);
  });

  it('the line and the advice', () => {
    expect(pathLine('/home/u/.local/bin')).toBe('export PATH="/home/u/.local/bin:$PATH"');
    expect(pathAdvice('/d', ['~/.zshrc'])).toBe(
      `Add /d to your PATH: echo 'export PATH="/d:$PATH"' >> ~/.zshrc`,
    );
    expect(pathAdvice('/d', ['~/.bashrc', '~/.profile'])).toBe(
      `Add /d to your PATH: echo 'export PATH="/d:$PATH"' | tee -a ~/.bashrc ~/.profile`,
    );
  });
});
