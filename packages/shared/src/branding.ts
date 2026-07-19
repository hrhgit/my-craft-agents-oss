/**
 * Centralized branding assets for Mortise
 * Used by OAuth callback pages
 */

export const MORTISE_LOGO = [
  ' __  __            _   _          ',
  '|  \\/  | ___  _ __| |_(_)___  ___ ',
  '| |\\/| |/ _ \\| `__| __| / __|/ _ \\',
  '| |  | | (_) | |  | |_| \\__ \\  __/',
  '|_|  |_|\\___/|_|   \\__|_|___/\\___|',
] as const;

/** Logo as a single string for HTML templates */
export const MORTISE_LOGO_HTML = MORTISE_LOGO.map((line) => line.trimEnd()).join('\n');

export const MORTISE_REPOSITORY_URL = 'https://github.com/hrhgit/mortise';
export const MORTISE_DOCS_URL = `${MORTISE_REPOSITORY_URL}/tree/main/apps/electron/resources/docs`;
