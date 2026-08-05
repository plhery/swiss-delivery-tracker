import { useEffect, useMemo, useState } from 'react';
import { AddParcelSheet } from './components/AddParcelSheet';
import { AccountMenu } from './components/AccountMenu';
import { ParcelCard } from './components/ParcelCard';
import { ParcelDetail } from './components/ParcelDetail';
import { NotificationControl } from './components/NotificationControl';
import type { ApiAuth } from './lib/apiClient';
import { currentStage, isDelivered, isFinal } from './lib/stages';
import { useParcels } from './store/ParcelsContext';
import type { ParcelWithEvents } from './types';

const DETAIL_HISTORY_KEY = 'parcelPostDetail';

export default function App({
  accountEmail,
  onSignOut,
  onExportAccount,
  onDeleteAccount,
  apiAuth,
}: {
  accountEmail?: string;
  onSignOut?: () => Promise<void>;
  onExportAccount?: () => Promise<void>;
  onDeleteAccount?: (confirmation: string) => Promise<void>;
  apiAuth?: ApiAuth;
} = {}) {
  const {
    parcels,
    loading,
    refreshing,
    error,
    authenticationRequired,
    usingCachedData,
    mode,
    addParcel,
    renameParcel,
    removeParcel,
    restoreParcel,
    refresh,
    refreshParcel,
    retryLoad,
  } = useParcels();
  const [adding, setAdding] = useState(false);
  const [undoParcel, setUndoParcel] = useState<ParcelWithEvents | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [openParcelId, setOpenParcelId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('parcel'),
  );

  useEffect(() => {
    if (!undoParcel || undoing || undoError) return;
    const timeout = window.setTimeout(() => setUndoParcel(null), 7_000);
    return () => window.clearTimeout(timeout);
  }, [undoParcel, undoing, undoError]);

  useEffect(() => {
    if (!refreshNotice) return;
    const timeout = window.setTimeout(() => setRefreshNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [refreshNotice]);

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
  const lastDpdPostcode = useMemo(
    () => [...parcels]
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .find((parcel) => parcel.carrier === 'dpd' && parcel.dpdPostcode)
      ?.dpdPostcode,
    [parcels],
  );

  async function handleArchive(parcel: ParcelWithEvents) {
    await removeParcel(parcel.id);
    closeParcelDetail();
    setUndoError(null);
    setUndoing(false);
    setUndoParcel(parcel);
  }

  async function handleRestore(parcel: ParcelWithEvents) {
    await restoreParcel(parcel.id);
    setUndoParcel((current) => current?.id === parcel.id ? null : current);
    if (openParcelId === parcel.id) closeParcelDetail();
  }

  async function undoArchive() {
    if (!undoParcel || undoing) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await handleRestore(undoParcel);
    } catch (reason) {
      setUndoError(reason instanceof Error ? reason.message : 'Could not restore the parcel');
    } finally {
      setUndoing(false);
    }
  }

  async function refreshAll() {
    setRefreshNotice(null);
    try {
      await refresh();
      setRefreshNotice('Tracking checks queued. Updates will appear automatically.');
    } catch {
      // The shared error banner contains the actionable failure message.
    }
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
              <p className="app__eyebrow">All your parcels</p>
              <h1 className="app__title">Swiss Delivery Tracker</h1>
            </div>
          </div>
          <div className="app__header-actions">
            {mode === 'api' && <NotificationControl apiAuth={apiAuth} />}
            <button
              type="button"
              className="icon-button"
              aria-label={refreshing ? 'Queueing tracking checks' : 'Refresh tracking'}
              aria-busy={refreshing}
              onClick={() => void refreshAll()}
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
            {accountEmail && onSignOut && (
              <AccountMenu
                email={accountEmail}
                onExport={onExportAccount}
                onDelete={onDeleteAccount}
                onSignOut={onSignOut}
              />
            )}
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
              : error && parcels.length === 0
                ? 'Your delivery box could not be loaded'
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
            {usingCachedData && <span>Showing the last parcel data saved on this device.</span>}
            {authenticationRequired && (
              <a className="error-banner__action" href="/">
                Sign in again
              </a>
            )}
            {!authenticationRequired && (
              <button
                className="error-banner__action"
                type="button"
                onClick={() => void retryLoad()}
              >
                Try again
              </button>
            )}
          </div>
        )}

        {loading && (
          <div className="parcel-grid" aria-label="Loading parcels">
            <div className="parcel-card parcel-card--skeleton" />
            <div className="parcel-card parcel-card--skeleton" />
          </div>
        )}

        {!loading && !error && parcels.length === 0 && (
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
        <AddParcelSheet
          onAdd={addParcel}
          onClose={() => setAdding(false)}
          lastDpdPostcode={lastDpdPostcode}
        />
      )}

      {openParcel && (
        <ParcelDetail
          parcel={openParcel}
          onBack={closeParcelDetail}
          onRename={(p, label) => renameParcel(p.id, label)}
          onRefresh={(p) => refreshParcel(p.id)}
          onRestore={(p) => handleRestore(p)}
          onDelete={(p) => handleArchive(p)}
        />
      )}

      {undoParcel && (
        <div className="undo-toast" role="status">
          <span className="undo-toast__message">
            <span>{undoParcel.label || 'Parcel'} archived</span>
            {undoError && <small role="alert">{undoError}</small>}
          </span>
          <button type="button" disabled={undoing} onClick={() => void undoArchive()}>
            {undoing ? 'Restoring…' : undoError ? 'Retry' : 'Undo'}
          </button>
        </div>
      )}

      {refreshNotice && !undoParcel && (
        <div className="action-toast" role="status">{refreshNotice}</div>
      )}
    </div>
  );
}
