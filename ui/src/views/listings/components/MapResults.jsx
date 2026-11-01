/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Link } from 'react-router';
import ListingPhoto from '../../../components/listings/ListingPhoto.jsx';
import FitSummary from '../../../components/searchWorkspace/FitSummary.jsx';
import { listingPictureSrc } from '../../../services/listings/listingPictures.js';
import { formatDecimal } from '../../../services/number/numberService.js';
import { formatEuroPrice } from '../../../services/price/priceService.js';
import { useLocale, useTranslation } from '../../../services/i18n/i18n.jsx';

/**
 * The adverts represented by filtered pins in the current canvas, including all in a stack.
 * Saved photos and fit receipts use the same components as the listings overview. Locating a
 * result opens its pin; the title is a real link to details, also available to keyboard users.
 * @param {{listings: Object[], selectedId: string|null, onLocate: (id: string) => void,
 * onHighlight: (id: string|null) => void, loading?: boolean, totalCount?: number, onShowAll?: () => void}} props
 * @returns {React.ReactElement}
 */
export default function MapResults({
  listings,
  selectedId,
  onLocate,
  onHighlight,
  loading = false,
  totalCount = listings.length,
  onShowAll,
}) {
  const t = useTranslation();
  const locale = useLocale();
  return (
    <section className="map-results" aria-label={t('map.results.title')} aria-busy={loading}>
      <header className="map-results__header">
        <h2 aria-live="polite">
          {loading ? t('map.results.loading') : t('map.results.count', { count: listings.length })}
        </h2>
        <p>{t('map.results.hint')}</p>
        {onShowAll && (
          <button className="map-results__showAll" disabled={loading || totalCount === 0} onClick={onShowAll}>
            {t('map.results.showAll', { count: totalCount })}
          </button>
        )}
      </header>
      <div className="map-results__scroll">
        {!loading && listings.length === 0 && <p className="map-results__empty">{t('map.results.empty')}</p>}
        {listings.map((listing) => (
          <article
            key={listing.id}
            className={`map-results__card${selectedId === listing.id ? ' map-results__card--selected' : ''}`}
            onMouseEnter={() => onHighlight(listing.id)}
            onMouseLeave={() => onHighlight(null)}
            onFocus={() => onHighlight(listing.id)}
            onBlur={() => onHighlight(null)}
          >
            <button
              className="map-results__photoButton"
              aria-label={t('map.results.locate', { title: listing.title })}
              onClick={() => onLocate(listing.id)}
            >
              <ListingPhoto src={listingPictureSrc(listing)} className="map-results__photo" />
            </button>
            <div className="map-results__body">
              <strong className="map-results__price">
                {listing.price ? formatEuroPrice(listing.price, locale) : t('map.results.priceOnRequest')}
              </strong>
              <Link className="map-results__title" to={`/listings/listing/${listing.id}`}>
                {listing.title}
              </Link>
              <span className="map-results__meta">{listing.address}</span>
              <span className="map-results__meta">
                {[
                  listing.rooms == null
                    ? null
                    : t('listing.detail.fieldRoomsValue', { count: formatDecimal(listing.rooms, locale) }),
                  listing.size == null ? null : `${formatDecimal(listing.size, locale)} m²`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <FitSummary compact summary={listing.fitSummary} />
              <button className="map-results__locate" onClick={() => onLocate(listing.id)}>
                {t('map.results.showPin')}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
