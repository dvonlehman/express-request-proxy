var express = require('express');
var http = require('http');
var bodyParser = require('body-parser');
var debug = require('debug')('express-api-proxy');
var proxy = require('..');
var _ = require('lodash');

module.exports.beforeEach = function() {
  var self = this;
  this.apiLatency = 0;
  this.apiResponse = null;

  this.remoteApi = express();
  this.remoteApi.all('/api/:apikey?', bodyParser.json(), function(req, res) {
    setTimeout(function() {
      // Just echo the query back in the response
      res.set('Content-Type', 'application/json');

      if (self.apiResponse)
        res.json(self.apiResponse);
      else
        res.json(_.pick(req, 'query', 'path', 'params', 'headers', 'method', 'body'));
    }, self.apiLatency);
  });

  this.remoteApi.all('/error', function(req, res, next) {
    res.status(400).send("error message");
  });

  var apiPort = 5998;
  this.apiUrl = 'http://localhost:' + apiPort;
  this.apiServer = http.createServer(this.remoteApi).listen(apiPort);

  this.proxyOptions = {
    timeout: 3000
  };

  this.user = {};
  this.isAuthenticated = false;

  this.server = express();
  this.server.use(function(req, res, next) {
    req.ext = {};
    req.user = self.user;
    req.ext.isAuthenticated = self.isAuthenticated;

    next();
  });

  this.server.all('/proxy', function(req, res, next) {
    // Wrap this in a function to allow individual tests
    // the opportunity to modify proxyOptions.
    proxy(self.proxyOptions)(req, res, next);
  });

  this.server.use(function(err, req, res, next) {
    if (!err.status)
      err.status = 500;

    if (err.status >= 500)
      console.error(err.stack);

    res.status(err.status).send(err.message);
  });
};

module.exports.afterEach = function() {
  if (this.proxyOptions.cache)
    this.proxyOptions.cache.del(this.apiUrl);

  this.apiServer.close();
};
