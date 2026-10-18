// Daily Cloudflare free-plan quota watch (run by .github/workflows/quota-watch.yml).
//
// The free plan's daily limits fail rather than bill, and Cloudflare sends no early warning. This
// reads the last 7 complete UTC days from the GraphQL analytics API, compares each day with the
// limits below, writes a job summary, and opens (or comments on) an issue when a quota's peak day
// reaches the alert threshold. At the fail threshold it also exits non-zero so the run shows red.
//
// Environment:
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_TOKEN  required (a missing token exits cleanly)
//   QUOTA_WATCH_THRESHOLD_PCT   alert threshold, default 30 (lower it to dry-run the issue flow)
//   QUOTA_WATCH_NO_ISSUES       set to skip gh (local runs)
//   GITHUB_STEP_SUMMARY, GITHUB_REPOSITORY, GH_TOKEN   provided by Actions

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';
const DEFAULT_ALERT_PCT = 30; // the point to move to Workers Paid
const FAIL_PCT = 80;
const WINDOW_DAYS = 7;
const CPU_LIMIT_MS = 10; // free plan, per request
const GB_PER_DO = 0.125; // a Durable Object is billed as 128 MB

// Free-plan limits per UTC day, in one place.
export const LIMITS = [
  { key: 'workerRequests', name: 'Worker requests', limit: 100_000 },
  { key: 'doRequests', name: 'DO requests', limit: 100_000 },
  { key: 'doRowsWritten', name: 'DO rows written', limit: 100_000 },
  { key: 'doRowsRead', name: 'DO rows read', limit: 5_000_000 },
  { key: 'doDurationGbS', name: 'DO duration (GB-s)', limit: 13_000 },
  { key: 'd1RowsWritten', name: 'D1 rows written', limit: 100_000 },
  { key: 'd1RowsRead', name: 'D1 rows read', limit: 5_000_000 },
];

// Durable Object namespace ids, by class, as GET /accounts/:id/workers/durable_objects/namespaces
// lists them. The analytics token can't read that endpoint, so they're kept here; an id stays the
// same while its class is deployed. One not listed shows as its id.
const DO_NAMESPACES = {
  '720a5ab32ddd4f76af01d6d5363ae6f4': 'MatchDO',
  '5174536da6c046808990b2f59b08f0a5': 'Matchmaker',
};

const isoDate = (d) => d.toISOString().slice(0, 10);

// The last 7 complete UTC days: yesterday and the six before it.
export function windowDates(now = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: isoDate(new Date(startOfToday - WINDOW_DAYS * day)),
    to: isoDate(new Date(startOfToday - day)),
  };
}

// Folds the per-dataset rows into one metrics object per date. A dataset can return more than one
// row for a date, so counts are summed and p99 takes the worst row.
export function mergeDays({ workerRequests = [], doRequests = [], doPeriodic = [], d1 = [] }) {
  const days = {};
  const at = (date) =>
    (days[date] ??= {
      workerRequests: 0,
      workerErrors: 0,
      workerCpuP99Us: 0,
      doRequests: 0,
      doRowsWritten: 0,
      doRowsRead: 0,
      doDurationGbS: 0,
      d1RowsWritten: 0,
      d1RowsRead: 0,
    });
  for (const r of workerRequests) {
    const d = at(r.date);
    d.workerRequests += r.requests;
    d.workerErrors += r.errors ?? 0;
    d.workerCpuP99Us = Math.max(d.workerCpuP99Us, r.cpuP99Us ?? 0);
  }
  for (const r of doRequests) at(r.date).doRequests += r.requests;
  for (const r of doPeriodic) {
    const d = at(r.date);
    d.doRowsWritten += r.rowsWritten;
    d.doRowsRead += r.rowsRead;
    d.doDurationGbS += (r.activeTime / 1e6) * GB_PER_DO;
  }
  for (const r of d1) {
    const d = at(r.date);
    d.d1RowsWritten += r.rowsWritten;
    d.d1RowsRead += r.rowsRead;
  }
  return days;
}

// Pure: daily metrics + limits -> findings. `level` is ok, alert (>= threshold) or fail (>= 80%).
export function analyze(days, { thresholdPct = DEFAULT_ALERT_PCT, limits = LIMITS } = {}) {
  const failPct = Math.max(FAIL_PCT, thresholdPct);
  const entries = Object.entries(days);

  const findings = limits.map(({ key, name, limit }) => {
    let peak = 0;
    let peakDate = null;
    for (const [date, metrics] of entries) {
      const v = metrics[key] ?? 0;
      if (v > peak) {
        peak = v;
        peakDate = date;
      }
    }
    const pct = (peak / limit) * 100;
    const level = pct >= failPct ? 'fail' : pct >= thresholdPct ? 'alert' : 'ok';
    return { key, name, limit, peak, peakDate, pct, level };
  });

  let cpuPeakUs = 0;
  let cpuPeakDate = null;
  for (const [date, metrics] of entries) {
    if ((metrics.workerCpuP99Us ?? 0) > cpuPeakUs) {
      cpuPeakUs = metrics.workerCpuP99Us;
      cpuPeakDate = date;
    }
  }
  const peakMs = cpuPeakUs / 1000;
  const cpu = { peakMs, peakDate: cpuPeakDate, limitMs: CPU_LIMIT_MS, warn: peakMs > CPU_LIMIT_MS };

  const alerts = findings.filter((f) => f.level !== 'ok');
  const status = findings.some((f) => f.level === 'fail')
    ? 'fail'
    : alerts.length > 0
      ? 'alert'
      : 'ok';
  return { findings, alerts, cpu, status };
}

// DO requests per namespace: each one's peak day and its total over the window, busiest first. The
// account-wide limit covers them all; this shows which class the requests come from.
export function doRequestsByNamespace(rows, names = DO_NAMESPACES) {
  const byName = {};
  for (const { date, namespaceId, requests } of rows) {
    const name = names[namespaceId] ?? namespaceId;
    const days = (byName[name] ??= {});
    days[date] = (days[date] ?? 0) + requests;
  }
  return Object.entries(byName)
    .map(([name, days]) => {
      const [peakDate, peak] = Object.entries(days).reduce((best, day) => (day[1] > best[1] ? day : best));
      const total = Object.values(days).reduce((sum, n) => sum + n, 0);
      return { name, peak, peakDate, total };
    })
    .sort((a, b) => b.peak - a.peak);
}

export const ISSUE_PREFIX = 'Cloudflare quota watch: ';

export function issueTitle({ name, pct }) {
  return `${ISSUE_PREFIX}${name} at ${Math.round(pct)}%`;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function summaryMarkdown(result, { from, to }, byNamespace = []) {
  const lines = [
    '## Cloudflare quota watch',
    '',
    `Peak day per quota, ${from} to ${to} (UTC), against the free-plan daily limits.`,
    '',
    '| Quota | Peak day | Peak | Limit | % of limit | |',
    '|---|---|---:|---:|---:|---|',
  ];
  const icon = { ok: '', alert: ':warning: past the alert threshold', fail: ':x: near or over the limit' };
  for (const f of result.findings) {
    lines.push(
      `| ${f.name} | ${f.peakDate ?? '-'} | ${fmt(f.peak)} | ${fmt(f.limit)} | ${f.pct.toFixed(1)}% | ${icon[f.level]} |`,
    );
  }
  if (byNamespace.length > 0) {
    lines.push('', 'DO requests by namespace:', '', '| Namespace | Peak day | Peak | 7-day total |', '|---|---|---:|---:|');
    for (const n of byNamespace) lines.push(`| ${n.name} | ${n.peakDate} | ${fmt(n.peak)} | ${fmt(n.total)} |`);
  }
  const { cpu } = result;
  lines.push(
    '',
    `Worker CPU p99 peak: ${cpu.peakMs.toFixed(1)} ms of ${cpu.limitMs} ms per request` +
      (cpu.peakDate ? ` (${cpu.peakDate})` : '') +
      (cpu.warn ? ' :warning: over the limit (warning only)' : '') +
      '.',
  );
  return lines.join('\n') + '\n';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphql(token, query, variables) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    const message = JSON.stringify(body.errors ?? (res.ok ? '' : res.status));
    if (res.ok && !body.errors) return body.data;
    // A depleted rate-limit budget refills over time, so one patient retry is worth it.
    if (attempt < 3 && /budget depleted|rate limit/i.test(message)) {
      await sleep(attempt * 20_000);
      continue;
    }
    throw new Error(`Cloudflare GraphQL request failed: ${message}`);
  }
}

// One small query per dataset: a combined query exhausted the API's rate-limit budget.
const DATASETS = [
  {
    name: 'workersInvocationsAdaptive',
    fields: 'dimensions { date } sum { requests errors } quantiles { cpuTimeP99 }',
    toRow: (r) => ({
      date: r.dimensions.date,
      requests: r.sum.requests,
      errors: r.sum.errors,
      cpuP99Us: r.quantiles.cpuTimeP99,
    }),
    into: 'workerRequests',
  },
  {
    name: 'durableObjectsInvocationsAdaptiveGroups',
    fields: 'dimensions { date } sum { requests }',
    toRow: (r) => ({ date: r.dimensions.date, requests: r.sum.requests }),
    into: 'doRequests',
  },
  {
    name: 'durableObjectsPeriodicGroups',
    fields: 'dimensions { date } sum { activeTime rowsRead rowsWritten }',
    toRow: (r) => ({ date: r.dimensions.date, ...r.sum }),
    into: 'doPeriodic',
  },
  {
    name: 'd1AnalyticsAdaptiveGroups',
    fields: 'dimensions { date } sum { rowsRead rowsWritten }',
    toRow: (r) => ({ date: r.dimensions.date, ...r.sum }),
    into: 'd1',
  },
];

async function fetchRows(token, accountTag, { from, to }, name, fields) {
  const query = `query($accountTag: string!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      ${name}(limit: 100, filter: { date_geq: $from, date_leq: $to }) { ${fields} }
    } }
  }`;
  const data = await graphql(token, query, { accountTag, from, to });
  return data.viewer.accounts[0]?.[name] ?? [];
}

async function fetchDays(token, accountTag, window) {
  const datasets = {};
  for (const ds of DATASETS) {
    datasets[ds.into] = (await fetchRows(token, accountTag, window, ds.name, ds.fields)).map(ds.toRow);
  }
  return mergeDays(datasets);
}

// Its own small query, like the datasets above. 7 days x a couple of namespaces is well under 100 rows.
async function fetchDoRequestsByNamespace(token, accountTag, window) {
  const rows = await fetchRows(
    token,
    accountTag,
    window,
    'durableObjectsInvocationsAdaptiveGroups',
    'dimensions { date namespaceId } sum { requests }',
  );
  return doRequestsByNamespace(
    rows.map((r) => ({ date: r.dimensions.date, namespaceId: r.dimensions.namespaceId, requests: r.sum.requests })),
  );
}

async function gh(...args) {
  const { stdout } = await run('gh', args);
  return stdout;
}

// Opens one issue per quota, or comments on that quota's open issue with the new numbers.
// Issues are never closed here: a person decides when it's handled.
async function report(alerts, { from, to }) {
  const open = JSON.parse(
    await gh('issue', 'list', '--state', 'open', '--label', 'worker', '--limit', '100', '--json', 'number,title'),
  );
  for (const f of alerts) {
    const title = issueTitle(f);
    const body =
      `**${f.name}** peaked at ${fmt(f.peak)} on ${f.peakDate}, ${f.pct.toFixed(1)}% of the ` +
      `${fmt(f.limit)} free-plan daily limit (${from} to ${to}, UTC).\n\n` +
      (f.level === 'fail'
        ? 'This is at or near the limit: past it, calls fail until 00:00 UTC.\n\n'
        : 'Past 30% is the point to plan the move to Workers Paid.\n\n') +
      `Reported by the daily quota watch (${process.env.GITHUB_SERVER_URL ?? ''}/` +
      `${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}).`;
    const existing = open.find((i) => i.title.startsWith(`${ISSUE_PREFIX}${f.name} at `));
    if (existing) {
      await gh('issue', 'comment', String(existing.number), '--body', `${title}\n\n${body}`);
      console.log(`Commented on #${existing.number}: ${title}`);
    } else {
      const url = (await gh('issue', 'create', '--title', title, '--label', 'worker', '--body', body)).trim();
      console.log(`Opened ${url}: ${title}`);
    }
  }
}

function writeSummary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

async function main() {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountTag) {
    // Exit cleanly: failing every night until someone adds the secret is just noise.
    writeSummary(
      '## Cloudflare quota watch\n\n' +
        'Skipped: `CLOUDFLARE_ANALYTICS_TOKEN` (or `CLOUDFLARE_ACCOUNT_ID`) is not set.\n\n' +
        'To enable it, create a Cloudflare API token with only **Account > Account Analytics > Read**, ' +
        'then add it as the repository secret `CLOUDFLARE_ANALYTICS_TOKEN` ' +
        '(Settings > Secrets and variables > Actions). Do not reuse `CLOUDFLARE_API_TOKEN`: that one deploys.\n',
    );
    console.log('::notice::Quota watch skipped: CLOUDFLARE_ANALYTICS_TOKEN is not set.');
    return 0;
  }

  const thresholdPct = Number(process.env.QUOTA_WATCH_THRESHOLD_PCT) || DEFAULT_ALERT_PCT;
  const window = windowDates();
  const days = await fetchDays(token, accountTag, window);
  const result = analyze(days, { thresholdPct });
  const byNamespace = await fetchDoRequestsByNamespace(token, accountTag, window);

  writeSummary(summaryMarkdown(result, window, byNamespace));
  if (result.alerts.length > 0 && !process.env.QUOTA_WATCH_NO_ISSUES) {
    await report(result.alerts, window);
  }
  if (result.status === 'fail') {
    console.error('::error::A Cloudflare free-plan quota is at 80% or more of its daily limit.');
    return 1;
  }
  return 0;
}

// Only when run directly, so the tests can import the pure functions.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
