var assert = require('assert');
var memoryCache = require('memory-cache-stream');
var supertest = require('supertest');
var _ = require('lodash');
var through2 = require('through2');
var proxy = require('..');
var setup = require('./setup');

describe('response transforms', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.proxyOptions.transforms = [
      appenderTransform('<<EOF>>', 'text/html')
    ];

    this.originHeaders = {
      'Content-Type': 'text/plain'
    };

    this.apiResponse = '1234';

    this.server.get('/proxy', proxy(this.proxyOptions));
    this.server.use(setup.errorHandler);
  });

  it('performs transform', function(done) {
    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Content-Type', /^text\/html/)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(done);
  });

  it('transformed response is stored in cache', function(done) {
    var self = this;

    _.extend(this.proxyOptions, {
      cache: memoryCache(),
      cacheMaxAge: 100
    });

    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Express-Api-Proxy-Cache', 'miss')
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>>');
      })
      .end(function(err, res) {
        if (err) return done(err);

        supertest(self.server).get('/proxy')
          .expect(200)
          .expect('Content-Type', /^text\/html/)
          .expect('Express-Api-Proxy-Cache', 'hit')
          .expect('1234<<EOF>>')
          .end(done);
      });
  });

  it('works with multiple transforms', function(done) {
    this.proxyOptions.transforms.push(appenderTransform('<<EOF2>>', 'text/html'));

    supertest(this.server).get('/proxy')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.text, '1234<<EOF>><<EOF2>>');
      })
      .end(done);
  });

  it('allows transform to override content-type', function(done) {
    this.proxyOptions.transforms = [appenderTransform('XYZ', 'text/html')];
    supertest(this.server)
      .get('/proxy')
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
  }
});
