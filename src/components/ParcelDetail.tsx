import { useEffect, useState, useRef, type FormEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  activeTrackingCarrierId,
  carrierInfo,
  formatTrackingNumber,
  parcelTrackingLinks,
} from '../lib/carriers';
import {
  localizedExpectedDelivery,
  localizedRelativeTime,
  useI18n,
} from '../i18n';
import {
  localizedParcelCompletionDate,
  parcelDisplayStatus,
  parcelDisplayStatusKey,
} from '../lib/parcelStatus';
import { currentEvent, isFinal } from '../lib/stages';
import { isBackSwipe, type TouchPoint } from '../lib/swipe';
import { useModalDialog } from '../lib/modal';
import type { ParcelCarrierInput, ParcelWithEvents } from '../types';
import { ChangeCarrierSheet } from './ChangeCarrierSheet';
import { Timeline } from './Timeline';

export function ParcelDetail({
  parcel,
  onBack,
  onRename,
  onChangeCarrier,
  onSetNotificationsMuted,
  onRefresh,
  onRestore,
  onArchive,
  onDelete,
}: {
  parcel: ParcelWithEvents;
  onBack: () => void;
  onRename: (parcel: ParcelWithEvents, label: string) => Promise<unknown>;
  onChangeCarrier: (
    parcel: ParcelWithEvents,
    input: ParcelCarrierInput,
  ) => Promise<unknown>;
  onSetNotificationsMuted: (
    parcel: ParcelWithEvents,
    muted: boolean,
  ) => Promise<unknown>;
  onRefresh: (parcel: ParcelWithEvents) => Promise<unknown>;
  onRestore: (parcel: ParcelWithEvents) => Promise<unknown>;
  onArchive: (parcel: ParcelWithEvents) => Promise<unknown>;
  onDelete: (parcel: ParcelWithEvents) => Promise<unknown>;
}) {
  const { locale, languageTag, t } = useI18n();
  const carrier = carrierInfo(activeTrackingCarrierId(parcel));
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const final = current ? isFinal(current.stage) : false;
  const statusLabel = t(parcelDisplayStatusKey(parcel));
  const completionDate = localizedParcelCompletionDate(parcel, languageTag);
  const trackingLinks = parcelTrackingLinks(parcel, locale);
  const lastChecked = current
    ? localizedRelativeTime(current.occurredAt, t, languageTag)
    : null;
  const swipeStart = useRef<TouchPoint | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingCarrier, setEditingCarrier] = useState(false);
  const [title, setTitle] = useState(parcel.label);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [savingNotifications, setSavingNotifications] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const actionsMenu = useRef<HTMLDetailsElement>(null);
  const dialog = useModalDialog<HTMLDivElement>(true, () => {
    if (editingCarrier) {
      setEditingCarrier(false);
      return;
    }
    if (confirmingDelete) {
      if (!deleting) {
        setConfirmingDelete(false);
        setCheckError(null);
      }
      return;
    }
    onBack();
  }, backButton);

  function beginTitleEdit() {
    setTitle(parcel.label);
    setTitleError(null);
    setEditingTitle(true);
  }

  function cancelTitleEdit() {
    setEditingTitle(false);
    setTitleError(null);
  }

  async function handleTitleSubmit(event: FormEvent) {
    event.preventDefault();
    if (savingTitle) return;
    const nextTitle = title.trim();
    if (nextTitle === parcel.label) {
      cancelTitleEdit();
      return;
    }
    setSavingTitle(true);
    setTitleError(null);
    try {
      await onRename(parcel, nextTitle);
      setEditingTitle(false);
    } catch (error) {
      setTitleError(error instanceof Error ? error.message : t('detail.renameFailed'));
    } finally {
      setSavingTitle(false);
    }
  }

  async function checkNow() {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    setCheckNotice(null);
    try {
      await onRefresh(parcel);
      setCheckNotice(t('detail.checkQueued'));
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('detail.checkFailed'));
    } finally {
      setChecking(false);
    }
  }

  async function restoreNow() {
    if (restoring) return;
    setRestoring(true);
    setCheckError(null);
    try {
      await onRestore(parcel);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('detail.restoreFailed'));
      setRestoring(false);
    }
  }

  async function archiveNow() {
    if (archiving) return;
    setArchiving(true);
    setCheckError(null);
    try {
      await onArchive(parcel);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('detail.archiveFailed'));
      setArchiving(false);
    }
  }

  async function deleteNow() {
    if (deleting) return;
    setDeleting(true);
    setCheckError(null);
    try {
      await onDelete(parcel);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : t('detail.deleteFailed'));
      setDeleting(false);
    }
  }

  async function copyTrackingNumber() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(parcel.trackingNumber);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }

  async function toggleNotifications() {
    if (savingNotifications) return;
    setSavingNotifications(true);
    setNotificationError(null);
    try {
      await onSetNotificationsMuted(parcel, !parcel.notificationsMuted);
    } catch (error) {
      setNotificationError(
        error instanceof Error ? error.message : t('detail.notificationFailed'),
      );
    } finally {
      setSavingNotifications(false);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.isPrimary === false) {
      swipeStart.current = null;
      return;
    }
    const detailBounds = event.currentTarget.getBoundingClientRect();
    swipeStart.current = {
      x: event.clientX - detailBounds.left,
      y: event.clientY,
    };
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (confirmingDelete) return;
    const detailBounds = event.currentTarget.getBoundingClientRect();
    if (start && isBackSwipe(start, {
      x: event.clientX - detailBounds.left,
      y: event.clientY,
    })) {
      onBack();
    }
  }

  return createPortal(
    <div
      ref={dialog}
      className="detail"
      role="dialog"
      aria-modal="true"
      aria-label={parcel.label || t('common.parcel')}
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { swipeStart.current = null; }}
    >
      <header className="detail__header">
        <button ref={backButton} type="button" className="detail__back" onClick={onBack}>
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m13 4-6 6 6 6" /></svg>
          {t('detail.back')}
        </button>
        <span>{t('detail.label')}</span>
        <details className="detail__actions-menu" ref={actionsMenu}>
          <summary aria-label={t('detail.parcelActions')}>
            <span aria-hidden="true">•••</span>
          </summary>
          <div>
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                if (actionsMenu.current) actionsMenu.current.open = false;
                setEditingCarrier(true);
              }}
            >
              {t('detail.changeCarrier')}
            </button>
            <button
              type="button"
              disabled={savingNotifications || deleting}
              onClick={() => {
                if (actionsMenu.current) actionsMenu.current.open = false;
                void toggleNotifications();
              }}
            >
              {parcel.notificationsMuted ? t('detail.unmute') : t('detail.mute')}
            </button>
            {!parcel.archivedAt && (
              <button
                type="button"
                disabled={archiving || deleting}
                onClick={() => {
                  if (actionsMenu.current) actionsMenu.current.open = false;
                  void archiveNow();
                }}
              >
                {archiving ? t('detail.archiving') : t('detail.archive')}
              </button>
            )}
            {!parcel.archivedAt && (
              <button
                type="button"
                className="detail__actions-menu-danger"
                disabled={archiving || deleting}
                onClick={() => {
                  if (actionsMenu.current) actionsMenu.current.open = false;
                  setCheckError(null);
                  setConfirmingDelete(true);
                }}
              >
                {t('detail.delete')}
              </button>
            )}
          </div>
        </details>
      </header>

      <section className="detail__hero">
        <div className="detail__hero-meta">
          <button
            type="button"
            className="detail__carrier detail__carrier--editable"
            onClick={() => setEditingCarrier(true)}
            aria-label={t('detail.changeCarrierFrom', { carrier: carrier.name })}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9" />
            </svg>
            {carrier.name}
            <span aria-hidden="true">›</span>
          </button>
          <span className={`detail__state detail__state--${status.tone}`}>
            {statusLabel}
          </span>
        </div>
        {editingTitle ? (
          <form className="detail__title-form" onSubmit={handleTitleSubmit}>
            <input
              className="detail__title-input"
              type="text"
              aria-label={t('detail.titleAria')}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('common.parcel')}
              maxLength={80}
              autoFocus
            />
            {titleError && (
              <p className="detail__title-error" role="alert">{titleError}</p>
            )}
            <div className="detail__title-actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={cancelTitleEdit}
                disabled={savingTitle}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={savingTitle}
              >
                {savingTitle ? t('detail.saving') : t('detail.saveTitle')}
              </button>
            </div>
          </form>
        ) : (
          <div className="detail__title-row">
            <h1 className="detail__title">{parcel.label || t('common.parcel')}</h1>
            <button
              type="button"
              className="detail__title-edit"
              aria-label={t('detail.editTitle')}
              onClick={beginTitleEdit}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="m13.8 3.2 3 3L7.2 15.8 3 17l1.2-4.2 9.6-9.6Z" />
              </svg>
            </button>
          </div>
        )}
        {(completionDate || (parcel.expectedDelivery && !final)) && (
          <p className="detail__arrival">
            {completionDate
              ? t('parcel.onDate', { date: completionDate })
              : localizedExpectedDelivery(parcel.expectedDelivery!, t, languageTag)}
          </p>
        )}
        <div className="detail__shipment">
          <div className="detail__tracking-ticket">
            <span className="detail__tracking-label">{t('detail.trackingNumber')}</span>
            <strong>{formatTrackingNumber(parcel.trackingNumber)}</strong>
            <button
              type="button"
              className="detail__tracking-copy"
              onClick={() => void copyTrackingNumber()}
              aria-label={t('detail.copyTracking')}
            >
              {copyStatus === 'copied' ? t('detail.copied') : t('detail.copy')}
            </button>
          </div>
          {trackingLinks.length > 0 && (
            <div className="detail__carrier-links" aria-label={t('detail.trackingSources')}>
              {trackingLinks.map((link) => (
                <a
                  key={link.carrier.id}
                  className={`detail__carrier-link detail__carrier-link--${link.role}`}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>{t('detail.openCarrier', { carrier: link.carrier.name })}</span>
                  {link.role !== 'active' && (
                    <small>
                      {link.role === 'waiting'
                        ? t('detail.sourceWaiting')
                        : t('detail.sourceHistory')}
                    </small>
                  )}
                </a>
              ))}
            </div>
          )}
        </div>
        {copyStatus === 'error' && (
          <p className="detail__copy-error" role="alert">
            {t('detail.copyUnavailable')}
          </p>
        )}
        {parcel.syncError && (
          <p className="detail__sync-error" role="status">{parcel.syncError}</p>
        )}
        <div className="detail__freshness">
          {lastChecked && <span>{t('detail.lastChecked', { date: lastChecked })}</span>}
          {!parcel.archivedAt && (
            <button
              type="button"
              className="detail__refresh"
              onClick={() => void checkNow()}
              disabled={checking}
              aria-label={checking ? t('detail.queueing') : t('detail.checkNow')}
            >
              <svg className={checking ? 'spin' : undefined} aria-hidden="true" viewBox="0 0 24 24">
                <path d="M19 8a7.5 7.5 0 1 0 .2 7.6M19 4v4h-4" />
              </svg>
            </button>
          )}
        </div>
        {checkError && <p className="detail__check-error" role="alert">{checkError}</p>}
        {checkNotice && <p className="detail__check-notice" role="status">{checkNotice}</p>}
        {notificationError && (
          <p className="detail__check-error" role="alert">{notificationError}</p>
        )}
      </section>

      <section className="detail__timeline">
        <div className="detail__section-heading">
          <h2 className="detail__section-title">{t('detail.journey')}</h2>
        </div>
        <Timeline events={parcel.events} syncing={status.syncing} />
      </section>

      {parcel.archivedAt && (
        <footer className="detail__footer detail__footer--archived">
          <button
            type="button"
            className="detail__restore"
            onClick={() => void restoreNow()}
            disabled={restoring}
          >
            {restoring ? t('common.restoring') : t('detail.restore')}
          </button>
          <button
            type="button"
            className="detail__delete"
            onClick={() => {
              setCheckError(null);
              setConfirmingDelete(true);
            }}
            disabled={restoring || deleting}
          >
            {t('detail.delete')}
          </button>
        </footer>
      )}

      {editingCarrier && (
        <ChangeCarrierSheet
          parcel={parcel}
          onChange={(input) => onChangeCarrier(parcel, input)}
          onClose={() => setEditingCarrier(false)}
        />
      )}

      {confirmingDelete && (
        <DeleteParcelDialog
          parcelName={parcel.label || t('common.parcel').toLocaleLowerCase(languageTag)}
          deleting={deleting}
          error={checkError}
          onCancel={() => {
            setConfirmingDelete(false);
            setCheckError(null);
          }}
          onDelete={() => void deleteNow()}
        />
      )}
    </div>,
    document.body,
  );
}

function DeleteParcelDialog({
  parcelName,
  deleting,
  error,
  onCancel,
  onDelete,
}: {
  parcelName: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="delete-parcel-dialog"
      aria-labelledby="delete-parcel-title"
      aria-describedby="delete-parcel-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!deleting) onCancel();
      }}
    >
      <p className="sheet__eyebrow">{t('detail.parcelActions')}</p>
      <h2 id="delete-parcel-title">
        {t('detail.deleteQuestionAria', { name: parcelName })}
      </h2>
      <p id="delete-parcel-description">{t('detail.deleteDescription')}</p>
      {error && <p className="sheet__error" role="alert">{error}</p>}
      <div className="delete-parcel-dialog__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={onCancel}
          disabled={deleting}
          autoFocus
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? t('detail.deleting') : t('detail.delete')}
        </button>
      </div>
    </dialog>
  );
}
