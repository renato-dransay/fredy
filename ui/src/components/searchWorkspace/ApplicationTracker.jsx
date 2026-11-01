/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@douyinfe/semi-ui-19';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { errorMessage } from '../../services/xhr.js';
import { fetchApplicationLetter } from '../../services/applicationClient.js';
import {
  loadApplication,
  saveApplication,
  addApplicationEvent,
  sendApplication,
  resolveApplicationDelivery,
  loadMailSettings,
  visitCalendarUrl,
} from '../../services/searchWorkspaceClient.js';
import { APPLICATION_STATUSES, localFromUtc, utcFromLocal, sendNeedsReview } from '../../services/searchWorkspace.js';
import './SearchWorkspace.less';

const EMPTY = {
  status: 'draft',
  recipient: '',
  subject: '',
  body: '',
  visitAt: null,
  followUpAt: null,
  autoSendAt: null,
  sendState: 'none',
};

/** A private application, its reviewed outgoing message and dated correspondence history. */
export default function ApplicationTracker({ listingId }) {
  const t = useTranslation();
  const [application, setApplication] = useState(EMPTY);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [smtpReady, setSmtpReady] = useState(false);
  const [note, setNote] = useState('');
  const [eventKind, setEventKind] = useState('note');
  const [resolvedOutcome, setResolvedOutcome] = useState('sent');
  const [resolutionNote, setResolutionNote] = useState('');
  const sendKey = useRef(null);
  const currentListing = useRef(listingId);

  useEffect(() => {
    let active = true;
    currentListing.current = listingId;
    setApplication(EMPTY);
    setEvents([]);
    setLoading(true);
    setMessage('');
    setReviewed(false);
    sendKey.current = null;
    Promise.all([loadApplication(listingId), loadMailSettings()])
      .then(([value, mail]) => {
        if (active) {
          setApplication({ ...EMPTY, ...value.application });
          setEvents(value.events ?? []);
          setSmtpReady(mail.smtp?.configured === true);
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
  }, [listingId, t]);

  const update = (patch) => {
    setApplication((value) => ({ ...value, ...patch }));
    setReviewed(false);
    sendKey.current = null;
  };
  const applyResponse = (value) => {
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
    autoSendAt: application.autoSendAt || null,
  });
  const save = () =>
    run(async (id) => {
      const value = await saveApplication(id, payload());
      if (currentListing.current === id) {
        applyResponse(value);
        setReviewed(false);
        sendKey.current = null;
      }
    }, t('search.saved'));

  const draft = () =>
    run(async (id) => {
      const letter = await fetchApplicationLetter(id);
      if (currentListing.current === id)
        update({ body: letter.text, subject: application.subject || t('search.applicationSubject') });
    }, t('search.draftReady'));

  const send = () =>
    run(async (id) => {
      if (!reviewed || application.autoSendAt || sendNeedsReview(application.sendState)) return;
      // Persist precisely the reviewed message before asking the server to send. A retry keeps its
      // key, while edits to the message explicitly invalidate the review and the previous key.
      sendKey.current ??= crypto.randomUUID();
      const saved = await saveApplication(id, { ...payload(), autoSendAt: null });
      if (currentListing.current !== id) return;
      applyResponse(saved);
      try {
        const sent = await sendApplication(id, sendKey.current, saved.application.revision);
        if (currentListing.current === id) {
          applyResponse(sent);
          setReviewed(false);
        }
      } catch (error) {
        const refreshed = await loadApplication(id).catch(() => null);
        if (currentListing.current === id && refreshed) applyResponse(refreshed);
        throw error;
      }
    }, t('search.sendRecorded'));

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

  const unsafeSend = sendNeedsReview(application.sendState);
  const alreadySent = ['sent', 'accepted', 'submitted'].includes(application.sendState);
  return (
    <section className="listing-card searchWorkspace" aria-label={t('search.applicationTitle')}>
      <h2 className="listing-card__label">{t('search.applicationTitle')}</h2>
      <p>{t('search.applicationHelp')}</p>
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
          {application.status === 'submitted' && (
            <p className="searchWorkspace__muted">{t('search.manualStatusHelp')}</p>
          )}
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
            <summary>{t('search.outgoingMessage')}</summary>
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
            <label className="searchWorkspace__field">
              <span>{t('search.autoSendAt')}</span>
              <input
                type="datetime-local"
                value={localFromUtc(application.autoSendAt)}
                disabled={busy || unsafeSend || alreadySent}
                onChange={(event) => update({ autoSendAt: utcFromLocal(event.target.value) })}
              />
            </label>
            {application.autoSendAt && (
              <div className="searchWorkspace__notice searchWorkspace__notice--warning">
                <p>{t('search.scheduleWarning')}</p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    run(async (id) => {
                      const result = await saveApplication(id, { autoSendAt: null });
                      if (currentListing.current === id) applyResponse(result);
                    }, t('search.scheduleCancelled'))
                  }
                >
                  {t('search.cancelSchedule')}
                </Button>
              </div>
            )}
            {!smtpReady && (
              <p className="searchWorkspace__notice">
                {t('search.smtpMissing')} <Link to="/applications">{t('search.mailSetup')}</Link>
              </p>
            )}
            {unsafeSend && (
              <p role="alert" className="searchWorkspace__notice searchWorkspace__notice--warning">
                {t('search.deliveryUnknown')}
              </p>
            )}
            {application.sendState === 'uncertain' && (
              <div className="searchWorkspace__notice searchWorkspace__notice--warning">
                <h3>{t('search.reconcileTitle')}</h3>
                <p>{t('search.reconcileHelp')}</p>
                <label className="searchWorkspace__field">
                  <span>{t('search.deliveryState')}</span>
                  <select
                    value={resolvedOutcome}
                    disabled={busy}
                    onChange={(event) => setResolvedOutcome(event.target.value)}
                  >
                    <option value="sent">{t('search.reconcileSent')}</option>
                    <option value="not_sent">{t('search.reconcileNotSent')}</option>
                  </select>
                </label>
                <label className="searchWorkspace__field">
                  <span>{t('search.reconcileNote')}</span>
                  <textarea
                    maxLength={16000}
                    value={resolutionNote}
                    disabled={busy}
                    onChange={(event) => setResolutionNote(event.target.value)}
                  />
                </label>
                <div className="searchWorkspace__actions">
                  <Button
                    disabled={busy || !resolutionNote.trim()}
                    onClick={() =>
                      run(async (id) => {
                        const result = await resolveApplicationDelivery(id, resolvedOutcome, resolutionNote);
                        if (currentListing.current === id) {
                          applyResponse(result);
                          setResolutionNote('');
                          sendKey.current = null;
                          setReviewed(false);
                        }
                      }, t('search.saved'))
                    }
                  >
                    {t('search.reconcileSave')}
                  </Button>
                </div>
              </div>
            )}
            {alreadySent && <p className="searchWorkspace__notice">{t('search.alreadySent')}</p>}
            <label className="searchWorkspace__check">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              {t('search.reviewed')}
            </label>
            <div className="searchWorkspace__actions">
              <Button
                onClick={send}
                loading={busy}
                disabled={
                  busy ||
                  !reviewed ||
                  !smtpReady ||
                  !application.recipient ||
                  !application.body ||
                  !!application.autoSendAt ||
                  unsafeSend ||
                  alreadySent
                }
              >
                {t('search.sendNow')}
              </Button>
            </div>
          </details>
          <div className="searchWorkspace__actions">
            <Button
              theme="solid"
              loading={busy}
              disabled={busy || unsafeSend || (!!application.autoSendAt && (!reviewed || !smtpReady))}
              onClick={save}
            >
              {application.autoSendAt ? t('search.saveAndSchedule') : t('search.saveApplication')}
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
