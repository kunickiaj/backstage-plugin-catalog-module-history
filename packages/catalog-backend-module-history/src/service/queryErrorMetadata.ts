/** Keep failure codes and call sites without logging SQL or entity payloads. */
export function queryErrorMetadata(error: unknown) {
  if (!(error instanceof Error)) {
    return { errorType: typeof error };
  }

  const code = 'code' in error ? error.code : undefined;
  const label = Error.prototype.toString.call(error);
  // The message can span multiple lines and contain credentials or SQL values.
  // Only retain frames after the complete, matching error header; unknown stack
  // formats are omitted rather than risking disclosure of a different message.
  const stack = error.stack?.startsWith(`${label}\n`)
    ? error.stack
        .slice(label.length + 1)
        .split('\n')
        .filter(line => /^\s+at\s/.test(line))
        .join('\n') || undefined
    : undefined;

  return {
    errorType: error.constructor.name,
    errorCode:
      typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code)
        ? code
        : undefined,
    stack,
  };
}
