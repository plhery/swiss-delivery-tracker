import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiApplication } from './ApiApplication';

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  browserStorage: vi.fn(),
  createApiRepo: vi.fn(),
  clearApiCache: vi.fn(),
  disablePushNotifications: vi.fn(),
  unsubscribePushNotificationsLocally: vi.fn(),
  exportAccount: vi.fn(),
  downloadAccountExport: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock('./auth/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('./store/apiRepo', () => ({
  browserStorage: mocks.browserStorage,
  createApiRepo: mocks.createApiRepo,
  clearApiCache: mocks.clearApiCache,
}));
vi.mock('./store/ParcelsContext', () => ({
  ParcelsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./lib/pushNotifications', () => ({
  disablePushNotifications: mocks.disablePushNotifications,
  unsubscribePushNotificationsLocally: mocks.unsubscribePushNotificationsLocally,
}));
vi.mock('./lib/account', () => ({
  exportAccount: mocks.exportAccount,
  downloadAccountExport: mocks.downloadAccountExport,
  deleteAccount: mocks.deleteAccount,
}));
vi.mock('./components/SignInScreen', () => ({
  SignInScreen: ({ configured }: { configured: boolean }) => (
    <div>{configured ? 'Configured sign in' : 'Unconfigured sign in'}</div>
  ),
}));
vi.mock('./App', () => ({
  default: ({
    accountEmail,
    onSignOut,
    onExportAccount,
    onDeleteAccount,
  }: {
    accountEmail: string;
    onSignOut: () => Promise<void>;
    onExportAccount: () => Promise<void>;
    onDeleteAccount: (confirmation: string) => Promise<void>;
  }) => (
    <div>
      <span>{accountEmail}</span>
      <button type="button" onClick={() => void onExportAccount()}>Export</button>
      <button type="button" onClick={() => void onDeleteAccount(accountEmail)}>Delete</button>
      <button type="button" onClick={() => void onSignOut()}>Sign out</button>
    </div>
  ),
}));

const USER = {
  id: '10000000-0000-0000-0000-000000000001',
  email: 'owner@example.test',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = {
    status: 'anonymous',
    user: null,
    getAccessToken: vi.fn().mockResolvedValue('token'),
    googleEnabled: false,
    emailOtpEnabled: true,
    signInWithGoogle: vi.fn(),
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  mocks.browserStorage.mockReturnValue(window.localStorage);
  mocks.createApiRepo.mockReturnValue({ mode: 'api' });
  mocks.disablePushNotifications.mockResolvedValue(undefined);
  mocks.unsubscribePushNotificationsLocally.mockResolvedValue(undefined);
  mocks.exportAccount.mockResolvedValue({ exportedAt: '2026-08-05T12:00:00Z' });
  mocks.deleteAccount.mockResolvedValue(undefined);
});

describe('ApiApplication', () => {
  it('renders loading and both sign-in configuration states', () => {
    mocks.auth.status = 'loading';
    const result = render(<ApiApplication />);
    expect(screen.getByRole('status')).toHaveTextContent('Opening your secure delivery box');

    mocks.auth.status = 'unconfigured';
    result.rerender(<ApiApplication />);
    expect(screen.getByText('Unconfigured sign in')).toBeInTheDocument();

    mocks.auth.status = 'anonymous';
    result.rerender(<ApiApplication />);
    expect(screen.getByText('Configured sign in')).toBeInTheDocument();
  });

  it('wires account export, deletion, and privacy-clean sign-out', async () => {
    mocks.auth.status = 'authenticated';
    mocks.auth.user = USER;
    mocks.disablePushNotifications.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<ApiApplication />);

    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    expect(mocks.createApiRepo).toHaveBeenCalledWith(
      30_000,
      1_000,
      window.localStorage,
      expect.objectContaining({ userId: USER.id }),
    );

    await user.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(mocks.downloadAccountExport).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.id }),
      USER.email,
    ));
    expect(mocks.unsubscribePushNotificationsLocally).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.disablePushNotifications).toHaveBeenCalled());
    expect(mocks.clearApiCache).toHaveBeenCalledWith(window.localStorage, USER.id);
    expect(mocks.auth.signOut).toHaveBeenCalled();
  });
});
