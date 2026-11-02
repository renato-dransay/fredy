/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef, useState } from 'react';
import AutoApplyRuns from '../autoApply/AutoApplyRuns.jsx';
import { Link } from 'react-router';
import { Button } from '@douyinfe/semi-ui-19';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { errorMessage } from '../../services/xhr.js';
import { subscribeJobEvents } from '../../services/sse/jobEvents.js';
import { fetchApplicationLetter } from '../../services/applicationClient.js';
import {
  loadApplication,
  saveApplication,
  addApplicationEvent,
  visitCalendarUrl,
} from '../../services/searchWorkspaceClient.js';
import { APPLICATION_STATUSES, localFromUtc, utcFromLocal } from '../../services/searchWorkspace.js';
import './SearchWorkspace.less';

const EMPTY = {
  status: 'draft',
  recipient: '',
  subject: '',
  body: '',
  visitAt: null,
  followUpAt: null,
};

/** A private application with manual status, letter draft, appointment dates and correspondence history. */
export default function ApplicationTracker({ listingId }) {
  const t = useTranslation();
  const [application, setApplication] = useState(EMPTY);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [eventKind, setEventKind] = useState('note');
  const currentListing = useRef(listingId);
  const draftDirty = useRef(false);

  useEffect(() => {
    let active = true;
    currentListing.current = listingId;
    draftDirty.current = false;
    setApplication(EMPTY);
    setEvents([]);
    setLoading(true);
    setMessage('');
    const refresh = () =>
      loadApplication(listingId)
        .then((value) => {
          if (active) {
            if (!draftDirty.current) setApplication({ ...EMPTY, ...value.application });
            setEvents(value.events ?? []);
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
    void refresh();
    const unsubscribe = subscribeJobEvents('auto-apply', refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [listingId, t]);

  const update = (patch) => {
    draftDirty.current = true;
    setApplication((value) => ({ ...value, ...patch }));
  };
  const applyResponse = (value) => {
    draftDirty.current = false;
    setApplication({ ...EMPTY, ...value.application });
    setEvents(value.events ?? []);
  };
  const run = async (action, success) => {
    const id = listingId;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await action(id);
      if (currentListing.current === id) setMessage(success);
    } catch (error) {
      if (currentListing.current === id) {
        setFailed(true);
        setMessage(errorMessage(error, t('search.error')));
      }
    } finally {
      if (currentListing.current === id) setBusy(false);
    }
  };
  const payload = () => ({
    status: application.status,
    recipient: application.recipient,
    subject: application.subject,
    body: application.body,
    visitAt: application.visitAt || null,
    followUpAt: application.followUpAt || null,
  });
  const save = () =>
    run(async (id) => {
      const value = await saveApplication(id, payload());
      if (currentListing.current === id) {
        applyResponse(value);
      }
    }, t('search.saved'));

  const draft = () =>
    run(async (id) => {
      const letter = await fetchApplicationLetter(id);
      if (currentListing.current === id)
        update({ body: letter.text, subject: application.subject || t('search.applicationSubject') });
    }, t('search.draftReady'));

  const recordEvent = () =>
    run(async (id) => {
      // A note may be the first action taken about a listing, so create its private draft first.
      if (!application.id) await saveApplication(id, payload());
      const result = await addApplicationEvent(id, { kind: eventKind, text: note });
      if (currentListing.current === id) {
        applyResponse(result);
        setNote('');
      }
    }, t('search.saved'));

  return (
    <section className="listing-card searchWorkspace" aria-label={t('search.applicationTitle')}>
      <h2 className="listing-card__label">{t('search.applicationTitle')}</h2>
      <p>{t('search.applicationHelp')}</p>
      <AutoApplyRuns listingId={listingId} />
      {loading ? (
        <p role="status">{t('search.loading')}</p>
      ) : (
        <>
          <label className="searchWorkspace__field">
            <span>{t('search.status')}</span>
            <select
              value={application.status}
              disabled={busy}
              onChange={(event) => update({ status: event.target.value })}
            >
              {APPLICATION_STATUSES.map((status) => (
                <option value={status} key={status}>
                  {t(`search.status.${status}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="searchWorkspace__fields">
            <label className="searchWorkspace__field">
              <span>{t('search.visitAt')}</span>
              <input
                type="datetime-local"
                value={localFromUtc(application.visitAt)}
                disabled={busy}
                onChange={(event) => update({ visitAt: utcFromLocal(event.target.value) })}
              />
            </label>
            <label className="searchWorkspace__field">
              <span>{t('search.followUpAt')}</span>
              <input
                type="datetime-local"
                value={localFromUtc(application.followUpAt)}
                disabled={busy}
                onChange={(event) => update({ followUpAt: utcFromLocal(event.target.value) })}
              />
            </label>
          </div>
          <p className="searchWorkspace__muted">{t('search.localTimes')}</p>
          {application.id && application.visitAt && (
            <a href={visitCalendarUrl(listingId)} download>
              {t('search.downloadVisit')}
            </a>
          )}
          <details>
            <summary>{t('search.letterDraft')}</summary>
            <div className="searchWorkspace__actions">
              <Button disabled={busy} onClick={draft}>
                {t('search.draftLetter')}
              </Button>
              <Link to="/settings/application">{t('search.applicantProfile')}</Link>
            </div>
            <label className="searchWorkspace__field">
              <span>{t('search.recipient')}</span>
              <input
                type="email"
                maxLength={320}
                value={application.recipient ?? ''}
                disabled={busy}
                onChange={(event) => update({ recipient: event.target.value })}
              />
            </label>
            <label className="searchWorkspace__field">
              <span>{t('search.subject')}</span>
              <input
                maxLength={512}
                value={application.subject ?? ''}
                disabled={busy}
                onChange={(event) => update({ subject: event.target.value })}
              />
            </label>
            <label className="searchWorkspace__field">
              <span>{t('search.body')}</span>
              <textarea
                rows={9}
                maxLength={32768}
                value={application.body ?? ''}
                disabled={busy}
                onChange={(event) => update({ body: event.target.value })}
              />
            </label>
          </details>
          <div className="searchWorkspace__actions">
            <Button theme="solid" loading={busy} disabled={busy} onClick={save}>
              {t('search.saveApplication')}
            </Button>
          </div>
          <h3>{t('search.timeline')}</h3>
          <ul className="searchWorkspace__timeline">
            {events.map((event, index) => (
              <li key={event.id ?? index}>
                <strong>{t(`search.event.${event.kind}`)}</strong>{' '}
                <span className="searchWorkspace__muted">
                  {event.source} · {event.createdAt ? new Date(event.createdAt).toLocaleString() : ''}
                </span>
                <p>{event.text}</p>
              </li>
            ))}
          </ul>
          {events.length === 0 && <p>{t('search.noEvents')}</p>}
          <label className="searchWorkspace__field">
            <span>{t('search.eventKind')}</span>
            <select value={eventKind} disabled={busy} onChange={(event) => setEventKind(event.target.value)}>
              {['note', 'reply', 'visit', 'follow_up'].map((kind) => (
                <option key={kind} value={kind}>
                  {t(`search.event.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="searchWorkspace__field">
            <span>{t('search.note')}</span>
            <textarea
              value={note}
              maxLength={16000}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="searchWorkspace__actions">
            <Button disabled={busy || !note.trim()} onClick={recordEvent}>
              {t('search.addEvent')}
            </Button>
          </div>
        </>
      )}
      <p role={failed ? 'alert' : 'status'} className="searchWorkspace__status">
        {message}
      </p>
    </section>
  );
}
