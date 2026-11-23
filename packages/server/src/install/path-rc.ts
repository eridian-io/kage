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

/** The comment install.sh writes on the line above the PATH line (R120: uninstall finds it). */
export const PATH_MARKER = '# Added by the Kage installer.';

/** Every file install.sh may have written to, whatever the shell is now. */
export function rcCandidates(home: string, zdotdir?: string): string[] {
  const files = [
    posix.join(zdotdir || home, '.zshrc'),
    posix.join(home, '.zshrc'),
    posix.join(home, '.bashrc'),
    posix.join(home, '.bash_profile'),
    posix.join(home, '.profile'),
  ];
  return [...new Set(files)];
}

/**
 * The 1-based line numbers of each marker line in a start-up file's text that has install.sh's
 * PATH line right below it: `[marker, line]` pairs.
 */
export function markedPathLines(text: string): [number, number][] {
  const lines = text.split(/\r?\n/);
  const found: [number, number][] = [];
  lines.forEach((l, i) => {
    if (l === PATH_MARKER && /^export PATH=".*:\$PATH"$/.test(lines[i + 1] ?? '')) {
      found.push([i + 1, i + 2]);
    }
  });
  return found;
}
