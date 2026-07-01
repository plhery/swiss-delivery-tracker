import { useMemo, useState } from 'react';
import { AddParcelSheet } from './components/AddParcelSheet';
import { ParcelCard } from './components/ParcelCard';
import { ParcelDetail } from './components/ParcelDetail';
import { isDelivered } from './lib/stages';
import { useParcels } from './store/ParcelsContext';
import type { ParcelWithEvents } from './types';

export default function App() {
  const { parcels, loading, refreshing, error, mode, addParcel, removeParcel, refresh } =
    useParcels();
  const [adding, setAdding] = useState(false);
  const [openParcelId, setOpenParcelId] = useState<string | null>(null);

  const openParcel = useMemo(
    () => parcels.find((p) => p.id === openParcelId) ?? null,
    [parcels, openParcelId],
  );

  const activeCount = useMemo(
    () => parcels.filter((p) => !isDelivered(p.events)).length,
    [parcels],
  );

  async function handleDelete(parcel: ParcelWithEvents) {
    const name = parcel.label || 'this parcel';
    if (!window.confirm(`Remove ${name} from your deliveries?`)) return;
    await removeParcel(parcel.id);
    setOpenParcelId(null);
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-row">
          <h1 className="app__title">My Deliveries</h1>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh tracking"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <span className={refreshing ? 'spin' : undefined} aria-hidden="true">
              ⟳
            </span>
          </button>
        </div>
        <p className="app__subtitle">
          {loading
            ? 'Loading…'
            : activeCount === 0
              ? 'Nothing on the way right now'
              : `${activeCount} parcel${activeCount === 1 ? '' : 's'} on the way 🚚`}
        </p>
      </header>

      {mode === 'demo' && (
        <div className="demo-banner">
          🧪 Demo mode — data stays on this device. Connect Supabase to sync
          across devices (see README).
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <main className="app__list">
        {!loading && parcels.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__emoji" aria-hidden="true">
              🕊️
            </div>
            <h2>No parcels yet</h2>
            <p>Add a tracking number and follow every step of the journey.</p>
          </div>
        )}
        {parcels.map((parcel) => (
          <ParcelCard
            key={parcel.id}
            parcel={parcel}
            onOpen={(p) => setOpenParcelId(p.id)}
          />
        ))}
      </main>

      <button
        type="button"
        className="fab"
        aria-label="Add a parcel"
        onClick={() => setAdding(true)}
      >
        +
      </button>

      {adding && (
        <AddParcelSheet onAdd={addParcel} onClose={() => setAdding(false)} />
      )}

      {openParcel && (
        <ParcelDetail
          parcel={openParcel}
          onBack={() => setOpenParcelId(null)}
          onDelete={(p) => void handleDelete(p)}
        />
      )}
    </div>
  );
}
