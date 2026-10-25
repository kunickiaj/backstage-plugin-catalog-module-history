/** @jsxRuntime automatic */
import { useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { Box, Text } from '@backstage/ui';
import { useSearchParams } from 'react-router-dom';
import { catalogHistoryApiRef } from '../api/CatalogHistoryApi';
import { HistoryFilters, HistoryFiltersValue } from './HistoryFilters';
import { HistoryTimeline } from './HistoryTimeline';
import { HistoryCycleView } from './HistoryCycleView';
import styles from './History.module.css';

/** Browse recorded changes across catalog entities, including deleted entities. @public */
export function CatalogHistoryPage() {
  const api = useApi(catalogHistoryApiRef);
  const [filters, setFilters] = useState<HistoryFiltersValue>({});
  const [params] = useSearchParams();
  const cycleId = params.get('cycleId');
  const request = { ...filters, limit: 25 };
  return (
    <>
      {cycleId !== null && (
        <HistoryCycleView key={cycleId} api={api} cycleId={cycleId} />
      )}
      {/* Preserve exact selections and drafts while cycle navigation hides the form. */}
      <div hidden={cycleId !== null} className={styles.history}>
        <Box p="4" className={styles.history}>
          <Text as="h1" variant="title-small">
            Catalog history
          </Text>
          <p className={styles.description}>
            Recorded changes across all entities, including deleted entities.
            Times show when each capture source recorded a change, not when the
            upstream system changed.
          </p>
          <HistoryFilters
            scope="all"
            onApply={setFilters}
            api={api}
            appliedFilters={filters}
          />
          {cycleId === null && (
            <HistoryTimeline
              key={JSON.stringify(request)}
              scope="all"
              api={api}
              request={request}
            />
          )}
        </Box>
      </div>
    </>
  );
}
