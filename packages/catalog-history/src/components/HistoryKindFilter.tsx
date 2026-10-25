/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from 'react';
import { Button, Combobox, ComboboxItemText, TextField } from '@backstage/ui';
import { makeValidator } from '@backstage/catalog-model';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { useKindSearch } from './useKindSearch';
import styles from './History.module.css';

const all = 'all-kinds';
const validators = makeValidator();
const kindKey = (kind: string) =>
  `kind-${encodeURIComponent(kind.toLowerCase())}`;

export function HistoryKindFilter(props: {
  api?: CatalogHistoryApi;
  value: string;
  appliedKind?: string;
  selectionRevision?: number;
  onLegacyChange: (value: string) => void;
  onSelect: (value: string | undefined) => void;
}) {
  const text = props.value || (props.api?.getKinds ? 'All kinds' : '');
  const [previous, setPrevious] = useState(props.value);
  const [revision, setRevision] = useState(props.selectionRevision);
  const [query, setQuery] = useState(text);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const inputText = useRef(text);
  if (previous !== props.value || revision !== props.selectionRevision) {
    setPrevious(props.value);
    setRevision(props.selectionRevision);
    setQuery(text);
    setEditing(false);
    inputText.current = text;
  }
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const search = useKindSearch({
    api: props.api,
    query: editing ? query : '',
    open,
  });
  const wasUnsupported = useRef(search.unsupported);
  useEffect(() => {
    if (search.unsupported && !wasUnsupported.current && focused.current)
      container.current?.querySelector('input')?.focus();
    wasUnsupported.current = search.unsupported;
  }, [search.unsupported]);
  const kinds = new Map(search.items.map(kind => [kindKey(kind), kind]));
  if (!editing && props.value && !kinds.has(kindKey(props.value)))
    kinds.set(kindKey(props.value), props.value);
  const items = [
    { id: all, label: 'All kinds', text: 'All kinds', disabled: false },
    ...Array.from(kinds, ([id, kind]) => ({
      id,
      label: kind.trim() ? kind : JSON.stringify(kind),
      text: kind,
      disabled: !validators.isValidKind(kind),
    })),
  ];
  function select(kind?: string) {
    inputText.current = kind ?? 'All kinds';
    setQuery(kind ?? 'All kinds');
    setEditing(false);
    props.onSelect(kind);
  }
  function input(value: string) {
    if (value === inputText.current) return;
    const sameSelectedKind =
      !editing &&
      props.value !== '' &&
      value.toLowerCase() === props.value.toLowerCase();
    inputText.current = value;
    setQuery(value);
    // A discovered spelling can differ from the selected row only by case.
    if (sameSelectedKind) return;
    setEditing(true);
    if (value === '') select();
  }
  let selection: string | null = all;
  if (editing) selection = null;
  else if (props.value) selection = kindKey(props.value);
  let control = (
    <Combobox
      label="Kind"
      description="Search retained kinds by literal prefix, then select a kind."
      items={items}
      value={selection}
      allowsCustomValue
      search={{ mode: 'server', inputValue: query, onInputChange: input }}
      loading={{ state: search.status }}
      onOpenChange={setOpen}
      onChange={key => {
        if (key === all) {
          select();
          return;
        }
        const kind = kinds.get(String(key));
        if (kind && validators.isValidKind(kind)) select(kind);
      }}
    >
      {item => (
        <ComboboxItemText
          id={item.id}
          title={item.label}
          textValue={item.text}
          isDisabled={item.disabled}
        />
      )}
    </Combobox>
  );
  if (search.unsupported)
    control = (
      <TextField
        label="Kind"
        placeholder="Component"
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
      {props.appliedKind && (
        <p className={styles.providerHelp}>
          Current kind filter: {props.appliedKind}
        </p>
      )}
      {!search.unsupported && (props.value || (editing && query)) && (
        <Button type="button" variant="secondary" onPress={() => select()}>
          Clear kind
        </Button>
      )}
      {!search.unsupported &&
        open &&
        search.status === 'idle' &&
        !search.items.length && (
          <p className={styles.providerHelp}>No matching kinds.</p>
        )}
      {search.nextCursor && (
        <Button
          type="button"
          variant="secondary"
          isDisabled={search.status !== 'idle'}
          onPress={() => {
            setOpen(true);
            search.loadMore();
          }}
        >
          Load more kinds
        </Button>
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
