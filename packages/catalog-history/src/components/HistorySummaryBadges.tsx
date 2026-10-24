/** @jsxRuntime automatic */
import type { HistoryTimelineSummary } from '@kunickiaj/backstage-plugin-catalog-history-common';
import styles from './History.module.css';

const SUMMARY_FIELDS = [
  { flag: 'ownerChanged', label: 'Owner changed' },
  { flag: 'relationsChanged', label: 'Relations changed' },
  { flag: 'statusChanged', label: 'Status changed' },
  { flag: 'orphanChanged', label: 'Orphan changed' },
] as const;

export function HistorySummaryBadges(props: {
  summary?: HistoryTimelineSummary;
}) {
  const changes = SUMMARY_FIELDS.filter(
    field => props.summary?.[field.flag] === true,
  );
  if (changes.length === 0) return null;

  return (
    <ul
      className={styles.summaryList}
      aria-label={`Recorded field changes: ${changes.map(field => field.label).join(', ')}`}
    >
      {changes.map(field => (
        <li key={field.flag} className={styles.summaryBadge}>
          {field.label}
        </li>
      ))}
    </ul>
  );
}
