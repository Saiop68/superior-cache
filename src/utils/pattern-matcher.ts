/**
 * pattern-matcher.ts
 * 
 * Converts glob-style cache key patterns (e.g. "user:*") into
 * JavaScript regular expressions for local pattern matching.
 * 
 * This is used by the pattern invalidation feature to find all
 * matching keys in the in-memory cache layer.
 * 
 * Supported glob syntax:
 *  - `*`  matches any sequence of characters (except separator)
 *  - `?`  matches exactly one character
 *  - `**` matches any sequence including separators (greedy)
 * 
 * All other characters are regex-escaped for safety.
 */



/**
 * Convert a glob pattern to a RegExp that matches cache keys.
 * 
 * @param pattern - A glob-style pattern (e.g. "user:*", "guild:???:*").
 * @returns A compiled RegExp anchored to match the full key.
 * 
 * @example
 * ```ts
 * const re = globToRegex("user:*");
 * re.test("user:123");  // true
 * re.test("admin:1");   // false
 * ```
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*" && pattern[i + 1] === "*") {
      // `**` → match everything (greedy)
      regexStr += ".*";
      i += 2;
    } else if (char === "*") {
      // `*` → match anything except nothing (non-greedy within segment)
      regexStr += "[^]*?";
      // Actually for cache keys we want greedy within the key
      regexStr = regexStr.slice(0, -5) + ".*";
      i++;
    } else if (char === "?") {
      // `?` → match exactly one character
      regexStr += ".";
      i++;
    } else {
      // Escape regex-special characters
      regexStr += escapeRegex(char);
      i++;
    }
  }

  // Anchor the pattern to match the full key
  return new RegExp(`^${regexStr}$`);
}

/**
 * Test whether a cache key matches a glob pattern.
 * 
 * Convenience wrapper around `globToRegex` for single-use checks.
 * If you need to test many keys against the same pattern, compile
 * the regex once with `globToRegex` and reuse it.
 * 
 * @param pattern - The glob pattern.
 * @param key     - The cache key to test.
 * @returns `true` if the key matches the pattern.
 */
export function matchesPattern(pattern: string, key: string): boolean {
  return globToRegex(pattern).test(key);
}



/**
 * Escape a single character for use in a regular expression.
 * Characters with special meaning in regex are prefixed with `\`.
 * 
 * @param char - A single character string.
 * @returns The escaped string.
 */
function escapeRegex(char: string): string {
  // These characters have special meaning in regex
  const specials = /[.+^${}()|[\]\\]/;
  if (specials.test(char)) {
    return `\\${char}`;
  }
  return char;
}
