/** @jsxRuntime automatic */
import { useRef, useState } from 'react';
import { Combobox, ComboboxItemText, TextField } from '@backstage/ui';
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
import { RetainedSearchField } from './RetainedSearchField';
import { useRetainedSearch } from './useRetainedSearch';

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
function isIdentity(value: unknown): value is HistoryEntityIdentity {
  if (!value || typeof value !== 'object') return false;
  return ['entityRef', 'kind', 'namespace', 'name'].every(
    key => typeof (value as Record<string, unknown>)[key] === 'string',
  );
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
  const search = useRetainedSearch({
    api: props.api,
    method: api => api.getEntities?.bind(api),
    context: props.context,
    query: editing ? query : '',
    open,
    isItem: isIdentity,
    key: item => item.entityRef,
    label: 'entity',
  });
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
  function clear() {
    inputText.current = '';
    setQuery('');
    setEditing(false);
    props.onSelect(undefined);
  }
  return (
    <RetainedSearchField
      label="entity"
      search={search}
      open={open}
      onOpenChange={setOpen}
      applied={props.appliedEntityRef}
      onClear={props.value || query ? clear : undefined}
    >
      {control}
    </RetainedSearchField>
  );
}
