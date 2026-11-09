// Upgrades of the metadata repository layout. schema.json holds the
// version of the data; Context.create runs the missing steps on start,
// each in its own transaction.

import type { MetaStore, Tx } from './store.ts';
import { SCHEMA_VERSION, indexVisibility, type AccessToken, type Repo } from './models.ts';

// MIGRATIONS[v] upgrades version v to v + 1.
const MIGRATIONS: Record<number, { description: string; run: (tx: Tx) => Promise<void> }> = {
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
};

export async function migrate(store: MetaStore): Promise<void> {
  for (;;) {
    const version = (await store.view().get<{ version: number }>('schema.json'))?.version ?? 1;
    if (version >= SCHEMA_VERSION) return;
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`no migration from schema version ${version}`);
    await store.transact(`Migrate to schema version ${version + 1}: ${step.description}`, async (tx) => {
      await step.run(tx);
      tx.put('schema.json', { version: version + 1 });
    });
  }
}
