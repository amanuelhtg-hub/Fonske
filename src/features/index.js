'use strict';
// Register features here: one line each. The engine, batch runner and UI pick them up automatically.
const FEATURES = [
  require('./subscriptions'),
  require('./household'),
  require('./travel'),
  require('./savings'),
];

const ACTIONS = Object.assign({}, ...FEATURES.map((f) => f.actions));
module.exports = { FEATURES, ACTIONS };
