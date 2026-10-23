/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, Text } from '@backstage/ui';
import type {
  HistoryEntityTimelineRequest,
  HistoryTimelineItem,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryDetail } from './HistoryDetail';
import { HistoryError } from './HistoryError';
import { useTimeline } from './useTimeline';

export function HistoryTimeline(props: {
  api: CatalogHistoryApi;
  request: HistoryEntityTimelineRequest;
}) {
  const timeline = useTimeline(props.api, props.request);
  const [selected, setSelected] = useState<string>();
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.focus();
  }, [selected]);
  const refresh = () => {
    setSelected(undefined);
    timeline.refresh();
  };
  return (
    <Box>
      <Flex gap="4" align="center">
        <Text as="h2" variant="title-small">
          Recorded history
        </Text>
        <Button
          variant="secondary"
          onPress={refresh}
          isDisabled={timeline.loading}
        >
          Refresh
        </Button>
      </Flex>
      {Boolean(timeline.error) && (
        <HistoryError error={timeline.error} onRetry={timeline.retry} />
      )}
      {timeline.loading && <p role="status">Loading history…</p>}
      {!timeline.loading && !timeline.error && timeline.items.length === 0 && (
        <p role="status">No recorded events match these filters.</p>
      )}
      {timeline.items.length > 0 && (
        <TimelineTable
          items={timeline.items}
          selected={selected}
          onSelect={id => {
            setSelected(id);
            if (selected === id) detailRef.current?.focus();
          }}
        />
      )}
      {timeline.nextCursor && !timeline.error && (
        <Button
          variant="secondary"
          onPress={timeline.older}
          isDisabled={timeline.loading}
        >
          Load older
        </Button>
      )}
      {selected && (
        <section
          ref={detailRef}
          tabIndex={-1}
          aria-label="Recorded event details"
        >
          <HistoryDetail
            key={selected}
            api={props.api}
            entityRef={props.request.entityRef}
            id={selected}
          />
        </section>
      )}
    </Box>
  );
}

function TimelineTable(props: {
  items: HistoryTimelineItem[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <caption>Entity history, newest recorded events first</caption>
        <thead>
          <tr>
            {['Recorded at', 'Source', 'Provider', 'Operation', 'Event'].map(
              label => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {props.items.map(event => (
            <tr key={event.id}>
              <td>
                <time dateTime={event.changedAt}>{event.changedAt}</time>
              </td>
              <td>{event.source}</td>
              <td>{event.provider}</td>
              <td>{event.op}</td>
              <td>
                <Button
                  variant="tertiary"
                  aria-pressed={props.selected === event.id}
                  onPress={() => props.onSelect(event.id)}
                >
                  View event {event.id}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
