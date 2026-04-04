const abbreviations: Record<string, string> = {
  st: 'street',
  ave: 'avenue',
  blvd: 'boulevard',
  dr: 'drive',
  ln: 'lane',
  ct: 'court',
  rd: 'road',
  pl: 'place',
  cir: 'circle',
};

/**
 * Normalize an address string for use as a cache key.
 * - Lowercase and trim
 * - Expand common abbreviations
 * - Strip punctuation (commas, periods, hashes)
 * - Collapse multiple spaces to single space
 */
export function normalizeAddress(address: string): string {
  let result = address.toLowerCase().trim();

  // Strip punctuation: commas, periods, hashes
  result = result.replace(/[.,#]/g, '');

  // Collapse multiple spaces to single space
  result = result.replace(/\s+/g, ' ');

  // Expand abbreviations (word-boundary match)
  result = result
    .split(' ')
    .map((word) => abbreviations[word] ?? word)
    .join(' ');

  return result;
}
