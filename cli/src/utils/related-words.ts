/**
 * Related-word suggestions from Datamuse (free, no API key).
 * `ml=` means "means like": synonyms plus close associations.
 */
const DATAMUSE_URL = "https://api.datamuse.com/words";
const MAX_WORDS = 30;

const cache = new Map<string, string[]>();

export async function fetchRelatedWords(word: string): Promise<string[]> {
  const cached = cache.get(word);
  if (cached) return cached;

  const res = await fetch(`${DATAMUSE_URL}?ml=${encodeURIComponent(word)}&max=60`);
  if (!res.ok) throw new Error(`Datamuse responded ${res.status}`);
  const data = (await res.json()) as { word: string }[];

  const seen = new Set<string>([word]);
  const related: string[] = [];
  for (const entry of data) {
    if (/^[a-z]{3,12}$/.test(entry.word) && !seen.has(entry.word)) {
      seen.add(entry.word);
      related.push(entry.word);
    }
  }

  const words = [word, ...related].slice(0, MAX_WORDS);
  cache.set(word, words);
  return words;
}
