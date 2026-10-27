/** @jsxRuntime automatic */
import { type ReactNode, useEffect, useRef } from 'react';
import { Button } from '@backstage/ui';
import type { RetainedSearch } from './useRetainedSearch';
import styles from './History.module.css';

/**
 * The parts every retained-history picker shares around its own control:
 * opening on focus, the current-filter note, Clear, match notes, Load more,
 * and the retry alert. When suggestions turn out to be unsupported, it moves
 * focus into the fallback text field the picker renders instead.
 */
export function RetainedSearchField(props: {
  /** Lowercase noun for notes and buttons, such as "kind". */
  label: string;
  search: RetainedSearch<unknown>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Text of the applied filter, shown as the current filter. */
  applied?: string;
  /** Shown when there is something to clear; omitted pickers have no Clear. */
  onClear?: () => void;
  /** Whether Load more is offered instead of a "type more" note. */
  paged?: boolean;
  children: ReactNode;
}) {
  const { label, search } = props;
  const container = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const wasUnsupported = useRef(search.unsupported);
  useEffect(() => {
    if (search.unsupported && !wasUnsupported.current && focused.current) {
      container.current?.querySelector('input')?.focus();
    }
    wasUnsupported.current = search.unsupported;
  }, [search.unsupported]);
  const reopen = (action: () => void) => () => {
    props.onOpenChange(true);
    action();
  };
  return (
    <div
      className={styles.providerField}
      ref={container}
      onFocusCapture={event => {
        if (!(event.target instanceof HTMLInputElement)) return;
        focused.current = true;
        props.onOpenChange(true);
      }}
      onBlurCapture={event => {
        if (
          event.target instanceof HTMLInputElement ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          focused.current = false;
      }}
    >
      {props.children}
      {props.applied && (
        <p className={styles.providerHelp}>
          Current {label} filter: {props.applied}
        </p>
      )}
      {!search.unsupported && props.onClear && (
        <Button
          type="button"
          variant="secondary"
          onPress={() => {
            props.onClear?.();
            // Clear hides itself; keep keyboard focus in the field.
            container.current?.querySelector('input')?.focus();
          }}
        >
          Clear {label}
        </Button>
      )}
      {!props.paged && search.more && (
        <p className={styles.providerHelp}>
          More matches. Type more to narrow.
        </p>
      )}
      {!search.unsupported &&
        props.open &&
        search.status === 'idle' &&
        !search.items.length && (
          <p className={styles.providerHelp}>No matching {plural(label)}.</p>
        )}
      {props.paged && search.nextCursor && (
        <Button
          type="button"
          variant="secondary"
          isDisabled={search.status !== 'idle'}
          onPress={reopen(search.loadMore)}
        >
          Load more {plural(label)}
        </Button>
      )}
      {search.error && (
        <div role="alert" className={styles.providerHelp}>
          {search.error}{' '}
          <Button
            type="button"
            variant="secondary"
            onPress={reopen(search.retry)}
          >
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

function plural(label: string): string {
  return label.endsWith('y') ? `${label.slice(0, -1)}ies` : `${label}s`;
}
