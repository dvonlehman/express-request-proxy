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
    this.proxyOptions.cache = cache;

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(originUrl))
      .expect(200)
      .expect('Content-Type', /application\/json/)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .end(function(err, res) {
        cache.exists(originUrl, function(err, exists) {
          if (err) return done(err);
          assert.ok(exists);
          done();
        });
      });
  });

  it('reads api response from cache', function(done) {
    var apiResponse= {name: 'foo'};
    var originUrl = this.apiUrl + '/api/' + new Date().getTime();

    var cache = redis.createClient();
    this.proxyOptions.cache = cache;
    cache.setex(originUrl, 1000, JSON.stringify(apiResponse));

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
});