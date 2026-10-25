/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TestApiProvider } from '@backstage/frontend-test-utils';
import { MemoryRouter } from 'react-router-dom';
import type {
  HistoryCycle,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  catalogHistoryApiRef,
  type CatalogHistoryApi,
} from '../api/CatalogHistoryApi';
import { CatalogHistoryPage } from './CatalogHistoryPage';

// Real plugin route binding and path overrides are covered by HistoryCycleNavigation.
// Keep this longer state regression independent of the full app's legacy sidebar.
jest.mock('@backstage/frontend-plugin-api', () => ({
  ...jest.requireActual('@backstage/frontend-plugin-api'),
  useRouteRef: () => () => '/audit-history',
}));

const entityRef = 'component:default/example';
const otherRef = 'group:teams/deleted';
const cycleId = 'CUSTOM?&/#ABC';
const header: HistoryCycle = {
  cycleId,
  source: 'provider',
  provider: ' Recorded Provider ',
  mutationType: 'full',
  startedAt: '2026-10-23T12:00:00.000Z',
  finishedAt: '2026-10-23T12:00:01.000Z',
  counts: { inserted: 4, updated: 8, deleted: 2, unchanged: 20 },
};
function event(id = 'selected', ref = entityRef): HistoryEntityVersionResponse {
  return {
    id,
    entityRef: ref,
    cycleId,
    source: header.source,
    provider: header.provider,
    op: 'update',
    changedAt: header.finishedAt,
    summary: {},
  };
}
function setup() {
  const api: jest.Mocked<
    CatalogHistoryApi & Required<Pick<CatalogHistoryApi, 'getChangeFeed'>>
  > = {
    getChangeFeed: jest.fn().mockResolvedValue({
      items: [
        {
          ...event(),
          kind: 'Component',
          namespace: 'default',
          name: 'example',
        },
      ],
    }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [event()] }),
    getEntityVersion: jest
      .fn()
      .mockImplementation(async ({ id, entityRef: ref }) => event(id, ref)),
    getCycle: jest.fn().mockResolvedValue({
      cycle: header,
      changes: {
        items: [
          {
            ...event('different', otherRef),
            kind: 'Group',
            namespace: 'teams',
            name: 'deleted',
          },
        ],
      },
    }),
    getEntities: jest.fn().mockResolvedValue({
      items: [
        {
          entityRef,
          kind: 'Component',
          namespace: 'default',
          name: 'example',
        },
      ],
    }),
    getKinds: jest.fn().mockResolvedValue({ items: ['Component', 'Group'] }),
    getProviders: jest.fn().mockResolvedValue({ items: [header.provider] }),
  };
  return api;
}

describe('recording cycle filter state', () => {
  it('restores applied controls and exact request scope after returning from a cycle', async () => {
    // Arrange
    const api = setup();
    render(
      <MemoryRouter initialEntries={['/audit-history']}>
        <TestApiProvider apis={[[catalogHistoryApiRef, api]]}>
          <CatalogHistoryPage />
        </TestApiProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('row', { name: /^Event selected,/ });
    const provider = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(provider);
    fireEvent.keyDown(provider, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', { name: 'Recorded Provider' }),
    );
    const entity = screen.getByRole('combobox', { name: 'Entity' });
    fireEvent.focus(entity);
    fireEvent.keyDown(entity, { key: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', {
        name: 'example — Component / default',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'provider' }));
    fireEvent.click(screen.getByRole('button', { name: /Operation$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'update' }));
    const after = '2026-10-01T12:00';
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: after },
    });
    await screen.findByRole('row', { name: /^Event selected,/ });
    // Act
    fireEvent.click(screen.getByRole('row', { name: /^Event selected,/ }));
    fireEvent.click(
      await screen.findByRole('link', {
        name: `View recording cycle ${cycleId}`,
      }),
    );
    await screen.findByRole('heading', { name: 'Recording cycle' });
    expect(
      screen.queryByRole('combobox', { name: 'Entity' }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    );
    await screen.findByRole('row', { name: /^Event selected,/ });
    // Assert: controls and subsequent changes must agree with the retained request.
    expect(screen.getByRole('combobox', { name: 'Entity' })).toHaveValue(
      'example',
    );
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue(
      'Component',
    );
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue(
      header.provider,
    );
    expect(screen.getByLabelText('Recorded after (local time)')).toHaveValue(
      after,
    );
    expect(screen.getByRole('button', { name: /Source$/ })).toHaveTextContent(
      'provider',
    );
    expect(
      screen.getByRole('button', { name: /Operation$/ }),
    ).toHaveTextContent('update');
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'processing' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityRef,
          kind: 'Component',
          provider: header.provider,
          source: 'processing',
          changedAfter: new Date(after).toISOString(),
        }),
      ),
    );
    const kind = screen.getByRole('combobox', { name: 'Kind' });
    fireEvent.focus(kind);
    fireEvent.keyDown(kind, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Group' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'Group',
          provider: header.provider,
        }),
      ),
    );
    expect(api.getChangeFeed.mock.calls.at(-1)![0].entityRef).toBeUndefined();
    expect(screen.getByRole('combobox', { name: 'Entity' })).toHaveValue('');
  });
});
