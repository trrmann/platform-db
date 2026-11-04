/**
 * Guard against development and preview servers writing to a remote (production) database.
 *
 * Every platform service runs its schema bootstrap on start, so a development or preview
 * server on the production database migrates production (it happened on 2026-11-03).
 * Development and preview must therefore use a local database, or open the remote one
 * read-only (DB_PG_READ_ONLY=true). DB_PG_ALLOW_REMOTE_WRITES=true overrides the guard for a
 * deliberate owner action. Production and other environments are not restricted.
 */

export class DatabaseTargetGuard {
  static LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];
  static GUARDED_ENVIRONMENTS = ['development', 'preview'];
  static OVERRIDE_VARIABLE = 'DB_PG_ALLOW_REMOTE_WRITES';

  /**
   * Whether `config` may be used by a server running in `env`.
   * @param {string} env - NODE_ENV of the server
   * @param {{host: string, readOnly?: boolean}} config - a PostgresDatabase config
   * @param {object} [processEnv]
   * @returns {{allowed: boolean, overridden: boolean}}
   */
  static evaluate(env, config, processEnv = process.env) {
    if (!this.GUARDED_ENVIRONMENTS.includes(env)) return { allowed: true, overridden: false };
    if (this.LOCAL_HOSTS.includes(config.host) || config.readOnly) {
      return { allowed: true, overridden: false };
    }
    const overridden = processEnv[this.OVERRIDE_VARIABLE] === 'true';
    return { allowed: overridden, overridden };
  }

  /**
   * Throw unless `config` may be used in `env`; warn when the override is what allows it.
   * Call it before anything can touch the database (pools connect lazily, so constructing
   * the adapter is fine; a session store or a schema bootstrap is not).
   */
  static assert(env, config, processEnv = process.env) {
    const { allowed, overridden } = this.evaluate(env, config, processEnv);
    if (overridden) {
      console.warn(`⚠️ ${env} server WRITING to remote database ${config.host} (override set)`);
    }
    if (allowed) return;
    throw new Error(
      `Refusing to start a ${env} server on the writable remote database ${config.host}. ` +
        'Use a local database (deploy.sh -dev / -preview, or local-db.sh), or open the remote ' +
        'one read-only with DB_PG_READ_ONLY=true (deploy.sh -preview --remote).'
    );
  }
}

export default DatabaseTargetGuard;
