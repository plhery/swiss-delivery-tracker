import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ApiAuthenticationError } from './lib/apiClient';
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

function renderSignedInApp() {
  return render(
    <ParcelsProvider repo={createDemoRepo(window.localStorage)}>
      <App accountEmail="owner@example.test" onSignOut={vi.fn()} />
    </ParcelsProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('App', () => {
  it('opens a prefilled add sheet for content shared to the installed PWA', async () => {
    window.history.replaceState({}, '', '/?share-target=1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      label: 'Coffee delivery',
      trackingInput: 'Track 993412345612345678',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    renderApp();

    const sheet = await screen.findByRole('dialog', { name: 'Add a parcel' });
    expect(within(sheet).getByLabelText(/what's inside/i)).toHaveValue('Coffee delivery');
    expect(within(sheet).getByLabelText(/tracking number or link/i)).toHaveValue(
      'Track 993412345612345678',
    );
    expect(window.location.search).toBe('');
  });

  it('shows the seeded demo parcels and the demo banner', async () => {
    renderApp();
    expect(screen.getByRole('heading', {
      level: 1,
      name: 'Swiss Delivery Tracker',
    })).toBeInTheDocument();
    expect(await screen.findByText('Coffee beans ☕')).toBeInTheDocument();
    expect(screen.getByText('New sneakers 👟')).toBeInTheDocument();
    expect(screen.getByText('Birthday gift 🎁')).toBeInTheDocument();
    expect(screen.getByText(/demo mode/i)).toBeInTheDocument();
    expect(
      screen.queryByText('Every shipment, from first lookup to arrival.'),
    ).not.toBeInTheDocument();

    const active = screen.getByRole('region', { name: 'On the way' });
    expect(within(active).getByText('New sneakers 👟')).toBeInTheDocument();
    expect(within(active).queryByText('Birthday gift 🎁')).not.toBeInTheDocument();

    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(attention).getByText('Birthday gift 🎁')).toBeInTheDocument();
    expect(within(attention).getByText('Held at customs')).toBeInTheDocument();

    const past = screen.getByRole('region', { name: 'Past deliveries' });
    expect(within(past).getByText('Coffee beans ☕')).toBeInTheDocument();
  });

  it('keeps the signed-in language selector inside the account menu', async () => {
    const user = userEvent.setup();
    const { container } = renderSignedInApp();

    expect(container.querySelector('.language-control--header')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Account options for owner@example.test'));
    const accountMenu = container.querySelector('.account-menu');
    expect(accountMenu).not.toBeNull();
    expect(within(accountMenu as HTMLElement).getByRole('combobox', { name: 'Language' }))
      .toBeInTheDocument();
  });

  it('searches and clears the parcel list', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('Coffee beans ☕');

    const viewToggle = screen.getByRole('button', { name: 'Search & filters' });
    expect(viewToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox', { name: 'Search parcels' })).not.toBeInTheDocument();
    await user.click(viewToggle);
    expect(viewToggle).toHaveAttribute('aria-expanded', 'true');

    await user.type(screen.getByRole('searchbox', { name: 'Search parcels' }), 'birthday');

    expect(screen.getByText('Birthday gift 🎁')).toBeInTheDocument();
    expect(screen.queryByText('Coffee beans ☕')).not.toBeInTheDocument();
    expect(screen.queryByText('New sneakers 👟')).not.toBeInTheDocument();
    expect(screen.getByText('1 shown')).toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search parcels' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search parcels' }), 'not here');
    expect(screen.getByRole('heading', { name: 'No matching parcels' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(await screen.findByText('Coffee beans ☕')).toBeInTheDocument();
    expect(screen.getByText('3 shown')).toBeInTheDocument();
  });

  it('filters parcels by status and carrier', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: 'Search & filters' }));

    await user.selectOptions(screen.getByLabelText('Status'), 'delivered');
    expect(screen.getByText('Coffee beans ☕')).toBeInTheDocument();
    expect(screen.queryByText('Birthday gift 🎁')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await user.selectOptions(screen.getByLabelText('Carrier'), 'intl-post');
    expect(screen.getByText('Birthday gift 🎁')).toBeInTheDocument();
    expect(screen.queryByText('Coffee beans ☕')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide search & filters/i }));
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.getByText('Custom view')).toBeInTheDocument();
  });

  it('shows current stage badges on the cards', async () => {
    renderApp();
    expect(await screen.findByText('Delivered', { selector: '.status-badge' }))
      .toBeInTheDocument();
    expect(screen.getByText('Out for delivery')).toBeInTheDocument();
    expect(screen.getByText('At customs')).toBeInTheDocument();
  });

  it('treats returned parcels as final without calling them delivered', async () => {
    const returned: ParcelWithEvents = {
      id: 'parcel-returned',
      trackingNumber: 'LX123456789DE',
      label: 'Returned shoes',
      carrier: 'intl-post',
      createdAt: '2026-07-10T10:00:00Z',
      syncStatus: 'ok',
      events: [{
        id: 'event-returned',
        parcelId: 'parcel-returned',
        stage: 'returned',
        description: 'Returned to sender',
        occurredAt: '2026-07-20T10:00:00Z',
      }],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([returned]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([returned]),
    };

    renderApp(repo);

    expect(await screen.findByText('Returned shoes')).toBeInTheDocument();
    expect(screen.getByText(/nothing on the way right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'On the way' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Returned' })).getByText('Returned shoes'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Past deliveries' })).not.toBeInTheDocument();
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
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
      refreshParcel: vi.fn().mockResolvedValue(parcel),
    };

    renderApp(repo);

    expect(await screen.findByText('Expected tomorrow')).toBeInTheDocument();
  });

  it('puts a non-actionable parcel with a delivery window in Arriving today', async () => {
    const today = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    const expectedDelivery = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())} 13:00–15:00`;
    const parcel: ParcelWithEvents = {
      id: 'parcel-today',
      trackingNumber: '993412345612345678',
      label: 'Today parcel',
      carrier: 'swiss-post',
      createdAt: new Date().toISOString(),
      expectedDelivery,
      syncStatus: 'ok',
      events: [{
        id: 'event-today',
        parcelId: 'parcel-today',
        stage: 'out_for_delivery',
        description: 'Out for delivery',
        occurredAt: new Date().toISOString(),
      }],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([parcel]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
    };

    renderApp(repo);

    const section = await screen.findByRole('region', { name: 'Arriving today' });
    expect(within(section).getByText('Today parcel')).toBeInTheDocument();
    expect(within(section).getAllByText(/^Expected today/)).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'On the way' })).not.toBeInTheDocument();
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

  it('asks for a DPD postcode and submits only four digits', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(
      within(sheet).getByLabelText(/tracking number/i),
      '06086514587082',
    );
    await user.selectOptions(within(sheet).getByLabelText(/carrier/i), 'dpd');

    const postcode = within(sheet).getByLabelText(/delivery postcode/i);
    expect(postcode).toBeRequired();
    expect(postcode).toHaveValue('');
    expect(within(sheet).getByRole('button', { name: /add parcel/i })).toBeDisabled();

    await user.type(postcode, '80A04');
    expect(postcode).toHaveValue('8004');
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '06086514587082',
      label: '',
      carrier: 'dpd',
      dpdPostcode: '8004',
    });
  });

  it('prefills the postcode from the newest DPD parcel', async () => {
    const repo = createDemoRepo(window.localStorage);
    await repo.add({
      trackingNumber: '06086514587082',
      label: 'Previous DPD parcel',
      carrier: 'dpd',
      dpdPostcode: '8004',
    });
    const user = userEvent.setup();
    renderApp(repo);
    await screen.findByText('Previous DPD parcel');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(
      within(sheet).getByLabelText(/tracking number/i),
      '06086514587083',
    );
    await user.selectOptions(within(sheet).getByLabelText(/carrier/i), 'dpd');

    expect(within(sheet).getByLabelText(/delivery postcode/i)).toHaveValue('8004');
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
      rename: vi.fn(),
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

  it('extracts the carrier and tracking number from a pasted tracking link', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    await user.type(
      within(sheet).getByLabelText(/tracking number or link/i),
      'https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming?parcelNumber=06086514587082',
    );

    expect(within(sheet).getByText('06086514587082').closest('p')).toHaveTextContent(
      /found 06086514587082 in the pasted link/i,
    );
    expect(within(sheet).getByText(/DPD will sync automatically/i)).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText(/delivery postcode/i), '8004');

    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '06086514587082',
      label: '',
      carrier: 'dpd',
      dpdPostcode: '8004',
    });
  });

  it('captures a complete Planzer shared link from the primary paste field', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    const trackingUrl =
      'https://trackandtrace.planzergroup.com/shared/sendungen/999.90.03316119?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH';
    await user.type(within(sheet).getByLabelText(/tracking number or link/i), trackingUrl);

    expect(within(sheet).queryByLabelText(/planzer tracking url/i)).not.toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /add parcel/i })).toBeEnabled();
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '999.90.03316119',
      label: '',
      carrier: 'planzer',
      trackingUrl,
    });
  });

  it('captures a complete Dachser capability link from the primary paste field', async () => {
    const base = createDemoRepo(window.localStorage);
    const add = vi.fn(base.add);
    const user = userEvent.setup();
    renderApp({ ...base, add });
    await screen.findByText('Coffee beans ☕');

    await user.click(screen.getByRole('button', { name: /add a parcel/i }));
    const sheet = screen.getByRole('dialog', { name: /add a parcel/i });
    const trackingUrl =
      'https://customeriberia.dachser.com/customerarea/utilidades/seguimiento-publico/detalle?cliente=generico&numeroUnico=9010000001234&fecha=20260513&clave=TESTKEY9';
    await user.type(within(sheet).getByLabelText(/tracking number or link/i), trackingUrl);

    expect(within(sheet).queryByLabelText(/dachser tracking url/i)).not.toBeInTheDocument();
    expect(within(sheet).getByText(/Dachser will sync automatically/i)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /add parcel/i })).toBeEnabled();
    await user.click(within(sheet).getByRole('button', { name: /add parcel/i }));

    expect(add).toHaveBeenCalledWith({
      trackingNumber: '9010000001234',
      label: '',
      carrier: 'dachser',
      trackingUrl,
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
    await user.type(within(sheet).getByLabelText(/tracking number/i), 'hello there');
    expect(within(sheet).getByText(/couldn't find a tracking number/i)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /add parcel/i })).toBeDisabled();
  });

  it('isolates the add sheet, focuses its primary field, and restores focus', async () => {
    const user = userEvent.setup();
    renderApp();
    const trigger = await screen.findByRole('button', { name: /add a parcel/i });

    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /add a parcel/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByLabelText(/tracking number/i)).toHaveFocus();
    expect(document.querySelector('.app')).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /add a parcel/i })).not.toBeInTheDocument();
    expect(document.querySelector('.app')).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('');
    expect(trigger).toHaveFocus();
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
        clientX: 12,
        clientY: 180,
      }),
    );
    fireEvent(
      detail,
      new MouseEvent('pointerup', {
        bubbles: true,
        clientX: 142,
        clientY: 190,
      }),
    );
    expect(
      screen.queryByRole('dialog', { name: 'Coffee beans ☕' }),
    ).not.toBeInTheDocument();
  });

  it('shows both handoff trackers and marks Swiss Post as not ready yet', async () => {
    const user = userEvent.setup();
    const parcel: ParcelWithEvents = {
      id: 'parcel-handoff',
      trackingNumber: 'LW230226618CH',
      label: 'AliExpress parcel',
      carrier: 'swiss-post',
      trackingSource: 'aliexpress',
      swissPostReady: false,
      createdAt: '2026-08-06T08:00:00Z',
      syncStatus: 'ok',
      events: [{
        id: 'event-china',
        parcelId: 'parcel-handoff',
        stage: 'in_transit',
        description: 'Departed origin country',
        occurredAt: '2026-08-06T08:00:00Z',
      }],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([parcel]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
      refreshParcel: vi.fn().mockResolvedValue(parcel),
    };

    renderApp(repo);
    await user.click(await screen.findByText('AliExpress parcel'));

    const detail = screen.getByRole('dialog', { name: 'AliExpress parcel' });
    const sources = within(detail).getByLabelText('Tracking sources');
    expect(within(sources).getByRole('link', { name: /open on aliexpress/i }))
      .toHaveAttribute('href', expect.stringContaining('global.cainiao.com'));
    expect(within(sources).queryByText('Active source')).not.toBeInTheDocument();
    expect(within(sources).getByRole('link', { name: /open on swiss post.*not ready yet/i }))
      .toHaveAttribute('href', expect.stringContaining('service.post.ch'));
  });

  it('edits a parcel title from the detail view', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    const detail = screen.getByRole('dialog', { name: 'Coffee beans ☕' });
    await user.click(within(detail).getByRole('button', { name: /edit parcel title/i }));

    const title = within(detail).getByRole('textbox', { name: /parcel title/i });
    expect(title).toHaveValue('Coffee beans ☕');
    expect(title).toHaveAttribute('maxlength', '80');
    await user.clear(title);
    await user.type(title, 'Espresso beans');
    await user.click(within(detail).getByRole('button', { name: /save title/i }));

    const renamedDetail = await screen.findByRole('dialog', { name: 'Espresso beans' });
    await user.click(within(renamedDetail).getByRole('button', { name: /back/i }));
    expect(await screen.findByText('Espresso beans')).toBeInTheDocument();
    expect(screen.queryByText('Coffee beans ☕')).not.toBeInTheDocument();
  });

  it('copies a parcel tracking number from its detail ticket', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText');
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    await user.click(screen.getByRole('button', { name: /copy tracking number/i }));

    expect(writeText).toHaveBeenCalledWith('993412345678901234');
    expect(screen.getByRole('button', { name: /copy tracking number/i })).toHaveTextContent('Copied');
  });

  it('mutes one parcel across the stored notification setting', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText('New sneakers 👟'));

    const toggle = screen.getByRole('switch', { name: 'Parcel alerts' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);

    expect(screen.getByRole('switch', { name: 'Parcel alerts' }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Parcel alerts' }))
      .toHaveTextContent('Muted');
    expect(screen.getByRole('dialog', { name: 'New sneakers 👟' }).lastElementChild)
      .toHaveClass('detail__notification-footer');
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
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
      refreshParcel: vi.fn().mockResolvedValue(parcel),
    };
    window.history.replaceState({}, '', '/?parcel=parcel-from-push');
    const user = userEvent.setup();
    renderApp(repo);
    const detail = await screen.findByRole('dialog', { name: 'From notification' });
    expect(detail).toBeInTheDocument();
    await user.click(within(detail).getByRole('button', { name: /back/i }));
    expect(window.location.search).toBe('');
  });

  it('opens parcel details as a browser history entry', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    expect(window.location.search).toContain('parcel=');
    expect(screen.getByRole('dialog', { name: 'Coffee beans ☕' })).toBeInTheDocument();

    act(() => window.history.back());
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Coffee beans ☕' })).not.toBeInTheDocument();
    });
    expect(window.location.search).toBe('');

    act(() => window.history.forward());
    expect(await screen.findByRole('dialog', { name: 'Coffee beans ☕' })).toBeInTheDocument();
  });

  it('archives a parcel immediately and offers undo', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByText('Coffee beans ☕'));
    await user.click(screen.getByRole('button', { name: /archive parcel/i }));

    expect(screen.queryByRole('dialog', { name: 'Coffee beans ☕' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Coffee beans ☕ archived');
    expect(screen.getByRole('region', { name: 'Archived' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));

    expect(await screen.findByText('Coffee beans ☕')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Archived' })).not.toBeInTheDocument();
  });

  it('archives a parcel with a long swipe to the left', async () => {
    renderApp();

    const label = await screen.findByText('Coffee beans ☕');
    const card = label.closest('button');
    expect(card).not.toBeNull();
    fireEvent.pointerDown(card!, { pointerId: 1, isPrimary: true, clientX: 240, clientY: 100 });
    fireEvent.pointerMove(card!, { pointerId: 1, isPrimary: true, clientX: 110, clientY: 105 });
    fireEvent.pointerUp(card!, { pointerId: 1, isPrimary: true, clientX: 110, clientY: 105 });

    expect(await screen.findByRole('status')).toHaveTextContent('Coffee beans ☕ archived');
    expect(screen.getByRole('region', { name: 'Archived' })).toBeInTheDocument();
  });

  it('keeps archive failures inside the parcel dialog', async () => {
    const base = createDemoRepo(window.localStorage);
    const user = userEvent.setup();
    renderApp({
      ...base,
      remove: vi.fn().mockRejectedValue(new Error('Archive service unavailable')),
    });

    await user.click(await screen.findByText('Coffee beans ☕'));
    await user.click(screen.getByRole('button', { name: /archive parcel/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Archive service unavailable');
    expect(screen.getByRole('dialog', { name: 'Coffee beans ☕' })).toBeInTheDocument();
  });

  it('restores a parcel from the collapsed archive', async () => {
    const archived: ParcelWithEvents = {
      id: 'parcel-archived',
      trackingNumber: '993412345612345678',
      label: 'Old delivery',
      carrier: 'swiss-post',
      createdAt: '2026-05-01T10:00:00Z',
      archivedAt: '2026-08-01T10:00:00Z',
      syncStatus: 'ok',
      events: [{
        id: 'delivered-event',
        parcelId: 'parcel-archived',
        stage: 'delivered',
        description: 'Delivered',
        occurredAt: '2026-05-04T10:00:00Z',
      }],
    };
    const restored = { ...archived, archivedAt: undefined };
    const restore = vi.fn().mockResolvedValue(restored);
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([archived]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      restore,
      refresh: vi.fn().mockResolvedValue([archived]),
    };
    const user = userEvent.setup();
    renderApp(repo);

    const archive = await screen.findByRole('region', { name: 'Archived' });
    await user.click(within(archive).getByText('Archived'));
    await user.click(within(archive).getByRole('button', { name: /old delivery/i }));
    await user.click(screen.getByRole('button', { name: /restore parcel/i }));

    expect(restore).toHaveBeenCalledWith(archived.id);
    expect(
      within(await screen.findByRole('region', { name: 'Past deliveries' }))
        .getByText('Old delivery'),
    ).toBeInTheDocument();
  });

  it('permanently deletes an archived parcel after confirmation', async () => {
    const archived: ParcelWithEvents = {
      id: 'parcel-archived',
      trackingNumber: '993412345612345678',
      label: 'Old delivery',
      carrier: 'swiss-post',
      createdAt: '2026-05-01T10:00:00Z',
      archivedAt: '2026-08-01T10:00:00Z',
      syncStatus: 'ok',
      events: [],
    };
    const deleteArchived = vi.fn().mockResolvedValue(undefined);
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([archived]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      deleteArchived,
      refresh: vi.fn().mockResolvedValue([archived]),
    };
    const user = userEvent.setup();
    renderApp(repo);

    const archive = await screen.findByRole('region', { name: 'Archived' });
    await user.click(within(archive).getByText('Archived'));
    await user.click(within(archive).getByRole('button', { name: /old delivery/i }));
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(screen.getByRole('group', { name: /permanently delete old delivery/i }))
      .toHaveTextContent('cannot be undone');
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(deleteArchived).toHaveBeenCalledWith(archived.id);
    expect(screen.queryByRole('dialog', { name: 'Old delivery' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Archived' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Old delivery permanently deleted');
  });

  it('advances the simulation when refreshing in demo mode', async () => {
    const user = userEvent.setup();
    renderApp();

    // The sneakers are out for delivery; one refresh delivers them.
    expect(await screen.findByText('Out for delivery')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /refresh tracking/i }));

    const cards = await screen.findAllByText('Delivered');
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('status')).toHaveTextContent('Tracking checks queued');
  });

  it('shows initial-load and refresh failures', async () => {
    const failingRepo: ParcelRepo = {
      mode: 'api',
      list: vi.fn()
        .mockRejectedValueOnce(new Error('Could not load deliveries'))
        .mockResolvedValueOnce([]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    };
    const user = userEvent.setup();
    const first = renderApp(failingRepo);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load deliveries');
    expect(screen.queryByText('No parcels yet')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No parcels yet')).toBeInTheDocument();
    first.unmount();

    const base = createDemoRepo(window.localStorage);
    renderApp({ ...base, refresh: vi.fn().mockRejectedValue(new Error('Sync unavailable')) });
    await screen.findByText('Coffee beans ☕');
    await user.click(screen.getByRole('button', { name: /refresh tracking/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sync unavailable');
  });

  it('shows the last saved parcels when the API is temporarily unavailable', async () => {
    const cached: ParcelWithEvents = {
      id: 'cached-parcel',
      trackingNumber: '993412345612345678',
      label: 'Saved coffee',
      carrier: 'swiss-post',
      createdAt: '2026-07-15T00:00:00Z',
      syncStatus: 'ok',
      events: [],
    };
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockRejectedValue(new Error('You are offline')),
      cachedList: () => [cached],
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    };

    renderApp(repo);

    expect(await screen.findByText('Saved coffee')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('last parcel data saved');
    expect(screen.queryByText('No parcels yet')).not.toBeInTheDocument();
  });

  it('offers the sign-in screen when the API session expires', async () => {
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockRejectedValue(new ApiAuthenticationError()),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn(),
    };

    renderApp(repo);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in needed');
    expect(alert).toHaveTextContent('sign-in expired');
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/',
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
      rename: vi.fn(),
      remove: vi.fn(),
      refresh: vi.fn().mockResolvedValue([parcel]),
      refreshParcel: vi.fn().mockResolvedValue(parcel),
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
    await user.click(screen.getByRole('button', { name: /check now/i }));
    expect(repo.refreshParcel).toHaveBeenCalledWith(parcel.id);
    expect(screen.getByText(/Tracking check queued/)).toBeInTheDocument();
  });

  it('shows a friendly empty state when there are no parcels', async () => {
    const repo: ParcelRepo = {
      mode: 'api',
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      refresh: vi.fn().mockResolvedValue([]),
    };
    renderApp(repo);

    expect(await screen.findByText(/no parcels yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing on the way right now/i)).toBeInTheDocument();
  });
});
