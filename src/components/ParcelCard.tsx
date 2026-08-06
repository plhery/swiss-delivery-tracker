import { useRef, useState, type PointerEvent } from 'react';
import {
  activeTrackingCarrierId,
  carrierInfo,
  formatTrackingNumber,
} from '../lib/carriers';
import {
  localizedExpectedDelivery,
  localizedRelativeTime,
  useI18n,
} from '../i18n';
import { parcelDisplayStatus, parcelDisplayStatusKey } from '../lib/parcelStatus';
import { currentEvent } from '../lib/stages';
import type { ParcelWithEvents } from '../types';
import { ProgressTrack } from './ProgressTrack';

export function ParcelCard({
  parcel,
  onOpen,
  onArchive,
  notice,
}: {
  parcel: ParcelWithEvents;
  onOpen: (parcel: ParcelWithEvents) => void;
  onArchive?: (parcel: ParcelWithEvents) => Promise<unknown>;
  notice?: string;
}) {
  const { t } = useI18n();
  const carrier = carrierInfo(activeTrackingCarrierId(parcel));
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const expectedDelivery = parcel.expectedDelivery
    ? localizedExpectedDelivery(parcel.expectedDelivery, t)
    : null;
  const statusLabel = t(parcelDisplayStatusKey(parcel));
  const parcelName = parcel.label || t('common.parcel');
  const dragStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const suppressClick = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [archiving, setArchiving] = useState(false);

  async function archive() {
    if (!onArchive || archiving) return;
    setArchiving(true);
    setDragOffset(-88);
    try {
      await onArchive(parcel);
    } catch {
      setArchiving(false);
      setDragOffset(0);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!onArchive || event.isPrimary === false) return;
    dragStart.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLButtonElement>) {
    const start = dragStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const horizontal = event.clientX - start.x;
    const vertical = event.clientY - start.y;
    if (horizontal >= 0 || Math.abs(horizontal) <= Math.abs(vertical)) return;
    event.preventDefault();
    suppressClick.current = true;
    setDragOffset(Math.max(-132, horizontal));
  }

  function finishSwipe(event: PointerEvent<HTMLButtonElement>) {
    const start = dragStart.current;
    dragStart.current = null;
    setDragging(false);
    if (!start || start.pointerId !== event.pointerId) return;
    const horizontal = event.clientX - start.x;
    const vertical = event.clientY - start.y;
    if (Math.abs(horizontal) > 8) suppressClick.current = true;
    if (horizontal <= -96 && Math.abs(horizontal) > Math.abs(vertical) * 1.25) {
      void archive();
    } else {
      setDragOffset(horizontal <= -36 && Math.abs(horizontal) > Math.abs(vertical) ? -88 : 0);
    }
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  }

  function cancelSwipe() {
    dragStart.current = null;
    setDragging(false);
    setDragOffset(0);
    window.setTimeout(() => { suppressClick.current = false; }, 0);
  }

  return (
    <div className={`parcel-card-swipe${onArchive ? ' parcel-card-swipe--enabled' : ''}`}>
      <button
        type="button"
        className={`parcel-card parcel-card--${status.tone}${onArchive ? ' parcel-card--swipeable' : ''}${dragging ? ' parcel-card--dragging' : ''}`}
        style={onArchive ? { transform: `translateX(${dragOffset}px)` } : undefined}
        onClick={() => {
          if (suppressClick.current) return;
          if (dragOffset !== 0) {
            setDragOffset(0);
            return;
          }
          onOpen(parcel);
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
        aria-label={expectedDelivery
          ? t('parcel.ariaExpected', { name: parcelName, status: statusLabel, date: expectedDelivery })
          : t('parcel.aria', { name: parcelName, status: statusLabel })}
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
            {current ? localizedRelativeTime(current.occurredAt, t) : ''}
          </span>
        </div>
        <span className="parcel-card__label">{parcelName}</span>
        <span className="parcel-card__tracking">
          {formatTrackingNumber(parcel.trackingNumber)}
        </span>
        <div className="parcel-card__status">
          <span
            className={`status-badge status-badge--${status.tone}${status.syncing ? ' status-badge--syncing' : ''}`}
          >
            {statusLabel}
          </span>
        </div>
        {expectedDelivery && (
          <p className="parcel-card__eta">
            {t('parcel.expected', { date: expectedDelivery })}
          </p>
        )}
        {parcel.syncStatus === 'error' && (
          <p className="parcel-card__sync-error">{t('parcel.syncAttention')}</p>
        )}
        {notice && parcel.syncStatus !== 'error' && (
          <p className="parcel-card__notice">{notice}</p>
        )}
        <ProgressTrack stage={current?.stage ?? null} />
      </div>
      <div className="parcel-card__chevron" aria-hidden="true">
        <svg viewBox="0 0 20 20"><path d="m7 4 6 6-6 6" /></svg>
      </div>
      </button>
      {onArchive && (
        <button
          type="button"
          className="parcel-card-swipe__archive"
          aria-label={t('parcel.archiveAria', { name: parcelName })}
          aria-busy={archiving}
          disabled={archiving}
          onFocus={() => setDragOffset(-88)}
          onClick={() => void archive()}
        >
          {archiving ? t('detail.archiving') : t('parcel.archive')}
        </button>
      )}
    </div>
  );
}
