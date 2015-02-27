var supertest = require('supertest');
var assert = require('assert');
var redis = require('redis');
var proxy = require('..');
var setup = require('./setup');

require('redis-streams');

describe('proxy api endpoints', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  it('endpoint match overrides defaults', function(done) {
    // Set default to not cache
    this.proxyOptions.cache = null;

    var cache = redis.createClient();
    this.proxyOptions.endpoints = [
      {
        // override to cache specific endpoint matches
        pattern: '/cache',
        cache: cache
      }
    ];

    var originUrl = this.apiUrl + '/api/cache';
    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .end(function(err) {
        cache.exists(originUrl, function(err, exists) {
          assert.equal(exists, 1);
          cache.del(originUrl);
          done();
        })
      });
  });
});