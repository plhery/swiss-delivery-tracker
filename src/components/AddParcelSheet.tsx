import { useState, type FormEvent } from 'react';
import { carrierInfo, detectCarrier } from '../lib/carriers';
import type { NewParcelInput } from '../types';

export function AddParcelSheet({
  onAdd,
  onClose,
}: {
  onAdd: (input: NewParcelInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const carrier = trackingNumber.trim()
    ? carrierInfo(detectCarrier(trackingNumber))
    : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trackingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({ trackingNumber: trackingNumber.trim(), label: label.trim() });
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
        <h2 className="sheet__title">Track a new parcel 📦</h2>
        <form onSubmit={handleSubmit} className="sheet__form">
          <label className="field">
            <span className="field__label">What's inside?</span>
            <input
              className="field__input"
              type="text"
              value={label}
              placeholder="e.g. New headphones"
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
              placeholder="99.34.123456.12345678"
              onChange={(e) => setTrackingNumber(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              required
            />
          </label>
          {carrier && (
            <p className="sheet__carrier-hint">
              {carrier.id === 'unknown'
                ? "We couldn't recognise this format — we'll still track it."
                : `Looks like a ${carrier.name} parcel 🎉`}
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
