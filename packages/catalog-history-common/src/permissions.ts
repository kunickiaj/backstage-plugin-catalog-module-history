import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Grants access to retained catalog history, including deleted entities.
 * This permission does not inherit current catalog entity visibility.
 *
 * @public
 */
export const catalogHistoryReadPermission = createPermission({
  name: 'catalog-history.read',
  attributes: { action: 'read' },
});
