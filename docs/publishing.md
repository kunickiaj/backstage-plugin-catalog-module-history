# Publishing packages

The **Publish npm packages** workflow validates and packs all five packages. It publishes only when a maintainer explicitly requests publication from `main`. Ordinary pushes, merges, tags, and pull requests never publish.

All five public packages stay in this repository's existing Yarn workspaces, with one lockfile and shared CI:

| Public package                                               | Existing directory                        |
| ------------------------------------------------------------ | ----------------------------------------- |
| `@kunickiaj/backstage-plugin-catalog-history-common`         | `packages/catalog-history-common`         |
| `@kunickiaj/backstage-plugin-catalog-history-node`           | `packages/catalog-history-node`           |
| `@kunickiaj/backstage-plugin-catalog-history-storage-node`   | `packages/catalog-history-backend`        |
| `@kunickiaj/backstage-plugin-catalog-backend-module-history` | `packages/catalog-backend-module-history` |
| `@kunickiaj/backstage-plugin-catalog-history`                | `packages/catalog-history`                |

The storage package is a `node-library`, not a backend plugin. The first four names are published at `0.1.0`; the frontend package is not yet published. Source is prepared as the `0.2.0` release candidate, not evidence that `0.2.0` is already available on npm. The superseded names were unpublished after the rename; they are not compatibility aliases.

## Validate a release

All five packages use the same stable version. Update their numeric `version` fields together, update the lockfile, and merge the change before publishing. The helper accepts stable versions such as `0.2.0`, not prerelease versions.

Internal dependencies use `workspace:^` in source and do not need a range edit for each release: Yarn rewrites them to ranges such as `^0.2.0` when packing. The archives must contain resolved numeric or caret ranges and no `workspace:` protocols.

In GitHub Actions, select **Publish npm packages → Run workflow**, choose a ref and enter that version. Leave **publish** unchecked. Validation runs release-helper tests, formatting, lint, typecheck, build, and the repository tests against PostgreSQL 16. It then packs and inspects the archives without contacting npm to publish them.

Download the `npm-release-COMMIT_SHA` artifact from that run. It contains:

1. `catalog-history-common-VERSION.tgz`
2. `catalog-history-node-VERSION.tgz`
3. `catalog-history-backend-VERSION.tgz`
4. `catalog-backend-module-history-VERSION.tgz`
5. `catalog-history-VERSION.tgz`

For this release, Backstage builds the frontend as ESM, the Node/backend packages as CommonJS, and the common package in both formats. The helper packs through Yarn, then checks declared compiled entrypoints, declarations, every migration file, and frontend CSS. It rejects source, development, and fixture files.

Local packing requires `yarn tsc` before `yarn build`:

```sh
yarn tsc
yarn build
node scripts/npm-release.mjs pack 0.2.0
```

Archive filenames follow workspace directories, not npm package names. Previously generated archives containing old package names are invalid for this release: regenerate all five through CI from the current manifests and imports. Do not rename or reuse archives.

## First release: manual bootstrap

The bootstrap below was completed for `0.1.0` and is retained as a reference. Do not rerun it for that version; subsequent releases need a new coordinated version and approved artifacts.

The four existing package names were bootstrapped at `0.1.0`; their trusted publishers have since been configured by the maintainer. The historical manual publication is complete and must not be rerun. It is retained below only as a record of the immutable `0.1.0` release.

After that approval, download the validated archives from a `main` run into `.tmp/npm-release`. Confirm that this reports `kunickiaj`:

```sh
npm whoami --registry 'https://registry.npmjs.org'
```

If it reports another account or requires login, authenticate manually with your personal npm account before continuing. Do not use a work account. Publish the exact downloaded archives in dependency order; for `0.1.0`:

```sh
npm publish .tmp/npm-release/catalog-history-common-0.1.0.tgz --access public --ignore-scripts --registry 'https://registry.npmjs.org'
npm publish .tmp/npm-release/catalog-history-node-0.1.0.tgz --access public --ignore-scripts --registry 'https://registry.npmjs.org'
npm publish .tmp/npm-release/catalog-history-backend-0.1.0.tgz --access public --ignore-scripts --registry 'https://registry.npmjs.org'
npm publish .tmp/npm-release/catalog-backend-module-history-0.1.0.tgz --access public --ignore-scripts --registry 'https://registry.npmjs.org'
```

Complete any npm browser or two-factor prompts yourself. Local publication does not generate GitHub Actions provenance; do not add `--provenance` to these bootstrap commands. npm package versions are immutable, so a partial release cannot be rolled back as one transaction.

## Release gate for `0.2.0`

Preparation of the `0.2.0` bootstrap tooling is approved; publication is not authorized yet. GitHub's `npm` environment retains its required reviewers and `main`-only deployment branch. Trusted publishing is already configured for the four existing package names.

The new `@kunickiaj/backstage-plugin-catalog-history` name is absent from npm. npm requires its first public publication before a trusted publisher can be configured for that name. Do not change npm trust settings or publish during validation.

After the separately approved manual frontend publication, configure its trusted publisher to match the existing packages:

| Setting           | Value                                     |
| ----------------- | ----------------------------------------- |
| User/organization | `kunickiaj`                               |
| Repository        | `backstage-plugin-catalog-module-history` |
| Workflow filename | `publish.yml`                             |
| Environment       | `npm`                                     |

Permit **direct `npm publish`** for the publisher. The default permission for staged publishing alone is insufficient for this workflow. No dist-tag management permission is needed.

A newly configured trusted publisher must make its first successful publish within two days or npm expires the configuration. Mark that window for follow-up, but do not create a new frontend version merely to test it: validation-only runs, or runs that skip every archive, do not prove the configuration works.

The workflow uses GitHub-hosted runners, Node 24, and npm pinned to `11.19.1` (trusted publishing requires npm 11.5.1 or later). Update that pin deliberately rather than installing a different CLI on every release. Only the publishing job receives `id-token: write`. There is no npm token secret or token fallback configured, and publication explicitly requests provenance.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) and [provenance](https://docs.npmjs.com/generating-provenance-statements) documentation for the account-side requirements.

## `0.2.0` publication procedure

The following external actions require the approvals named in each step. A successful bootstrap workflow is not a completed five-package publication: it intentionally leaves the frontend pending.

1. Dispatch **Publish npm packages** from the release branch with version `0.2.0`, **publish** unchecked, and **bootstrap_frontend** unchecked. This validation-only run packs and inspects the archives without publishing.
2. With explicit merge approval, merge the release PR.
3. With explicit approval to publish, dispatch the workflow from `main` with **publish** checked and **bootstrap_frontend** checked. The publishing job waits for validation and GitHub's `npm` environment approval, then uses the artifacts from that same successful run. It publishes common → node → storage-node → module with OIDC and provenance, and records the frontend as pending. Its final warning means the five-package release is incomplete.
4. With separate approval for manual npm publication, download `npm-release-COMMIT_SHA` for that same successful CI run through the GitHub UI. Keep all five archives together. Compare the logged deferred-frontend `sha512-...` integrity value and archive path with the downloaded frontend archive; the helper logs both so an operator can verify the exact bytes. Do not rebuild, repack, rename, or substitute an archive.
5. Authenticate to npm with the authorized personal `kunickiaj` account and complete any browser or two-factor prompts. A local `npm whoami` 401 does not block the GitHub Actions publication of the first four packages; it does block this separate manual step until authentication is completed. Then publish only the downloaded frontend archive:

   ```sh
   npm publish 'path/to/catalog-history-0.2.0.tgz' --access public --tag latest --ignore-scripts --registry 'https://registry.npmjs.org'
   ```

   Do not add `--provenance`: manual publication cannot make GitHub Actions provenance claims.

6. With separate approval, configure the frontend trusted publisher as described above. Future releases use the normal workflow from `main` with **bootstrap_frontend** unchecked after that configuration is in place.

To calculate the npm-style SHA-512 integrity value of the downloaded frontend archive for comparison with the workflow log:

```sh
node -e "const { createHash } = require('node:crypto'); const { readFileSync } = require('node:fs'); console.log('sha512-' + createHash('sha512').update(readFileSync(process.argv[1])).digest('base64'))" 'path/to/catalog-history-0.2.0.tgz'
```

Before a publishing job changes npm, the helper validates all five archives and checks each exact registry version. A version can be skipped only when its registry integrity matches the corresponding archive bytes. Different bytes, malformed metadata, or a registry error other than a missing version stop the run before publication.

Normal publication refuses to run while the frontend package name is absent. Bootstrap is allowed only while that name is absent; if the frontend name exists at any version, bootstrap stops rather than publishing a subset. It has no token fallback and does not allow an arbitrary package subset.

If one of the first four packages fails after another has published, rerun the publishing job from the original successful CI run so it reuses the same artifacts. Matching published bytes are skipped and the missing packages continue in dependency order. Do not dispatch a fresh run or retry with newly built archives against existing backend versions. If the frontend becomes public during recovery, stop using bootstrap and resolve the matching-byte and trusted-publisher requirements before normal publication.

Npm package versions are immutable. Do not edit or overwrite an already-published version.

The workflow does not create Git tags, GitHub releases, or changelogs, and it does not bump versions automatically.
