/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@douyinfe/semi-ui-19';
import Headline from '../../components/headline/Headline.jsx';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { errorMessage } from '../../services/xhr.js';
import {
  loadApplications,
  loadMailSettings,
  saveMailSettings,
  syncApplicationMail,
} from '../../services/searchWorkspaceClient.js';
import { isFollowUpDue, mailSettingsPayload } from '../../services/searchWorkspace.js';
import '../../components/searchWorkspace/SearchWorkspace.less';

const MAIL_DEFAULTS = {
  smtp: { host: '', port: 465, secure: true, user: '', from: '', password: '' },
  imap: { host: '', port: 993, user: '', mailbox: 'INBOX', password: '' },
};

/** Applications, due follow-ups and this user's encrypted mail integration setup. */
export default function ApplicationsPage() {
  const t = useTranslation();
  const [applications, setApplications] = useState([]);
  const [mail, setMail] = useState(MAIL_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [onlyDue, setOnlyDue] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const mailValue = (value) => ({
    ...value,
    smtp: { ...MAIL_DEFAULTS.smtp, ...value.smtp, password: '' },
    imap: { ...MAIL_DEFAULTS.imap, ...value.imap, password: '' },
  });
  useEffect(() => {
    let active = true;
    Promise.all([loadApplications(), loadMailSettings()])
      .then(([data, settings]) => {
        if (active) {
          setApplications(data.applications ?? []);
          setMail(mailValue(settings));
        }
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
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    let active = true;
    // Keep due actions and background-imported replies current while the tracker stays open.
    // Mail form values are deliberately not reloaded here, preserving an unfinished edit.
    const timer = setInterval(() => {
      setNow(Date.now());
      loadApplications()
        .then((data) => {
          if (active) setApplications(data.applications ?? []);
        })
        .catch(() => {});
    }, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const changeMail = (kind, field, value) =>
    setMail((current) => ({ ...current, [kind]: { ...current[kind], [field]: value } }));
  const saveMail = async () => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      setMail(mailValue(await saveMailSettings(mailSettingsPayload(mail))));
      setMessage(t('search.mailSaved'));
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage(error, t('search.error')));
    } finally {
      setBusy(false);
    }
  };
  const syncMail = async () => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const result = await syncApplicationMail();
      const [data, settings] = await Promise.all([loadApplications(), loadMailSettings()]);
      setApplications(data.applications ?? []);
      setMail(mailValue(settings));
      setMessage(t('search.syncResult', { matched: result.matched, scanned: result.scanned }));
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
                          {application.autoSendAt && (
                            <p className="searchWorkspace__muted">
                              {t('search.scheduledFor', { time: new Date(application.autoSendAt).toLocaleString() })}
                            </p>
                          )}
                          <p className="searchWorkspace__muted">{application.recipient}</p>
                        </td>
                        <td>
                          {t(`search.status.${application.status}`)}
                          {application.sendState && (
                            <p className="searchWorkspace__muted">
                              {t('search.deliveryState')}: {t(`search.sendState.${application.sendState}`)}
                            </p>
                          )}
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
      <section className="searchWorkspace__card">
        <h2>{t('search.mailSetup')}</h2>
        <p>{t('search.mailHelp')}</p>
        <p>
          {t('search.smtp')}: {mail.smtp?.configured ? t('search.configured') : t('search.notConfigured')} ·{' '}
          {t('search.imap')}: {mail.imap?.configured ? t('search.configured') : t('search.notConfigured')}
        </p>
        <details>
          <summary>{t('search.editMail')}</summary>
          {['smtp', 'imap'].map((kind) => (
            <fieldset key={kind} className="searchWorkspace__criterion">
              <legend>{t(`search.${kind}`)}</legend>
              <div className="searchWorkspace__fields">
                {['host', 'port', 'user', ...(kind === 'smtp' ? ['from'] : ['mailbox'])].map((field) => (
                  <label className="searchWorkspace__field" key={field}>
                    <span>{t(`search.mail.${field}`)}</span>
                    <input
                      type={field === 'port' ? 'number' : field === 'from' ? 'email' : 'text'}
                      autoComplete="off"
                      maxLength={512}
                      min={field === 'port' ? 1 : undefined}
                      max={field === 'port' ? 65535 : undefined}
                      value={mail[kind][field] ?? ''}
                      disabled={busy}
                      onChange={(event) => changeMail(kind, field, event.target.value)}
                    />
                  </label>
                ))}
                <label className="searchWorkspace__field">
                  <span>{t('search.mail.password')}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={mail[kind].password ?? ''}
                    disabled={busy}
                    placeholder={mail[kind].passwordSet ? t('search.passwordRetained') : ''}
                    onChange={(event) => changeMail(kind, 'password', event.target.value)}
                  />
                </label>
              </div>
              {kind === 'smtp' && (
                <label className="searchWorkspace__check">
                  <input
                    type="checkbox"
                    checked={mail.smtp.secure === true}
                    disabled={busy}
                    onChange={(event) => changeMail('smtp', 'secure', event.target.checked)}
                  />
                  {t('search.smtpTls')}
                </label>
              )}
              <label className="searchWorkspace__check">
                <input
                  type="checkbox"
                  checked={mail[kind].password === null}
                  disabled={busy}
                  onChange={(event) => changeMail(kind, 'password', event.target.checked ? null : '')}
                />
                {t('search.clearPassword')}
              </label>
            </fieldset>
          ))}
          <div className="searchWorkspace__actions">
            <Button loading={busy} disabled={busy} onClick={saveMail}>
              {t('search.saveMail')}
            </Button>
          </div>
        </details>
        <p>{t('search.inboxHelp')}</p>
        {mail.lastSyncAt && (
          <p>
            {t('search.lastSync')}: {new Date(mail.lastSyncAt).toLocaleString()}
          </p>
        )}
        {mail.lastSyncError && <p role="alert">{mail.lastSyncError}</p>}
        <div className="searchWorkspace__actions">
          <Button disabled={busy || !mail.imap?.configured} loading={busy} onClick={syncMail}>
            {t('search.syncNow')}
          </Button>
        </div>
      </section>
      <p role={failed ? 'alert' : 'status'} className="searchWorkspace__status">
        {message}
      </p>
    </div>
  );
}
