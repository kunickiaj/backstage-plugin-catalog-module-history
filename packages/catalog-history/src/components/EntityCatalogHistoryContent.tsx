/** @jsxRuntime automatic */
import { useState } from 'react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { useApi } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { Box, Text } from '@backstage/ui';
import { catalogHistoryApiRef } from '../api/CatalogHistoryApi';
import { HistoryFilters, HistoryFiltersValue } from './HistoryFilters';
import { HistoryTimeline } from './HistoryTimeline';
import styles from './History.module.css';

/** Entity History tab, using the catalog entity context and history API. @public */
export function EntityCatalogHistoryContent() {
  const { entity } = useEntity();
  const entityRef = stringifyEntityRef(entity);
  return <EntityHistory key={entityRef} entityRef={entityRef} />;
}

function EntityHistory({ entityRef }: { entityRef: string }) {
  const api = useApi(catalogHistoryApiRef);
  const [filters, setFilters] = useState<HistoryFiltersValue>({});
  const request = { ...filters, entityRef, limit: 25 };
  return (
    <Box p="4" className={styles.history}>
      <Text as="h2" variant="title-small">
        History
      </Text>
      <p className={styles.description}>
        Events show when each capture source recorded a change, not when the
        upstream system changed.
      </p>
      <HistoryFilters
        onApply={setFilters}
        api={api}
        appliedFilters={filters}
        entityRef={entityRef}
      />
      <HistoryTimeline
        key={JSON.stringify(request)}
        api={api}
        request={request}
      />
    </Box>
  );
}
