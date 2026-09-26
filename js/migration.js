/**
 * migration.js — Version-stamped, idempotent data migration module.
 *
 * Ensures Firestore documents conform to the current schema.
 * Preserves historical integrity — missing fields stay null, never 0.
 */

import { db, getUserId } from './firebase-config.js';
import { doc, getDoc, setDoc } from './firebase-config.js';

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Run pending migrations on startup.
 */
export async function runMigrations() {
  try {
    const userId = getUserId();
    if (!userId) return;

    const migrationRef = doc(db, 'users', userId, 'settings', 'migrations');
    const snap = await getDoc(migrationRef);
    const lastVersion = snap.exists() ? (snap.data().schema_version || 0) : 0;

    if (lastVersion >= CURRENT_SCHEMA_VERSION) {
      return; // Already up to date
    }

    console.log(`[Migration] Running migrations from v${lastVersion} to v${CURRENT_SCHEMA_VERSION}...`);

    if (lastVersion < 1) {
      await migrateToV1(userId);
    }

    await setDoc(migrationRef, {
      schema_version: CURRENT_SCHEMA_VERSION,
      migrated_at: new Date().toISOString()
    }, { merge: true });

    console.log(`[Migration] Migrations complete. Schema version is now v${CURRENT_SCHEMA_VERSION}.`);
  } catch (e) {
    console.warn('[Migration] Error during migration:', e.message);
  }
}

/**
 * v1 Migration:
 * Ensure saturatedFat semantics are recognized across settings.
 * Historical daily logs and diet plans without saturatedFat remain untouched;
 * missing fields will be interpreted as null (unknown), never 0.
 */
async function migrateToV1(userId) {
  // No destructive modifications to existing daily logs.
  // Legacy documents missing saturatedFat will implicitly resolve to null via nutrition-core.fromLegacy.
  console.log('[Migration v1] Initialised saturatedFat null-by-default schema.');
}
