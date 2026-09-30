'use strict';
// Sharded batch scoring: the customer id space is split into contiguous ranges, one per worker
// thread. Customers are independent, so this scales linearly with cores (and, in production,
// with machines: same partitioning by customer id).
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const os = require('node:os');
const { syntheticCustomer } = require('./data');
const { decide } = require('./engine');

const KBC_CUSTOMERS = 2_300_000;

function processRange(from, to) {
  const actions = {};
  const moments = {};
  let cards = 0;
  for (let i = from; i < to; i++) {
    const r = decide(syntheticCustomer(i));
    cards += r.decisions.length;
    for (const d of r.decisions) actions[d.action.id] = (actions[d.action.id] || 0) + 1;
    for (const m of r.moments) moments[m.id] = (moments[m.id] || 0) + 1;
  }
  return { cards, actions, moments };
}

function merge(into, part) {
  into.cards += part.cards;
  for (const k of ['actions', 'moments']) {
    for (const [id, n] of Object.entries(part[k])) into[k][id] = (into[k][id] || 0) + n;
  }
  return into;
}

function runBatch(total, workers = os.availableParallelism()) {
  const t0 = process.hrtime.bigint();
  const finish = (agg) => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const perSec = Math.round(total / (ms / 1000));
    return { customers: total, workers, ms: Math.round(ms), customersPerSecond: perSec, ...agg };
  };
  if (workers <= 1) return Promise.resolve(finish(processRange(0, total)));
  const size = Math.ceil(total / workers);
  const jobs = Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const from = w * size;
    const to = Math.min(total, from + size);
    if (from >= to) return resolve({ cards: 0, actions: {}, moments: {} });
    const worker = new Worker(__filename, { workerData: { from, to } });
    worker.once('message', resolve);
    worker.once('error', reject);
  }));
  return Promise.all(jobs).then((parts) => finish(parts.reduce(merge, { cards: 0, actions: {}, moments: {} })));
}

if (!isMainThread) {
  parentPort.postMessage(processRange(workerData.from, workerData.to));
} else if (require.main === module) {
  const n = Number(process.argv[2]) || KBC_CUSTOMERS;
  runBatch(n).then((r) => console.log(r));
}

module.exports = { runBatch, processRange, KBC_CUSTOMERS };
