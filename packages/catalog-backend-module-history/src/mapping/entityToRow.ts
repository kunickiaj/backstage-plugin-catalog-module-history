import { createHash } from 'node:crypto';
import { Entity } from '@backstage/catalog-model';
import stableStringify from 'json-stable-stringify';
import { JsonObject } from '@backstage/types';
import { EntityRow } from '@kunickiaj/catalog-history-node';

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

// Fields whose array values are conceptually unordered. Sorting them before
// hashing keeps the etag stable across providers that emit the same set in
// different orders between runs (otherwise every full mutation would look
// like an update even when nothing changed).
const UNORDERED_METADATA_ARRAYS = ['tags'] as const;
const UNORDERED_SPEC_ARRAYS = ['memberOf', 'children'] as const;
const ORPHAN_ANNOTATION = 'backstage.io/orphan';

function sortIfStringArray(value: unknown): unknown {
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    return [...value].sort();
  }
  return value;
}

function normalizeForHash(
  metadata: JsonObject,
  spec: JsonObject,
): {
  metadata: JsonObject;
  spec: JsonObject;
} {
  const md: JsonObject = { ...metadata };
  for (const key of UNORDERED_METADATA_ARRAYS) {
    if (key in md) {
      md[key] = sortIfStringArray(md[key]) as JsonObject[string];
    }
  }
  const sp: JsonObject = { ...spec };
  for (const key of UNORDERED_SPEC_ARRAYS) {
    if (key in sp) {
      sp[key] = sortIfStringArray(sp[key]) as JsonObject[string];
    }
  }
  return { metadata: md, spec: sp };
}

function computeEtag(metadata: JsonObject, spec: JsonObject): string {
  const canonical = stableStringify(normalizeForHash(metadata, spec)) ?? '';
  return createHash('sha256').update(canonical).digest('hex');
}

function getRelations(entity: Entity): EntityRow['relations'] {
  const relations = (entity as { relations?: unknown }).relations;
  if (!Array.isArray(relations)) {
    return undefined;
  }

  return relations
    .flatMap(relation => {
      const type = getString(relation, 'type');
      const targetRef = getString(relation, 'targetRef');
      return type && targetRef ? [{ type, targetRef }] : [];
    })
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.targetRef.localeCompare(b.targetRef),
    );
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStatusItems(entity: Entity): EntityRow['statusItems'] {
  const status = (entity as { status?: unknown }).status;
  if (!isJsonObject(status)) {
    return undefined;
  }

  const items = status.items;
  return Array.isArray(items) && items.every(isJsonObject)
    ? [...items]
    : undefined;
}

function getOrphan(entity: Entity): true | undefined {
  return entity.metadata.annotations?.[ORPHAN_ANNOTATION] === 'true'
    ? true
    : undefined;
}

export function entityToRow(entity: Entity): EntityRow {
  const kind = entity.kind;
  const namespace = entity.metadata.namespace ?? DEFAULT_NAMESPACE;
  const name = entity.metadata.name;
  const entityRef = `${kind}:${namespace}/${name}`.toLowerCase();

  const metadata = (entity.metadata ?? {}) as unknown as JsonObject;
  const spec = (entity.spec ?? {}) as unknown as JsonObject;

  const profile = (spec.profile ?? {}) as JsonObject;

  // Keep fallback etags scoped to metadata+spec. Provider-layer entities lack
  // relations, so hashing stitched-only fields would make existing rows look
  // modified; stitched entities already carry a metadata.etag covering them.
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
    relations: getRelations(entity),
    statusItems: getStatusItems(entity),
    orphan: getOrphan(entity),
  };
}
