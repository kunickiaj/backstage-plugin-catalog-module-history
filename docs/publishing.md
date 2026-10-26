# Publishing packages

All five public packages are published at `0.3.0` with the `latest` dist-tag. A normal release publishes the same numeric version for every package from `main`, using the validated archives from one successful CI run. Do not publish from a branch, source directory, rebuilt archive, or arbitrary package subset.

| Public package                                               | Workspace directory                       |
| ------------------------------------------------------------ | ----------------------------------------- |
| `@kunickiaj/backstage-plugin-catalog-history-common`         | `packages/catalog-history-common`         |
| `@kunickiaj/backstage-plugin-catalog-history-node`           | `packages/catalog-history-node`           |
| `@kunickiaj/backstage-plugin-catalog-history-storage-node`   | `packages/catalog-history-backend`        |
| `@kunickiaj/backstage-plugin-catalog-backend-module-history` | `packages/catalog-backend-module-history` |
| `@kunickiaj/backstage-plugin-catalog-history`                | `packages/catalog-history`                |

The storage package is a `node-library`, not a backend plugin. The root package remains private; its `0.1.0` version is not a public package release.

## Normal five-package release

1. Update all five public numeric versions together with a stable version (for example, `0.2.1`) and write `docs/releases/VERSION.md`, then merge the release change to `main` with explicit merge approval. Confirm the validated commit is on upstream `main`. Internal `workspace:^` dependencies are rewritten by Yarn 4.5 during packing to ranges such as `^0.2.1`.
2. Dispatch **Publish npm packages** from `main` with the version, **publish** checked, and **bootstrap_frontend** unchecked. The run validates and packs, then waits at the `npm` environment review. Validation uses PostgreSQL 16 and Node 24 and runs release-helper checks, formatting, lint, typecheck, build, and tests with watches disabled.
3. Before approving the review, inspect that run's `npm-release-COMMIT_SHA` artifact. It contains `release-notes.md` and these five archives, named after their workspace directories:

   - `catalog-history-common-VERSION.tgz`
   - `catalog-history-node-VERSION.tgz`
   - `catalog-history-backend-VERSION.tgz`
   - `catalog-backend-module-history-VERSION.tgz`
   - `catalog-history-VERSION.tgz`

   The frontend archive is ESM-only; Node and backend archives are CommonJS; the common archive is dual-format. The helper packs with Yarn after `yarn tsc` and `yarn build`, checks declared compiled entrypoints, types, module output, frontend CSS, README, license, and every migration, and rejects source, development, and fixture files.

   Source and packed manifests must have the expected Backstage role and required plugin identity metadata. The catalog module must declare its configuration schema and reconciliation command; packed schema and CLI targets must stay inside the package and exist in the archive. Schema targets must be compiled JSON, not source declarations; these checks confirm target inclusion, not schema-content correctness or CLI execution.

4. Approve the `npm` environment review. The publishing job publishes all five archives from that artifact in dependency order through trusted publishing and provenance.
5. The release job then waits up to 20 minutes for npm to return every exact version, because npm can hold a new version in automated review. It fails unless each registry integrity equals its archive, each version has a provenance attestation, and `latest` points to the version. After verification passes, it tags the validated commit `vVERSION` and creates the GitHub release from `release-notes.md`.

To check a release without publishing, dispatch with **publish** unchecked. Only the validation job runs.

## Publication safeguards

The workflow validates all five archives and preflights each exact registry version before npm changes. It skips a version only when the existing registry integrity equals the matching archive. A malformed response, unexpected existing version, integrity mismatch, or registry error other than a missing version stops publication.

The publishing job uses GitHub-hosted runners, Node 24, pinned npm `11.19.1`, and `id-token: write` for OIDC. The `npm` environment remains main-only with required reviewers. No npm token secret or token fallback is configured.

Before publication, confirm all five trusted publishers match this repository, workflow filename `publish.yml`, and environment `npm`, with **direct `npm publish`** allowed. Staged-publishing-only permission is insufficient for this workflow.

## Verify a published release

Check each package separately: an exact version identifies the immutable release, while `latest` is a moving tag and must be checked independently. Compare integrity values to confirm the archive bytes.

```sh
npm view '<package>@<version>' version dist.integrity dist.attestations --json --registry 'https://registry.npmjs.org'
npm view '<package>' dist-tags --json --registry 'https://registry.npmjs.org'
npm view '<package>@<version>' dist.tarball --registry 'https://registry.npmjs.org'
```

Record results for all five packages in the release checklist. The exact version must match `VERSION`; `dist-tags.latest` must point to `VERSION`; and `dist.integrity` must equal the SHA-512 value of the exact successful CI archive. `dist.attestations` indicates that npm exposes attestation links; it is not itself full cryptographic verification of provenance.

| Package                          | Exact version | `latest` | Archive SHA-512 | Attestation links |
| -------------------------------- | ------------- | -------- | --------------- | ----------------- |
| `catalog-history-common`         | ☐             | ☐        | ☐               | ☐                 |
| `catalog-history-node`           | ☐             | ☐        | ☐               | ☐                 |
| `catalog-history-storage-node`   | ☐             | ☐        | ☐               | ☐                 |
| `catalog-backend-module-history` | ☐             | ☐        | ☐               | ☐                 |
| `catalog-history`                | ☐             | ☐        | ☐               | ☐                 |

Calculate an archive integrity value without rebuilding or renaming it:

```sh
node -e "const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs'); console.log('sha512-' + createHash('sha512').update(readFileSync(process.argv[1])).digest('base64'))" 'path/to/archive.tgz'
```

For `0.2.0`, all five exact versions and `latest` tags were checked, and their registry integrities matched the CI archives. The first four packages came from the OIDC/provenance job at commit `a9260710c6158a774853be7d11b7f7fc4ab4a115`; the frontend was manually published from its exact CI archive after approval and has the same SHA-512 integrity. The frontend's local publish has no GitHub Actions provenance claim.

For `0.3.0`, all five exact versions and `latest` tags were checked, and their registry integrities matched the archives from OIDC/provenance run `40270922196` at commit `daa8409a7ca0b0062a04bcb70879557a0c4fa2cd`. All five, including the frontend, expose npm provenance attestations. This was the frontend's first trusted publish. That release used a separate validation-only dispatch and a manually created tag and GitHub release, which the workflow now handles.

## Installed-package smoke check

Run this only in a disposable, authorized consumer development workspace. Install the published **exact** versions, use the host's normal backend loader and service overrides, and do not change a running E2E instance.

- Start with a backup when upgrading older history data. `0.1` shared catalog migration logs need the [migration guidance](migration.md); do not blindly downgrade a database.
- Confirm migrations apply on startup and the default Postgres store works. Keep the existing provider wrapper when provider-origin capture is required; use the reconciler for served-catalog capture. Processing capture does not cover deletes.
- If enabled by the host's existing policy, test the authenticated read API, explicit `catalog-history.read` permission decision, unauthenticated rejection, and permission rejection. Do not change the host's authentication or permission policy without approval.
- Confirm the NFS plugin, BUI stylesheet, React `^18.3.1` peers, global page, entity tab, filters, page/detail views, and delete's last-recorded-snapshot label. Confirm provider capture and reconciler behavior; do not treat a preview as a host smoke test.

The read permission grants access to retained history, including deleted entities, independently of live catalog visibility. The global-feed index builds during schema startup even when the HTTP API is disabled and blocks history-entity writes while it builds. Plan a maintenance window for large histories; do not use this smoke check for production data writes or row deletion.

## GitHub tag and release

The workflow creates the `vVERSION` tag and GitHub release only after npm verification passes. It does not write changelogs or bump versions. The release body is `docs/releases/VERSION.md` from the validated commit, with relative links rewritten to files under the tag. Validation fails if that file is missing, so write human-reviewed notes in the release PR.

The release job uses `contents: write` and never receives the npm OIDC permission. If the tag already points at the validated commit, the job keeps an existing release or creates a missing one. If the tag points at another commit, the job fails without changing it. A bootstrap run skips the release job because the frontend is not published yet.

If verification times out after a successful publish, rerun only the release job from the same run. Do not dispatch a new run. A GitHub tag or release does not publish npm packages.

## Partial publication and recovery

npm versions are immutable. If any package publishes before the batch fails, stop. Do not delete, unpublish, overwrite a version, move dist-tags automatically, dispatch a fresh run, or rebuild archives against an existing version.

With approval, retry the original publishing job so it uses the original archives. It skips only packages whose registry integrities match and continues the missing packages in dependency order. Complete the coordinated batch first when possible. If that cannot be done, create a new coordinated patch release under its own approval.

For consumers, an operator may pin previous known-compatible package versions and lockfile after review. Do not downgrade a database using the dedicated history migration log to `0.1.0`.

Prefer a forward fix for database migrations. Take a backup, use an operator-approved restore when needed, and never run automatic down migrations. Any npm authentication, trusted-publisher, tag, deployment, or data action needs explicit approval.

## Historical `0.1.0` bootstrap — completed

The one-time `0.1.0` bootstrap is historical record, not an instruction to rerun. Four packages were manually published by an authorized personal npm account from approved CI archives, with browser or two-factor prompts completed by the operator; local publication did not claim GitHub Actions provenance. `0.1.0` is immutable.

The separate `0.2.0` frontend bootstrap completed the transition: four packages were published by CI through OIDC with provenance, and the frontend was manually published from the matching CI artifact. That workflow option is not a general package selector: it is allowed only while the frontend name is absent and now refuses to run because the name exists.

The maintainer confirmed the frontend trusted publisher is configured, but its first actual OIDC publication remains untested. A new configuration must complete its first successful publish within two days or it expires; recheck or renew it near the next approved release. Do not publish a new version merely to test setup, and do not count an all-skipped retry as validation.

Future normal releases use the five-package flow above with `bootstrap_frontend` unchecked. See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) and [provenance](https://docs.npmjs.com/generating-provenance-statements) documentation for account-side requirements.
