/**
 * Formats a display name beautifully.
 * Capitalizes the first letter of the category, except for 'us' which is capitalized as 'US'.
 */
export function formatDisplayName(name: string): string {
  return name.toUpperCase() === 'US' ? 'US' : (name.charAt(0).toUpperCase() + name.slice(1));
}
