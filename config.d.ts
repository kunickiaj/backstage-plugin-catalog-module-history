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
       * Processor-layer capture settings. Reserved for the future history
       * CatalogProcessor; defaults to false until that feature lands.
       */
      processing?: {
        /**
         * Enables processor-layer history capture once implemented. Defaults to
         * false.
         */
        enabled?: boolean;
      };

      /**
       * In-process reconciler settings. Reserved for a future scheduled
       * reconciliation mode; defaults to disabled until that feature lands.
       */
      reconciler?: {
        /**
         * Enables scheduled in-process reconciliation once implemented.
         * Defaults to false.
         */
        enabled?: boolean;

        /**
         * Scheduler configuration for future in-process reconciliation. The
         * shape follows Backstage's SchedulerServiceTaskScheduleDefinition
         * config format.
         */
        schedule?: {
          /**
           * Future reconciler schedule frequency. Uses Backstage scheduler
           * duration configuration objects.
           */
          frequency?: { [key: string]: unknown };

          /**
           * Future reconciler task timeout. Uses Backstage scheduler duration
           * configuration objects.
           */
          timeout?: { [key: string]: unknown };

          /**
           * Future reconciler initial delay. Uses Backstage scheduler duration
           * configuration objects.
           */
          initialDelay?: { [key: string]: unknown };
        };
      };
    };
  };
}
