import { invalidQuery } from './query-values.js';

const MAX_REGEX_LENGTH = 4096;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertLiteralPattern = (pattern, flags) => {
  if (
    typeof pattern !== 'string' ||
    pattern.length > MAX_REGEX_LENGTH ||
    pattern.includes('\0') ||
    !['', 'i'].includes(flags)
  ) {
    invalidQuery('Only literal regex patterns without NUL and the i flag are supported');
  }
};

// Accept only escaped literal patterns. Anchors keep Mongo's regex semantics (including $).
export const parseLiteralRegex = (pattern, flags = '') => {
  assertLiteralPattern(pattern, flags);
  let start = false;
  let end = false;
  let literal = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '^' && index === 0) {
      start = true;
    } else if (char === '$' && index === pattern.length - 1) {
      end = true;
    } else if (char === '\\') {
      const escaped = pattern[++index];
      if (!escaped || !'.*+?^${}()|[]\\'.includes(escaped)) {
        invalidQuery('Unsupported regex escape');
      }
      literal += escaped;
    } else {
      if ('.*+?^${}()|[]'.includes(char)) {
        invalidQuery('Only escaped literal regex patterns are supported');
      }
      literal += char;
    }
  }
  return { pattern: (start ? '^' : '') + escapeRegex(literal) + (end ? '$' : ''), flags };
};
