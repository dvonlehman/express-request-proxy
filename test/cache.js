var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
var async = require('async');
var memoryCache = require('memory-cache-stream');
// var redis = require('redis');
var debug = require('debug')('express-api-proxy');
var proxy = require('..');
var setup = require('./setup');
var shortid = require('shortid');

require('dash-assert');

describe('proxy cache', function() {
  var self;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    self = this;
    this.cache = memoryCache();

    _.extend(this.proxyOptions, {
      cache: this.cache,
      cacheMaxAge: 100
    });

    this.server.get('/proxy', proxy(this.proxyOptions));
    this.server.use(setup.errorHandler);
  });

  it('writes api response to cache', function(done) {
    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Cache-Control', 'max-age=' + this.proxyOptions.cacheMaxAge)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(err, res) {
        if (err) return done(err);

        var cacheKey = res.body.fullUrl;
        async.each([cacheKey, cacheKey + '__headers'], function(key, cb) {
          self.cache.exists(cacheKey + '__headers', function(_err, exists) {
            if (_err) return cb(_err);
            assert.ok(exists);
            cb();
          });
        }, done);
      });
  });

  it('reads api response from cache', function(done) {
    this.apiResponse = {name: 'foo'};

    this.cache.setex(this.baseApiUrl,
      this.proxyOptions.cacheMaxAge,
      JSON.stringify(this.apiResponse));

    this.cache.setex(this.baseApiUrl + '__headers',
      this.proxyOptions.cacheMaxAge,
      JSON.stringify({'content-type': 'application/json'}));

    supertest(this.server)
      .get('/proxy')
      .set('Accept', 'application/json')
      .expect(200)
      .expect('Content-Type', /^application\/json/)
      .expect('Cache-Control', /^max-age/)
      .expect('Express-Api-Proxy-Cache', 'hit')
      .expect(function(res) {
        assert.deepEqual(res.body, self.apiResponse);
      })
      .end(done);
  });

  it('bypasses cache for non-GET requests', function(done) {
    supertest(this.server).put('/proxy')
      .expect(200)
      .end(function(err, res) {
        self.cache.exists(self.baseApiUrl, function(_err, exists) {
          if (_err) return done(_err);
          assert.equal(exists, 0);
          done();
        });
      });
  });

  it('overrides Cache-Control from the origin API', function(done) {
    this.apiResponse = {id: shortid.generate()};
    this.originHeaders = {
      'Cache-Control': 'max-age=20'
    };
    this.proxyOptions.cacheMaxAge = 200;

    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Cache-Control', 'max-age=' + self.proxyOptions.cacheMaxAge)
      .expect(function(res) {
        assert.deepEqual(res.body, self.apiResponse);
      })
      .end(done);
  });


  it('removes cache related headers', function(done) {
    self.apiResponse = {id: shortid.generate()};

    this.originHeaders = {
      'Last-Modified': new Date().toUTCString(),
      'Expires': new Date().toUTCString(),
      'Etag': '345345345345'
    };

    this.proxyOptions.cacheMaxAge = 200;
    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect(function(res) {
        assert.deepEqual(res.body, self.apiResponse);
        assert.ok(_.isUndefined(res.headers['last-modified']));
        assert.ok(_.isUndefined(res.headers.expires));
        assert.ok(_.isUndefined(res.headers.etag));
      })
      .end(done);
  });

  it('original content-type preserved when request comes from cache', function(done) {
    this.apiResponse = shortid.generate();
    this.originHeaders = {
      'Content-Type': 'some/custom-type'
    };

    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .expect('Content-Type', /^some\/custom-type/)
      .expect(self.apiResponse)
      .end(function(err, res) {
        supertest(self.server).get('/proxy')
          .expect('Express-Api-Proxy-Cache', 'hit')
          .expect(200)
          .expect(self.apiResponse)
          .expect('Content-Type', /^some\/custom-type/)
          .end(done);
      });
  });


  it('does not cache non-200 responses from remote API', function(done) {
    this.apiResponse = {message: 'not found'};
    this.apiResponseStatus = 404;

    supertest(this.server)
      .get('/proxy')
      .expect(404)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(res) {
        self.cache.exists(self.baseApiUrl, function(err, exists) {
          assert.ok(!exists);
          done();
        });
      });
  });

  it('does not send conditional get headers to origin', function(done) {
    this.originHeaders = {
      'ETag': '2435345345',
      'If-Modified-Since': (new Date()).toUTCString()
    };

    supertest(this.server)
      .get('/proxy')
      .expect(function(res) {
        assert.isUndefined(res.body.headers.etag);
        assert.isUndefined(res.body.headers['if-modified-since']);
      })
      .end(done);
  });

  it('retains gzip encoding when served from cache', function(done) {
    this.apiGzipped = true;
    this.apiResponse = {foo: 1, name: 'elmer'};

    async.series([
      function(cb) {
        supertest(self.server).get('/proxy')
          .set('Accept-Encoding', 'gzip')
          .expect('Express-Api-Proxy-Cache', 'miss')
          .expect(function(res) {
            assert.deepEqual(res.body, self.apiResponse);
          })
          .end(cb);
      },
      function(cb) {
        // Check what's in the cache
        self.cache.get(self.baseApiUrl + '__headers', function(err, value) {
          assert.deepEqual({
            'content-type': 'application/json; charset=utf-8'
          }, JSON.parse(value));
          cb();
        });
      },
      function(cb) {
        supertest(self.server).get('/proxy')
          .set('Accept-Encoding', 'gzip')
          .expect('Express-Api-Proxy-Cache', 'hit')
          .expect(function(res) {
            assert.deepEqual(res.body, self.apiResponse);
          })
          .end(cb);
      }
    ], done);
  });
});
