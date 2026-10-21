/**
 * @file The roll-off and retention numbers (how long until deleted, backups), as plain data so the website,
 * FAQ, legal pages and portal can show the same numbers the server uses (lib/rolloff.ts re-exports them).
 * No imports, safe in client components.
 */

/** Days until a group is deleted when nobody picks a date. */
export const GROUP_DEFAULT_DAYS = 30;
/** Fewest days' notice for ending a group (time to export and to tell the client). */
export const MIN_GROUP_DAYS = 7;
/** Most days ahead a deletion can be scheduled. */
export const MAX_ROLLOFF_DAYS = 365;
/** Days an organization stays read-only (with export) after its plan ends, before everything is deleted. */
export const ORG_GRACE_DAYS = 30;
/** Azure Database for PostgreSQL keeps backups this many days (docs/HOSTING.md); then deleted data is gone from them too. */
export const BACKUP_RETENTION_DAYS = 35;
