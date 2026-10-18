import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, doRequestsByNamespace, issueTitle, mergeDays, summaryMarkdown, windowDates } from './quota-watch.mjs';

// One quiet day: every quota well under 30%.
const quiet = {
  workerRequests: 2_000,
  workerCpuP99Us: 3_000,
  doRequests: 2_100,
  doRowsWritten: 1_800,
  doRowsRead: 40_000,
  doDurationGbS: 40,
  d1RowsWritten: 150,
  d1RowsRead: 9_000,
};

const find = (result, key) => result.findings.find((f) => f.key === key);

test('windowDates is the last 7 complete UTC days', () => {
  const w = windowDates(new Date('2026-10-13T00:30:00Z'));
  assert.deepEqual(w, { from: '2026-10-06', to: '2026-10-12' });
});

test('windowDates crosses a month boundary', () => {
  const w = windowDates(new Date('2026-11-03T00:30:00Z'));
  assert.deepEqual(w, { from: '2026-10-27', to: '2026-11-02' });
});

test('a quiet week has no alerts', () => {
  const days = { '2026-10-11': quiet, '2026-10-12': quiet };
  const r = analyze(days);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.alerts, []);
  assert.ok(r.findings.every((f) => f.pct < 30));
});

test('the 2026-10-03 D1 rows-written spike is 102% and fails', () => {
  const days = {
    '2026-10-02': quiet,
    '2026-10-03': { ...quiet, d1RowsWritten: 102_385 },
    '2026-10-04': quiet,
  };
  const r = analyze(days);
  const f = find(r, 'd1RowsWritten');
  assert.equal(f.peak, 102_385);
  assert.equal(f.peakDate, '2026-10-03');
  assert.equal(Math.round(f.pct), 102);
  assert.equal(f.level, 'fail');
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.alerts.map((a) => a.key), ['d1RowsWritten']);
});

test('30% opens an alert without failing; 80% fails', () => {
  const at30 = analyze({ d: { ...quiet, doRequests: 30_000 } });
  assert.equal(find(at30, 'doRequests').level, 'alert');
  assert.equal(at30.status, 'alert');

  const below = analyze({ d: { ...quiet, doRequests: 29_999 } });
  assert.equal(below.status, 'ok');

  const at80 = analyze({ d: { ...quiet, doRequests: 80_000 } });
  assert.equal(find(at80, 'doRequests').level, 'fail');
  assert.equal(at80.status, 'fail');
});

test('the peak day is the highest day, not the latest or the sum', () => {
  const days = {
    '2026-10-06': { ...quiet, workerRequests: 40_000 },
    '2026-10-07': { ...quiet, workerRequests: 10_000 },
  };
  const f = find(analyze(days), 'workerRequests');
  assert.equal(f.peak, 40_000);
  assert.equal(f.peakDate, '2026-10-06');
  assert.equal(f.pct, 40);
});

test('the threshold is configurable for dry runs', () => {
  const r = analyze({ d: quiet }, { thresholdPct: 1 });
  // 2,100 DO requests is 2.1% of 100,000, so past a 1% threshold.
  assert.ok(r.alerts.some((a) => a.key === 'doRequests'));
  assert.equal(r.status, 'alert');
});

test('worker CPU p99 over 10 ms is a warning only', () => {
  const r = analyze({ d: { ...quiet, workerCpuP99Us: 13_900 } });
  const cpu = r.cpu;
  assert.equal(cpu.peakMs, 13.9);
  assert.equal(cpu.warn, true);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.alerts, []);
});

test('an empty window reports zeros, not NaN', () => {
  const r = analyze({});
  assert.equal(r.status, 'ok');
  assert.ok(r.findings.every((f) => f.peak === 0 && f.pct === 0));
  assert.equal(r.cpu.warn, false);
});

test('mergeDays sums counts and takes the max for p99 across rows of one date', () => {
  const days = mergeDays({
    workerRequests: [
      { date: '2026-10-12', requests: 5, errors: 1, cpuP99Us: 2_000 },
      { date: '2026-10-12', requests: 7, errors: 2, cpuP99Us: 9_000 },
    ],
    doRequests: [{ date: '2026-10-12', requests: 11 }],
    doPeriodic: [{ date: '2026-10-12', activeTime: 8_000_000, rowsRead: 3, rowsWritten: 4 }],
    d1: [{ date: '2026-10-12', rowsRead: 20, rowsWritten: 30 }],
  });
  assert.deepEqual(days['2026-10-12'], {
    workerRequests: 12,
    workerErrors: 3,
    workerCpuP99Us: 9_000,
    doRequests: 11,
    doRowsWritten: 4,
    doRowsRead: 3,
    doDurationGbS: 1, // 8 s of active time x 0.125 GB
    d1RowsWritten: 30,
    d1RowsRead: 20,
  });
});

test('issueTitle names the quota and the rounded percentage', () => {
  assert.equal(
    issueTitle({ name: 'D1 rows written', pct: 102.385 }),
    'Cloudflare quota watch: D1 rows written at 102%',
  );
});

test('doRequestsByNamespace names each class and finds its peak day', () => {
  const rows = [
    { date: '2026-10-11', namespaceId: '5174536da6c046808990b2f59b08f0a5', requests: 300 },
    { date: '2026-10-12', namespaceId: '5174536da6c046808990b2f59b08f0a5', requests: 900 },
    { date: '2026-10-12', namespaceId: '720a5ab32ddd4f76af01d6d5363ae6f4', requests: 4_000 },
    { date: '2026-10-12', namespaceId: 'abc123', requests: 5 },
  ];
  assert.deepEqual(doRequestsByNamespace(rows), [
    { name: 'MatchDO', peak: 4_000, peakDate: '2026-10-12', total: 4_000 },
    { name: 'Matchmaker', peak: 900, peakDate: '2026-10-12', total: 1_200 },
    { name: 'abc123', peak: 5, peakDate: '2026-10-12', total: 5 },
  ]);
});

test('the summary lists DO requests by namespace when there are any', () => {
  const window = { from: '2026-10-06', to: '2026-10-12' };
  const result = analyze({ '2026-10-12': quiet });
  const split = [{ name: 'Matchmaker', peak: 900, peakDate: '2026-10-12', total: 1_200 }];
  assert.match(summaryMarkdown(result, window, split), /\| Matchmaker \| 2026-10-12 \| 900 \| 1,200 \|/);
  assert.doesNotMatch(summaryMarkdown(result, window), /by namespace/);
});
