/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Read a bounded form snapshot. Password/OTP screens are detected before any model observation. */
export async function readPageState(page, accountIdentity = '') {
  return page.evaluate((identity) => {
    const visible = (element) =>
      Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
    const login =
      [
        ...document.querySelectorAll(
          'input[type="password"],input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[title*="challenge"]',
        ),
      ].some(visible) || /\/(?:login|signin|sign-in|anmelden|captcha)(?:[/?#]|$)/i.test(location.href);
    if (login) return { login: true, url: location.href, controls: [], text: '' };
    document
      .querySelectorAll('[data-fredy-control]')
      .forEach((element) => element.removeAttribute('data-fredy-control'));
    const elements = [
      ...document.querySelectorAll('input:not([type="hidden"]),textarea,select,button,a[href],[role="button"]'),
    ]
      .filter(visible)
      .slice(0, 120);
    const controls = elements.map((element, index) => {
      element.setAttribute('data-fredy-control', String(index));
      const label = [
        element.getAttribute('aria-label'),
        ...(element.labels ? [...element.labels].map((item) => item.textContent) : []),
        element.getAttribute('placeholder'),
        element.textContent,
        element.getAttribute('name'),
      ]
        .filter(Boolean)
        .join(' ')
        .trim()
        .slice(0, 300);
      return {
        id: String(index),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        label,
        name: element.getAttribute('name') || '',
        required: element.required === true,
        checked: element.checked === true,
        files: element.type === 'file' ? [...element.files].map((file) => file.name) : [],
        disabled: element.disabled === true,
        value: ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? String(element.value).slice(0, 32768) : '',
        href: element.tagName === 'A' ? element.href : null,
        options:
          element.tagName === 'SELECT'
            ? [...element.options].map((option) => ({ value: option.value, label: option.textContent })).slice(0, 50)
            : [],
        multiple: element.multiple === true,
        accept: element.accept || '',
      };
    });
    const identityElements = [
      ...document.querySelectorAll(
        '[data-testid="account-email"],[data-testid="user-menu-email"],#user-menu [data-testid="email"]',
      ),
    ].filter(visible);
    const accountVisible =
      Boolean(identity) &&
      identityElements.some((element) => element.textContent.trim().toLowerCase() === identity.trim().toLowerCase());
    const confirmations = [
      ...document.querySelectorAll('[role="status"],[role="alert"],[data-testid*="success"],[class*="success"]'),
    ]
      .filter(visible)
      .map((element) => element.textContent.trim())
      .filter((text) =>
        /(?:nachricht|anfrage|bewerbung).{0,60}(?:gesendet|versendet|übermittelt)|(?:message|enquiry|application).{0,60}(?:sent|submitted)/i.test(
          text,
        ),
      );
    return {
      login: false,
      url: location.href,
      controls,
      accountVisible,
      confirmations,
      text: document.body.innerText.slice(0, 12000),
    };
  }, accountIdentity);
}

const MESSAGE = /nachricht|anschreiben|bewerbungstext|message|mitteilung/i;
const SUBMIT =
  /^(?:nachricht|anfrage|bewerbung)?\s*(?:senden|absenden|abschicken|abschicken und bewerben|send|submit)|(?:nachricht|anfrage|bewerbung)\s+(?:senden|absenden|abschicken)/i;
const OPEN =
  /^(?:kontakt(?:ieren| aufnehmen)?|anbieter kontaktieren|nachricht schreiben|anfrage stellen|contact(?: agent)?|write message|bewerben)$/i;

/** Return only finite safe actions; no model-generated selectors, scripts, text or arbitrary click. */
export function availableActions(state, profile, letter) {
  return state.controls
    .filter((control) => !control.disabled)
    .flatMap((control) => {
      if (control.type === 'file') return [{ action: 'upload', controlId: control.id }];
      if (
        ['input', 'textarea', 'select'].includes(control.tag) &&
        !['submit', 'button', 'password', 'hidden', 'checkbox', 'radio', 'file'].includes(control.type)
      ) {
        if (MESSAGE.test(control.label))
          return [{ action: 'fill', controlId: control.id, fact: 'letter', value: letter }];
        return Object.entries(profile)
          .filter(([, value]) => value != null && typeof value !== 'object' && String(value).trim())
          .map(([fact, value]) => ({ action: 'fill', controlId: control.id, fact, value: String(value) }));
      }
      if (
        (control.tag === 'button' || control.type === 'submit' || control.type === 'button') &&
        SUBMIT.test(control.label)
      )
        return [{ action: 'submit', controlId: control.id }];
      if (OPEN.test(control.label.trim())) return [{ action: 'open', controlId: control.id }];
      return [];
    });
}

/** Mandatory fields and the message are checked from the browser again before authorizing Send. */
export function validatePreparedForm(state, letter) {
  if (state.login || !state.accountVisible) return 'login_required';
  if (!state.controls.some((control) => MESSAGE.test(control.label) && control.value === letter))
    return 'message_not_verified';
  if (
    state.controls.some(
      (control) =>
        control.required &&
        !control.disabled &&
        ['input', 'textarea', 'select'].includes(control.tag) &&
        (control.type === 'file'
          ? !control.files?.length
          : ['checkbox', 'radio'].includes(control.type)
            ? !control.checked
            : !control.value),
    )
  )
    return 'mandatory_answer_missing';
  return null;
}
