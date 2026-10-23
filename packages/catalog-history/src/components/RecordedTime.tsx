/** @jsxRuntime automatic */

/** Local date and time with an explicit zone and the exact stored instant. */
export function RecordedTime({ value }: { value: string }) {
  const date = new Date(value);
  const label = Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
    : value;
  return (
    <time dateTime={value} title={value}>
      {label}
    </time>
  );
}
