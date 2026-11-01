/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Consistent topic illustrations for requirement chips, hidden from assistive technology because
 * the adjacent keyword provides their name. Unknown topics use the neutral checklist icon.
 * @param {{topic: string}} props Supported criterion topic.
 * @returns {React.ReactElement}
 */
export default function FitCriterionIcon({ topic }) {
  const drawings = {
    rooms: (
      <>
        <path d="M3 18V8m18 10V8M3 14h18v4M4 10h16V6H4z" />
        <path d="M7 10V8h4v2m2 0V8h4v2" />
      </>
    ),
    size: (
      <>
        <path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5M4 4l5 5m11-5-5 5M4 20l5-5m11 5-5-5" />
      </>
    ),
    budget: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M4 6V4h14v2m3 5h-6v4h6m-3-2h.01" />
      </>
    ),
    transit: (
      <>
        <rect x="6" y="3" width="12" height="16" rx="3" />
        <path d="M6 11h12M9 3v8m6-8v8M9 15h.01M15 15h.01M9 19l-2 3m8-3 2 3" />
      </>
    ),
    kitchen: (
      <>
        <path d="M5 3v6m3-6v6M3 3v6c0 3 5 3 5 0m-3 3v9m12 0V3c-4 2-4 9 0 9" />
      </>
    ),
    pets: (
      <>
        <ellipse cx="12" cy="16" rx="5" ry="4" />
        <ellipse cx="5" cy="10" rx="2" ry="3" />
        <ellipse cx="10" cy="6" rx="2" ry="3" />
        <ellipse cx="16" cy="6" rx="2" ry="3" />
        <ellipse cx="20" cy="11" rx="2" ry="3" />
      </>
    ),
    outdoor: (
      <>
        <path d="M12 21V9m0 5C4 14 3 9 4 4c6 0 8 4 8 10Zm0 3c0-7 3-10 8-10 1 6-2 10-8 10Z" />
      </>
    ),
    lift: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M9 16V8l-2 2m2-2 2 2m4-2v8l-2-2m2 2 2-2" />
      </>
    ),
    lease: (
      <>
        <rect x="4" y="5" width="16" height="16" rx="2" />
        <path d="M8 3v4m8-4v4M4 11h16m-12 4h3m2 0h3m-8 3h3" />
      </>
    ),
    furniture: (
      <>
        <path d="M6 12V7a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v5M6 10a3 3 0 0 0-3 3v5h18v-5a3 3 0 0 0-3-3M6 18v3m12-3v3M6 14h12" />
      </>
    ),
    requirement: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 4V2h6v2m-7 7 2 2 4-4m-6 8h8" />
      </>
    ),
  };
  return (
    <svg
      className="fitCard__icon"
      data-topic={topic}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {drawings[topic] ?? drawings.requirement}
    </svg>
  );
}
