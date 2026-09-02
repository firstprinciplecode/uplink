import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const WORDLIST_URL =
  "https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-no-swears.txt";
const CACHE_DIR = join(homedir(), ".uplink", "cache");
const CACHE_FILE = join(CACHE_DIR, "words.txt");

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "who",
  "whom",
  "what",
  "which",
  "of",
  "to",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "about",
  "over",
  "after",
  "before",
  "under",
  "between",
  "through",
  "during",
  "without",
  "within",
  "against",
  "among",
  "across",
  "around",
  "behind",
  "beyond",
  "and",
  "or",
  "but",
  "if",
  "because",
  "while",
  "although",
  "whether",
  "than",
  "nor",
  "yet",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "not",
  "no",
  "so",
  "both",
  "each",
  "every",
  "all",
  "any",
  "some",
  "such",
  "only",
  "just",
  "also",
  "very",
  "too",
  "more",
  "most",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "etc",
]);

export interface DomainWordStrategy {
  id: string;
  label: string;
  generate: (words: string[]) => string[];
}

const VOWELS = new Set("aeiou");

function disemvowel(word: string): string {
  return word[0] + [...word.slice(1)].filter((c) => !VOWELS.has(c)).join("");
}

export const BROWSE_STRATEGIES: DomainWordStrategy[] = [
  {
    id: "words",
    label: "dictionary words (alchemy)",
    generate: (words) => words,
  },
  {
    id: "abbrev",
    label: "abbreviated (alchmy, vrtl, sbtl)",
    generate: (words) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const word of words) {
        const short = disemvowel(word);
        if (short !== word && short.length >= 3 && !seen.has(short)) {
          seen.add(short);
          out.push(short);
        }
      }
      return out;
    },
  },
  {
    id: "getx",
    label: "getX (getalchemy)",
    generate: (words) => words.map((w) => `get${w}`),
  },
  {
    id: "tryx",
    label: "tryX (tryalchemy)",
    generate: (words) => words.map((w) => `try${w}`),
  },
];

function filterWords(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const word = line.trim().toLowerCase();
    if (/^[a-z]{4,9}$/.test(word) && !STOPWORDS.has(word)) seen.add(word);
  }
  return [...seen];
}

let wordsPromise: Promise<string[]> | undefined;

async function loadWordsUncached(): Promise<string[]> {
  try {
    const cached = filterWords(await readFile(CACHE_FILE, "utf8"));
    if (cached.length > 0) return cached;
  } catch {
    /* cache miss */
  }

  try {
    const res = await fetch(WORDLIST_URL);
    if (!res.ok) throw new Error(`wordlist fetch failed (${res.status})`);
    const words = filterWords(await res.text());
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, words.join("\n"));
    } catch {
      /* cache is best-effort */
    }
    return words;
  } catch {
    return filterWords(await readFile("/usr/share/dict/words", "utf8"));
  }
}

export function loadDomainWords(): Promise<string[]> {
  wordsPromise ??= loadWordsUncached().catch((error: unknown) => {
    wordsPromise = undefined;
    throw error;
  });
  return wordsPromise;
}
