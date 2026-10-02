// A cross-realm RegExp fails `instanceof RegExp` but keeps this tag.
const isRegExp = (value) => Object.prototype.toString.call(value) === '[object RegExp]';

/** Private RegExp copy shared by `validators.pattern()` and `createPatternStringScalar()`; not a published subpath. */
export const compilePattern = (pattern) => {
  if (typeof pattern !== 'string' && !isRegExp(pattern)) {
    throw new TypeError('pattern must be a RegExp or a string');
  }
  return new RegExp(pattern);
};

/** Tests each value from its first character, so `g` and `y` keep no state between values. */
export const matchesPattern = (regex, value) => {
  regex.lastIndex = 0;
  return regex.test(value);
};
