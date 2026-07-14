import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';

function fakeClient(session: Session | null) {
  const unsubscribe = vi.fn();
  const signInWithPassword = vi.fn().mockResolvedValue({
    data: { session: null },
    error: { message: 'Invalid login credentials' },
  });
  const signUp = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
  const updateUser = vi.fn().mockResolvedValue({ data: {}, error: null });
  const refreshSession = vi.fn().mockResolvedValue({ data: {}, error: null });
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe } } }),
      signInWithPassword,
      signUp,
      updateUser,
      refreshSession,
      signOut: vi.fn(),
    },
    rpc: vi.fn(),
  };
  return {
    client: client as unknown as SupabaseClient,
    spies: { signInWithPassword, signUp, updateUser, refreshSession, unsubscribe },
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
});
