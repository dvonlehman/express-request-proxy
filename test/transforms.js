var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var through2 = require('through2');
var setup = require('./setup');

require('redis-streams')(redis);

describe('response transforms', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.proxyOptions.apis.transformedApi = {
      baseUrl: this.baseApiUrl,
      transforms: [
        appenderTransform('<<EOF>>', 'text/html')
      ]
    };

    this.remoteApi.get('/api/transform', function(req, res) {
      // Just echo the query back in the response
      res.set('x-custom', 'custom header');
      res.set('content-type', 'text/plain');
      res.send('1234');
    });
  });

  it('performs transform', function(done) {
    supertest(this.server).get('/proxy?api=transformedApi&path=transform')
      .expect(200)
      .expect('x-custom', 'custom header')
      .expect('Content-Type', /^text\/html/)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(function(err, res) {
        console.log("callback");
        done(err);
      });
  });

  it('transformed response is stored in cache', function(done) {
    var self = this;

    this.proxyOptions.cache = redis.createClient();

    _.extend(this.proxyOptions.apis.transformedApi, {
      cache: true,
      cacheMaxAge: 100
    });

    var apiUrl = this.baseApiUrl + '/transform';
    this.proxyOptions.cache.del(apiUrl);

    supertest(this.server).get('/proxy?api=transformedApi&path=transform')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(function(err, res) {
        if (err) return done(err);

        supertest(self.server).get('/proxy?api=transformedApi&path=transform')
          .expect(200)
          .expect('Content-Type', /^text\/html/)
          .expect('1234<<EOF>>')
          .end(done);
      });
  });

  it('works with multiple transforms', function(done) {
    this.proxyOptions.apis.transformedApi.transforms.push(appenderTransform('<<EOF2>>', 'text/html'));

    supertest(this.server).get('/proxy?api=transformedApi&path=transform')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>><<EOF2>>');
      })
      .end(done);
  });

  it('allows transform to override content-type', function(done) {
    this.proxyOptions.apis.transformedApi.transforms = [appenderTransform('XYZ', 'text/html')];
    supertest(this.server)
      .get('/proxy?api=transformedApi&path=transform')
      .expect(200)
      .expect('Content-Type', /^text\/html/)
      .expect(function(res) {
        assert.equal(res.text, '1234XYZ');
      })
      .end(done);
  });

  function appenderTransform(appendText, contentType) {
    return {
      name: 'appender',
      contentType: contentType,
      transform: through2(function(chunk, enc, cb) {
        this.push(chunk + appendText);
        cb();
      })
    };
  };
});
