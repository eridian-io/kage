/**
 * An error line: "Couldn't <what>. <sentence>", the same in every place that shows one. The
 * server's sentence keeps its own words; only a lower-case first letter is raised, since it now
 * starts a sentence ("git couldn't show the diff" → "Git couldn't show the diff").
 */
export function couldnt(what: string, sentence: string): string {
  const s = sentence.trim();
  return `Couldn't ${what}. ${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}
