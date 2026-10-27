/** @jsxRuntime automatic */
import { useRef, useState } from 'react';
import { Combobox, ComboboxItemText, TextField } from '@backstage/ui';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { RetainedSearchField } from './RetainedSearchField';
import { useRetainedSearch } from './useRetainedSearch';

export function HistoryProviderFilter(props: {
  api?: CatalogHistoryApi;
  context: HistoryProviderSearchRequest;
  appliedProvider?: string;
  value: string;
  onLegacyChange: (value: string) => void;
  onSelect: (value: string | undefined) => void;
}) {
  const [query, setQuery] = useState(props.value);
  const inputText = useRef(props.value);
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const search = useRetainedSearch({
    api: props.api,
    method: api => api.getProviders?.bind(api),
    context: props.context,
    query: editing ? query : '',
    open,
    isItem: (value): value is string => typeof value === 'string',
    key: name => name,
    label: 'provider',
  });
  const names = new Map(
    search.items.map(name => [`provider-${encodeURIComponent(name)}`, name]),
  );
  const items = Array.from(names, ([id, name]) => ({
    id,
    provider: name,
    label: providerLabel(name),
    disabled: name === '',
  }));

  function input(value: string) {
    // Selection also reports input text; it must not become a prefix edit.
    if (value === inputText.current) return;
    inputText.current = value;
    setQuery(value);
    setEditing(true);
    setSelection(null);
    if (value === '') props.onSelect(undefined);
  }

  let control = (
    <Combobox
      label="Provider"
      description="Search retained provider names by literal prefix, then select a full name."
      items={items}
      value={selection}
      allowsCustomValue
      search={{ mode: 'server', inputValue: query, onInputChange: input }}
      loading={{ state: search.status }}
      onOpenChange={setOpen}
      onChange={key => {
        const name = names.get(String(key));
        if (name === undefined || name === '') return;
        inputText.current = name;
        setSelection(String(key));
        setQuery(name);
        setEditing(false);
        props.onSelect(name);
      }}
    >
      {item => (
        <ComboboxItemText
          id={item.id}
          title={item.label}
          textValue={item.provider}
          isDisabled={item.disabled}
        />
      )}
    </Combobox>
  );
  if (search.unsupported) {
    control = (
      <TextField
        label="Provider"
        description="Exact provider name; suggestions unavailable."
        value={query}
        onChange={value => {
          inputText.current = value;
          setQuery(value);
          props.onLegacyChange(value);
        }}
      />
    );
  }
  function clear() {
    inputText.current = '';
    setQuery('');
    setEditing(false);
    setSelection(null);
    props.onSelect(undefined);
  }
  return (
    <RetainedSearchField
      label="provider"
      search={search}
      open={open}
      onOpenChange={setOpen}
      applied={
        props.appliedProvider
          ? JSON.stringify(props.appliedProvider)
          : undefined
      }
      onClear={query ? clear : undefined}
    >
      {control}
    </RetainedSearchField>
  );
}

function providerLabel(name: string): string {
  if (name === '') return 'Empty provider name (not selectable)';
  if (name.trim() === '')
    return `Whitespace provider name ${JSON.stringify(name)}`;
  return name;
}
