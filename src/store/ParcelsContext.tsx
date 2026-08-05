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
  usingCachedData: boolean;
  mode: ParcelRepo['mode'];
  addParcel: (input: NewParcelInput) => Promise<ParcelWithEvents>;
  renameParcel: (id: string, label: string) => Promise<ParcelWithEvents>;
  removeParcel: (id: string) => Promise<void>;
  restoreParcel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  refreshParcel: (id: string) => Promise<void>;
  retryLoad: () => Promise<void>;
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
  const [usingCachedData, setUsingCachedData] = useState(false);
  const mounted = useRef(true);
  const parcelsRef = useRef<ParcelWithEvents[]>([]);

  useEffect(() => {
    parcelsRef.current = parcels;
  }, [parcels]);

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
        setUsingCachedData(false);
      }
    } catch (e) {
      const cached = repo.cachedList?.() ?? null;
      if (mounted.current) {
        if (parcelsRef.current.length === 0 && cached?.length) setParcels(cached);
        setUsingCachedData(parcelsRef.current.length > 0 || Boolean(cached?.length));
      }
      rememberError(e);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [repo, rememberError]);

  const retryLoad = useCallback(async () => {
    if (parcelsRef.current.length === 0) setLoading(true);
    await reload();
  }, [reload]);

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

  const renameParcel = useCallback(
    async (id: string, label: string) => {
      try {
        const renamed = await repo.rename(id, label);
        if (mounted.current) {
          setParcels((current) =>
            current.map((parcel) => parcel.id === renamed.id ? renamed : parcel),
          );
          setError(null);
          setAuthenticationRequired(false);
        }
        return renamed;
      } catch (error) {
        rememberError(error);
        throw error;
      }
    },
    [repo, rememberError],
  );

  const restoreParcel = useCallback(async (id: string) => {
    try {
      if (!repo.restore) throw new Error('Restoring archived parcels is unavailable');
      const restored = await repo.restore(id);
      if (mounted.current) {
        setParcels((current) =>
          current.map((parcel) => parcel.id === restored.id ? restored : parcel),
        );
        setError(null);
        setAuthenticationRequired(false);
      }
    } catch (error) {
      rememberError(error);
      throw error;
    }
  }, [repo, rememberError]);

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

  const refreshParcel = useCallback(async (id: string) => {
    try {
      const parcel = repo.refreshParcel
        ? await repo.refreshParcel(id)
        : (await repo.refresh()).find((candidate) => candidate.id === id);
      if (!parcel) throw new Error('Parcel not found after refreshing');
      if (mounted.current) {
        setParcels((current) =>
          current.map((candidate) => candidate.id === parcel.id ? parcel : candidate),
        );
        setError(null);
        setAuthenticationRequired(false);
      }
    } catch (error) {
      rememberError(error);
      throw error;
    }
  }, [repo, rememberError]);

  const value = useMemo(
    () => ({
      parcels,
      loading,
      refreshing,
      error,
      authenticationRequired,
      usingCachedData,
      mode: repo.mode,
      addParcel,
      renameParcel,
      removeParcel,
      restoreParcel,
      refresh,
      refreshParcel,
      retryLoad,
    }),
    [
      parcels,
      loading,
      refreshing,
      error,
      authenticationRequired,
      usingCachedData,
      repo.mode,
      addParcel,
      renameParcel,
      removeParcel,
      restoreParcel,
      refresh,
      refreshParcel,
      retryLoad,
    ],
  );

  return <ParcelsContext.Provider value={value}>{children}</ParcelsContext.Provider>;
}

export function useParcels(): ParcelsState {
  const ctx = useContext(ParcelsContext);
  if (!ctx) throw new Error('useParcels must be used within ParcelsProvider');
  return ctx;
}
