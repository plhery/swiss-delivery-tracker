import { useMemo, useState } from 'react';
import { AddParcelSheet } from './components/AddParcelSheet';
import { ParcelCard } from './components/ParcelCard';
import { ParcelDetail } from './components/ParcelDetail';
import { NotificationControl } from './components/NotificationControl';
import { isDelivered } from './lib/stages';
import { useParcels } from './store/ParcelsContext';
import type { ParcelWithEvents } from './types';

export default function App() {
  const { parcels, loading, refreshing, error, mode, addParcel, removeParcel, refresh } =
    useParcels();
  const [adding, setAdding] = useState(false);
  const [openParcelId, setOpenParcelId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('parcel'),
  );

  function showParcel(packageId: string | null) {
    const url = new URL(window.location.href);
    if (packageId) url.searchParams.set('parcel', packageId);
    else url.searchParams.delete('parcel');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setOpenParcelId(packageId);
  }

  const openParcel = useMemo(
    () => parcels.find((p) => p.id === openParcelId) ?? null,
    [parcels, openParcelId],
  );

  const activeCount = useMemo(
    () => parcels.filter((p) => !isDelivered(p.events)).length,
    [parcels],
  );
  const activeParcels = useMemo(
    () => parcels.filter((p) => !isDelivered(p.events)),
    [parcels],
  );
  const deliveredParcels = useMemo(
    () => parcels.filter((p) => isDelivered(p.events)),
    [parcels],
  );

  async function handleDelete(parcel: ParcelWithEvents) {
    const name = parcel.label || 'this parcel';
    if (!window.confirm(`Remove ${name} from your deliveries?`)) return;
    await removeParcel(parcel.id);
    showParcel(null);
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__masthead">
          <div className="app__brand">
            <span className="app__brand-mark" aria-hidden="true">
              <span />
            </span>
            <div>
              <p className="app__eyebrow">Delivery desk</p>
              <h1 className="app__title">Parcel post</h1>
            </div>
          </div>
          <div className="app__header-actions">
            {mode === 'api' && <NotificationControl />}
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh tracking"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <svg
                className={refreshing ? 'spin' : undefined}
                aria-hidden="true"
                viewBox="0 0 24 24"
              >
                <path d="M19 8a7.5 7.5 0 1 0 .2 7.6M19 4v4h-4" />
              </svg>
            </button>
          </div>
        </div>
        <div className="app__summary" aria-live="polite">
          <div className="app__summary-count">
            <strong>{loading ? '—' : activeCount}</strong>
            <span>
              {activeCount === 1 ? 'parcel' : 'parcels'}
              <br />
              on the way
            </span>
          </div>
          <p className="app__subtitle">
            {loading
              ? 'Opening your delivery box…'
              : activeCount === 0
                ? 'Nothing on the way right now'
                : 'Every shipment, from announcement to arrival.'}
          </p>
        </div>
      </header>

      <main className="app__content">
        {mode === 'demo' && (
          <div className="demo-banner">
            <span className="demo-banner__stamp">Demo mode</span>
            <span>These sample parcels stay on this device.</span>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            <strong>Tracking is taking a break.</strong>
            <span>{error}</span>
          </div>
        )}

        {loading && (
          <div className="parcel-grid" aria-label="Loading parcels">
            <div className="parcel-card parcel-card--skeleton" />
            <div className="parcel-card parcel-card--skeleton" />
          </div>
        )}

        {!loading && parcels.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__mailbox" aria-hidden="true"><span /></div>
            <p className="empty-state__eyebrow">Delivery box empty</p>
            <h2>No parcels yet</h2>
            <p>Add a tracking number and follow every step of the journey.</p>
          </div>
        )}

        {!loading && activeParcels.length > 0 && (
          <section
            className="parcel-section"
            aria-labelledby="active-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="active-parcels-title">On the way</h2>
              <span>{activeParcels.length}</span>
            </div>
            <div className="parcel-grid">
              {activeParcels.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => showParcel(p.id)}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && deliveredParcels.length > 0 && (
          <section
            className="parcel-section parcel-section--past"
            aria-labelledby="past-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="past-parcels-title">Past deliveries</h2>
              <span>{deliveredParcels.length}</span>
            </div>
            <div className="parcel-grid">
              {deliveredParcels.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => showParcel(p.id)}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      <button
        type="button"
        className="fab"
        aria-label="Add a parcel"
        onClick={() => setAdding(true)}
      >
        <span aria-hidden="true">+</span>
        Add parcel
      </button>

      {adding && (
        <AddParcelSheet onAdd={addParcel} onClose={() => setAdding(false)} />
      )}

      {openParcel && (
        <ParcelDetail
          parcel={openParcel}
          onBack={() => showParcel(null)}
          onDelete={(p) => void handleDelete(p)}
        />
      )}
    </div>
  );
}
