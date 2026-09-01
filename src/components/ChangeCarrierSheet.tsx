import { useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  type CarrierInputField,
  carrierInfo,
  carrierRequirements,
  formatTrackingNumber,
  SELECTABLE_CARRIERS,
  tracksAutomatically,
} from '../lib/carriers';
import { useI18n } from '../i18n';
import { useModalDialog } from '../lib/modal';
import type {
  CarrierId,
  ParcelCarrierInput,
  ParcelWithEvents,
} from '../types';

export function ChangeCarrierSheet({
  parcel,
  onChange,
  onClose,
}: {
  parcel: ParcelWithEvents;
  onChange: (input: ParcelCarrierInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [selectedCarrier, setSelectedCarrier] = useState<CarrierId>(parcel.carrier);
  const [trackingUrl, setTrackingUrl] = useState(parcel.trackingUrl ?? '');
  const [dpdPostcode, setDpdPostcode] = useState(parcel.dpdPostcode ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const carrierSelect = useRef<HTMLSelectElement>(null);
  const dialog = useModalDialog<HTMLDivElement>(true, onClose, carrierSelect);
  const carrier = carrierInfo(selectedCarrier);
  const requirements = carrierRequirements(selectedCarrier, parcel.trackingNumber);
  const valueFor = (field: CarrierInputField) => field === 'trackingUrl'
    ? trackingUrl
    : dpdPostcode;
  const requirementsSatisfied = requirements.every((requirement) => {
    const value = valueFor(requirement.field).trim();
    return value && (!requirement.pattern || new RegExp(requirement.pattern).test(value));
  });
  const nextTrackingUrl = requirements.some(({ field }) => field === 'trackingUrl')
    ? trackingUrl.trim()
    : undefined;
  const nextPostcode = requirements.some(({ field }) => field === 'dpdPostcode')
    ? dpdPostcode.trim()
    : undefined;
  const changed = selectedCarrier !== parcel.carrier
    || (nextTrackingUrl ?? '') !== (parcel.trackingUrl ?? '')
    || (nextPostcode ?? '') !== (parcel.dpdPostcode ?? '');

  function selectCarrier(value: CarrierId) {
    setSelectedCarrier(value);
    setTrackingUrl(value === parcel.carrier ? parcel.trackingUrl ?? '' : '');
    setDpdPostcode(value === parcel.carrier ? parcel.dpdPostcode ?? '' : '');
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!requirementsSatisfied || !changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange({
        carrier: selectedCarrier,
        trackingUrl: nextTrackingUrl,
        dpdPostcode: nextPostcode,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('detail.changeCarrierFailed'));
      setSaving(false);
    }
  }

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="sheet change-carrier-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-carrier-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet__grabber" aria-hidden="true" />
        <div className="sheet__heading">
          <div>
            <p className="sheet__eyebrow">{t('detail.label')}</p>
            <h2 className="sheet__title" id="change-carrier-title">
              {t('detail.changeCarrier')}
            </h2>
          </div>
          <button
            type="button"
            className="sheet__close"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="sheet__intro">
          {t('detail.changeCarrierDescription', {
            number: formatTrackingNumber(parcel.trackingNumber),
          })}
        </p>
        <form className="sheet__form" onSubmit={submit}>
          <label className="field">
            <span className="field__label">{t('add.carrier')}</span>
            <select
              ref={carrierSelect}
              className="field__input"
              value={selectedCarrier}
              onChange={(event) => selectCarrier(event.target.value as CarrierId)}
            >
              {SELECTABLE_CARRIERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}{tracksAutomatically(option.id) ? '' : ` (${t('add.linkOnly')})`}
                </option>
              ))}
            </select>
          </label>
          <div className="sheet__carrier-card">
            <span className="sheet__carrier-mark" aria-hidden="true" />
            <span className="sheet__carrier-copy">
              <small>{t('add.carrier')}</small>
              <strong>{carrier.name}</strong>
              <span>
                {tracksAutomatically(carrier.id)
                  ? t('add.autoSync', { carrier: carrier.name })
                  : t('add.linkSync', { carrier: carrier.name })}
              </span>
            </span>
          </div>
          {requirements.map((requirement) => (
            <label className="field" key={requirement.field}>
              <span className="field__label">
                {locale === 'en'
                  ? requirement.label
                  : t(`add.requirement.${requirement.field}`)}
              </span>
              <input
                className="field__input"
                type={requirement.type}
                inputMode={requirement.inputMode}
                autoComplete={requirement.autoComplete}
                value={valueFor(requirement.field)}
                placeholder={requirement.placeholder}
                pattern={requirement.pattern}
                maxLength={requirement.maxLength}
                onChange={(event) => {
                  const value = requirement.inputMode === 'numeric'
                    ? event.target.value.replace(/\D/g, '').slice(0, requirement.maxLength)
                    : event.target.value;
                  if (requirement.field === 'trackingUrl') setTrackingUrl(value);
                  else setDpdPostcode(value);
                }}
                autoCapitalize={requirement.type === 'url' ? 'none' : undefined}
                autoCorrect="off"
                spellCheck={false}
                required
              />
              {requirement.help && (
                <small className="field__help">
                  {t(requirement.field === 'dpdPostcode'
                    ? 'add.requirement.dpdPostcodeHelp'
                    : 'add.requirement.trackingUrlHelp')}
                </small>
              )}
            </label>
          ))}
          {error && <p className="sheet__error" role="alert">{error}</p>}
          <div className="sheet__actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClose}
              disabled={saving}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={!requirementsSatisfied || !changed || saving}
            >
              {saving ? t('detail.changingCarrier') : t('detail.saveCarrier')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
