import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CloudflareAccessError } from '../lib/cloudflareAccess';
import type { NewParcelInput, ParcelRepo, ParcelWithEvents } from '../types';

interface ParcelsState {
  parcels: ParcelWithEvents[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  authenticationRequired: boolean;
  mode: ParcelRepo['mode'];
  addParcel: (input: NewParcelInput) => Promise<ParcelWithEvents>;
  removeParcel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const ParcelsContext = createContext<ParcelsState | null>(null);

export function ParcelsProvider({
  repo,
  children,
}: {
  repo: ParcelRepo;
  children: ReactNode;
}) {
  const [parcels, setParcels] = useState<ParcelWithEvents[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rememberError = useCallback((reason: unknown) => {
    if (!mounted.current) return;
    setError(reason instanceof Error ? reason.message : String(reason));
    setAuthenticationRequired(reason instanceof CloudflareAccessError);
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await repo.list();
      if (mounted.current) {
        setParcels(list);
        setError(null);
        setAuthenticationRequired(false);
      }
    } catch (e) {
      rememberError(e);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [repo, rememberError]);

  useEffect(() => {
    void reload();
    const unsubscribe = repo.subscribe?.(reload);
    return unsubscribe;
  }, [repo, reload]);

  const addParcel = useCallback(
    async (input: NewParcelInput) => {
      try {
        const parcel = await repo.add(input);
        await reload();
        return parcel;
      } catch (error) {
        rememberError(error);
        throw error;
      }
    },
    [repo, reload, rememberError],
  );

  const removeParcel = useCallback(
    async (id: string) => {
      try {
        await repo.remove(id);
        await reload();
      } catch (error) {
        rememberError(error);
        throw error;
      }
    },
    [repo, reload, rememberError],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await repo.refresh();
      if (mounted.current) {
        setParcels(list);
        setError(null);
        setAuthenticationRequired(false);
      }
    } catch (e) {
      rememberError(e);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [repo, rememberError]);

  const value = useMemo(
    () => ({
      parcels,
      loading,
      refreshing,
      error,
      authenticationRequired,
      mode: repo.mode,
      addParcel,
      removeParcel,
      refresh,
    }),
    [
      parcels,
      loading,
      refreshing,
      error,
      authenticationRequired,
      repo.mode,
      addParcel,
      removeParcel,
      refresh,
    ],
  );

  return <ParcelsContext.Provider value={value}>{children}</ParcelsContext.Provider>;
}

export function useParcels(): ParcelsState {
  const ctx = useContext(ParcelsContext);
  if (!ctx) throw new Error('useParcels must be used within ParcelsProvider');
  return ctx;
}
