import { sanitiseText } from './elicitation.js';

/**
 * A string a child server wrote, on its way into a tool result the model reads.
 *
 * The meta-tools answer with the hub's own words — `list_servers`, `list_tools`
 * and `get_tool_schema` are built from the hub's snapshot — and until now they
 * carried a child's `title`, `description` and error message into that answer
 * untouched. Those are the one channel a child has into a conversation it is
 * not part of: a bidi override reverses the line, a zero-width character hides
 * what a model still reads, an ESC sequence lands in whatever terminal shows
 * the transcript, and a description of any length crowds out the tools next
 * to it. Stripped of the characters that let text lie about its shape (the
 * same set an elicitation prompt loses), and cut to a size that fits the field.
 *
 * Deliberately not applied to `inputSchema`, `outputSchema` or `annotations`:
 * those are documents the client validates against and the hub passes on
 * verbatim by contract — hub-tools.md says whose word they are.
 */
export function childText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const clean = sanitiseText(value);
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, Math.max(0, max - 1));
  // A cut can split a surrogate pair; a lone half serialises as an escape and
  // fails a Python client's UTF-8 encoder.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** What a child's error message may say inside the hub's own error sentence. */
export const MAX_CHILD_ERROR_CHARS = 500;
/** A title or a server's display name. */
export const MAX_CHILD_TITLE_CHARS = 200;
/** A full tool description, as `get_tool_schema` hands it on. */
export const MAX_CHILD_DESCRIPTION_CHARS = 16 * 1024;
