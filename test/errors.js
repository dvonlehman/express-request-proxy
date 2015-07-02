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

  var self;
  beforeEach(function() {
    self = this;
    
    this.apiLatency = 50;
    this.proxyOptions.timeout = 20;

    this.proxyOptions.apis.slowApi = {
      baseUrl: this.baseApiUrl
    };
  });

  it('returns error message', function(done) {
    supertest(this.server).get('/proxy?api=slowApi&path=error')
      .expect(400)
      .expect(/error message/)
      .end(done);
  });

  it('api timeout returns 408', function(done) {
    supertest(this.server)
      .get('/proxy?api=slowApi')
      .expect(408, done);
  });

  it('api returns 408 when writing to cache', function(done) {
    this.proxyOptions.cache = redis.createClient();

    // var cacheKey = new Date().getTime().toString();
    // this.proxyOptions.cacheKeyFn = function(req) {
    //   return cacheKey;
    // };

    supertest(this.server)
      .get('/proxy?api=slowApi')
      .expect(408)
      .end(function(err, res) {
        self.proxyOptions.cache.exists(self.baseApiUrl + '/api', function(err, exists) {
          assert.equal(0, exists);
          done();
        })
      });
  });
});
