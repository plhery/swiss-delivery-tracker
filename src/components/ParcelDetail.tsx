import { useRef, type PointerEvent } from 'react';
import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { formatExpectedDelivery } from '../lib/format';
import { latestEvent, stageMeta } from '../lib/stages';
import { isLeftSwipe, type TouchPoint } from '../lib/swipe';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';
import { Timeline } from './Timeline';

export function ParcelDetail({
  parcel,
  onBack,
  onDelete,
}: {
  parcel: ParcelWithEvents;
  onBack: () => void;
  onDelete: (parcel: ParcelWithEvents) => void;
}) {
  const carrier = carrierInfo(parcel.carrier);
  const last = latestEvent(parcel.events);
  const meta = last ? stageMeta(last.stage) : null;
  const trackingUrl = carrier.trackingUrl?.(parcel.trackingNumber);
  const swipeStart = useRef<TouchPoint | null>(null);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.isPrimary === false) {
      swipeStart.current = null;
      return;
    }
    swipeStart.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start && isLeftSwipe(start, { x: event.clientX, y: event.clientY })) {
      onBack();
    }
  }

  return (
    <div
      className="detail"
      role="dialog"
      aria-label={parcel.label || 'Parcel'}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { swipeStart.current = null; }}
    >
      <header className="detail__header">
        <button type="button" className="detail__back" onClick={onBack}>
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
        <h1 className="detail__title">{parcel.label || 'Parcel'}</h1>
        <p className="detail__status">
          <span className={`status-badge status-badge--${meta?.tone ?? 'ok'}`}>
            {meta?.label ?? 'Not announced yet'}
          </span>
        </p>
        <ProgressTrack stage={last?.stage ?? null} />
        <div className="detail__tracking-ticket">
          <span className="detail__tracking-label">Tracking number</span>
          <strong>{formatTrackingNumber(parcel.trackingNumber)}</strong>
          <span className="detail__barcode" aria-hidden="true" />
        </div>
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
        <Timeline events={parcel.events} />
      </section>

      <footer className="detail__footer">
        <button
          type="button"
          className="button button--danger"
          onClick={() => onDelete(parcel)}
        >
          Remove parcel
        </button>
      </footer>
    </div>
  );
}
