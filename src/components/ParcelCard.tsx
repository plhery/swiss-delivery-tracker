import { useRef, useState, type PointerEvent } from 'react';
import {
  activeTrackingCarrierId,
  carrierInfo,
  formatTrackingNumber,
} from '../lib/carriers';
import {
  localizedExpectedDelivery,
  useI18n,
} from '../i18n';
import {
  localizedParcelCompletionDate,
  parcelDisplayStatus,
  parcelDisplayStatusKey,
} from '../lib/parcelStatus';
import { currentEvent, isFinal } from '../lib/stages';
import type { ParcelWithEvents } from '../types';

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
  const { languageTag, t } = useI18n();
  const carrier = carrierInfo(activeTrackingCarrierId(parcel));
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const final = current ? isFinal(current.stage) : false;
  const expectedDelivery = parcel.expectedDelivery && !final
    ? localizedExpectedDelivery(parcel.expectedDelivery, t)
    : null;
  const statusLabel = t(parcelDisplayStatusKey(parcel));
  const completionDate = localizedParcelCompletionDate(parcel, languageTag);
  const statusSummary = completionDate
    ? `${statusLabel} ${t('parcel.onDate', { date: completionDate })}`
    : statusLabel;
  const parcelName = parcel.label || t('common.parcel');
  const dragStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const actionsMenu = useRef<HTMLDetailsElement>(null);
  const suppressClick = useRef(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [archiving, setArchiving] = useState(false);

  async function archive() {
    if (!onArchive || archiving) return;
    if (actionsMenu.current) actionsMenu.current.open = false;
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
          ? t('parcel.ariaExpected', { name: parcelName, status: statusSummary, date: expectedDelivery })
          : t('parcel.aria', { name: parcelName, status: statusSummary })}
      >
      <div className="parcel-card__body">
        <div className="parcel-card__top">
          <span className="parcel-card__carrier">{carrier.name}</span>
        </div>
        <span className="parcel-card__label">{parcelName}</span>
        <span className="parcel-card__tracking">
          {formatTrackingNumber(parcel.trackingNumber)}
        </span>
        <div className="parcel-card__status">
          {final ? (
            <span className={`status-badge status-badge--${status.tone}`}>
              {statusLabel}
            </span>
          ) : (
            <span className={`parcel-card__state parcel-card__state--${status.tone}`}>
              {statusLabel}
            </span>
          )}
          {completionDate && (
            <span className="parcel-card__completion">
              {t('parcel.onDate', { date: completionDate })}
            </span>
          )}
          {expectedDelivery && (
            <span className="parcel-card__eta">
              {expectedDelivery}
            </span>
          )}
        </div>
        {parcel.syncStatus === 'error' && (
          <p className="parcel-card__sync-error">{t('parcel.syncAttention')}</p>
        )}
        {notice && parcel.syncStatus !== 'error' && (
          <p className="parcel-card__notice">{notice}</p>
        )}
      </div>
      </button>
      {onArchive && (
        <button
          type="button"
          className="parcel-card-swipe__archive"
          aria-label={t('parcel.archiveAria', { name: parcelName })}
          aria-busy={archiving}
          disabled={archiving}
          tabIndex={-1}
          onFocus={() => setDragOffset(-88)}
          onClick={() => void archive()}
        >
          {archiving ? t('detail.archiving') : t('parcel.archive')}
        </button>
      )}
      {onArchive && (
        <details className="parcel-card-menu" ref={actionsMenu}>
          <summary aria-label={`${t('detail.parcelActions')}: ${parcelName}`}>
            <span aria-hidden="true">•••</span>
          </summary>
          <div>
            <button type="button" disabled={archiving} onClick={() => void archive()}>
              {archiving ? t('detail.archiving') : t('parcel.archive')}
            </button>
          </div>
        </details>
      )}
    </div>
  );
}
