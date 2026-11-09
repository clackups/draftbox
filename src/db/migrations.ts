// Upgrades of the metadata repository layout. schema.json holds the
// version of the data; Context.create runs the missing steps on start,
// each in its own transaction.

import type { MetaStore, Tx } from './store.ts';
import { SCHEMA_VERSION, indexVisibility, revokedSessionDay, type AccessToken, type Repo } from './models.ts';

// What some migrations need to know of the configuration.
export interface MigrationConfig {
  sessionMaxAgeDays: number;
}

// MIGRATIONS[v] upgrades version v to v + 1.
const MIGRATIONS: Record<number, { description: string; run: (tx: Tx, config: MigrationConfig) => Promise<void> }> = {
  1: {
    description: 'Index access tokens by user',
    run: async (tx) => {
      for (const name of await tx.list('tokens')) {
        const token = await tx.get<AccessToken>(`tokens/${name}`);
        if (token) tx.putText(`index/user-tokens/${token.userId}/${token.id}`, token.id);
      }
    },
  },
  2: {
    description: 'Index public repositories',
    run: async (tx) => {
      for (const name of await tx.list('repos')) {
        const repo = await tx.get<Repo>(`repos/${name}`);
        if (repo) indexVisibility(tx, repo);
      }
    },
  },
  3: {
    description: 'Group revoked sessions by issue day',
    run: async (tx, config) => {
      for (const sid of await tx.list('revoked-sessions')) {
        if (!/^[0-9a-f]{32}$/.test(sid)) continue;
        // The entry holds the expiry, which is the issue time plus the
        // session lifetime.
        const until = Date.parse((await tx.getText(`revoked-sessions/${sid}`)) ?? '');
        tx.delete(`revoked-sessions/${sid}`);
        if (until > Date.now()) tx.putText(`revoked-sessions/${revokedSessionDay(until - config.sessionMaxAgeDays * 86400_000)}/${sid}`, '');
      }
    },
  },
};

export async function migrate(store: MetaStore, config: MigrationConfig): Promise<void> {
  for (;;) {
    const version = (await store.view().get<{ version: number }>('schema.json'))?.version ?? 1;
    if (version >= SCHEMA_VERSION) return;
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`no migration from schema version ${version}`);
    await store.transact(`Migrate to schema version ${version + 1}: ${step.description}`, async (tx) => {
      await step.run(tx, config);
      tx.put('schema.json', { version: version + 1 });
    });
  }
}
