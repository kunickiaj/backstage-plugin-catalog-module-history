# Contributing

## Checks

Run these before opening a pull request:

```sh
yarn prettier:check
yarn lint
yarn tsc
yarn test --watchAll=false
```

Storage and module tests need PostgreSQL 16. Point them at a local server:

```sh
env BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING=postgres://postgres:postgres@localhost:5432 yarn test --watchAll=false
```

## Code quality limits

`eslint.quality.js` adds these rules to Backstage's ESLint defaults in every package:

| Rule                                                            | Level   | Tests |
| --------------------------------------------------------------- | ------- | ----- |
| Type-only imports use `import type`                             | error   | error |
| No non-null assertions (`!`)                                    | error   | off   |
| No nested ternaries                                             | error   | error |
| Cyclomatic complexity of at most 15                             | warning | off   |
| Functions of at most 50 lines, without blank lines and comments | warning | off   |

Warnings mark existing code to split when you next change it. Each package's `lint` script caps its warnings with `--max-warnings` at the current count, so a change that adds a warning fails `yarn lint`. When you remove warnings, lower that package's cap to the new count in the same pull request.
