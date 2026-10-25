/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Button, Combobox, ComboboxItemText, TextField } from '@backstage/ui';
import {
  makeValidator,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import type {
  HistoryEntityIdentity,
  HistoryEntitySearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { useEntitySearch } from './useEntitySearch';
import styles from './History.module.css';

const validators = makeValidator();
function selectable(item: HistoryEntityIdentity) {
  if (!validators.isValidKind(item.kind)) return false;
  try {
    const ref = parseEntityRef(item.entityRef);
    return (
      validators.isValidKind(ref.kind) &&
      validators.isValidNamespace(ref.namespace.toLowerCase()) &&
      validators.isValidEntityName(ref.name) &&
      stringifyEntityRef(ref) === item.entityRef
    );
  } catch {
    return false;
  }
}
function readable(value: string) {
  return value.trim() ? value : JSON.stringify(value);
}

function entityText(item: HistoryEntityIdentity) {
  return item.name || item.entityRef;
}

export function HistoryEntityFilter(props: {
  api?: CatalogHistoryApi;
  context: HistoryEntitySearchRequest;
  selected?: HistoryEntityIdentity;
  appliedEntityRef?: string;
  value: string;
  onLegacyChange: (value: string) => void;
  onSelect: (value: HistoryEntityIdentity | undefined) => void;
}) {
  const text = props.selected ? entityText(props.selected) : props.value;
  const [previous, setPrevious] = useState(text);
  const [query, setQuery] = useState(text);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const inputText = useRef(text);
  if (previous !== text) {
    setPrevious(text);
    setQuery(text);
    setEditing(false);
    inputText.current = text;
  }
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const search = useEntitySearch({
    api: props.api,
    context: props.context,
    query: editing ? query : '',
    open,
  });
  const wasUnsupported = useRef(search.unsupported);
  useEffect(() => {
    if (search.unsupported && !wasUnsupported.current && focused.current)
      container.current?.querySelector('input')?.focus();
    wasUnsupported.current = search.unsupported;
  }, [search.unsupported]);
  const identities = new Map(search.items.map(item => [item.entityRef, item]));
  if (!editing && props.selected)
    identities.set(props.selected.entityRef, props.selected);
  const items = Array.from(identities.values(), item => ({
    ...item,
    id: item.entityRef,
  }));

  function input(value: string) {
    if (value === inputText.current) return;
    inputText.current = value;
    setQuery(value);
    setEditing(true);
    if (value === '') props.onSelect(undefined);
  }
  let control = (
    <Combobox
      label="Entity"
      description="Search retained entity names by literal prefix, then select an entity."
      items={items}
      value={editing ? null : (props.selected?.entityRef ?? null)}
      allowsCustomValue
      search={{ mode: 'server', inputValue: query, onInputChange: input }}
      loading={{ state: search.status }}
      onOpenChange={setOpen}
      onChange={key => {
        const item = identities.get(String(key));
        if (!item || !selectable(item)) return;
        inputText.current = entityText(item);
        setQuery(entityText(item));
        setEditing(false);
        props.onSelect(item);
      }}
    >
      {item => (
        <ComboboxItemText
          id={item.id}
          title={`${readable(item.name)} — ${readable(item.kind)} / ${readable(item.namespace)}`}
          textValue={entityText(item)}
          isDisabled={!selectable(item)}
        />
      )}
    </Combobox>
  );
  if (search.unsupported)
    control = (
      <TextField
        label="Entity reference"
        description="Exact entity reference. Short names default to Component in the default namespace."
        placeholder="component:default/example-service"
        value={editing ? query : props.value}
        onChange={value => {
          inputText.current = value;
          setQuery(value);
          props.onLegacyChange(value);
        }}
      />
    );
  return (
    <div
      className={styles.providerField}
      ref={container}
      onFocusCapture={event => {
        if (event.target instanceof HTMLInputElement) {
          focused.current = true;
          setOpen(true);
        }
      }}
      onBlurCapture={event => {
        if (
          event.target instanceof HTMLInputElement ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          focused.current = false;
      }}
    >
      {control}
      {props.appliedEntityRef && (
        <p className={styles.providerHelp}>
          Current entity filter: {props.appliedEntityRef}
        </p>
      )}
      {!search.unsupported && (props.value || query) && (
        <Button
          type="button"
          variant="secondary"
          onPress={() => {
            inputText.current = '';
            setQuery('');
            setEditing(false);
            props.onSelect(undefined);
          }}
        >
          Clear entity
        </Button>
      )}
      {search.more && (
        <p className={styles.providerHelp}>
          More matches. Type more to narrow.
        </p>
      )}
      {!search.unsupported &&
        open &&
        search.status === 'idle' &&
        !search.items.length && (
          <p className={styles.providerHelp}>No matching entities.</p>
        )}
      {search.error && (
        <div role="alert" className={styles.providerHelp}>
          {search.error}{' '}
          <Button
            type="button"
            variant="secondary"
            onPress={() => {
              setOpen(true);
              search.retry();
            }}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
