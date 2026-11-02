/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */
import db from '../storage/SqliteConnection.js';
import { nanoid } from 'nanoid';
import { connectionFor, changed, fail, isDraining } from './storage.js';
import { PORTALS } from './portals.js';

// Screenshots, keystrokes and login challenges never persist in the database or logs.
const frames = new Map(),
  commands = new Map();
const TTL = 30000;
function prune() {
  for (const [id, value] of frames) if (Date.now() - value.at > TTL) frames.delete(id);
  for (const [id, value] of commands) if (Date.now() - value.at > TTL) commands.delete(id);
}
export function controlConnection(userId, id, action) {
  connectionFor(userId, id);
  if (isDraining() && ['open', 'resume'].includes(action)) fail('Deployment is draining browser workers.', 409);
  if (!['open', 'pause', 'resume', 'revoke'].includes(action)) fail('Unknown browser action.');
  db.withTransaction(() => {
    db.execute('UPDATE auto_apply_connections SET control_mode=?,revoked=? WHERE id=?', [
      action === 'resume' ? 'agent' : action === 'open' ? 'human' : 'paused',
      action === 'revoke' ? 1 : 0,
      id,
    ]);
    if (action !== 'resume')
      db.execute(
        "UPDATE auto_apply_runs SET state=CASE WHEN state='submitting' THEN 'uncertain' ELSE 'needs_input' END,reason='browser_paused',updated_at=? WHERE connection_id=? AND state IN ('running','submitting')",
        [Date.now(), id],
      );
  });
  if (action === 'revoke') {
    frames.delete(id);
    commands.delete(id);
  }
  changed(userId);
  return { ok: true };
}
export function readFrame(userId, id) {
  const connection = connectionFor(userId, id);
  prune();
  const frame = frames.get(id);
  return { imageBase64: frame?.imageBase64 ?? null, url: frame?.url ?? null, mode: connection.controlMode };
}
/** Inputs travel only to the selected authenticated connection while the agent is stopped. */
export function browserInput(userId, id, input) {
  const connection = connectionFor(userId, id);
  if (isDraining()) fail('Deployment is draining browser workers.', 409);
  if (connection.controlMode !== 'human') fail('Open the browser in human control first.', 409);
  const command = { id: nanoid(), type: input?.type };
  if (input?.type === 'click') {
    if (
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      input.x < 0 ||
      input.y < 0 ||
      input.x > 10000 ||
      input.y > 10000
    )
      fail('Invalid browser coordinates.');
    Object.assign(command, { x: input.x, y: input.y });
  } else if (input?.type === 'type') {
    if (typeof input.text !== 'string' || input.text.length > 32768) fail('Invalid browser text.');
    command.text = input.text;
  } else if (input?.type === 'key') {
    if (
      ![
        'Enter',
        'Tab',
        'Backspace',
        'Escape',
        'ArrowDown',
        'ArrowUp',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'PageDown',
        'PageUp',
      ].includes(input.key)
    )
      fail('Unsupported browser key.');
    command.key = input.key;
  } else if (input?.type === 'verify_login') {
    if (
      typeof input.accountIdentity !== 'string' ||
      !input.accountIdentity.trim() ||
      input.accountIdentity.length > 200
    )
      fail('Enter the visible portal account identity.');
    command.accountIdentity = input.accountIdentity.trim();
  } else if (input?.type === 'scroll') {
    if (![input.x, input.y, input.deltaY].every(Number.isFinite) || Math.abs(input.deltaY) > 2000)
      fail('Invalid scroll.');
    Object.assign(command, { x: input.x, y: input.y, deltaY: input.deltaY });
  } else if (input?.type === 'navigate') {
    // Direct entry is deliberately restricted to the portal home/login page.
    command.url = PORTALS[connection.portal].home;
  } else fail('Unsupported browser input.');
  prune();
  const pending = commands.get(id)?.items ?? [];
  if (pending.length >= 20) fail('Browser is not responding.', 409);
  commands.set(id, { at: Date.now(), items: [...pending, command] });
  return { ok: true };
}
/** A frame reply drains inputs once. Expired login keystrokes cannot replay on reconnect. */
export function receiveFrame(connection, { imageBase64, url } = {}) {
  const current = connectionFor(connection.userId, connection.id);
  prune();
  if (typeof imageBase64 !== 'string' || imageBase64.length > 2800000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64))
    fail('Invalid browser frame.');
  if (typeof url !== 'string' || url.length > 4096) fail('Invalid browser URL.');
  frames.set(connection.id, { imageBase64, url, at: Date.now() });
  db.execute('UPDATE auto_apply_connections SET last_seen=?,status=? WHERE id=?', [
    Date.now(),
    current.qualified ? 'login_verified' : 'connected',
    connection.id,
  ]);
  const pending = commands.get(connection.id)?.items ?? [];
  commands.delete(connection.id);
  return { commands: current.controlMode === 'human' ? pending : [], mode: current.controlMode };
}
