# @kunickiaj/backstage-plugin-catalog-history-common

Frontend/backend-safe types and API contracts for the Backstage catalog history plugin family.

This package owns:

- history source, operation, and mutation-type enums with type guards;
- cursor pagination and filter contracts for history list endpoints;
- timeline, cycle, version, as-of, diff, facet, and stats DTOs shared by the backend query API and the frontend plugin.

The contracts are intentionally transport-agnostic: they describe request and response payloads, while the backend router decides URL paths, validation, and permission behavior.

The `0.2.0` contracts serve the backend query API and frontend client from the same DTO surface.

It must not depend on backend-only Backstage packages, Knex, or Node-only APIs.

For architecture and roadmap details, see the [workspace README](../../README.md).
