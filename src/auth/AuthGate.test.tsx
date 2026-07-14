import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';

function fakeClient(session: Session | null) {
  let authChange: ((_event: string, session: Session | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { session: null },
    error: { message: 'Invalid login credentials' },
  });
  const signUp = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
  const updateUser = vi.fn().mockResolvedValue({ data: {}, error: null });
  const refreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({ data: 0, error: null });
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
      onAuthStateChange: vi.fn().mockImplementation((callback) => {
        authChange = callback;
        return { data: { subscription: { unsubscribe } } };
      }),
      signInWithPassword,
      signUp,
      updateUser,
      refreshSession,
      signOut,
    },
    rpc,
  };
  return {
    client: client as unknown as SupabaseClient,
    spies: {
      signInWithPassword,
      signUp,
      updateUser,
      refreshSession,
      signOut,
      rpc,
      unsubscribe,
      emitAuth(nextSession: Session | null) {
        authChange?.('SIGNED_IN', nextSession);
      },
    },
  };
}

function permanentSession(): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'user-1', email: 'me@example.com', is_anonymous: false } as User,
  } as Session;
}

describe('AuthGate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a durable login when there is no existing session', async () => {
    const { client, spies } = fakeClient(null);
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{() => <p>Deliveries</p>}</AuthGate>);

    await user.type(await screen.findByLabelText('Email'), 'me@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(spies.signInWithPassword).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'wrong-password',
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid login credentials');
    expect(screen.queryByText('Deliveries')).not.toBeInTheDocument();
  });

  it('renders deliveries for a permanent account', async () => {
    const { client } = fakeClient(permanentSession());
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    expect(await screen.findByText('Deliveries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  it('creates a permanent account from the sign-up screen', async () => {
    const { client, spies } = fakeClient(null);
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{() => <p>Deliveries</p>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'strong-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(spies.signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'strong-password',
    });
  });

  it('reports when sign-up still requires confirmation', async () => {
    const { client, spies } = fakeClient(null);
    spies.signUp.mockResolvedValueOnce({ data: { session: null }, error: null });
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{() => <p>Deliveries</p>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), 'strong-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/needs confirmation/i);
  });

  it('reacts to auth changes and unsubscribes on unmount', async () => {
    const { client, spies } = fakeClient(null);
    const view = render(
      <AuthGate supabase={client}>{() => <p>Deliveries</p>}</AuthGate>,
    );
    await screen.findByRole('button', { name: 'Sign in' });

    spies.emitAuth(permanentSession());
    expect(await screen.findByText('Deliveries')).toBeInTheDocument();

    view.unmount();
    expect(spies.unsubscribe).toHaveBeenCalledOnce();
  });

  it('lets an existing anonymous user protect the same account', async () => {
    const session = permanentSession();
    session.user = { id: 'anon-1', is_anonymous: true } as User;
    const { client, spies } = fakeClient(session);
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Protect this account' }));
    await user.type(screen.getByLabelText('Email'), 'protected@example.com');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Protect account' }));

    expect(spies.updateUser).toHaveBeenNthCalledWith(1, { email: 'protected@example.com' });
    expect(spies.updateUser).toHaveBeenNthCalledWith(2, { password: 'safe-password' });
    expect(spies.refreshSession).toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Account protected');
  });

  it('stops account protection when updating the email fails', async () => {
    const session = permanentSession();
    session.user = { id: 'anon-1', is_anonymous: true } as User;
    const { client, spies } = fakeClient(session);
    spies.updateUser.mockResolvedValueOnce({ data: {}, error: { message: 'Email already used' } });
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Protect this account' }));
    await user.type(screen.getByLabelText('Email'), 'used@example.com');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Protect account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email already used');
    expect(spies.updateUser).toHaveBeenCalledTimes(1);
    expect(spies.refreshSession).not.toHaveBeenCalled();
  });

  it('reports password protection failures without refreshing the session', async () => {
    const session = permanentSession();
    session.user = { id: 'anon-1', is_anonymous: true } as User;
    const { client, spies } = fakeClient(session);
    spies.updateUser
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: {}, error: { message: 'Weak password' } });
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Protect this account' }));
    await user.type(screen.getByLabelText('Email'), 'protected@example.com');
    await user.type(screen.getByLabelText('Password'), 'safe-password');
    await user.click(screen.getByRole('button', { name: 'Protect account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Weak password');
    expect(spies.refreshSession).not.toHaveBeenCalled();
  });

  it('recovers legacy parcels and signs out permanent accounts', async () => {
    const { client, spies } = fakeClient(permanentSession());
    spies.rpc.mockResolvedValueOnce({ data: 1, error: null });
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Account' }));
    await user.type(screen.getByLabelText(/recovery code/i), 'one-time-code');
    await user.click(screen.getByRole('button', { name: 'Recover' }));

    expect(spies.rpc).toHaveBeenCalledWith('claim_legacy_packages', {
      recovery_code: 'one-time-code',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('1 existing delivery recovered');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(spies.signOut).toHaveBeenCalledOnce();
  });

  it('shows recovery RPC errors', async () => {
    const { client, spies } = fakeClient(permanentSession());
    spies.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Code already used' } });
    const user = userEvent.setup();
    render(<AuthGate supabase={client}>{(control) => <>{control}<p>Deliveries</p></>}</AuthGate>);

    await user.click(await screen.findByRole('button', { name: 'Account' }));
    await user.type(screen.getByLabelText(/recovery code/i), 'bad-code');
    await user.click(screen.getByRole('button', { name: 'Recover' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Code already used');
  });
});
