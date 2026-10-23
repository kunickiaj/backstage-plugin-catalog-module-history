/** @jsxRuntime automatic */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Flex, Select, TextField } from '@backstage/ui';
import {
  HISTORY_OPERATIONS,
  HISTORY_SOURCES,
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryEntityTimelineRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';

export type HistoryFiltersValue = Omit<
  HistoryEntityTimelineRequest,
  'entityRef' | 'limit' | 'cursor'
>;
const empty = { source: 'all', provider: '', op: 'all', after: '', before: '' };

export function HistoryFilters(props: {
  onApply: (filters: HistoryFiltersValue) => void;
}) {
  const [draft, setDraft] = useState(empty);
  const [error, setError] = useState('');
  function apply(event: FormEvent) {
    event.preventDefault();
    const after = draft.after ? new Date(draft.after) : undefined;
    const before = draft.before ? new Date(draft.before) : undefined;
    if (
      (after && !Number.isFinite(after.getTime())) ||
      (before && !Number.isFinite(before.getTime())) ||
      (after && before && after > before)
    ) {
      setError(
        'Enter valid dates, with recorded after no later than recorded before.',
      );
      return;
    }
    setError('');
    props.onApply({
      source: isHistorySource(draft.source) ? draft.source : undefined,
      provider: draft.provider.trim() || undefined,
      op: isHistoryOperation(draft.op) ? draft.op : undefined,
      changedAfter: after?.toISOString(),
      changedBefore: before?.toISOString(),
    });
  }
  return (
    <form onSubmit={apply} aria-label="History filters">
      <Flex gap="4" align="end" style={{ flexWrap: 'wrap' }}>
        <Select
          label="Source"
          selectedKey={draft.source}
          onSelectionChange={key =>
            setDraft({ ...draft, source: String(key ?? 'all') })
          }
          options={[
            { id: 'all', label: 'All sources' },
            ...HISTORY_SOURCES.map(id => ({ id, label: id })),
          ]}
        />
        <TextField
          label="Provider"
          value={draft.provider}
          onChange={provider => setDraft({ ...draft, provider })}
        />
        <Select
          label="Operation"
          selectedKey={draft.op}
          onSelectionChange={key =>
            setDraft({ ...draft, op: String(key ?? 'all') })
          }
          options={[
            { id: 'all', label: 'All operations' },
            ...HISTORY_OPERATIONS.map(id => ({ id, label: id })),
          ]}
        />
        <label>
          Recorded after (local time)
          <input
            type="datetime-local"
            value={draft.after}
            onChange={event =>
              setDraft({ ...draft, after: event.target.value })
            }
          />
        </label>
        <label>
          Recorded before (local time)
          <input
            type="datetime-local"
            value={draft.before}
            onChange={event =>
              setDraft({ ...draft, before: event.target.value })
            }
          />
        </label>
        <Button type="submit">Apply filters</Button>
        <Button
          variant="secondary"
          onPress={() => {
            setDraft(empty);
            setError('');
            props.onApply({});
          }}
        >
          Reset filters
        </Button>
      </Flex>
      {error && (
        <Alert
          role="alert"
          status="danger"
          title="Check date filters"
          description={error}
        />
      )}
    </form>
  );
}
