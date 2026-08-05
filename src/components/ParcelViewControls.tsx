import { useI18n } from '../i18n';
import { carrierInfo } from '../lib/carriers';
import type { ParcelSort, ParcelStatusFilter } from '../lib/parcelView';
import type { CarrierId } from '../types';

export function ParcelViewControls({
  query,
  status,
  carrier,
  sort,
  carriers,
  count,
  onQueryChange,
  onStatusChange,
  onCarrierChange,
  onSortChange,
}: {
  query: string;
  status: ParcelStatusFilter;
  carrier: CarrierId | '';
  sort: ParcelSort;
  carriers: CarrierId[];
  count: number;
  onQueryChange: (query: string) => void;
  onStatusChange: (status: ParcelStatusFilter) => void;
  onCarrierChange: (carrier: CarrierId | '') => void;
  onSortChange: (sort: ParcelSort) => void;
}) {
  const { t } = useI18n();
  return (
    <search className="parcel-view" aria-label={t('view.search')}>
      <label className="parcel-view__search">
        <span>{t('view.search')}</span>
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder={t('view.searchPlaceholder')}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <div className="parcel-view__selects">
        <label>
          <span>{t('view.status')}</span>
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as ParcelStatusFilter)}
          >
            <option value="all">{t('view.filter.all')}</option>
            <option value="active">{t('view.filter.active')}</option>
            <option value="attention">{t('view.filter.attention')}</option>
            <option value="today">{t('view.filter.today')}</option>
            <option value="delivered">{t('view.filter.delivered')}</option>
            <option value="archived">{t('view.filter.archived')}</option>
          </select>
        </label>
        <label>
          <span>{t('view.carrier')}</span>
          <select
            value={carrier}
            onChange={(event) => onCarrierChange(event.target.value as CarrierId | '')}
          >
            <option value="">{t('view.allCarriers')}</option>
            {carriers.map((carrierId) => (
              <option key={carrierId} value={carrierId}>{carrierInfo(carrierId).name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('view.sort')}</span>
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value as ParcelSort)}
          >
            <option value="priority">{t('view.sort.priority')}</option>
            <option value="updated">{t('view.sort.updated')}</option>
            <option value="newest">{t('view.sort.newest')}</option>
            <option value="eta">{t('view.sort.eta')}</option>
            <option value="carrier">{t('view.sort.carrier')}</option>
          </select>
        </label>
      </div>
      <p className="parcel-view__count" aria-live="polite">
        {t('view.shown', { count })}
      </p>
    </search>
  );
}
