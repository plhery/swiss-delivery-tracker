import { carrierInfo, formatTrackingNumber } from '../lib/carriers';
import { relativeTime } from '../lib/format';
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

  return (
    <button
      type="button"
      className="parcel-card"
      onClick={() => onOpen(parcel)}
      aria-label={`${parcel.label || 'Parcel'} — ${meta?.label ?? 'no updates yet'}`}
    >
      <div className="parcel-card__emoji" aria-hidden="true">
        {meta?.emoji ?? '📦'}
      </div>
      <div className="parcel-card__body">
        <div className="parcel-card__top">
          <span className="parcel-card__label">{parcel.label || 'Parcel'}</span>
          <span className="parcel-card__time">
            {last ? relativeTime(last.occurredAt) : ''}
          </span>
        </div>
        <div className="parcel-card__status">
          <span
            className={`status-badge status-badge--${meta?.tone ?? 'ok'}`}
          >
            {meta?.label ?? 'Waiting for updates'}
          </span>
          <span className="parcel-card__carrier">
            {carrier.name} · {formatTrackingNumber(parcel.trackingNumber)}
          </span>
        </div>
        <ProgressTrack stage={last?.stage ?? null} />
      </div>
      <div className="parcel-card__chevron" aria-hidden="true">
        ›
      </div>
    </button>
  );
}
