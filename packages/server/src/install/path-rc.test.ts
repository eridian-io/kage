import { describe, expect, it } from 'vitest';
import { pathAdvice, pathLine, pathRcFiles } from './path-rc.ts';

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
