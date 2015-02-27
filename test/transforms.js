var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var through2 = require('through2');
var setup = require('./setup');

require('redis-streams');

describe('response transforms', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.remoteApi.get('/test', function(req, res) {
      // Just echo the query back in the response
      res.send('1234');
    });

    this.proxyOptions.transforms = [
      function() {
        return through2(function (chunk, enc, cb) { 
          this.push(chunk + '<<EOF>>');
          cb();
        });
      }
    ];
  });

  it('performs transform', function(done) {      
    supertest(this.server).get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/test'))
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(done);
  });

  it('transformed response is stored in cache', function(done) {
    var cache = redis.createClient();
    this.proxyOptions.cache = cache;
    var apiUrl = this.apiUrl + '/test';
    cache.del(apiUrl);

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(apiUrl))
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(function(err, res) {
        if (err) return done(err);

        cache.get(apiUrl, function(err, val) {
          if (err) return done(err);
          assert.equal(val, '1234<<EOF>>');
          done();
        });
      });
  });

  it('works with multiple transforms', function(done) {
    this.proxyOptions.transforms.push(function() {
      return through2(function(chunk, enc, cb) { 
        this.push(chunk + '<<EOF2>>');
        cb();
      });
    });

    supertest(this.server).get('/proxy?url=' + encodeURIComponent('http://localhost:5998/test'))
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>><<EOF2>>');
      })
      .end(done);
  });
});