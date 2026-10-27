/** @jsxRuntime automatic */
import { useMemo, useState } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { Box, Text } from '@backstage/ui';
import { useSearchParams } from 'react-router-dom';
import { catalogHistoryApiRef } from '../api/CatalogHistoryApi';
import type { HistoryFiltersValue } from './HistoryFilters';
import { HistoryFilters } from './HistoryFilters';
import { HistoryTimeline } from './HistoryTimeline';
import { HistoryCycleView } from './HistoryCycleView';
import {
  formatComparisonParam,
  type HistoryComparisonTarget,
  parseComparisonParams,
} from './comparisonTarget';
import styles from './History.module.css';

/** Browse recorded changes across catalog entities, including deleted entities. @public */
export function CatalogHistoryPage() {
  const api = useApi(catalogHistoryApiRef);
  const [filters, setFilters] = useState<HistoryFiltersValue>({});
  const [params, setParams] = useSearchParams();
  const cycleId = params.get('cycleId');
  // Keep one request per applied filter set. The timeline reloads when the
  // request changes, and comparison URL updates rerender this page.
  const request = useMemo(() => ({ ...filters, limit: 25 }), [filters]);
  const comparison = parseComparisonParams(params);
  // Keep a comparison in the URL so an audit link opens the same pair.
  const setComparison = (target?: HistoryComparisonTarget) => {
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        if (target) {
          next.set('compare', formatComparisonParam(target));
          next.set('compareRef', target.entityRef);
        } else {
          next.delete('compare');
          next.delete('compareRef');
        }
        return next;
      },
      { replace: true },
    );
  };
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
              comparison={comparison}
              onComparisonChange={setComparison}
            />
          )}
        </Box>
      </div>
    </>
  );
}
