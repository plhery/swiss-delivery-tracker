import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disablePushNotifications,
  enablePushNotifications,
  inspectPushState,
} from '../lib/pushNotifications';
import { NotificationControl } from './NotificationControl';

vi.mock('../lib/pushNotifications', () => ({
  inspectPushState: vi.fn(),
  enablePushNotifications: vi.fn(),
  disablePushNotifications: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(inspectPushState).mockReset();
  vi.mocked(enablePushNotifications).mockReset();
  vi.mocked(disablePushNotifications).mockReset();
});

describe('NotificationControl', () => {
  it('enables alerts and shows the configured cadence', async () => {
    vi.mocked(inspectPushState).mockResolvedValue({ kind: 'prompt', publicKey: 'public' });
    vi.mocked(enablePushNotifications).mockResolvedValue(true);
    const apiAuth = {
      userId: 'user-1',
      getAccessToken: vi.fn().mockResolvedValue('token'),
    };
    const user = userEvent.setup();
    render(<NotificationControl apiAuth={apiAuth} />);

    await user.click(screen.getByRole('button', { name: 'Notification settings' }));
    expect(await screen.findByText(/every 10 minutes from 08:00 to 22:00/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(inspectPushState).toHaveBeenCalledWith(apiAuth);
    expect(enablePushNotifications).toHaveBeenCalledWith('public', apiAuth);
    expect(await screen.findByText('Updates will find you')).toBeInTheDocument();
  });

  it('turns alerts off for only this device', async () => {
    vi.mocked(inspectPushState)
      .mockResolvedValueOnce({ kind: 'enabled', publicKey: 'public' })
      .mockResolvedValueOnce({ kind: 'prompt', publicKey: 'public' });
    vi.mocked(disablePushNotifications).mockResolvedValue();
    const user = userEvent.setup();
    render(<NotificationControl />);
    await user.click(await screen.findByRole('button', { name: 'Notifications enabled' }));
    await user.click(screen.getByRole('button', { name: /turn off on this device/i }));
    expect(disablePushNotifications).toHaveBeenCalled();
    expect(await screen.findByText(/get parcel progress/i)).toBeInTheDocument();
  });

  it('gives iPhone installation guidance when Web Push is unavailable', async () => {
    vi.mocked(inspectPushState).mockResolvedValue({ kind: 'unsupported' });
    const user = userEvent.setup();
    render(<NotificationControl />);
    await user.click(screen.getByRole('button', { name: 'Notification settings' }));
    expect(await screen.findByText(/add Swiss Delivery Tracker to your Home Screen/i)).toBeInTheDocument();
  });
});
