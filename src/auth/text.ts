/**
 * Untrusted strings on their way into a log line or onto an HTML page.
 *
 * Both destinations have a structure an attacker would otherwise get to write.
 * A log file is line-oriented and is read by fail2ban and log shippers, so a
 * newline inside a value forges a whole record; the consent page is read by a
 * human, so a few thousand characters of prose push the parts that matter out
 * of view.
 */

/** Long enough for a real client_id, short enough to keep one line one line. */
const MAX_LOGGED_LENGTH = 200;
/** A name, not a paragraph. */
const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * A value that cannot forge a log record.
 *
 * Control characters become visible escapes rather than disappearing, so an
 * attempt shows up in the log instead of being silently normalised away, and
 * the result is capped: `client_id` is only bounded by the request line, and
 * the log file has no rotation of its own.
 *
 * Deliberately applied at the interpolation sites rather than centrally in
 * `installFileLogging`: a stack trace is legitimately multi-line and has to
 * stay readable.
 */
export function logSafe(value: unknown, maxLength = MAX_LOGGED_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  // Cc and Cf are the control and format characters; Zl and Zp are the two
  // invisible separators that a log viewer may still render as a line break.
  const escaped = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, character => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0xff ? `\\u{${code.toString(16)}}` : `\\x${code.toString(16).padStart(2, '0')}`;
  });
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}

/**
 * A self-declared client name the login and consent pages can show without the
 * name becoming the page. Escaping alone is not enough: the text is still
 * rendered, and a name carrying newlines and a few hundred characters of
 * instructions scrolls the redirect target and the loopback warning off the
 * screen. Undefined when nothing usable is left.
 */
export function clampDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_DISPLAY_NAME_LENGTH ? `${collapsed.slice(0, MAX_DISPLAY_NAME_LENGTH)}…` : collapsed;
}
