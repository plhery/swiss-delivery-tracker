import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { CloudflareAccessError } from './lib/cloudflareAccess';
import { createDemoRepo } from './store/demoRepo';
import { ParcelsProvider } from './store/ParcelsContext';
import type { ParcelRepo, ParcelWithEvents } from './types';

function renderApp(repo: ParcelRepo = createDemoRepo(window.localStorage)) {
  return render(
    <ParcelsProvider repo={repo}>
      <App />
    </ParcelsProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('App', () => {
  it('shows the seeded demo parcels and the demo banner', async () => {
    renderApp();
    expect(await screen.findByText('Coffee beans ☕')).toBeInTheDocument();
    expect(screen.getByText('New sneakers 👟')).toBeInTheDocument();
    expect(screen.getByText('Birthday gift 🎁')).toBeInTheDocument();
    expect(screen.getByText(/demo mode/i)).toBeInTheDocument();

    const active = screen.getByRole('region', { name: 'On the way' });
    expect(within(active).getByText('New sneakers 👟')).toBeInTheDocument();
    expect(within(active).getByText('Birthday gift 🎁')).toBeInTheDocument();

    const past = screen.getByRole('region', { name: 'Past deliveries' });
    expect(within(past).getByText('Coffee beans ☕')).toBeInTheDocument();
  });

  it('shows current stage badges on the cards', async () => {
    renderApp();
    expect(await screen.findByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('Out for delivery')).toBeInTheDocument();
    expect(screen.getByText('At customs')).toBeInTheDocument();
  });

  it('shows a tomorrow ETA on the main parcel card', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (value: number) => String(value).padStart(2, '0');
    const expectedDelivery = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    const parcel: ParcelWithEvents = {
      id: 'parcel-with-eta',
      trackingNumber: '993412345612345678',
      label: 'Tomorrow parcel',
      carrier: 'swiss-post',
      createdAt: new Date().toISOString(),
      expectedDelivery,
      syncStatus: 'ok',
      events: [],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([parcel]),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
    };

    renderApp(repo);

    expect(await screen.findByText('Expected tomorrow')).toBeInTheDocument();
  });

  it('adds a parcel through the bottom sheet', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });

    await user.type(
      within(sheet).getByLabelText(/what's inside/i),
      'Fondue set 🫕',
    );
    await user.type(
      within(sheet).getByLabelText(/tracking number/i),
      '99.34.111111.22222222',
    );
    expect(
      within(sheet).getByText(/swiss post will sync automatically/i),
    ).toBeInTheDocument();

    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(await screen.findByText('Fondue set 🫕')).toBeInTheDocument();
    expect(screen.getByText('Tracked')).toBeInTheDocument();
    expect(
      screen.queryByRole('dialog', { name: /add a parcel/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the first sync in progress and reflects its result without manual refresh', async () => {
    const pendingEvent = {
      id: 'event-pending',
      parcelId: 'parcel-syncing',
      stage: 'pending' as const,
      description: 'Tracking added',
      occurredAt: '2026-07-16T10:00:00Z',
    };
    let parcel: ParcelWithEvents = {
      id: 'parcel-syncing',
      trackingNumber: '993412345612345678',
      label: 'Fresh parcel',
      carrier: 'swiss-post',
      createdAt: '2026-07-16T10:00:00Z',
      syncStatus: 'pending',
      events: [pendingEvent],
    };
    let notify: (() => void | Promise<void>) | undefined;
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn(async () => [parcel]),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(async () => [parcel]),
      subscribe: (onChange) => {
        notify = onChange;
        return () => undefined;
      },
    };
    renderApp(repo);

    expect(await screen.findByText('Sync in progress')).toBeInTheDocument();

    parcel = {
      ...parcel,
      syncStatus: 'ok',
      events: [
        pendingEvent,
        {
          id: 'event-announced',
          parcelId: parcel.id,
          stage: 'registered',
          description: 'Shipment announced',
          occurredAt: '2026-07-16T10:00:01Z',
        },
      ],
    };
    await act(async () => {
      await notify?.();
    });

    expect(screen.getByText('Announced')).toBeInTheDocument();
    expect(screen.queryByText('Sync in progress')).not.toBeInTheDocument();
  });

  it('keeps a manual carrier selection for ambiguous tracking numbers', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(within(sheet).getByLabelText(/tracking number/i), 'ambiguous-123');
    await user.selectOptions(within(sheet).getByLabelText('Carrier'), 'planzer');
    expect(within(sheet).getByText(/Planzer will sync automatically/i)).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: 'ambiguous-123',
      label: '',
      carrier: 'planzer',
    });
  });

  it('automatically detects a Planzer delivery number', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(
      within(sheet).getByLabelText(/tracking number/i),
      '91346097020038089282',
    );

    expect(
      within(sheet).getByText(/Planzer will sync automatically/i),
    ).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '91346097020038089282',
      label: '',
      carrier: 'planzer',
    });
  });

  it('asks for the complete URL for a Planzer shared-link shipment', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(
      within(sheet).getByLabelText(/tracking number/i),
      '999.90.03316119',
    );

    const urlField = within(sheet).getByLabelText(/planzer tracking url/i);
    expect(urlField).toBeRequired();
    expect(within(sheet).getByRole('button', { name: /add parcel/i })).toBeDisabled();

    const trackingUrl =
      'https://trackandtrace.planzergroup.com/shared/sendungen/999.90.03316119?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH';
    await user.type(urlField, trackingUrl);
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '999.90.03316119',
      label: '',
      carrier: 'planzer',
      trackingUrl,
    });
  });

  it('keeps the add sheet open and reports repository failures', async () => {
    const base = createDemoRepo(window.localStorage);
    const user = userEvent.setup();
    renderApp({ ...base, add: vi.fn().mockRejectedValue(new Error('Duplicate parcel')) });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(within(sheet).getByLabelText(/tracking number/i), '123456');
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(await within(sheet).findByRole('alert')).toHaveTextContent('Duplicate parcel');
    expect(sheet).toBeInTheDocument();
  });

  it('requires a tracking number before submitting', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    expect(
      within(sheet).getByRole('button', { name: /add parcel/i }),
    ).toBeDisabled();
  });

  it('opens the detail view with the full journey timeline', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));

    const detail = screen.getByRole('dialog', { name: 'Coffee beans ☕' });
    const timeline = within(detail).getByRole('list', {
      name: /tracking history/i,
    });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(5);

    // Newest first: delivered on top, announcement at the bottom.
    expect(within(items[0]).getByText('Delivered')).toBeInTheDocument();
    expect(within(items[4]).getByText('Announced')).toBeInTheDocument();
    expect(
      within(detail).getByRole('link', { name: /open on swiss post/i }),
    ).toBeInTheDocument();

    fireEvent(
      detail,
      new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 280,
        clientY: 180,
      }),
    );
    fireEvent(
      detail,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 150,
        clientY: 190,
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Coffee beans ☕' }),
    ).not.toBeInTheDocument();
  });

  it('opens notification deep links and clears the parcel query on back', async () => {
    const parcel: ParcelWithEvents = {
      id: 'parcel-from-push',
      trackingNumber: '993412345612345678',
      label: 'From notification',
      carrier: 'swiss-post',
      createdAt: '2026-07-15T08:00:00Z',
      syncStatus: 'ok',
      events: [],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([parcel]),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
    };
    window.history.replaceState({}, '', '/?parcel=parcel-from-push');
    const user = userEvent.setup();
    renderApp(repo);
    const detail = await screen.findByRole('dialog', { name: 'From notification' });
    expect(detail).toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: /back/i }));
    expect(window.location.search).toBe('');
  });

  it('removes a parcel after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    await user.click(screen.getByRole('button', { name: /remove parcel/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(screen.queryByText('Coffee beans ☕')).not.toBeInTheDocument();
  });

  it('keeps the parcel when confirmation is declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    await user.click(screen.getByRole('button', { name: /remove parcel/i }));

    // Detail stays open and the parcel is still there.
    expect(
      screen.getByRole('dialog', { name: 'Coffee beans ☕' }),
    ).toBeInTheDocument();
  });

  it('advances the simulation when refreshing in demo mode', async () => {
    const user = userEvent.setup();
    renderApp();

    // The sneakers are out for delivery; one refresh delivers them.
    expect(await screen.findByText('Out for delivery')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh tracking/i }));

    const cards = await screen.findAllByText('Delivered');
    expect(cards.length).toBeGreaterThanOrEqual(2);
  });

  it('shows initial-load and refresh failures', async () => {
    const failingRepo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockRejectedValue(new Error('Could not load deliveries')),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    };
    const first = renderApp(failingRepo);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load deliveries');
    first.unmount();

    const base = createDemoRepo(window.localStorage);
    const user = userEvent.setup();
    renderApp({ ...base, refresh: vi.fn().mockRejectedValue(new Error('Sync unavailable')) });
    await screen.findByText('Coffee beans ☕');
    await user.click(screen.getByRole('button', { name: /refresh tracking/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sync unavailable');
  });

  it('offers an uncached sign-in route when Cloudflare Access expires', async () => {
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockRejectedValue(new CloudflareAccessError()),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    };

    renderApp(repo);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in needed');
    expect(alert).toHaveTextContent('Cloudflare Access session expired');
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/reauth',
    );
  });

  it('shows sync diagnostics and an empty journey', async () => {
    const parcel: ParcelWithEvents = {
      id: 'pkg-error',
      trackingNumber: '993412345612345678',
      label: '',
      carrier: 'swiss-post',
      createdAt: '2026-07-14T10:00:00Z',
      lastSyncedAt: '2026-07-14T12:00:00Z',
      syncStatus: 'error',
      syncError: 'Carrier maintenance',
      events: [],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([parcel]),
      add: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
    };
    const user = userEvent.setup();
    renderApp(repo);

    expect(await screen.findByText('Sync needs attention')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /Parcel — Sync failed/i }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Carrier maintenance');
    expect(
      screen.getByText(/carrier hasn’t announced this shipment yet/i),
    ).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no parcels', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderApp();

    for (const label of ['Coffee beans ☕', 'New sneakers 👟', 'Birthday gift 🎁']) {
      await user.click(await screen.findByText(label));
      await user.click(screen.getByRole('button', { name: /remove parcel/i }));
    }

    expect(await screen.findByText(/no parcels yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing on the way right now/i)).toBeInTheDocument();
  });
});
