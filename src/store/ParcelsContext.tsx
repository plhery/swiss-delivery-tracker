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
import type { NewParcelInput, ParcelRepo, ParcelWithEvents } from '../types';

interface ParcelsState {
  parcels: ParcelWithEvents[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
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
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await repo.list();
      if (mounted.current) {
        setParcels(list);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    void reload();
    const unsubscribe = repo.subscribe?.(reload);
    return unsubscribe;
  }, [repo, reload]);

  const addParcel = useCallback(
    async (input: NewParcelInput) => {
      const parcel = await repo.add(input);
      await reload();
      return parcel;
    },
    [repo, reload],
  );

  const removeParcel = useCallback(
    async (id: string) => {
      await repo.remove(id);
      await reload();
    },
    [repo, reload],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await repo.refresh();
      if (mounted.current) {
        setParcels(list);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [repo]);

  const value = useMemo(
    () => ({
      parcels,
      loading,
      refreshing,
      error,
      mode: repo.mode,
      addParcel,
      removeParcel,
      refresh,
    }),
    [parcels, loading, refreshing, error, repo.mode, addParcel, removeParcel, refresh],
  );

  return <ParcelsContext.Provider value={value}>{children}</ParcelsContext.Provider>;
}

export function useParcels(): ParcelsState {
  const ctx = useContext(ParcelsContext);
  if (!ctx) throw new Error('useParcels must be used within ParcelsProvider');
  return ctx;
}
