var assert = require('assert');
var express = require('express');
var http = require('http');
var querystring = require('querystring');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var setup = require('./setup');

require('redis-streams');

describe('proxy cache', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  it('writes api response to cache', function(done) {
    // var apiResponse= {name: 'foo'};
    var originUrl = this.apiUrl + '/api/' + new Date().getTime();
    // var cache = new MemoryCache();
    var cache = redis.createClient();
    this.proxyOptions.cacheMaxAge = 100;
    this.proxyOptions.cache = cache;

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Cache-Control', 'max-age=100')
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(err, res) {
        cache.exists(originUrl, function(err, exists) {
          assert.ok(exists);
          cache.exists(originUrl + '__headers', function(err, exists) {
            assert.ok(exists);
            done();
          })
        });
      });
  });

  it('reads api response from cache', function(done) {
    var apiResponse= {name: 'foo'};
    var originUrl = this.apiUrl + '/api/' + new Date().getTime();

    var cache = redis.createClient();
    this.proxyOptions.cache = cache;

    cache.setex(originUrl, 1000, JSON.stringify(apiResponse));
    cache.setex(originUrl + '__headers', 1000, JSON.stringify({'content-type':'application/json'}));

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(originUrl))
      .set('Accept', 'application/json')
      .expect(200)   
      .expect('Content-Type', /^application\/json/)
      .expect('Cache-Control', /^max-age/)
      .expect('Express-Api-Proxy-Cache', 'hit')
      .expect(function(res) {
        assert.ok(_.isEqual(res.body, apiResponse));
      })
      .end(done);
  });

  it('bypasses cache for non-GET requests', function(done) {
    var cache = this.proxyOptions.cache = redis.createClient();
    var originUrl = this.apiUrl + '/api/' + new Date().getTime();

    supertest(this.server).put('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .end(function(err, res) {
        cache.exists(originUrl, function(err, exists) {
          if (err) return done(err);
          assert.equal(exists, 0);
          done();
        })
      });
  });

  it('overrides Cache-Control from the origin API', function(done) {
    this.remoteApi.get('/cache', function(req, res) {
      res.set('Cache-Control', 'max-age=20');
      res.json({});
    });

    this.proxyOptions.cache = redis.createClient();
    this.proxyOptions.cacheMaxAge = 200;
    
    var originUrl = this.apiUrl + '/cache';
    this.proxyOptions.cache.del(originUrl);

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .expect('Cache-Control', 'max-age=200')
      .end(done);
  });

  it('removes cache related headers', function(done) {
    this.remoteApi.get('/cache', function(req, res) {
      res.set('last-modified', new Date().toUTCString());
      res.set('expires', new Date().toUTCString());
      res.set('etag', '345345345345');
      res.set('x-custom', 'custom-header')

      res.json({});
    });

    this.proxyOptions.cache = redis.createClient();
    this.proxyOptions.cacheMaxAge = 200;
    
    var originUrl = this.apiUrl + '/cache';
    this.proxyOptions.cache.del(originUrl);

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('x-custom', 'custom-header')
      .expect(function(res) {
        assert.ok(_.isUndefined(res.headers['last-modified']));
        assert.ok(_.isUndefined(res.headers['expires']));
        assert.ok(_.isUndefined(res.headers['etag']));
      })
      .end(done);
  });

  it('original headers preserved when request comes from cache', function(done) {
    var self = this;

    this.remoteApi.get('/cache', function(req, res) {
      res.set('X-Custom-Header', 'foo');
      res.set('set-cookie', 'foo=1');
      res.json({});
    });

    this.proxyOptions.cache = redis.createClient();
    
    var originUrl = this.apiUrl + '/cache';
    this.proxyOptions.cache.del(originUrl);
    var proxyUrl = '/proxy?url=' + encodeURIComponent(originUrl);

    supertest(this.server).get(proxyUrl)
      .expect(200)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(err, res) {
        supertest(self.server).get(proxyUrl)
          .expect('Express-Api-Proxy-Cache', 'hit')
          .expect('Content-Type', /application\/json/)
          .expect('X-Custom-Header', 'foo')
          .expect(function(res) {
            assert.ok(_.isUndefined(res.headers['set-cookie']))
          })
          .end(done);
      });
  });
});