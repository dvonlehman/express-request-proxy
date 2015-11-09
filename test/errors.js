var assert = require('assert');
var supertest = require('supertest');
var memoryCache = require('memory-cache-stream');
var proxy = require('..');
var setup = require('./setup');

describe('timeout', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  var self;
  beforeEach(function() {
    self = this;

    this.server.get('/proxy', proxy(this.proxyOptions));
    this.server.use(setup.errorHandler);
  });

  it('returns error message', function(done) {
    this.apiResponseStatus = 400;
    this.apiResponse = {error: 'bad request'};

    supertest(this.server).get('/proxy')
      .expect(400)
      .expect('Content-Type', /application\/json/)
      .expect(function(res) {
        assert.deepEqual(res.body, self.apiResponse);
      })
      .end(done);
  });

  it('api timeout returns 408', function(done) {
    this.apiLatency = 50;
    this.proxyOptions.timeout = 20;

    supertest(this.server)
      .get('/proxy')
      .expect(408, done);
  });

  it('api returns 408 when instructed to cache', function(done) {
    this.apiLatency = 50;
    this.proxyOptions.timeout = 20;
    this.proxyOptions.cache = memoryCache();

    supertest(this.server)
      .get('/proxy')
      .expect(408)
      .end(function(err, res) {
        self.proxyOptions.cache.exists(self.baseApiUrl, function(_err, exists) {
          assert.equal(0, exists);
          done();
        });
      });
  });
});
