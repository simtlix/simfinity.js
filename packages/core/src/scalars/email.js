// Accepts exactly the strings matched by /^[^\s@]+@[^\s@]+\.[^\s@]+$/ in linear time. The
// lookahead rejects a domain containing '@' or whitespace before the ambiguous `x.y` split is
// tried, so hostile input such as 'a@' + '.'.repeat(n) + ' ' cannot backtrack quadratically.
const EMAIL_RE = /^[^\s@]+@(?=[^\s@]*$)[^\s@]+\.[^\s@]+$/;

/** Email shape check shared by `validators.email()` and `EmailScalar`; not a published subpath. */
export const isEmailFormat = (value) => EMAIL_RE.test(value);
