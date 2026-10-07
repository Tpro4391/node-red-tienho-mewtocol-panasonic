'use strict';
const MewtocolClient = require('./client');
const MewtocolConnection = require('./connection');
const protocol = require('./protocol');

module.exports = MewtocolClient;
module.exports.MewtocolClient = MewtocolClient;
module.exports.MewtocolConnection = MewtocolConnection;
module.exports.MewtocolError = protocol.MewtocolError;
module.exports.protocol = protocol;
