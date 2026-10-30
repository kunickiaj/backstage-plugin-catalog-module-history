// A separate OS process must execute production TypeScript, without Jest's module
// registry or transforms. Workspace packages already resolve to their src entries.
const fs = require('node:fs');
const path = require('node:path');
// The repository root owns the test-only compiler dependency.
// eslint-disable-next-line @backstage/no-undeclared-imports
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(outputText, filename);
};

const { knex } = require('knex');
const { PostgresHistoryStore } = require('../PostgresHistoryStore.ts');

const { HistoryRecordingEntityProvider } = require(
  path.resolve(
    // This fixture intentionally executes checked-out sources, never a build.
    // eslint-disable-next-line no-restricted-syntax
    __dirname,
    '../../../../catalog-backend-module-history/src/provider/HistoryRecordingEntityProvider.ts',
  ),
);

const send = message => process.send(message);
let release;
const released = new Promise(resolve => {
  release = resolve;
});
process.on('message', message => {
  if (message.type === 'release') release();
  if (message.type === 'start')
    run(message).catch(error => {
      send({ type: 'error', message: error.stack });
      process.exitCode = 1;
      process.disconnect();
    });
});

async function run({
  connection,
  provider,
  version,
  pause,
  mutationType,
  failForward,
}) {
  const db = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  // Observe actual PostgreSQL lock attempts in this isolated process. The
  // second attempt proves that a real five-second timeout already occurred.
  const client = db.client.driver.Client;
  const query = client.prototype.query;
  let attempts = 0;
  client.prototype.query = function observeLockQuery(...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (sql?.includes('pg_advisory_xact_lock')) {
      attempts++;
      send({ type: attempts === 1 ? 'lock-attempt' : 'lock-retry' });
      const index = args.length - 1;
      const callback = args[index];
      if (typeof callback === 'function') {
        args[index] = (error, ...result) => {
          if (error && ['55P03', '57014'].includes(error.code)) {
            send({ type: 'lock-timeout' });
          }
          callback(error, ...result);
        };
      }
    }
    return query.apply(this, args);
  };
  const store = new PostgresHistoryStore(db);
  await store.ensureReady();
  if (pause) {
    // Also pause legacy uncoordinated reads so reverting wrapper coordination
    // reproduces overtaking, rather than merely missing the IPC barrier.
    const read = store.loadCurrentEtags.bind(store);
    store.loadCurrentEtags = async (...args) => {
      send({ type: 'baseline' });
      await released;
      return read(...args);
    };
    const coordinate = store.withProviderMutation.bind(store);
    store.withProviderMutation = (name, work) =>
      coordinate(name, scoped =>
        work({
          ...scoped,
          loadCurrentEtags: async (...args) => {
            // Pause the OLD full only after its catalog mutation was accepted. This
            // is the first baseline read, the original cross-instance race window.
            send({ type: 'baseline' });
            await released;
            return scoped.loadCurrentEtags(...args);
          },
        }),
      );
  }
  let wrapped;
  const inner = {
    getProviderName: () => provider,
    connect: async connectionToUse => {
      wrapped = connectionToUse;
    },
  };
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map(name => [name, () => {}]),
  );
  logger.error = (message, error) =>
    send({
      type: 'recording-error',
      message: `${message}: ${error?.message ?? String(error ?? '')}`,
    });
  logger.child = () => logger;
  const wrapper = new HistoryRecordingEntityProvider({ inner, store, logger });
  await wrapper.connect({
    refresh: async () => {},
    applyMutation: async mutation => {
      if (failForward) throw new Error('synthetic catalog rejected mutation');
      const entities =
        mutation.type === 'full' ? mutation.entities : mutation.added;
      await db('synthetic_catalog')
        .insert({ provider, version: entities[0].entity.metadata.etag })
        .onConflict('provider')
        .merge();
      send({ type: 'accepted' });
    },
  });
  send({ type: 'attempting' });
  const entry = {
    entity: {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'example', namespace: 'default', etag: version },
      spec: { type: 'service' },
    },
    locationKey: provider,
  };
  try {
    await wrapped.applyMutation(
      mutationType === 'full'
        ? { type: 'full', entities: [entry] }
        : { type: 'delta', added: [entry], removed: [] },
    );
    send({ type: 'done' });
  } catch (error) {
    send({ type: 'rejected', message: error.message });
  } finally {
    await store.shutdown();
    await db.destroy();
    process.disconnect();
  }
}
