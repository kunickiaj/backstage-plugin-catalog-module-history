/** @jsxRuntime automatic */
import type { HistoryTimelineItem } from '@kunickiaj/backstage-plugin-catalog-history-common';

export function HistoryProvenance({ event }: { event: HistoryTimelineItem }) {
  return (
    <dl>
      <dt>Recorded at</dt>
      <dd>
        <time dateTime={event.changedAt}>{event.changedAt}</time>
      </dd>
      <dt>Source</dt>
      <dd>{event.source}</dd>
      <dt>Provider</dt>
      <dd>{event.provider}</dd>
      <dt>Operation</dt>
      <dd>{event.op}</dd>
      <dt>Event ID</dt>
      <dd>{event.id}</dd>
      <dt>Cycle ID</dt>
      <dd>{event.cycleId}</dd>
      <dt>ETag</dt>
      <dd>{event.etag ?? 'Not recorded'}</dd>
    </dl>
  );
}
