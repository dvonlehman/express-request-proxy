var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
var setup = require('./setup');

describe('http headers', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.proxyOptions.apis.test = {
      baseUrl: this.baseApiUrl
    };
  });

  it('passes through content-type', function(done) {
    supertest(this.server).get('/proxy?api=test')
      .expect(200)
      .expect('Content-Type', /^application\/json/)
      .end(done);
  });

  it('uses correct user-agent', function(done) {
    supertest(this.server).get('/proxy?api=test')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.body.headers['user-agent'], 'express-api-proxy')
      })
      .end(done);
    });
});
