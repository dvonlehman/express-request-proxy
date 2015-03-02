var assert = require('assert');
var querystring = require('querystring');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var setup = require('./setup');

require('redis-streams');

describe('timeout', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.apiLatency = 50;
    this.proxyOptions.timeout = 20;
  });

  it('api timeout returns 408', function(done) {
    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .expect(408, done);
  });

  it('api returns 408 when writing to cache', function(done) {
    var cache = redis.createClient();
    this.proxyOptions.cache = cache;

    var cacheKey = new Date().getTime().toString();
    this.proxyOptions.cacheKeyFn = function(req) {
      return cacheKey;
    };

    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .expect(408)
      .end(function(err, res) {
        cache.exists(cacheKey, function(err, exists) {
          assert.equal(0, exists);
          done();
        })
      });
  });
});