import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { formatExpectedDelivery, relativeTime } from '../lib/format';
import { latestEvent, stageMeta } from '../lib/stages';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';

export function ParcelCard({
  parcel,
  onOpen,
}: {
  parcel: ParcelWithEvents;
  onOpen: (parcel: ParcelWithEvents) => void;
}) {
  const carrier = carrierInfo(parcel.carrier);
  const last = latestEvent(parcel.events);
  const meta = last ? stageMeta(last.stage) : null;
  const expectedDelivery = parcel.expectedDelivery
    ? formatExpectedDelivery(parcel.expectedDelivery)
    : null;

  return (
    <button
      type="button"
      className={`parcel-card parcel-card--${meta?.tone ?? 'ok'}`}
      onClick={() => onOpen(parcel)}
      aria-label={`${parcel.label || 'Parcel'} — ${meta?.label ?? 'no updates yet'}${expectedDelivery ? ` — expected ${expectedDelivery}` : ''}`}
    >
      <div className="parcel-card__stamp" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path d="m6 10 10-5 10 5-10 5-10-5Z" />
          <path d="M6 10v12l10 5 10-5V10M16 15v12" />
        </svg>
      </div>
      <div className="parcel-card__body">
        <div className="parcel-card__top">
          <span className="parcel-card__carrier">{carrier.name}</span>
          <span className="parcel-card__time">
            {last ? relativeTime(last.occurredAt) : ''}
          </span>
        </div>
        <span className="parcel-card__label">{parcel.label || 'Parcel'}</span>
        <span className="parcel-card__tracking">
          {formatTrackingNumber(parcel.trackingNumber)}
        </span>
        <div className="parcel-card__status">
          <span
            className={`status-badge status-badge--${meta?.tone ?? 'ok'}`}
          >
            {meta?.label ?? 'Waiting for updates'}
          </span>
        </div>
        {expectedDelivery && (
          <p className="parcel-card__eta">
            Expected {expectedDelivery}
          </p>
        )}
        {parcel.syncStatus === 'error' && (
          <p className="parcel-card__sync-error">Sync needs attention</p>
        )}
        <ProgressTrack stage={last?.stage ?? null} />
      </div>
      <div className="parcel-card__chevron" aria-hidden="true">
        <svg viewBox="0 0 20 20"><path d="m7 4 6 6-6 6" /></svg>
      </div>
    </button>
  );
}
