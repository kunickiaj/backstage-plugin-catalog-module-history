/** @jsxRuntime automatic */
import { Alert, Button } from '@backstage/ui';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';

function message(error: unknown) {
  if (!(error instanceof CatalogHistoryApiError))
    return 'The recording cycle could not be loaded. Try again.';
  switch (error.status) {
    case 401:
      return 'Sign in again, then retry loading this recording cycle.';
    case 403:
      return 'You do not have permission to read this recording cycle. Contact your administrator.';
    case 404:
      return 'This recording cycle is unavailable. Refresh history or check whether this installation supports cycle details.';
    case 501:
      return 'Recording cycle details are not supported by this installation. Ask your administrator to upgrade the history backend or configure an API that supports recording cycles.';
    default:
      return 'The recording cycle could not be loaded. Try again.';
  }
}

export function HistoryCycleError(props: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Alert
      role="alert"
      status="danger"
      title="Recording cycle unavailable"
      description={message(props.error)}
      customActions={
        <Button type="button" variant="secondary" onPress={props.onRetry}>
          Retry
        </Button>
      }
    />
  );
}
