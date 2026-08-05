import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  carrierInfo,
  formatTrackingNumber,
  isPlanzerSharedTrackingNumber,
  parseTrackingInput,
  SELECTABLE_CARRIERS,
} from '../lib/carriers';
import type { CarrierId, NewParcelInput } from '../types';
import { useModalDialog } from '../lib/modal';

export function AddParcelSheet({
  onAdd,
  onClose,
}: {
  onAdd: (input: NewParcelInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [trackingInputValue, setTrackingInputValue] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [selectedCarrier, setSelectedCarrier] = useState<CarrierId | 'auto'>('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackingInput = useRef<HTMLTextAreaElement>(null);
  const dialog = useModalDialog<HTMLDivElement>(true, onClose, trackingInput);

  const parsedTracking = parseTrackingInput(trackingInputValue);
  const trackingNumber = parsedTracking.trackingNumber;
  const carrier = trackingNumber
    ? carrierInfo(selectedCarrier === 'auto' ? parsedTracking.carrier : selectedCarrier)
    : null;
  const needsPlanzerUrl =
    carrier?.id === 'planzer' && isPlanzerSharedTrackingNumber(trackingNumber);
  const resolvedTrackingUrl = parsedTracking.trackingUrl ?? trackingUrl.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trackingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        trackingNumber: trackingNumber.trim(),
        label: label.trim(),
        carrier: selectedCarrier === 'auto' ? parsedTracking.carrier : selectedCarrier,
        trackingUrl: needsPlanzerUrl ? resolvedTrackingUrl : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the parcel');
      setSaving(false);
    }
  }

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-parcel-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grabber" aria-hidden="true" />
        <div className="sheet__heading">
          <div>
            <p className="sheet__eyebrow">New shipment</p>
            <h2 className="sheet__title" id="add-parcel-title">Add a parcel</h2>
          </div>
          <button
            type="button"
            className="sheet__close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="sheet__intro">
          Paste a tracking number, carrier link, or text from a shipping email.
        </p>
        <form onSubmit={handleSubmit} className="sheet__form">
          <label className="field">
            <span className="field__label">What's inside? <small>Optional</small></span>
            <input
              className="field__input"
              type="text"
              value={label}
              placeholder="Coffee beans, new shoes…"
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
          </label>
          <label className="field">
            <span className="field__label">Tracking number or link</span>
            <textarea
              className="field__input field__input--tracking"
              ref={trackingInput}
              value={trackingInputValue}
              placeholder="Paste a number, link, or shipping message"
              onChange={(e) => setTrackingInputValue(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </label>
          {parsedTracking.source !== 'number' && trackingNumber && (
            <p className="sheet__carrier-hint">
              Found <strong>{formatTrackingNumber(trackingNumber)}</strong> in the pasted{' '}
              {parsedTracking.source === 'link' ? 'link' : 'text'}.
            </p>
          )}
          {needsPlanzerUrl && !parsedTracking.trackingUrl && (
            <label className="field">
              <span className="field__label">Planzer tracking URL</span>
              <input
                className="field__input"
                type="url"
                value={trackingUrl}
                placeholder="https://trackandtrace.planzergroup.com/shared/…"
                onChange={(e) => setTrackingUrl(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
              <small className="field__help">
                Paste the complete shared link, including its accessKey.
              </small>
            </label>
          )}
          <label className="field">
            <span className="field__label">Carrier</span>
            <select
              className="field__input"
              value={selectedCarrier}
              onChange={(e) => setSelectedCarrier(e.target.value as CarrierId | 'auto')}
            >
              <option value="auto">Detect automatically</option>
              {SELECTABLE_CARRIERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}{option.automatic ? '' : ' (link only)'}
                </option>
              ))}
            </select>
          </label>
          {carrier && (
            <p className="sheet__carrier-hint">
              {carrier.id === 'unknown'
                ? "We couldn't recognise this format. Choose the carrier to enable syncing."
                : carrier.automatic
                  ? `${carrier.name} will sync automatically.`
                  : `${carrier.name} is saved with a link; automatic syncing needs a supported adapter.`}
            </p>
          )}
          {error && (
            <p className="sheet__error" role="alert">
              {error}
            </p>
          )}
          <div className="sheet__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={
                !trackingNumber || (needsPlanzerUrl && !resolvedTrackingUrl) || saving
              }
            >
              {saving ? 'Adding…' : 'Add parcel'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
