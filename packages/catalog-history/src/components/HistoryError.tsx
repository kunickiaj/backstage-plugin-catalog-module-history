/** @jsxRuntime automatic */
import { Alert, Button } from '@backstage/ui';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';

function message(error: unknown, detail: boolean) {
  if (!(error instanceof CatalogHistoryApiError))
    return 'History could not be loaded. Try again.';
  if (error.status === 401) return 'Sign in again, then retry loading history.';
  if (error.status === 403)
    return 'You do not have permission to read this history. Contact your administrator.';
  if (error.status === 501)
    return 'Cross-entity history is not supported by this installation. Ask your administrator to upgrade the history backend or configure a history API that supports browsing all entities.';
  if (error.status === 404 && detail)
    return 'This recorded event is no longer available. Refresh the timeline.';
  if (error.status === 404)
    return 'History is unavailable. Ask your administrator to check that the history backend is enabled.';
  return 'History could not be loaded. Try again.';
}

export function HistoryError(props: {
  error: unknown;
  detail?: boolean;
  onRetry: () => void;
}) {
  return (
    <Alert
      role="alert"
      status="danger"
      title="History request failed"
      description={message(props.error, props.detail ?? false)}
      customActions={
        <Button variant="secondary" onPress={props.onRetry}>
          Retry
        </Button>
      }
    />
  );
}
