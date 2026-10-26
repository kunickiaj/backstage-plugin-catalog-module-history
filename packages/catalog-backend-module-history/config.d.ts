export interface Config {
  /**
   * Configuration for catalog history capture and storage.
   */
  catalog?: {
    /**
     * Catalog history module configuration.
     */
    history?: {
      /**
       * Master switch for the catalog history module. Set to false to skip
       * schema bootstrap entirely.
       */
      enabled?: boolean;

      /** Authenticated history reads with Backstage permission checks. */
      api?: {
        /** Enables timeline and version routes. Defaults to false. */
        enabled?: boolean;
        /**
         * Per-SQL-statement history read timeout in milliseconds for the default
         * PostgreSQL store only. Defaults to 10000; must be an integer from 0
         * through 2147483647. A stricter existing database timeout still applies.
         * Set to 0 to disable the plugin limit without changing host limits.
         * Does not limit pool acquisition, schema setup, mapping, transaction
         * cleanup, or the entire HTTP request, and does not apply to custom stores.
         */
        queryTimeoutMs?: number;
      };

      /**
       * Deprecated compatibility database override for history storage.
       *
       * Prefer registering a custom `historyStoreServiceRef` factory in your
       * backend instead. That lets provider wrappers, processor capture, and
       * scheduled reconciliation all receive the same store through Backstage
       * DI at creation time.
       *
       * The default `historyStoreServiceFactory` honors this override for all
       * consumers of `historyStoreServiceRef`, including provider wrappers
       * that inject the same store in their own catalog module.
       */
      database?: {
        /**
         * Knex database client name. Defaults to pg.
         */
        client?: string;

        /**
         * Knex connection string or connection object for the history
         * database. Required when the `database` block is present — the
         * default store factory uses it to open the override connection.
         *
         * @visibility secret
         * @deepVisibility secret
         */
        connection: string | { [key: string]: unknown };
      };

      /**
       * Provider-layer capture settings.
       *
       * IMPORTANT: this key is advisory — the backend module cannot enforce
       * it, because provider wrapping happens in your own backend wiring.
       * You must thread it into the wrapper yourself along with the injected
       * history store, e.g.
       * `new HistoryRecordingEntityProvider({ ..., enabled:
       * config.getOptionalBoolean('catalog.history.provider.enabled') ??
       * true })`. Setting it in app-config without that wiring has no
       * effect beyond a startup log line.
       */
      provider?: {
        /**
         * Enables provider-layer history recording. Defaults to true.
         */
        enabled?: boolean;
      };

      /**
       * Processor-layer capture settings. Defaults to false because processor
       * capture runs once per entity per processing cycle.
       */
      processing?: {
        /**
         * Enables processor-layer history capture. Defaults to false.
         */
        enabled?: boolean;
      };

      /**
       * In-process reconciler settings. Defaults to disabled. When enabled
       * without an explicit schedule, the task runs hourly with a 10 minute
       * timeout and a 30 second initial delay.
       */
      reconciler?: {
        /**
         * Enables scheduled in-process reconciliation. Defaults to false.
         */
        enabled?: boolean;

        /**
         * Scheduler configuration for in-process reconciliation. The shape
         * follows Backstage's SchedulerServiceTaskScheduleDefinition config
         * format; omit it to use the default hourly schedule, 10 minute
         * timeout, and 30 second initial delay.
         *
         * Keys you omit inherit those defaults, so `frequency` alone keeps the
         * 10 minute timeout and 30 second initial delay. Set `initialDelay`
         * to `{ seconds: 0 }` to start without a delay.
         */
        schedule?: {
          /**
           * Reconciler schedule frequency. Uses Backstage scheduler duration
           * configuration objects, string durations, cron objects, or manual
           * trigger config supported by SchedulerServiceTaskScheduleDefinition.
           */
          frequency?: string | { [key: string]: unknown };

          /**
           * Reconciler task timeout. Uses Backstage scheduler duration
           * configuration objects or string durations.
           */
          timeout?: string | { [key: string]: unknown };

          /**
           * Reconciler initial delay. Uses Backstage scheduler duration
           * configuration objects or string durations.
           */
          initialDelay?: string | { [key: string]: unknown };
        };
      };

      /**
       * Scheduled history retention. Defaults to disabled. When enabled, one
       * backend replica runs the `catalog-history-retention` task. Retention
       * keeps the newest row of each entity capture stream unless every stream
       * of that entity ended in a delete before the cutoff. It also removes
       * cycles that finished before the cutoff and have no rows. The history
       * store must implement `planRetention` and `applyRetention`, or startup
       * fails.
       */
      retention?: {
        /**
         * Enables scheduled retention. Defaults to false. When false, the
         * module schedules nothing and reads no other retention keys.
         */
        enabled?: boolean;

        /**
         * How long to keep history. Required when retention is enabled and
         * must be at least 1 day. Each run removes eligible history recorded
         * before now minus this duration. Accepts a duration object such as
         * `{ days: 90 }` or a string such as `P90D`.
         */
        maxAge?: string | { [key: string]: unknown };

        /**
         * When true, each run only counts what it would remove and logs the
         * counts. Set to false to delete. Defaults to true.
         */
        dryRun?: boolean;

        /**
         * Maximum rows or cycles removed per transaction when deleting.
         * Must be an integer from 1 through 10000. Defaults to 1000.
         */
        batchSize?: number;

        /**
         * Scheduler configuration for retention. The shape follows Backstage's
         * SchedulerServiceTaskScheduleDefinition config format. Omitted keys
         * use the defaults: every 24 hours, a 1 hour timeout, and a 5 minute
         * initial delay.
         */
        schedule?: {
          /** Retention schedule frequency. Defaults to `{ hours: 24 }`. */
          frequency?: string | { [key: string]: unknown };

          /** Retention task timeout. Defaults to `{ hours: 1 }`. */
          timeout?: string | { [key: string]: unknown };

          /** Retention initial delay. Defaults to `{ minutes: 5 }`. */
          initialDelay?: string | { [key: string]: unknown };
        };
      };
    };
  };
}
