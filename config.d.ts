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
       * Optional database override for history storage. Defaults to the
       * Backstage database service when omitted.
       */
      database?: {
        /**
         * Knex database client name. Defaults to pg.
         */
        client?: string;

        /**
         * Knex connection string or connection object for the history database.
         *
         * @visibility secret
         * @deepVisibility secret
         */
        connection?: string | { [key: string]: unknown };
      };

      /**
       * Provider-layer capture settings. This gates recording performed by the
       * HistoryRecordingEntityProvider wrapper; wiring is handled where
       * providers are registered. Defaults to true.
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
