import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface AuthConfig {
  url: string;
  publishableKey: string;
}

type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'unconfigured';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  accessToken: string | null;
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function configuredClient(config: AuthConfig | null): SupabaseClient | null {
  if (!config?.url || !config.publishableKey) return null;
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
      flowType: 'pkce',
    },
  });
}

function sessionState(client: SupabaseClient | null, session: Session | null) {
  if (!client) {
    return {
      status: 'unconfigured' as const,
      user: null,
      accessToken: null,
    };
  }
  return session
    ? {
        status: 'authenticated' as const,
        user: session.user,
        accessToken: session.access_token,
      }
    : {
        status: 'anonymous' as const,
        user: null,
        accessToken: null,
      };
}

export function AuthProvider({
  config,
  client: suppliedClient,
  children,
}: {
  config: AuthConfig | null;
  client?: SupabaseClient;
  children: ReactNode;
}) {
  const client = useMemo(
    () => suppliedClient ?? configuredClient(config),
    [config, suppliedClient],
  );
  const [state, setState] = useState<Pick<AuthState, 'status' | 'user' | 'accessToken'>>(
    () => client
      ? { status: 'loading', user: null, accessToken: null }
      : sessionState(null, null),
  );

  useEffect(() => {
    if (!client) return;

    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      setState(error ? sessionState(client, null) : sessionState(client, data.session));
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      if (active) setState(sessionState(client, session));
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [client]);

  const sendCode = useCallback(async (email: string) => {
    if (!client) throw new Error('Authentication is not configured');
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) throw error;
  }, [client]);

  const verifyCode = useCallback(async (email: string, code: string) => {
    if (!client) throw new Error('Authentication is not configured');
    const { data, error } = await client.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    if (error) throw error;
    if (!data.session) throw new Error('The sign-in code did not create a session');
    setState(sessionState(client, data.session));
  }, [client]);

  const signOut = useCallback(async () => {
    if (!client) return;
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    setState(sessionState(client, null));
  }, [client]);

  const value = useMemo(
    () => ({ ...state, sendCode, verifyCode, signOut }),
    [state, sendCode, verifyCode, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
