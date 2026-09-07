import { afterEach, describe, expect, it } from 'vitest';

import { runToCompletion } from '../harness/run.js';
import { tierEnabled } from '../harness/tiers.js';
import { assertBuildIsFresh, DIST_ENTRY, makeWorkspace, type Workspace } from '../harness/workspace.js';

let workspace: Workspace | undefined;
afterEach(() => workspace?.remove());

describe.runIf(tierEnabled('process'))('HTTP startup requires operator credentials', () => {
  it.each([undefined, '', ' \t\n'])('refuses missing or blank PASSWORD %j before listening', async password => {
    assertBuildIsFresh();
    workspace = makeWorkspace('no-password');
    workspace.writeConfigInPlace({});
    const result = await runToCompletion(DIST_ENTRY, [], {
      env: {
        EXTERNAL_URL: 'http://127.0.0.1',
        CONFIG_PATH: workspace.configPath,
        DATA_PATH: workspace.data,
        PORT: '0',
        ...(password !== undefined ? { PASSWORD: password } : {})
      },
      timeoutMs: 5000
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PASSWORD_HASH or a non-empty PASSWORD is required');
    expect(result.output).not.toContain('listening on');
  });
});
