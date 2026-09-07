import crypto from 'node:crypto';

import bcrypt from 'bcryptjs';

/**
 * The one operator credential the HTTP hub has, and what to do when it is
 * missing or unusable.
 *
 * The answer is "nobody can sign in", not "refuse to start". Both keep every
 * token out of reach — approving a client is the only way to one, and approval
 * needs the password — so the security outcome is the same. What differs is
 * what an operator, an inspector or a health check sees: a container that
 * boots, serves `/livez` and the discovery documents, and says loudly in its
 * log and on its login page why nobody can get further, rather than a process
 * that exits before it has said anything. Directory crawlers that start the
 * image without a password to see what it offers (Glama does) fall in the
 * same category as a health check: they need the process, not the login.
 *
 * `PASSWORD_HASH` wins over `PASSWORD` when both are set, and a hash that is
 * not a bcrypt hash disables the login rather than falling back to the
 * plain-text sibling: a hash was configured on purpose, and silently using the
 * weaker variable instead would be a surprise in the wrong direction.
 */

/** `$2a$`, `$2b$` or `$2y$`, a cost of 04–31, then 53 characters of salt+digest. */
const BCRYPT_HASH = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

export interface OperatorCredential {
  /** Whether a login can succeed at all. */
  readonly enabled: boolean;
  /** Why it cannot, for the log and the login page. Absent when it can. */
  readonly problem?: string;
  /** Constant-time for the plain-text variant; bcrypt's own for the hash. */
  check(password: string): boolean;
}

export function operatorCredential(options: { password?: string; passwordHash?: string }): OperatorCredential {
  const hash = options.passwordHash?.trim();
  if (hash) {
    if (!BCRYPT_HASH.test(hash)) {
      return disabled(
        `PASSWORD_HASH is not a bcrypt hash (expected $2a$, $2b$ or $2y$, a cost and 53 characters, ${hash.length} characters given) — the operator login is disabled, no client can be approved`
      );
    }
    return { enabled: true, check: password => bcrypt.compareSync(password, hash) };
  }
  // Trimmed for the test only: a value of whitespace is an unset variable that
  // somebody quoted, not a password. The comparison itself is on the raw value.
  const password = options.password ?? '';
  if (password.trim().length === 0) {
    return disabled('neither PASSWORD_HASH nor PASSWORD is set — the operator login is disabled, no client can be approved');
  }
  const expected = Buffer.from(password);
  return {
    enabled: true,
    check: given => {
      const buffer = Buffer.from(given);
      return buffer.length === expected.length && crypto.timingSafeEqual(buffer, expected);
    }
  };
}

function disabled(problem: string): OperatorCredential {
  return { enabled: false, problem, check: () => false };
}
