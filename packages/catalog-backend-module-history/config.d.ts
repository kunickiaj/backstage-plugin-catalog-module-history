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
         * When set, `frequency` and `timeout` are both required (Backstage's
         * schedule parser rejects partial definitions at startup); the
         * defaults above apply only when the whole `schedule` key is omitted.
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
    };
  };
}
