/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { useEffect, useState } from 'react';
import { Button } from '@douyinfe/semi-ui-19';
import {
  applicantDocumentUrl,
  deleteApplicantDocument,
  updateApplicantDocument,
  uploadApplicantDocument,
} from '../../services/autoApplyClient.js';

/** Edit a saved document's private explanation independently of its immutable uploaded bytes. */
function ApplicantDocument({ document, busy, run }) {
  const [description, setDescription] = useState(document.description ?? '');
  useEffect(() => setDescription(document.description ?? ''), [document.description]);
  return (
    <li className="autoApply__card">
      <div className="autoApply__actions">
        <a href={applicantDocumentUrl(document.id)} download>
          {document.filename}
        </a>
        <span>{Math.ceil(document.size / 1024)} KB</span>
      </div>
      <label className="autoApply__field">
        <span>Explanation for {document.filename}</span>
        <textarea
          value={description}
          maxLength={2000}
          rows={3}
          disabled={busy}
          placeholder="What this document contains and when you want to share it."
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="autoApply__actions">
        <Button
          disabled={busy || description === (document.description ?? '')}
          onClick={() => run(() => updateApplicantDocument(document.id, description), 'Document explanation saved.')}
        >
          Save explanation
        </Button>
        <Button
          disabled={busy}
          type="danger"
          onClick={() => run(() => deleteApplicantDocument(document.id), 'Document removed.')}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

/** Private file library shared by all searches; sharing remains an explicit per-rule choice. */
export default function ApplicantDocuments({ documents, busy, run }) {
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState('');
  const [uploadVersion, setUploadVersion] = useState(0);
  const upload = () =>
    run(async () => {
      await uploadApplicantDocument(file, description);
      setFile(null);
      setDescription('');
      setUploadVersion((version) => version + 1);
    }, 'Applicant document uploaded.');
  return (
    <section className="autoApply__card" aria-label="Private applicant documents">
      <h3>Private applicant documents</h3>
      <p className="autoApply__muted">
        Save your application files and explain what each contains. PDF, JPEG or PNG, up to 10 MB each. Files and
        explanations are private to your account. Explanations are internal notes and are not included in your
        application message. Select the files to share in each search rule.
      </p>
      <label className="autoApply__field">
        <span>Choose applicant document</span>
        <input
          key={uploadVersion}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          disabled={busy}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <label className="autoApply__field">
        <span>Document explanation</span>
        <textarea
          value={description}
          maxLength={2000}
          rows={3}
          disabled={busy}
          placeholder="For example: Income statements for the last three months."
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="autoApply__actions">
        <Button disabled={busy || !file} onClick={upload}>
          Upload document
        </Button>
      </div>
      <ul className="autoApply__list">
        {documents.map((document) => (
          <ApplicantDocument key={document.id} document={document} busy={busy} run={run} />
        ))}
      </ul>
      {!documents.length && <p>No applicant documents saved yet.</p>}
    </section>
  );
}
