import { useEffect, useMemo, useState } from 'react';
import { AddParcelSheet } from './components/AddParcelSheet';
import { ParcelCard } from './components/ParcelCard';
import { ParcelDetail } from './components/ParcelDetail';
import { NotificationControl } from './components/NotificationControl';
import { REAUTH_PATH } from './lib/cloudflareAccess';
import { currentStage, isDelivered, isFinal } from './lib/stages';
import { useParcels } from './store/ParcelsContext';
import type { ParcelWithEvents } from './types';

const DETAIL_HISTORY_KEY = 'parcelPostDetail';

export default function App() {
  const {
    parcels,
    loading,
    refreshing,
    error,
    authenticationRequired,
    mode,
    addParcel,
    renameParcel,
    removeParcel,
    restoreParcel,
    refresh,
    refreshParcel,
  } = useParcels();
  const [adding, setAdding] = useState(false);
  const [undoParcel, setUndoParcel] = useState<ParcelWithEvents | null>(null);
  const [openParcelId, setOpenParcelId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('parcel'),
  );

  useEffect(() => {
    if (window.location.pathname !== REAUTH_PATH) return;
    window.history.replaceState(
      window.history.state,
      '',
      `/${window.location.search}${window.location.hash}`,
    );
  }, []);

  useEffect(() => {
    if (!undoParcel) return;
    const timeout = window.setTimeout(() => setUndoParcel(null), 7_000);
    return () => window.clearTimeout(timeout);
  }, [undoParcel]);

  useEffect(() => {
    const onPopState = () => {
      setOpenParcelId(new URLSearchParams(window.location.search).get('parcel'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function openParcelDetail(packageId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('parcel', packageId);
    const currentState = typeof window.history.state === 'object' && window.history.state
      ? window.history.state
      : {};
    window.history.pushState(
      { ...currentState, [DETAIL_HISTORY_KEY]: packageId },
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    setOpenParcelId(packageId);
  }

  function closeParcelDetail() {
    if (window.history.state?.[DETAIL_HISTORY_KEY] === openParcelId) {
      setOpenParcelId(null);
      window.history.back();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('parcel');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    setOpenParcelId(null);
  }

  const openParcel = useMemo(
    () => parcels.find((p) => p.id === openParcelId) ?? null,
    [parcels, openParcelId],
  );

  const activeParcels = useMemo(
    () => parcels.filter((parcel) => {
      if (parcel.archivedAt) return false;
      const stage = currentStage(parcel.events);
      return stage === null || !isFinal(stage);
    }),
    [parcels],
  );
  const activeCount = activeParcels.length;
  const deliveredParcels = useMemo(
    () => parcels.filter((p) => !p.archivedAt && isDelivered(p.events)),
    [parcels],
  );
  const returnedParcels = useMemo(
    () => parcels.filter(
      (parcel) => !parcel.archivedAt && currentStage(parcel.events) === 'returned',
    ),
    [parcels],
  );
  const archivedParcels = useMemo(
    () => parcels.filter((parcel) => Boolean(parcel.archivedAt)),
    [parcels],
  );

  async function handleArchive(parcel: ParcelWithEvents) {
    const name = parcel.label || 'this parcel';
    if (!window.confirm(`Archive ${name}? You can restore it later.`)) return;
    await removeParcel(parcel.id);
    closeParcelDetail();
    setUndoParcel(parcel);
  }

  async function handleRestore(parcel: ParcelWithEvents) {
    await restoreParcel(parcel.id);
    setUndoParcel((current) => current?.id === parcel.id ? null : current);
    if (openParcelId === parcel.id) closeParcelDetail();
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
                : 'Every shipment, from first lookup to arrival.'}
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
            <strong>
              {authenticationRequired ? 'Sign-in needed.' : 'Tracking is taking a break.'}
            </strong>
            <span>{error}</span>
            {authenticationRequired && (
              <a className="error-banner__action" href={REAUTH_PATH}>
                Sign in again
              </a>
            )}
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
                  onOpen={(p) => openParcelDetail(p.id)}
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
                  onOpen={(p) => openParcelDetail(p.id)}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && returnedParcels.length > 0 && (
          <section
            className="parcel-section parcel-section--past"
            aria-labelledby="returned-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="returned-parcels-title">Returned</h2>
              <span>{returnedParcels.length}</span>
            </div>
            <div className="parcel-grid">
              {returnedParcels.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => openParcelDetail(p.id)}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && archivedParcels.length > 0 && (
          <section
            className="parcel-section archived-section"
            aria-labelledby="archived-parcels-title"
          >
            <details>
              <summary>
                <span id="archived-parcels-title">Archived</span>
                <span className="archived-section__count">{archivedParcels.length}</span>
              </summary>
              <div className="parcel-grid">
                {archivedParcels.map((parcel) => (
                  <ParcelCard
                    key={parcel.id}
                    parcel={parcel}
                    onOpen={(p) => openParcelDetail(p.id)}
                  />
                ))}
              </div>
            </details>
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
          onBack={closeParcelDetail}
          onRename={(p, label) => renameParcel(p.id, label)}
          onRefresh={(p) => refreshParcel(p.id)}
          onRestore={(p) => handleRestore(p)}
          onDelete={(p) => void handleArchive(p)}
        />
      )}

      {undoParcel && (
        <div className="undo-toast" role="status">
          <span>{undoParcel.label || 'Parcel'} archived</span>
          <button type="button" onClick={() => void handleRestore(undoParcel)}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
