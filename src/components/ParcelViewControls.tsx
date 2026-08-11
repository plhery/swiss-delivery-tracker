import { type MessageKey, useI18n } from '../i18n';
import { carrierInfo } from '../lib/carriers';
import type { ParcelSort, ParcelStatusFilter } from '../lib/parcelView';
import type { CarrierId } from '../types';

const STATUS_LABELS: Record<ParcelStatusFilter, MessageKey> = {
  all: 'view.filter.all',
  active: 'view.filter.active',
  attention: 'view.filter.attention',
  today: 'view.filter.today',
  delivered: 'view.filter.delivered',
  archived: 'view.filter.archived',
};

const SORT_LABELS: Record<ParcelSort, MessageKey> = {
  priority: 'view.sort.priority',
  updated: 'view.sort.updated',
  newest: 'view.sort.newest',
  eta: 'view.sort.eta',
  carrier: 'view.sort.carrier',
};

export function ParcelViewControls({
  id,
  query,
  status,
  carrier,
  sort,
  carriers,
  count,
  advancedOpen,
  hasCustomView,
  onQueryChange,
  onStatusChange,
  onCarrierChange,
  onSortChange,
  onToggleAdvanced,
  onClearAll,
}: {
  id: string;
  query: string;
  status: ParcelStatusFilter;
  carrier: CarrierId | '';
  sort: ParcelSort;
  carriers: CarrierId[];
  count: number;
  advancedOpen: boolean;
  hasCustomView: boolean;
  onQueryChange: (query: string) => void;
  onStatusChange: (status: ParcelStatusFilter) => void;
  onCarrierChange: (carrier: CarrierId | '') => void;
  onSortChange: (sort: ParcelSort) => void;
  onToggleAdvanced: () => void;
  onClearAll: () => void;
}) {
  const { t } = useI18n();
  const activeFilterCount = Number(query.trim().length > 0)
    + Number(status !== 'all')
    + Number(carrier !== '')
    + Number(sort !== 'priority');

  return (
    <div id={id} className="parcel-view" role="search" aria-label={t('view.search')}>
      <div className="parcel-view__top">
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
        <button
          type="button"
          className={`parcel-view__filter-button${activeFilterCount ? ' parcel-view__filter-button--active' : ''}`}
          aria-expanded={advancedOpen}
          aria-controls={`${id}-advanced`}
          onClick={onToggleAdvanced}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d="M3 5h14M6 10h8M8 15h4" />
          </svg>
          <span>{advancedOpen ? t('view.hideFilters') : t('view.filters')}</span>
          {activeFilterCount > 0 && <strong>{activeFilterCount}</strong>}
        </button>
      </div>

      {hasCustomView && (
        <div className="parcel-view__chips" aria-label={t('view.customized')}>
          {status !== 'all' && (
            <button type="button" onClick={() => onStatusChange('all')}>
              <span>{t(STATUS_LABELS[status])}</span><b aria-hidden="true">×</b>
            </button>
          )}
          {carrier && (
            <button type="button" onClick={() => onCarrierChange('')}>
              <span>{carrierInfo(carrier).name}</span><b aria-hidden="true">×</b>
            </button>
          )}
          {sort !== 'priority' && (
            <button type="button" onClick={() => onSortChange('priority')}>
              <span>{t(SORT_LABELS[sort])}</span><b aria-hidden="true">×</b>
            </button>
          )}
          <button type="button" className="parcel-view__clear" onClick={onClearAll}>
            {t('view.clearAll')}
          </button>
        </div>
      )}

      {advancedOpen && (
        <div className="parcel-view__advanced" id={`${id}-advanced`}>
          <div className="parcel-view__selects">
            <label>
              <span>{t('view.status')}</span>
              <select
                value={status}
                onChange={(event) => onStatusChange(event.target.value as ParcelStatusFilter)}
              >
                {(Object.keys(STATUS_LABELS) as ParcelStatusFilter[]).map((value) => (
                  <option key={value} value={value}>{t(STATUS_LABELS[value])}</option>
                ))}
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
                {(Object.keys(SORT_LABELS) as ParcelSort[]).map((value) => (
                  <option key={value} value={value}>{t(SORT_LABELS[value])}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}
      <p className="parcel-view__count" aria-live="polite">
        {t('view.shown', { count })}
      </p>
    </div>
  );
}
