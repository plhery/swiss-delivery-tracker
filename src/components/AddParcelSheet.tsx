import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  type CarrierInputField,
  carrierInfo,
  carrierRequirements,
  formatTrackingNumber,
  parseTrackingInput,
  SELECTABLE_CARRIERS,
  tracksAutomatically,
} from '../lib/carriers';
import type { CarrierId, NewParcelInput } from '../types';
import { useModalDialog } from '../lib/modal';

export function AddParcelSheet({
  onAdd,
  onClose,
  lastDpdPostcode,
}: {
  onAdd: (input: NewParcelInput) => Promise<unknown>;
  onClose: () => void;
  lastDpdPostcode?: string;
}) {
  const [label, setLabel] = useState('');
  const [trackingInputValue, setTrackingInputValue] = useState('');
  const [carrierInputs, setCarrierInputs] = useState<Record<CarrierInputField, string>>({
    trackingUrl: '',
    dpdPostcode: lastDpdPostcode ?? '',
  });
  const [selectedCarrier, setSelectedCarrier] = useState<CarrierId | 'auto'>('auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackingInput = useRef<HTMLTextAreaElement>(null);
  const dialog = useModalDialog<HTMLDivElement>(true, onClose, trackingInput);

  const parsedTracking = parseTrackingInput(trackingInputValue);
  const trackingNumber = parsedTracking.trackingNumber;
  const resolvedCarrier = selectedCarrier === 'auto' ? parsedTracking.carrier : selectedCarrier;
  const carrier = trackingNumber ? carrierInfo(resolvedCarrier) : null;
  const requirements = carrier ? carrierRequirements(carrier.id, trackingNumber) : [];
  const requiresCarrierConfirmation =
    selectedCarrier === 'auto' && parsedTracking.confidence === 'low';
  const parsedCarrierTrackingUrl =
    parsedTracking.carrier === resolvedCarrier ? parsedTracking.trackingUrl : undefined;
  const carrierInputValue = (field: CarrierInputField) =>
    field === 'trackingUrl' && parsedCarrierTrackingUrl
      ? parsedCarrierTrackingUrl
      : carrierInputs[field];
  const requirementsSatisfied = requirements.every((requirement) => {
    const value = carrierInputValue(requirement.field).trim();
    return value && (!requirement.pattern || new RegExp(requirement.pattern).test(value));
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!trackingNumber.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        trackingNumber: trackingNumber.trim(),
        label: label.trim(),
        carrier: resolvedCarrier,
        trackingUrl: requirements.some(({ field }) => field === 'trackingUrl')
          ? carrierInputValue('trackingUrl').trim()
          : undefined,
        dpdPostcode: requirements.some(({ field }) => field === 'dpdPostcode')
          ? carrierInputValue('dpdPostcode').trim()
          : undefined,
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
          {trackingInputValue.trim() && !trackingNumber && (
            <p className="sheet__error" role="status">
              We couldn&apos;t find a tracking number. Paste the code itself or a carrier link.
            </p>
          )}
          {parsedTracking.source !== 'number' && trackingNumber && (
            <p className="sheet__carrier-hint">
              Found <strong>{formatTrackingNumber(trackingNumber)}</strong> in the pasted{' '}
              {parsedTracking.source === 'link' ? 'link' : 'text'}.
            </p>
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
                  {option.name}{tracksAutomatically(option.id) ? '' : ' (link only)'}
                </option>
              ))}
            </select>
          </label>
          {requirements
            .filter(({ field }) => field !== 'trackingUrl' || !parsedCarrierTrackingUrl)
            .map((requirement) => (
              <label className="field" key={requirement.field}>
                <span className="field__label">{requirement.label}</span>
                <input
                  className="field__input"
                  type={requirement.type}
                  inputMode={requirement.inputMode}
                  autoComplete={requirement.autoComplete}
                  value={carrierInputValue(requirement.field)}
                  placeholder={requirement.placeholder}
                  pattern={requirement.pattern}
                  maxLength={requirement.maxLength}
                  onChange={(event) => {
                    const value = requirement.inputMode === 'numeric'
                      ? event.target.value.replace(/\D/g, '').slice(0, requirement.maxLength)
                      : event.target.value;
                    setCarrierInputs((current) => ({
                      ...current,
                      [requirement.field]: value,
                    }));
                  }}
                  autoCapitalize={requirement.type === 'url' ? 'none' : undefined}
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
                {requirement.help && (
                  <small className="field__help">{requirement.help}</small>
                )}
              </label>
            ))}
          {carrier && (
            <p className="sheet__carrier-hint">
              {requiresCarrierConfirmation
                ? `This number format could belong to ${parsedTracking.candidates
                  .map((candidate) => carrierInfo(candidate).name)
                  .join(' or ')}. Choose the carrier to confirm.`
                : carrier.id === 'unknown'
                  ? "We couldn't recognise this format. Choose the carrier to enable syncing."
                  : tracksAutomatically(carrier.id)
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
                !trackingNumber
                || requiresCarrierConfirmation
                || !requirementsSatisfied
                || saving
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
