var assert = require('assert');
var express = require('express');
var http = require('http');
var querystring = require('querystring');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var debug = require('debug')('express-api-proxy');
var setup = require('./setup');
var shortid = require('shortid');

require('dash-assert');
require('redis-streams')(redis);

describe('proxy cache', function() {
  var self;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    self = this;
    this.cache = redis.createClient();
    this.proxyOptions.cacheMaxAge = 100;
    this.proxyOptions.cache = this.cache;

    this.proxyOptions.apis.cachedApi = {
      baseUrl: this.baseApiUrl,
      cache: true,
      cacheMaxAge: 100
    };
  });

  it('writes api response to cache', function(done) {
    this.apiResponse = {id: shortid.generate()};

    // var originPath = shortid.generate();
    var originUrl = this.baseApiUrl;
    this.cache.del(originUrl);

    supertest(this.server).get('/proxy?api=cachedApi')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Cache-Control', 'max-age=' + this.proxyOptions.cacheMaxAge)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(err, res) {
        self.cache.exists(originUrl, function(err, exists) {
          assert.ok(exists);
          self.cache.exists(originUrl + '__headers', function(err, exists) {
            assert.ok(exists);
            done();
          })
        });
      });
  });

  it('reads api response from cache', function(done) {
    this.apiResponse= {name: 'foo'};
    var originPath = shortid.generate();
    var originUrl = this.baseApiUrl + '/' + originPath;

    this.cache.setex(originUrl, 1000, JSON.stringify(this.apiResponse));
    this.cache.setex(originUrl + '__headers', 1000, JSON.stringify({'content-type':'application/json'}));

    supertest(this.server)
      .get('/proxy?api=cachedApi&path=' + originPath)
      .set('Accept', 'application/json')
      .expect(200)
      .expect('Content-Type', /^application\/json/)
      .expect('Cache-Control', /^max-age/)
      .expect('Express-Api-Proxy-Cache', 'hit')
      .expect(function(res) {
        assert.ok(_.isEqual(res.body, self.apiResponse));
      })
      .end(done);
  });

  it('bypasses cache for non-GET requests', function(done) {
    var originUrl = this.baseApiUrl + '/' + new Date().getTime();

    supertest(this.server).put('/proxy?api=cachedApi')
      .expect(200)
      .end(function(err, res) {
        self.cache.exists(originUrl, function(err, exists) {
          if (err) return done(err);
          assert.equal(exists, 0);
          done();
        })
      });
  });

  it('overrides Cache-Control from the origin API', function(done) {
    var resp = {id: shortid.generate()};
    this.remoteApi.get('/api/cache', function(req, res) {
      res.set('Cache-Control', 'max-age=20');
      res.json(resp);
    });

    this.proxyOptions.apis.cachedApi.cacheMaxAge = 200;

    var originUrl = this.baseApiUrl + '/cache';
    this.proxyOptions.cache.del(originUrl);

    supertest(this.server).get('/proxy?api=cachedApi&path=cache')
      .expect(200)
      .expect('Cache-Control', 'max-age=200')
      .expect(function(res) {
        assert.deepEqual(res.body, resp);
      })
      .end(done);
  });

  it('removes cache related headers', function(done) {
    var resp = {id: shortid.generate()};

    this.remoteApi.get('/api/cache', function(req, res) {
      debug("/api/cache endpoint");

      res.set('last-modified', new Date().toUTCString());
      res.set('expires', new Date().toUTCString());
      res.set('etag', '345345345345');

      res.json(resp);
    });

    this.proxyOptions.cacheMaxAge = 200;

    var originUrl = this.baseApiUrl + '/cache';
    this.proxyOptions.cache.del(originUrl);

    supertest(this.server).get('/proxy?api=cachedApi&path=cache')
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect(function(res) {
        assert.deepEqual(res.body, resp);
        assert.ok(_.isUndefined(res.headers['last-modified']));
        assert.ok(_.isUndefined(res.headers['expires']));
        assert.ok(_.isUndefined(res.headers['etag']));
      })
      .end(done);
  });

  it('original content-type preserved when request comes from cache', function(done) {
    var resp = shortid.generate();

    this.remoteApi.get('/api/custom-content', function(req, res) {
      debug("custom-content api endpoint");
      res.set('content-type', 'some/custom-type')
      res.send(resp);
    });

    var originUrl = this.baseApiUrl + '/custom-content';
    this.cache.del(originUrl);
    var proxyUrl = '/proxy?api=cachedApi&path=custom-content';

    supertest(this.server).get(proxyUrl)
      .expect(200)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .expect('Content-Type', /^some\/custom-type/)
      .expect(resp)
      .end(function(err, res) {
        supertest(self.server).get(proxyUrl)
          .expect('Express-Api-Proxy-Cache', 'hit')
          .expect(200)
          .expect(resp)
          .expect('Content-Type', /^some\/custom-type/)
          .expect(function(res) {
            assert.isUndefined(res.headers['set-cookie']);
          })
          .end(done);
      });
  });

  it('does not cache non-200 responses from remote API', function(done) {
    this.remoteApi.get('/api/not-found', function(req, res) {
      res.status(404).send('not found');
    });

    var originUrl = this.baseApiUrl + '/not-found';
    this.cache.del(originUrl);
    var proxyUrl = '/proxy?api=cachedApi&path=not-found';

    supertest(this.server)
      .get(proxyUrl)
      .expect(404)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(res) {
        self.cache.exists(originUrl, function(err, exists) {
          assert.ok(!exists);
          done();
        });
      });
  });
});
