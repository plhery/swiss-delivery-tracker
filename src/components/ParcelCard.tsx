import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
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
  const { languageTag, t } = useI18n();
  const carrier = carrierInfo(activeTrackingCarrierId(parcel));
  const current = currentEvent(parcel.events);
  const status = parcelDisplayStatus(parcel);
  const final = current ? isFinal(current.stage) : false;
  const expectedDelivery = parcel.expectedDelivery && !final
    ? localizedExpectedDelivery(parcel.expectedDelivery, t, languageTag)
    : null;
  const statusLabel = t(parcelDisplayStatusKey(parcel));
  const completionDate = localizedParcelCompletionDate(parcel, languageTag);
  const statusSummary = completionDate
    ? `${statusLabel} ${t('parcel.onDate', { date: completionDate })}`
    : statusLabel;
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
        {!final && <ProgressTrack stage={current?.stage ?? null} />}
      </div>
      </button>
      {onArchive && (
        <button
          type="button"
          className="parcel-card-swipe__archive"
          aria-label={t('parcel.archiveAria', { name: parcelName })}
          aria-hidden="true"
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
        <ParcelActionsMenu
          label={t('parcel.actionsAria', { name: parcelName })}
          archiveLabel={archiving ? t('detail.archiving') : t('parcel.archive')}
          archiving={archiving}
          onArchive={() => void archive()}
        />
      )}
    </div>
  );
}

function ParcelActionsMenu({
  label,
  archiveLabel,
  archiving,
  onArchive,
}: {
  label: string;
  archiveLabel: string;
  archiving: boolean;
  onArchive: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const open = position !== null;

  const close = useCallback((restoreFocus = false) => {
    setPosition(null);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  function toggle() {
    if (open) {
      close();
      return;
    }
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const menuWidth = 188;
    const menuHeight = 58;
    const left = Math.min(
      Math.max(8, bounds.right - menuWidth),
      window.innerWidth - menuWidth - 8,
    );
    const below = bounds.bottom + 6;
    const top = below + menuHeight <= window.innerHeight - 8
      ? below
      : Math.max(8, bounds.top - menuHeight - 6);
    setPosition({ top, left });
  }

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();

    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    }

    function handleViewportChange() {
      close();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="parcel-card-menu"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={archiving}
        disabled={archiving}
        onClick={toggle}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {position && createPortal(
        <div
          ref={menu}
          className="parcel-card-menu__popover"
          role="menu"
          style={position}
        >
          <button
            type="button"
            role="menuitem"
            disabled={archiving}
            onClick={() => {
              close();
              onArchive();
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 5h16v4H4z" />
              <path d="M6 9v10h12V9" />
            </svg>
            <span>{archiveLabel}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
