import { fetchWithTimeout } from '../lib/fetch-utils.js';
import { sendJson } from '../lib/http-helpers.js';
import { esc, relative } from '../lib/html.js';

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function text(value, fallback = '-') {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value);
}

function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (['limited', 'critical', 'configuration_conflict', 'dedicated_binding_error'].includes(value)) return 'fail';
  if (['warning', 'unavailable'].includes(value)) return 'warn';
  return 'ok';
}

function statusLabel(status) {
  return {
    normal: '正常',
    warning: '接近限额',
    critical: '即将限额',
    limited: '已达限额',
    unlimited: '不限额',
    unavailable: '暂不可用',
  }[status] || text(status, '未知');
}

function modeLabel(mode) {
  return {
    shared_pool: '共享池',
    dedicated_upstream: '独立上游',
  }[mode] || text(mode, '配置异常');
}

export function normalizePayload(data) {
  return {
    ok: data?.ok === true,
    username: text(data?.username, ''),
    usageMode: text(data?.usage_mode, ''),
    overallStatus: text(data?.overall_status, ''),
    source: data?.source || {},
    windows: data?.windows || {},
    updatedAt: data?.updated_at || null,
    cache: data?.cache || {},
  };
}

export function windowDisplay(window, usageMode) {
  if (!window) return { value: '-', detail: '暂无数据', status: 'unavailable' };
  if (window.status === 'unlimited') {
    return { value: '不限额', detail: `已用 $${Number(window.used_usd || 0).toFixed(2)}`, status: window.status };
  }
  const percent = Number.isFinite(Number(window.percent)) ? `${Number(window.percent).toFixed(1)}%` : '-';
  const detail = usageMode === 'shared_pool' && window.limit_usd > 0
    ? `$${Number(window.used_usd || 0).toFixed(2)} / $${Number(window.limit_usd).toFixed(2)}`
    : statusLabel(window.status);
  return { value: percent, detail, status: window.status || 'unavailable' };
}

export default function createSub2apiUsagePanel(config) {
  const cfg = config.sub2apiUsage || {};
  const enabled = cfg.enabled === true;
  const monitorBaseUrl = cleanBaseUrl(cfg.monitorBaseUrl);
  const username = String(cfg.username || '').trim();
  const apiToken = String(cfg.apiToken || '').trim();
  const intervalMs = cfg.intervalMs || 30000;
  const cacheTtlMs = cfg.cacheTtlMs || 30000;
  const timeoutMs = cfg.timeoutMs || 8000;
  const staleTtlMs = cfg.staleTtlMs || 300000;
  const allowLocalRefresh = cfg.allowLocalRefresh === true;

  const state = {
    enabled,
    configured: Boolean(monitorBaseUrl && username && apiToken),
    username,
    lastCheck: null,
    lastSuccess: null,
    error: null,
    stale: false,
    data: null,
  };

  let timer = null;
  let inFlight = null;

  function publicState() {
    return {
      enabled: state.enabled,
      configured: state.configured,
      username: state.username,
      lastCheck: state.lastCheck,
      lastSuccess: state.lastSuccess,
      error: state.error,
      stale: state.stale,
      data: state.data,
    };
  }

  async function refresh({ force = false } = {}) {
    if (!enabled) return publicState();
    if (!state.configured) {
      state.error = 'sub2apiUsage is not configured';
      state.lastCheck = Date.now();
      return publicState();
    }

    const now = Date.now();
    const fresh = state.lastSuccess && now - state.lastSuccess < cacheTtlMs;
    if ((!force || !allowLocalRefresh) && fresh) return publicState();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const url = new URL(`${monitorBaseUrl}/api/downstream-usage/user`);
      url.searchParams.set('username', username);
      try {
        const res = await fetchWithTimeout(url, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
          timeoutMs,
        });
        state.lastCheck = Date.now();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.data = normalizePayload(await res.json());
        state.error = null;
        state.stale = Boolean(state.data.cache.stale);
        state.lastSuccess = state.lastCheck;
      } catch (err) {
        state.lastCheck = Date.now();
        state.error = err.message;
        state.stale = Boolean(state.data && state.lastSuccess && state.lastCheck - state.lastSuccess <= staleTtlMs);
        if (!state.stale) state.data = null;
      } finally {
        inFlight = null;
      }
      return publicState();
    })();
    return inFlight;
  }

  function startPolling() {
    if (!enabled) return;
    refresh();
    timer = setInterval(() => refresh(), intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function routes() {
    return {
      'GET /api/sub2api-usage': (req, res) => sendJson(res, publicState()),
      'GET /api/sub2api-usage/refresh': async (req, res) => sendJson(res, await refresh({ force: true })),
    };
  }

  function renderEmpty(message) {
    return `<div class="panel sub2api-usage-panel"><div class="panel-header"><h3>GPT 用量</h3><span class="status-badge unknown">未启用</span></div><div class="sub2api-empty">${esc(message)}</div></div>`;
  }

  function renderWindow(label, window, usageMode) {
    const shown = windowDisplay(window, usageMode);
    return `
      <div class="sub2api-summary-card ${statusClass(shown.status)}">
        <span>${esc(label)}</span>
        <strong>${esc(shown.value)}</strong>
        <small>${esc(shown.detail)}</small>
        <small>${window?.reset_at ? `重置 ${esc(window.reset_at)}` : '-'}</small>
      </div>`;
  }

  function renderSummary(data) {
    const sourceLabel = data.source.label || data.source.tier || '-';
    const sourceDetail = data.usageMode === 'dedicated_upstream'
      ? `${text(data.source.available_accounts, 0)} / ${text(data.source.total_accounts, 0)} 可用`
      : statusLabel(data.overallStatus);
    return `
      <div class="sub2api-summary">
        <div class="sub2api-summary-card"><span>用量来源</span><strong>${esc(modeLabel(data.usageMode))}</strong><small>${esc(sourceLabel)}</small><small>${esc(sourceDetail)}</small></div>
        ${renderWindow('5 小时', data.windows['5h'], data.usageMode)}
        ${renderWindow('7 天', data.windows['7d'], data.usageMode)}
      </div>`;
  }

  function render() {
    if (!enabled) return '';
    if (!state.configured) return renderEmpty('请配置中心地址、固定用户名和只读 Token');
    const data = state.data;
    const badgeCls = state.error ? (state.stale ? 'warn' : 'fail') : statusClass(data?.overallStatus);
    const badgeText = state.error ? (state.stale ? '缓存' : '异常') : statusLabel(data?.overallStatus);
    const meta = [
      state.username,
      data?.updatedAt ? `中心更新 ${data.updatedAt}` : '',
      state.lastSuccess ? `本机更新 ${relative(state.lastSuccess)}` : '',
      state.stale || data?.cache?.stale ? '数据已过期' : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="panel sub2api-usage-panel">
        <div class="panel-header"><h3>GPT 用量</h3><div class="sub2api-actions"><span class="status-badge ${badgeCls}">${esc(badgeText)}</span><button onclick="refreshSub2apiUsage()" class="btn btn-sm">刷新</button></div></div>
        ${data ? renderSummary(data) : '<div class="sub2api-empty">正在获取用量数据</div>'}
        ${state.error ? `<div class="sub2api-error">${esc(state.error)}</div>` : ''}
        <div class="card-time">${esc(meta || '-')}</div>
      </div>`;
  }

  return { name: 'sub2api-usage', routes, render, startPolling, stopPolling, refresh };
}
