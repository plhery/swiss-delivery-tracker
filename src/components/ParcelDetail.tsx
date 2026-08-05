import { useState, useRef, type FormEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { formatExpectedDelivery } from '../lib/format';
import { parcelDisplayStatus } from '../lib/parcelStatus';
import { currentEvent } from '../lib/stages';
import { isBackSwipe, type TouchPoint } from '../lib/swipe';
import { useModalDialog } from '../lib/modal';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';
import { Timeline } from './Timeline';

export function ParcelDetail({
  parcel,
  onBack,
  onRename,
  onRefresh,
  onRestore,
  onDelete,
}: {
  parcel: ParcelWithEvents;
  onBack: () => void;
  onRename: (parcel: ParcelWithEvents, label: string) => Promise<unknown>;
  onRefresh: (parcel: ParcelWithEvents) => Promise<unknown>;
  onRestore: (parcel: ParcelWithEvents) => Promise<unknown>;
  onDelete: (parcel: ParcelWithEvents) => Promise<unknown>;
}) {
  const carrier = carrierInfo(parcel.carrier);
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const trackingUrl = parcel.trackingUrl ?? carrier.trackingUrl?.(parcel.trackingNumber);
  const swipeStart = useRef<TouchPoint | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(parcel.label);
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const backButton = useRef<HTMLButtonElement>(null);
  const dialog = useModalDialog<HTMLDivElement>(true, onBack, backButton);

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
      setTitleError(error instanceof Error ? error.message : 'Could not rename the parcel');
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
      setCheckNotice('Tracking check queued. Updates will appear automatically.');
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Could not queue a tracking check');
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
      setCheckError(error instanceof Error ? error.message : 'Could not restore the parcel');
      setRestoring(false);
    }
  }

  async function archiveNow() {
    if (archiving) return;
    setArchiving(true);
    setCheckError(null);
    try {
      await onDelete(parcel);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Could not archive the parcel');
      setArchiving(false);
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
      aria-label={parcel.label || 'Parcel'}
      tabIndex={-1}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { swipeStart.current = null; }}
    >
      <header className="detail__header">
        <button ref={backButton} type="button" className="detail__back" onClick={onBack}>
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m13 4-6 6 6 6" /></svg>
          Back
        </button>
        <span>Parcel details</span>
      </header>

      <div className="detail__hero">
        <div className="detail__stamp" aria-hidden="true">
          <svg viewBox="0 0 40 40">
            <path d="m7 13 13-7 13 7-13 7-13-7Z" />
            <path d="M7 13v15l13 7 13-7V13M20 20v15" />
          </svg>
        </div>
        <p className="detail__eyebrow">{carrier.name}</p>
        {editingTitle ? (
          <form className="detail__title-form" onSubmit={handleTitleSubmit}>
            <input
              className="detail__title-input"
              type="text"
              aria-label="Parcel title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Parcel"
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
                Cancel
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={savingTitle}
              >
                {savingTitle ? 'Saving…' : 'Save title'}
              </button>
            </div>
          </form>
        ) : confirmingArchive ? (
          <>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setConfirmingArchive(false)}
              disabled={archiving}
            >
              Keep parcel
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => void archiveNow()}
              disabled={archiving}
            >
              {archiving ? 'Archiving…' : 'Confirm archive'}
            </button>
          </>
        ) : (
          <div className="detail__title-row">
            <h1 className="detail__title">{parcel.label || 'Parcel'}</h1>
            <button
              type="button"
              className="detail__title-edit"
              aria-label="Edit parcel title"
              onClick={beginTitleEdit}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="m13.8 3.2 3 3L7.2 15.8 3 17l1.2-4.2 9.6-9.6Z" />
              </svg>
            </button>
          </div>
        )}
        <p className="detail__status">
          <span className={`status-badge status-badge--${status.tone}${status.syncing ? ' status-badge--syncing' : ''}`}>
            {status.label}
          </span>
        </p>
        <ProgressTrack stage={current?.stage ?? null} />
        <div className="detail__tracking-ticket">
          <span className="detail__tracking-label">Tracking number</span>
          <strong>{formatTrackingNumber(parcel.trackingNumber)}</strong>
          <button
            type="button"
            className="detail__tracking-copy"
            onClick={() => void copyTrackingNumber()}
            aria-label="Copy tracking number"
          >
            {copyStatus === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <span className="detail__barcode" aria-hidden="true" />
        </div>
        {copyStatus === 'error' && (
          <p className="detail__copy-error" role="alert">
            Copying is unavailable. Press and hold the tracking number instead.
          </p>
        )}
        {parcel.expectedDelivery && (
          <p className="detail__meta">
            Expected: {formatExpectedDelivery(parcel.expectedDelivery)}
          </p>
        )}
        {parcel.lastSyncedAt && (
          <p className="detail__meta">
            Last checked: {new Date(parcel.lastSyncedAt).toLocaleString('de-CH')}
          </p>
        )}
        {parcel.syncError && (
          <p className="detail__sync-error" role="status">{parcel.syncError}</p>
        )}
        {trackingUrl && (
          <a
            className="detail__carrier-link"
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open on {carrier.name} ↗
          </a>
        )}
      </div>

      <section className="detail__timeline">
        <div className="detail__section-heading">
          <p>Tracking history</p>
          <h2 className="detail__section-title">Journey</h2>
        </div>
        <Timeline events={parcel.events} syncing={status.syncing} />
      </section>

      <footer className={`detail__footer${parcel.archivedAt ? ' detail__footer--single' : ''}`}>
        {checkError && <p className="detail__check-error" role="alert">{checkError}</p>}
        {checkNotice && <p className="detail__check-notice" role="status">{checkNotice}</p>}
        {parcel.archivedAt ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => void restoreNow()}
            disabled={restoring}
          >
            {restoring ? 'Restoring…' : 'Restore parcel'}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void checkNow()}
              disabled={checking}
            >
              {checking ? 'Queueing check…' : 'Check now'}
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => setConfirmingArchive(true)}
            >
              Archive parcel
            </button>
          </>
        )}
      </footer>
    </div>,
    document.body,
  );
}
