/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import Headline from '../../components/headline/Headline.jsx';
import AutoApplyRuns from '../../components/autoApply/AutoApplyRuns.jsx';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { errorMessage } from '../../services/xhr.js';
import { subscribeJobEvents } from '../../services/sse/jobEvents.js';
import { loadApplications, saveApplication } from '../../services/searchWorkspaceClient.js';
import { APPLICATION_STATUSES, isFollowUpDue } from '../../services/searchWorkspace.js';
import '../../components/searchWorkspace/SearchWorkspace.less';

/** Manage private application statuses, upcoming viewings and due follow-ups without mail setup. */
export default function ApplicationsPage() {
  const t = useTranslation();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [onlyDue, setOnlyDue] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () =>
      loadApplications()
        .then((data) => {
          if (active) setApplications(data.applications ?? []);
        })
        .catch((error) => {
          if (active) {
            setFailed(true);
            setMessage(errorMessage(error, t('search.error')));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void refresh();
    const unsubscribe = subscribeJobEvents('auto-apply', refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [t]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  /** Save only the changed status, preserving this application's letter, notes and dates. */
  const changeStatus = async (listingId, status) => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const result = await saveApplication(listingId, { status });
      setApplications((current) =>
        current.map((application) => (application.listingId === listingId ? result.application : application)),
      );
      setMessage(t('search.saved'));
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error, t('search.error')));
    } finally {
      setBusy(false);
    }
  };

  const due = applications.filter((application) => isFollowUpDue(application, now));
  const shown = onlyDue ? due : applications;
  return (
    <div className="searchWorkspace">
      <Headline text={t('search.applicationsTitle')} subtitle={t('search.applicationsHelp')} />
      <AutoApplyRuns />
      <section className="searchWorkspace__card">
        <div className="searchWorkspace__actions">
          <label className="searchWorkspace__check">
            <input type="checkbox" checked={onlyDue} onChange={(event) => setOnlyDue(event.target.checked)} />
            {t('search.onlyDue', { count: due.length })}
          </label>
          <Link to="/listings">{t('search.chooseListing')}</Link>
        </div>
        {loading ? (
          <p role="status">{t('search.loading')}</p>
        ) : (
          <>
            {shown.length === 0 ? (
              <p>{onlyDue ? t('search.noDue') : t('search.noApplications')}</p>
            ) : (
              <div className="searchWorkspace__scroll">
                <table className="searchWorkspace__table">
                  <thead>
                    <tr>
                      <th>{t('search.apartment')}</th>
                      <th>{t('search.status')}</th>
                      <th>{t('search.visitAt')}</th>
                      <th>{t('search.followUpAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((application) => (
                      <tr key={application.id}>
                        <td>
                          <Link to={`/listings/listing/${encodeURIComponent(application.listingId)}`}>
                            {application.title || application.listingId}
                          </Link>
                        </td>
                        <td>
                          <select
                            aria-label={`${t('search.status')}: ${application.title || application.listingId}`}
                            value={application.status}
                            disabled={busy}
                            onChange={(event) => changeStatus(application.listingId, event.target.value)}
                          >
                            {APPLICATION_STATUSES.map((status) => (
                              <option value={status} key={status}>
                                {t(`search.status.${status}`)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>{application.visitAt ? new Date(application.visitAt).toLocaleString() : '—'}</td>
                        <td>
                          {application.followUpAt ? new Date(application.followUpAt).toLocaleString() : '—'}
                          {isFollowUpDue(application, now) && (
                            <p className="searchWorkspace__badge">{t('search.due')}</p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
      <p role={failed ? 'alert' : 'status'} className="searchWorkspace__status">
        {message}
      </p>
    </div>
  );
}
