/** @jsxRuntime automatic */
import { useRouteRef } from '@backstage/frontend-plugin-api';
import { Link } from '@backstage/ui';
import { catalogHistoryRouteRef } from '../routes';

export function HistoryCycleLink({ cycleId }: { cycleId: string }) {
  const route = useRouteRef(catalogHistoryRouteRef);
  if (!route) return <>{cycleId}</>;
  const [path, query = ''] = route().split('?');
  const params = new URLSearchParams(query);
  params.set('cycleId', cycleId);
  return (
    <Link
      href={`${path}?${params}`}
      aria-label={`View recording cycle ${cycleId}`}
    >
      {cycleId}
    </Link>
  );
}
