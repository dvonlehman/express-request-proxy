var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
var proxy = require("..");
var setup = require('./setup');

describe('http headers', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.server.get('/proxy', proxy(this.proxyOptions));
    this.server.use(setup.errorHandler);
  });

  it('passes through content-type', function(done) {
    supertest(this.server).get('/proxy')
      .expect(200)
      .expect('Content-Type', /^application\/json/)
      .end(done);
  });

  it('uses correct user-agent', function(done) {
    supertest(this.server).get('/proxy')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.body.headers['user-agent'], 'express-api-proxy')
      })
      .end(done);
    });
});
