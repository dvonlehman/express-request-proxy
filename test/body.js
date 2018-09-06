var assert = require('assert');
var supertest = require('supertest');
var proxy = require('..');
var debug = require('debug')('express-request-proxy:test');
var querystring = require('querystring');
var setup = require('./setup');

describe('req body', function() {
  var self;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    self = this;
    this.server.all('/proxy', proxy(this.proxyOptions));
    this.server.use(setup.errorHandler);
  });

  it('posts JSON body', function(done) {
    var postData = {foo: 1, arr: [1, 2, 3]};

    supertest(this.server).post('/proxy')
      .set('Content-Type', 'application/json')
      .send(postData)
      .expect(200)
      .expect('Content-Type', /^application\/json/)
      .expect(function(res) {
        assert.deepEqual(res.body.body, postData);
        assert.equal(res.body.headers['content-type'], 'application/json');
      })
      .end(done);
  });

  it('posts url-encoded form body', function(done) {
    var postData = {foo: 1, bar: 'hello'};

    supertest(this.server).post('/proxy')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(querystring.stringify(postData))
      .expect(200)
      .expect(function(res) {
        assert.deepEqual(res.body.body, postData);
      })
      .end(done);
  });

  it('posts to a wildcard route', function(done) {
    var postData = {key: 'asfasdfasdfasdf'};

    this.proxyOptions.url = 'http://localhost:' + this.apiPort + '/api/*';
    this.remoteApi.post('/api/v1/token', function(req, res, next) {
      res.json({path: req.path});
    });

    this.server.post('/api/auth/*', function(req, res, next) {
      debug('hit the auth endpoint');
      proxy(self.proxyOptions)(req, res, next);
    });

    supertest(this.server).post('/api/auth/v1/token')
      .send(postData)
      .expect(200)
      .expect(function(res) {
        assert.equal(res.body.path, '/api/v1/token');
      })
      .end(done);
  });
});
