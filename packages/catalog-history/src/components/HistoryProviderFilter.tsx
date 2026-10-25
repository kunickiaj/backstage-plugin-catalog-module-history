/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Button, Combobox, ComboboxItemText, TextField } from '@backstage/ui';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { useProviderSearch } from './useProviderSearch';
import styles from './History.module.css';

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
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const search = useProviderSearch({
    ...props,
    query: editing ? query : '',
    open,
    resetToken: 0,
  });
  const wasUnsupported = useRef(search.unsupported);
  useEffect(() => {
    if (search.unsupported && !wasUnsupported.current && focused.current) {
      container.current?.querySelector('input')?.focus();
    }
    wasUnsupported.current = search.unsupported;
  }, [search.unsupported]);
  const names = new Map(
    search.names.map(name => [`provider-${encodeURIComponent(name)}`, name]),
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
  return (
    <div
      className={styles.providerField}
      ref={container}
      onFocusCapture={event => {
        if (!(event.target instanceof HTMLInputElement)) return;
        focused.current = true;
        setOpen(true);
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
      {props.appliedProvider && (
        <p className={styles.providerHelp}>
          Current provider filter: {JSON.stringify(props.appliedProvider)}
        </p>
      )}
      {search.more && (
        <p className={styles.providerHelp}>Type more to narrow.</p>
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

function providerLabel(name: string): string {
  if (name === '') return 'Empty provider name (not selectable)';
  if (name.trim() === '')
    return `Whitespace provider name ${JSON.stringify(name)}`;
  return name;
}
