/** @jsxRuntime automatic */
import { Text } from '@backstage/ui';
import type {
  HistoryEntitySnapshot,
  HistoryJsonObject,
  HistoryJsonValue,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import styles from './History.module.css';

export function HistorySnapshot({
  snapshot,
}: {
  snapshot: HistoryEntitySnapshot;
}) {
  return (
    <div className={styles.snapshot}>
      <section
        className={styles.snapshotSection}
        aria-label="Recorded entity fields"
      >
        <Text as="h4" variant="title-small">
          Recorded entity fields
        </Text>
        <dl className={styles.snapshotFields}>
          <div>
            <dt>Owner</dt>
            <dd>{recordedString(snapshot.owner)}</dd>
          </div>
          <div>
            <dt>Memberships</dt>
            <dd>
              <Memberships values={snapshot.memberOf} />
            </dd>
          </div>
          <div>
            <dt>Parent</dt>
            <dd>{recordedString(snapshot.parent)}</dd>
          </div>
          <div>
            <dt>Orphan</dt>
            <dd>{recordedOrphan(snapshot.orphan)}</dd>
          </div>
        </dl>
      </section>
      <ObjectSection title="Metadata" value={snapshot.metadata} />
      <ObjectSection title="Spec" value={snapshot.spec} />
      <RecordSection title="Relations" values={snapshot.relations} />
      <RecordSection title="Status items" values={snapshot.statusItems} />
    </div>
  );
}

function recordedString(value: string | undefined) {
  if (value === undefined) return 'Not recorded';
  if (value === '') return 'Empty string';
  return value;
}

function recordedOrphan(value: boolean | undefined) {
  if (value === undefined) return 'Not recorded';
  return value ? 'Yes' : 'No';
}

function Memberships({ values }: { values?: string[] }) {
  if (values === undefined) return <>Not recorded</>;
  if (values.length === 0) return <>No memberships recorded</>;
  return (
    <ul className={styles.snapshotList}>
      {values.map((value, index) => (
        <li key={index}>{recordedString(value)}</li>
      ))}
    </ul>
  );
}

function ObjectSection({
  title,
  value,
}: {
  title: 'Metadata' | 'Spec';
  value?: HistoryJsonObject;
}) {
  let content = <p>{title} was not recorded.</p>;
  if (value !== undefined) {
    content = (
      <ObjectFields
        value={value}
        label={title}
        empty={`No ${title.toLowerCase()} fields recorded`}
      />
    );
  }
  return (
    <section className={styles.snapshotSection} aria-label={title}>
      <Text as="h4" variant="title-small">
        {title}
      </Text>
      {content}
    </section>
  );
}

function RecordSection({
  title,
  values,
}: {
  title: 'Relations' | 'Status items';
  values?: HistoryJsonObject[];
}) {
  let content = <p>Not recorded</p>;
  if (values?.length === 0) content = <p>No {title.toLowerCase()} recorded</p>;
  if (values && values.length > 0) {
    content = (
      <ol className={styles.snapshotRecords}>
        {values.map((value, index) => (
          <li key={index}>
            <ObjectFields
              value={value}
              label={`${title}, record ${index + 1}`}
              empty="No fields recorded"
            />
          </li>
        ))}
      </ol>
    );
  }
  return (
    <section className={styles.snapshotSection} aria-label={title}>
      <Text as="h4" variant="title-small">
        {title}
      </Text>
      {content}
    </section>
  );
}

function ObjectFields({
  value,
  label,
  empty,
}: {
  value: HistoryJsonObject;
  label: string;
  empty: string;
}) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <p>{empty}</p>;
  return (
    <dl className={styles.snapshotFields}>
      {entries.map(([key, field]) => (
        <div key={key}>
          <dt>{key === '' ? 'Empty string (field name)' : key}</dt>
          <dd>
            <JsonValue
              value={field}
              label={`${label}: ${JSON.stringify(key)}`}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function JsonValue({
  value,
  label,
}: {
  value: HistoryJsonValue;
  label: string;
}) {
  if (value !== null && typeof value === 'object') {
    return (
      <pre
        className={`${styles.code} ${styles.snapshotJson}`}
        // Keyboard users need to focus this scroll container to read long JSON.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        // A generic element's name is ignored; the group role makes it read.
        role="group"
        aria-label={`${label} JSON`}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <code className={styles.snapshotScalar}>{JSON.stringify(value)}</code>;
}
