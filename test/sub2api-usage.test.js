import assert from 'node:assert/strict';
import test from 'node:test';

import createPanel, { normalizePayload, windowDisplay } from '../src/panels/sub2api-usage.js';


test('normalizes unified username response', () => {
  const result = normalizePayload({
    ok: true,
    username: 'example-user',
    usage_mode: 'shared_pool',
    overall_status: 'warning',
    source: { tier: 'plus' },
    windows: { '5h': { percent: 75 } },
    cache: { stale: false },
  });
  assert.equal(result.username, 'example-user');
  assert.equal(result.usageMode, 'shared_pool');
  assert.equal(result.windows['5h'].percent, 75);
});

test('formats shared and unlimited windows', () => {
  assert.deepEqual(
    windowDisplay({ status: 'warning', percent: 75, used_usd: 15, limit_usd: 20 }, 'shared_pool'),
    { value: '75.0%', detail: '$15.00 / $20.00', status: 'warning' },
  );
  assert.deepEqual(
    windowDisplay({ status: 'unlimited', used_usd: 8 }, 'shared_pool'),
    { value: '不限额', detail: '已用 $8.00', status: 'unlimited' },
  );
});

test('local API state never exposes the center token or accepts a query username', () => {
  const panel = createPanel({
    sub2apiUsage: {
      enabled: false,
      monitorBaseUrl: 'https://monitor.example.test',
      username: 'fixed-user',
      apiToken: 'center-secret-token',
    },
  });
  let body = '';
  const response = {
    writeHead() {},
    end(value) { body = value; },
  };
  panel.routes()['GET /api/sub2api-usage']({ url: '/api/sub2api-usage?username=other-user' }, response);
  assert.equal(JSON.parse(body).username, 'fixed-user');
  assert.equal(body.includes('other-user'), false);
  assert.equal(body.includes('center-secret-token'), false);
});
