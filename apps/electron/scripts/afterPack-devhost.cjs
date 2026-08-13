const afterPack = require('./afterPack.cjs');

module.exports = context => afterPack(context, { isDeveloperHost: true });
