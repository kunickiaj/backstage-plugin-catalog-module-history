import { createHash } from 'node:crypto';
import { Entity } from '@backstage/catalog-model';
import stableStringify from 'json-stable-stringify';
import { JsonObject } from '@backstage/types';
import { EntityRow } from '../store/types';

const DEFAULT_NAMESPACE = 'default';

function getString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function getStringArray(obj: unknown, key: string): string[] | undefined {
  if (obj && typeof obj === 'object' && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      return value as string[];
    }
  }
  return undefined;
}

function computeEtag(metadata: JsonObject, spec: JsonObject): string {
  const canonical = stableStringify({ metadata, spec }) ?? '';
  return createHash('sha256').update(canonical).digest('hex');
}

export function entityToRow(entity: Entity): EntityRow {
  const kind = entity.kind;
  const namespace = entity.metadata.namespace ?? DEFAULT_NAMESPACE;
  const name = entity.metadata.name;
  const entityRef = `${kind}:${namespace}/${name}`.toLowerCase();

  const metadata = (entity.metadata ?? {}) as unknown as JsonObject;
  const spec = (entity.spec ?? {}) as unknown as JsonObject;

  const profile = (spec.profile ?? {}) as JsonObject;

  const etag =
    typeof entity.metadata.etag === 'string'
      ? entity.metadata.etag
      : computeEtag(metadata, spec);

  return {
    entityRef,
    kind,
    namespace,
    name,
    etag,
    displayName: getString(profile, 'displayName'),
    email: getString(profile, 'email'),
    parent: getString(spec, 'parent'),
    memberOf: getStringArray(spec, 'memberOf'),
    owner: getString(spec, 'owner'),
    metadata,
    spec,
  };
}
