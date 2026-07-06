# @kunickiaj/catalog-history-common

Frontend/backend-safe types and API contracts for the Backstage catalog history plugin family.

This package owns:

- history source, operation, and mutation-type enums with type guards;
- cursor pagination contracts for history list endpoints;
- timeline and cycle DTOs shared by the backend query API and the frontend plugin.

Diff and change-summary contracts are intentionally deferred until the diff endpoint is implemented, so published shapes are validated by real code.

It must not depend on backend-only Backstage packages, Knex, or Node-only APIs.

For architecture and roadmap details, see the [workspace README](../../README.md).
