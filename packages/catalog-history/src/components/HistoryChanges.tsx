/** @jsxRuntime automatic */
import { Text } from '@backstage/ui';
import type {
  HistoryDiffEntry,
  HistoryJsonValue,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import styles from './History.module.css';

function formatValue(value: HistoryJsonValue | undefined) {
  if (value === undefined) return 'Not present';
  return JSON.stringify(value, null, 2);
}

export function HistoryChanges({
  changes,
  title = 'Changes from previous event',
  description = 'Compared with the previous saved event from the same source and provider. Array values are compared as a whole.',
  emptyMessage = 'No saved field differences.',
}: {
  changes?: HistoryDiffEntry[];
  title?: string;
  description?: string;
  emptyMessage?: string;
}) {
  let content = <p>No previous saved snapshot is available for comparison.</p>;
  if (changes?.length === 0) content = <p>{emptyMessage}</p>;
  if (changes && changes.length > 0) {
    content = (
      <div className={styles.changes}>
        {changes.map(change => (
          <div className={styles.change} key={JSON.stringify(change.path)}>
            <div className={styles.changeHeader}>
              <code>
                {change.path.length === 0
                  ? '(root)'
                  : `/${change.path.map(segment => segment.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`}
              </code>
              <span className={styles.operation}>{change.op}</span>
            </div>
            <dl className={styles.changeValues}>
              <div>
                <dt>Before</dt>
                <dd>
                  <pre className={styles.code}>
                    {formatValue(change.before)}
                  </pre>
                </dd>
              </div>
              <div>
                <dt>After</dt>
                <dd>
                  <pre className={styles.code}>{formatValue(change.after)}</pre>
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    );
  }
  return (
    <section className={styles.disclosure} aria-label={title}>
      <Text as="h3" variant="title-small">
        {title}
      </Text>
      <p className={styles.description}>{description}</p>
      {content}
    </section>
  );
}
