/**
 * Wording shared by the API's error messages.
 */

/**
 * `"An"` or `"A"` for `word`, chosen by its first letter: "An audiobook", "A
 * film", "An \"Anime\"". Quotes and other punctuation in front are skipped.
 */
export function article(word: string): "A" | "An" {
  const first = /[a-z]/i.exec(word)?.[0].toLowerCase();
  return first !== undefined && "aeiou".includes(first) ? "An" : "A";
}
