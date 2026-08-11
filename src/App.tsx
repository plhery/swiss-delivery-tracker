import { useEffect, useMemo, useState } from 'react';
import { AddParcelSheet } from './components/AddParcelSheet';
import { AccountMenu } from './components/AccountMenu';
import { ParcelCard } from './components/ParcelCard';
import { ParcelDetail } from './components/ParcelDetail';
import { NotificationControl } from './components/NotificationControl';
import { ParcelViewControls } from './components/ParcelViewControls';
import {
  LanguageControl,
  localizedExpectedDelivery,
  type MessageKey,
  useI18n,
} from './i18n';
import type { ApiAuth } from './lib/apiClient';
import {
  isActiveParcel,
  prioritizeActiveParcels,
  type ParcelAttention,
} from './lib/parcelPriority';
import {
  parcelComparator,
  viewParcels,
  type ParcelSort,
  type ParcelStatusFilter,
} from './lib/parcelView';
import {
  clearSharedParcelInput,
  readSharedParcelInput,
  type SharedParcelInput,
} from './lib/shareTarget';
import { parcelDisplayStatusKey } from './lib/parcelStatus';
import { currentStage, isDelivered } from './lib/stages';
import { useParcels } from './store/ParcelsContext';
import type { CarrierId, ParcelWithEvents } from './types';

const DETAIL_HISTORY_KEY = 'parcelPostDetail';
const PARCEL_VIEW_CONTROLS_ID = 'parcel-view-controls';

const ATTENTION_LABELS: Record<ParcelAttention, MessageKey> = {
  sync_error: 'attention.sync_error',
  failed_attempt: 'attention.failed_attempt',
  ready_for_pickup: 'attention.ready_for_pickup',
  customs: 'attention.customs',
  stalled: 'attention.stalled',
  not_announced: 'attention.not_announced',
};

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
  const { t } = useI18n();
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
    setParcelNotificationsMuted,
    removeParcel,
    restoreParcel,
    deleteParcel,
    refresh,
    refreshParcel,
    retryLoad,
  } = useParcels();
  const [sharedParcelInput, setSharedParcelInput] = useState<SharedParcelInput | null>(null);
  const [adding, setAdding] = useState(false);
  const [undoParcel, setUndoParcel] = useState<ParcelWithEvents | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ParcelStatusFilter>('all');
  const [carrierFilter, setCarrierFilter] = useState<CarrierId | ''>('');
  const [sort, setSort] = useState<ParcelSort>('priority');
  const [viewControlsOpen, setViewControlsOpen] = useState(false);
  const [viewNow, setViewNow] = useState(() => Date.now());
  const [openParcelId, setOpenParcelId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('parcel'),
  );

  useEffect(() => {
    let active = true;
    if (new URLSearchParams(window.location.search).get('share-target') !== '1') return;
    void readSharedParcelInput().then((input) => {
      if (active && input) {
        setSharedParcelInput(input);
        setAdding(true);
      }
    }).finally(() => clearSharedParcelInput());
    return () => {
      active = false;
    };
  }, []);

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
    const interval = window.setInterval(() => setViewNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

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

  const visibleParcels = useMemo(
    () => viewParcels(parcels, {
      query,
      status: statusFilter,
      carrier: carrierFilter || undefined,
      sort,
      now: viewNow,
    }),
    [parcels, query, statusFilter, carrierFilter, sort, viewNow],
  );
  const availableCarriers = useMemo(
    () => [...new Set(parcels.map((parcel) => parcel.carrier))]
      .sort((first, second) => first.localeCompare(second)),
    [parcels],
  );
  const hasCustomView = query.trim().length > 0
    || statusFilter !== 'all'
    || carrierFilter !== ''
    || sort !== 'priority';

  const activeParcels = useMemo(
    () => visibleParcels.filter(isActiveParcel),
    [visibleParcels],
  );
  const prioritized = useMemo(
    () => prioritizeActiveParcels(activeParcels, viewNow, parcelComparator(sort)),
    [activeParcels, sort, viewNow],
  );
  const allPrioritized = useMemo(
    () => prioritizeActiveParcels(
      parcels.filter(isActiveParcel),
      viewNow,
      parcelComparator('priority'),
    ),
    [parcels, viewNow],
  );
  const nextParcel = allPrioritized.attention[0]?.parcel
    ?? allPrioritized.arrivingToday[0]
    ?? allPrioritized.onTheWay[0]
    ?? null;
  const activeCount = useMemo(
    () => parcels.filter(isActiveParcel).length,
    [parcels],
  );
  const deliveredParcels = useMemo(
    () => visibleParcels.filter((p) => !p.archivedAt && isDelivered(p.events)),
    [visibleParcels],
  );
  const returnedParcels = useMemo(
    () => visibleParcels.filter(
      (parcel) => !parcel.archivedAt && currentStage(parcel.events) === 'returned',
    ),
    [visibleParcels],
  );
  const archivedParcels = useMemo(
    () => visibleParcels.filter((parcel) => Boolean(parcel.archivedAt)),
    [visibleParcels],
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
    if (openParcelId === parcel.id) closeParcelDetail();
    setUndoError(null);
    setUndoing(false);
    setUndoParcel(parcel);
  }

  async function handleDelete(parcel: ParcelWithEvents) {
    await deleteParcel(parcel.id);
    if (openParcelId === parcel.id) closeParcelDetail();
    setUndoParcel((current) => current?.id === parcel.id ? null : current);
    setRefreshNotice(t('app.deletedToast', {
      name: parcel.label || t('common.parcel'),
    }));
  }

  function clearView() {
    setQuery('');
    setStatusFilter('all');
    setCarrierFilter('');
    setSort('priority');
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
      setUndoError(reason instanceof Error ? reason.message : t('detail.restoreFailed'));
    } finally {
      setUndoing(false);
    }
  }

  async function refreshAll() {
    setRefreshNotice(null);
    try {
      await refresh();
      setRefreshNotice(t('app.refreshQueued'));
    } catch {
      // The shared error banner contains the actionable failure message.
    }
  }

  const summaryMessage = loading
    ? t('app.opening')
    : error && parcels.length === 0
      ? t('app.loadFailed')
      : activeCount === 0
        ? t('app.noneOnWay')
        : null;

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__masthead">
          <div className="app__brand">
            <span className="app__brand-mark" aria-hidden="true">
              <span />
            </span>
            <div>
              <p className="app__eyebrow">{t('app.eyebrow')}</p>
              <h1 className="app__title">{t('app.title')}</h1>
            </div>
          </div>
          <div className="app__header-actions">
            {(!accountEmail || !onSignOut) && (
              <LanguageControl className="language-control--header" />
            )}
            {mode === 'api' && <NotificationControl apiAuth={apiAuth} />}
            <button
              type="button"
              className="icon-button"
              aria-label={refreshing ? t('app.refreshing') : t('app.refresh')}
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
              {activeCount === 1 ? t('app.parcel.one') : t('app.parcel.many')}
              <br />
              {t('app.onTheWay')}
            </span>
          </div>
          {nextParcel ? (
            <div className="app__next">
              <span>{t('app.nextUp')}</span>
              <strong>{nextParcel.label || t('common.parcel')}</strong>
              <small>
                {nextParcel.expectedDelivery
                  ? t('parcel.expected', {
                    date: localizedExpectedDelivery(nextParcel.expectedDelivery, t),
                  })
                  : t(parcelDisplayStatusKey(nextParcel))}
              </small>
            </div>
          ) : summaryMessage ? <p className="app__subtitle">{summaryMessage}</p> : null}
        </div>
      </header>

      <main className="app__content">
        {mode === 'demo' && (
          <div className="demo-banner">
            <span className="demo-banner__stamp">{t('app.demo')}</span>
            <span>{t('app.demoDescription')}</span>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            <strong>
              {authenticationRequired ? t('app.signInNeeded') : t('app.trackingBreak')}
            </strong>
            <span>{error}</span>
            {usingCachedData && <span>{t('app.cachedData')}</span>}
            {authenticationRequired && (
              <a className="error-banner__action" href="/">
                {t('app.signInAgain')}
              </a>
            )}
            {!authenticationRequired && (
              <button
                className="error-banner__action"
                type="button"
                onClick={() => void retryLoad()}
              >
                {t('app.tryAgain')}
              </button>
            )}
          </div>
        )}

        {!loading && parcels.length > 0 && (
          <div className="parcel-view-shell">
            <ParcelViewControls
              id={PARCEL_VIEW_CONTROLS_ID}
              query={query}
              status={statusFilter}
              carrier={carrierFilter}
              sort={sort}
              carriers={availableCarriers}
              count={visibleParcels.length}
              advancedOpen={viewControlsOpen}
              hasCustomView={hasCustomView}
              onQueryChange={setQuery}
              onStatusChange={setStatusFilter}
              onCarrierChange={setCarrierFilter}
              onSortChange={setSort}
              onToggleAdvanced={() => setViewControlsOpen((open) => !open)}
              onClearAll={clearView}
            />
          </div>
        )}

        {loading && (
          <div className="parcel-grid" aria-label={t('app.loadingParcels')}>
            <div className="parcel-card parcel-card--skeleton" />
            <div className="parcel-card parcel-card--skeleton" />
          </div>
        )}

        {!loading && !error && parcels.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__mailbox" aria-hidden="true"><span /></div>
            <p className="empty-state__eyebrow">{t('app.emptyEyebrow')}</p>
            <h2>{t('app.emptyTitle')}</h2>
            <p>{t('app.emptyDescription')}</p>
          </div>
        )}

        {!loading && parcels.length > 0 && visibleParcels.length === 0 && (
          <div className="empty-state empty-state--filtered">
            <p className="empty-state__eyebrow">{t('view.search')}</p>
            <h2>{t('view.noResultsTitle')}</h2>
            <p>{t('view.noResultsDescription')}</p>
            <button
              type="button"
              className="button button--secondary"
              onClick={clearView}
            >
              {t('view.clear')}
            </button>
          </div>
        )}

        <div className="parcel-sections">
        {!loading && prioritized.attention.length > 0 && (
          <section
            className="parcel-section parcel-section--attention"
            aria-labelledby="attention-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="attention-parcels-title">{t('app.needsAttention')}</h2>
              <span>{prioritized.attention.length}</span>
            </div>
            <div className="parcel-grid">
              {prioritized.attention.map(({ parcel, reason }) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  notice={t(ATTENTION_LABELS[reason])}
                  onOpen={(p) => openParcelDetail(p.id)}
                  onArchive={handleArchive}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && prioritized.arrivingToday.length > 0 && (
          <section
            className="parcel-section parcel-section--today"
            aria-labelledby="today-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="today-parcels-title">{t('app.arrivingToday')}</h2>
              <span>{prioritized.arrivingToday.length}</span>
            </div>
            <div className="parcel-grid">
              {prioritized.arrivingToday.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => openParcelDetail(p.id)}
                  onArchive={handleArchive}
                />
              ))}
            </div>
          </section>
        )}

        {!loading && prioritized.onTheWay.length > 0 && (
          <section
            className="parcel-section"
            aria-labelledby="active-parcels-title"
          >
            <div className="parcel-section__heading">
              <h2 id="active-parcels-title">{t('app.onTheWaySection')}</h2>
              <span>{prioritized.onTheWay.length}</span>
            </div>
            <div className="parcel-grid">
              {prioritized.onTheWay.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => openParcelDetail(p.id)}
                  onArchive={handleArchive}
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
              <h2 id="past-parcels-title">{t('app.pastDeliveries')}</h2>
              <span>{deliveredParcels.length}</span>
            </div>
            <div className="parcel-grid">
              {deliveredParcels.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => openParcelDetail(p.id)}
                  onArchive={handleArchive}
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
              <h2 id="returned-parcels-title">{t('app.returned')}</h2>
              <span>{returnedParcels.length}</span>
            </div>
            <div className="parcel-grid">
              {returnedParcels.map((parcel) => (
                <ParcelCard
                  key={parcel.id}
                  parcel={parcel}
                  onOpen={(p) => openParcelDetail(p.id)}
                  onArchive={handleArchive}
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
                <span id="archived-parcels-title">{t('app.archived')}</span>
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
        </div>
      </main>

      <button
        type="button"
        className="fab"
        aria-label={t('app.addParcelAria')}
        onClick={() => setAdding(true)}
      >
        <span aria-hidden="true">+</span>
        {t('app.addParcel')}
      </button>

      {adding && (
        <AddParcelSheet
          onAdd={addParcel}
          onClose={() => setAdding(false)}
          lastDpdPostcode={lastDpdPostcode}
          initialLabel={sharedParcelInput?.label}
          initialTrackingInput={sharedParcelInput?.trackingInput}
        />
      )}

      {openParcel && (
        <ParcelDetail
          parcel={openParcel}
          onBack={closeParcelDetail}
          onRename={(p, label) => renameParcel(p.id, label)}
          onSetNotificationsMuted={(p, muted) =>
            setParcelNotificationsMuted(p.id, muted)}
          onRefresh={(p) => refreshParcel(p.id)}
          onRestore={(p) => handleRestore(p)}
          onArchive={(p) => handleArchive(p)}
          onDelete={(p) => handleDelete(p)}
        />
      )}

      {undoParcel && (
        <div className="undo-toast" role="status">
          <span className="undo-toast__message">
            <span>{t('app.archivedToast', { name: undoParcel.label || t('common.parcel') })}</span>
            {undoError && <small role="alert">{undoError}</small>}
          </span>
          <button type="button" disabled={undoing} onClick={() => void undoArchive()}>
            {undoing ? t('common.restoring') : undoError ? t('common.retry') : t('app.undo')}
          </button>
        </div>
      )}

      {refreshNotice && !undoParcel && (
        <div className="action-toast" role="status">{refreshNotice}</div>
      )}
    </div>
  );
}
