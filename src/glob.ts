/**
 * Convert a glob pattern to a RegExp anchored to the full string.
 *
 * Supported:
 *   *  — matches any sequence of characters (including empty)
 *   ?  — matches exactly one character
 *
 * All other regex special characters are escaped so they are treated literally.
 */
export function globToRegex(pattern: string): RegExp {
  // Escape all regex metacharacters except * and ?
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Convert glob wildcards to regex equivalents
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`);
}
