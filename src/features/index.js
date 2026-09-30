'use strict';
// To add a feature: copy subscriptions.js, optionally export `personas` (demo customers) and
// `eventCats` (extra allowed transaction categories), then add ONE line below.
// Register features here: one line each. The engine, batch runner and UI pick them up automatically.
const FEATURES = [
  require('./subscriptions'),
  require('./household'),
  require('./travel'),
  require('./savings'),
];

const ACTIONS = Object.assign({}, ...FEATURES.map((f) => f.actions));
module.exports = { FEATURES, ACTIONS };
