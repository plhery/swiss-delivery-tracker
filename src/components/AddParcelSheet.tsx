import { useState, type FormEvent } from 'react';
import { carrierInfo, detectCarrier, SELECTABLE_CARRIERS } from '../lib/carriers';
import type { CarrierId, NewParcelInput } from '../types';

export function AddParcelSheet({
  onAdd,
  onClose,
}: {
  onAdd: (input: NewParcelInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [selectedCarrier, setSelectedCarrier] = useState<CarrierId | 'auto'>('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedCarrier = trackingNumber.trim() ? detectCarrier(trackingNumber) : 'unknown';
  const carrier = trackingNumber.trim()
    ? carrierInfo(selectedCarrier === 'auto' ? detectedCarrier : selectedCarrier)
    : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trackingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        trackingNumber: trackingNumber.trim(),
        label: label.trim(),
        carrier: selectedCarrier === 'auto' ? detectedCarrier : selectedCarrier,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the parcel');
      setSaving(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Add a parcel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet__grabber" aria-hidden="true" />
        <div className="sheet__heading">
          <div>
            <p className="sheet__eyebrow">New shipment</p>
            <h2 className="sheet__title">Add a parcel</h2>
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
          Paste the tracking number from your receipt or shipping email.
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
            <span className="field__label">Tracking number</span>
            <input
              className="field__input"
              type="text"
              value={trackingNumber}
              placeholder="e.g. 99.34.123456.12345678"
              onChange={(e) => setTrackingNumber(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              required
            />
          </label>
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
              disabled={!trackingNumber.trim() || saving}
            >
              {saving ? 'Adding…' : 'Add parcel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
