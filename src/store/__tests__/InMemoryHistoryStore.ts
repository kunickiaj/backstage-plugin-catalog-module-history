import { CurrentEtag, HistoryStore } from '../HistoryStore';
import { CaptureSource, CycleInput } from '../types';

export class InMemoryHistoryStore implements HistoryStore {
  readonly cycles: CycleInput[] = [];
  private readonly etagsByProvider = new Map<string, Map<string, string>>();
  private readonly etagsByProviderAndSource = new Map<
    string,
    Map<string, string>
  >();
  private readonly globalLatest = new Map<string, CurrentEtag>();
  private readonly globalLatestBySource = new Map<
    CaptureSource,
    Map<string, CurrentEtag>
  >();

  async loadCurrentEtags(
    provider: string,
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, string>> {
    const existing = opts.source
      ? this.etagsByProviderAndSource.get(
          sourceProviderKey(provider, opts.source),
        )
      : this.etagsByProvider.get(provider);
    return new Map(existing ?? []);
  }

  async loadAllCurrentEtags(
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, CurrentEtag>> {
    return new Map(
      opts.source
        ? (this.globalLatestBySource.get(opts.source) ?? [])
        : this.globalLatest,
    );
  }

  async recordCycle(input: CycleInput): Promise<void> {
    this.cycles.push(input);

    let etags = this.etagsByProvider.get(input.provider);
    if (!etags) {
      etags = new Map();
      this.etagsByProvider.set(input.provider, etags);
    }
    let sourceEtags = this.etagsByProviderAndSource.get(
      sourceProviderKey(input.provider, input.source),
    );
    if (!sourceEtags) {
      sourceEtags = new Map();
      this.etagsByProviderAndSource.set(
        sourceProviderKey(input.provider, input.source),
        sourceEtags,
      );
    }
    let sourceGlobalLatest = this.globalLatestBySource.get(input.source);
    if (!sourceGlobalLatest) {
      sourceGlobalLatest = new Map();
      this.globalLatestBySource.set(input.source, sourceGlobalLatest);
    }

    for (const row of input.inserts) {
      etags.set(row.entityRef, row.etag);
      sourceEtags.set(row.entityRef, row.etag);
      this.globalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
      sourceGlobalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
    }
    for (const row of input.updates) {
      etags.set(row.entityRef, row.etag);
      sourceEtags.set(row.entityRef, row.etag);
      this.globalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
      sourceGlobalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
    }
    for (const ref of input.deletes) {
      etags.delete(ref);
      sourceEtags.delete(ref);
      // A delete is the newest observation for this entity_ref across all
      // providers, so the global entry drops regardless of which provider
      // had previously claimed it. Mirrors PostgresHistoryStore semantics
      // where DISTINCT ON ... ORDER BY changed_at DESC picks the latest
      // row globally and filters when its op is 'delete'.
      this.globalLatest.delete(ref);
      sourceGlobalLatest.delete(ref);
    }
  }
}

function sourceProviderKey(provider: string, source: CaptureSource): string {
  return `${source}\0${provider}`;
}
