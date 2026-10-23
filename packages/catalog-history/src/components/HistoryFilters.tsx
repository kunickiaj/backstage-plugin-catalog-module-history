/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Select, TextField } from '@backstage/ui';
import {
  HISTORY_OPERATIONS,
  HISTORY_SOURCES,
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryEntityTimelineRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import styles from './History.module.css';

export type HistoryFiltersValue = Omit<
  HistoryEntityTimelineRequest,
  'entityRef' | 'limit' | 'cursor'
>;
const empty = {
  source: 'all',
  provider: '',
  op: 'all',
  after: '',
  before: '',
  afterInvalid: false,
  beforeInvalid: false,
};

function parseFilters(draft: typeof empty): HistoryFiltersValue | undefined {
  const after = draft.after ? new Date(draft.after) : undefined;
  const before = draft.before ? new Date(draft.before) : undefined;
  if (
    draft.afterInvalid ||
    draft.beforeInvalid ||
    (after && !Number.isFinite(after.getTime())) ||
    (before && !Number.isFinite(before.getTime())) ||
    (after && before && after > before)
  ) {
    return undefined;
  }
  return {
    source: isHistorySource(draft.source) ? draft.source : undefined,
    provider: draft.provider.trim() || undefined,
    op: isHistoryOperation(draft.op) ? draft.op : undefined,
    changedAfter: after?.toISOString(),
    changedBefore: before?.toISOString(),
  };
}

export function HistoryFilters(props: {
  onApply: (filters: HistoryFiltersValue) => void;
}) {
  const [draft, setDraft] = useState(empty);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const onApply = useRef(props.onApply);
  const applied = useRef(JSON.stringify(parseFilters(empty)));

  useEffect(() => {
    onApply.current = props.onApply;
  }, [props.onApply]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function cancelPending() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  function update(next: typeof empty, debounce = false) {
    cancelPending();
    setDraft(next);
    const filters = parseFilters(next);
    if (!filters) {
      setError(
        'Enter valid dates, with recorded after no later than recorded before.',
      );
      return;
    }
    setError('');
    const key = JSON.stringify(filters);
    if (key === applied.current) return;
    const apply = () => {
      timer.current = undefined;
      applied.current = key;
      onApply.current(filters);
    };
    // Selects and dates flush the latest provider instead of waiting for typing.
    if (debounce) timer.current = setTimeout(apply, 300);
    else apply();
  }
  return (
    <form
      onSubmit={event => event.preventDefault()}
      aria-label="History filters"
      className={styles.filters}
    >
      <div className={styles.filterFields}>
        <Select
          className={styles.field}
          label="Source"
          selectedKey={draft.source}
          onSelectionChange={key =>
            update({ ...draft, source: String(key ?? 'all') })
          }
          options={[
            { id: 'all', label: 'All sources' },
            ...HISTORY_SOURCES.map(id => ({ id, label: id })),
          ]}
        />
        <TextField
          className={styles.field}
          label="Provider"
          value={draft.provider}
          onChange={provider => update({ ...draft, provider }, true)}
        />
        <Select
          className={styles.field}
          label="Operation"
          selectedKey={draft.op}
          onSelectionChange={key =>
            update({ ...draft, op: String(key ?? 'all') })
          }
          options={[
            { id: 'all', label: 'All operations' },
            ...HISTORY_OPERATIONS.map(id => ({ id, label: id })),
          ]}
        />
        <label className={styles.dateField}>
          Recorded after (local time)
          <input
            type="datetime-local"
            value={draft.after}
            onChange={event =>
              update({
                ...draft,
                after: event.target.value,
                afterInvalid: event.target.validity.badInput,
              })
            }
          />
        </label>
        <label className={styles.dateField}>
          Recorded before (local time)
          <input
            type="datetime-local"
            value={draft.before}
            onChange={event =>
              update({
                ...draft,
                before: event.target.value,
                beforeInvalid: event.target.validity.badInput,
              })
            }
          />
        </label>
      </div>
      <div className={styles.filterActions}>
        <Button
          type="button"
          variant="secondary"
          onPress={() => {
            cancelPending();
            setDraft(empty);
            setError('');
            applied.current = JSON.stringify(parseFilters(empty));
            props.onApply({});
          }}
        >
          Reset filters
        </Button>
      </div>
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
