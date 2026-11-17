// Helpers for tests whose fixtures write named values bare (the old shape): the loader warns about each, and its messages
// name people, roles and apps with their kind. Run on both a golden warning (recorded before values said their kind) and a
// loaded one, `unkinded` puts them in one form, so the comparison is about everything else the message says.

/** The warning a bare person, role or app gets. */
export const isValueWarning = (w: string): boolean => w.includes('a value says its kind')

/** A message with the kind taken off every person, role and app it names (`app:sales` and `app sales` both read `sales`). */
export const unkinded = (w: string): string => w
  .replace(/\b(app|person|role):(?=[\w<])/g, '')
  .replace(/\(role "([^"]+)"\)/g, '($1)')
  .replace(/\bapp (?=\w)/g, '')
