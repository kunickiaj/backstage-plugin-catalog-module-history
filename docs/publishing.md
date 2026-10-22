# Publishing packages

The **Publish npm packages** workflow validates and packs all four packages. It publishes only when a maintainer explicitly requests publication from `main`. Ordinary pushes, merges, tags, and pull requests never publish.

## Validate a release

All four packages use the same stable version. Update their `version` fields and internal dependency ranges together, update the lockfile, and merge the change before publishing. The helper accepts stable versions such as `0.1.0`, not prerelease versions.

In GitHub Actions, select **Publish npm packages → Run workflow**, choose a ref and enter that version. Leave **publish** unchecked. Validation runs release-helper tests, formatting, lint, typecheck, build, and the repository tests against PostgreSQL 16. It then packs and inspects the archives without contacting npm to publish them.

Download the `npm-release-COMMIT_SHA` artifact from that run. It contains:

1. `catalog-history-common-VERSION.tgz`
2. `catalog-history-node-VERSION.tgz`
3. `catalog-history-backend-VERSION.tgz`
4. `catalog-backend-module-history-VERSION.tgz`

The archives contain compiled JavaScript and declarations, not workspace source entry points. Local packing requires `yarn tsc` before `yarn build`, followed by `node scripts/npm-release.mjs pack VERSION`.

## First release: manual bootstrap

npm trusted publishers are configured in each existing package's settings. They cannot bootstrap these package names before their first publication. The first release therefore requires a separately approved manual publish from your personal npm account; no npm token needs to be stored in GitHub.

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

## Configure trusted publishing for later releases

This is external setup, not something the workflow configures. Arrange it shortly before the first automated release.

1. Create a GitHub environment named **npm**, restrict its deployment branches to `main`, and add the required reviewer approval rules. An `environment: npm` line alone does **not** configure those protections.
2. In the npm settings for **each** of the four packages, add a GitHub Actions trusted publisher:

   | Setting           | Value                                     |
   | ----------------- | ----------------------------------------- |
   | User/organization | `kunickiaj`                               |
   | Repository        | `backstage-plugin-catalog-module-history` |
   | Workflow filename | `publish.yml`                             |
   | Environment       | `npm`                                     |

3. Permit **direct `npm publish`** for that publisher. The default permission for staged publishing alone is insufficient for this workflow. No dist-tag management permission is needed.
4. Complete a successful automated publish within npm's two-day validation window for new publisher configurations. An all-skipped rerun of an already-published version does not validate a new publisher; prepare a new version for that first automated release.

The workflow uses GitHub-hosted runners, Node 24, and npm pinned to `11.19.1` (trusted publishing requires npm 11.5.1 or later). Update that pin deliberately rather than installing a different CLI on every release. Only the publishing job receives `id-token: write`. There is no npm token secret or token fallback configured, and publication explicitly requests provenance.

See npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) and [provenance](https://docs.npmjs.com/generating-provenance-statements) documentation for the account-side requirements.

## Publish and retry

After setup and release approval, dispatch the workflow on `main` with the shared version and **publish** checked. The publishing job waits for successful validation and the GitHub environment's configured approval. It downloads archives from the same workflow run and publishes common → node → backend → module. It does not rebuild in the job that has publishing permission.

Before publishing anything, the helper checks every archive and looks up every exact version on npm. Existing versions are skipped only when their registry integrity matches the local archive bytes. Different bytes, malformed metadata, or registry errors other than a missing version stop the run before publication begins.

If a later publish fails, earlier successful publishes remain public. After correcting the cause, choose **Re-run failed jobs** on the original run so the publishing job can reuse its validation archives. Matching versions are skipped, and missing packages continue in dependency order.

A fresh dispatch or **Re-run all jobs** rebuilds the archives; even the same source commit may produce different bytes. If integrity differs or the original artifacts are no longer available, investigate and prepare a new coordinated version when necessary. Do not edit or overwrite an already-published version.

The workflow does not create Git tags, GitHub releases, or changelogs, and it does not bump versions automatically.
