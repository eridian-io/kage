/**
 * R114: which shell start-up files get the PATH line. install.sh adds the line by this same rule
 * (its `add_path` calls), and doctor's advice names the same files; install-sh.test.ts runs
 * install.sh against this function so the two stay in step.
 *
 * - zsh (the macOS default): `${ZDOTDIR:-$HOME}/.zshrc`.
 * - bash: `~/.bashrc` for interactive shells, plus the login file bash reads: `~/.bash_profile`
 *   when there is one (bash then skips `~/.profile`), else `~/.profile`.
 * - anything else: `~/.profile`.
 */

import { posix } from 'node:path';

export interface RcInput {
  /** The user's login shell ($SHELL). */
  shell: string | undefined;
  home: string;
  /** zsh's ZDOTDIR, when set. */
  zdotdir?: string | undefined;
  /** Whether `~/.bash_profile` exists. */
  hasBashProfile: boolean;
}

/** The files the PATH line goes into, in the order install.sh writes them. */
export function pathRcFiles(o: RcInput): string[] {
  const shell = posix.basename(o.shell ?? '');
  if (shell === 'zsh') return [posix.join(o.zdotdir || o.home, '.zshrc')];
  if (shell === 'bash') {
    return [
      posix.join(o.home, '.bashrc'),
      posix.join(o.home, o.hasBashProfile ? '.bash_profile' : '.profile'),
    ];
  }
  return [posix.join(o.home, '.profile')];
}

/** The line itself, exactly as install.sh writes it. */
export function pathLine(dir: string): string {
  return `export PATH="${dir}:$PATH"`;
}

/** Doctor's advice: the command that adds the line to `files` (shown as the user would type them). */
export function pathAdvice(dir: string, files: string[]): string {
  const line = `'${pathLine(dir)}'`;
  const add =
    files.length === 1 ? `echo ${line} >> ${files[0]}` : `echo ${line} | tee -a ${files.join(' ')}`;
  return `Add ${dir} to your PATH: ${add}`;
}
