/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/globalSetup.js'],
    testTimeout: 60000,
    // Fixture migrations also need this budget on the shared ARM64 deployment runner.
    hookTimeout: 60000,
    reporters: ['verbose'],
    pool: 'threads',
  },
});
