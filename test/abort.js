var supertest = require('supertest');
var request = require('request');
var assert = require('assert');
var proxy = require('..');
var setup = require('./setup');

describe('request abortion', function() {
  var self;
  var fullyExecuted = false;
  var postCount = 0;
  var remoteRequestDelay = 50;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    this.remoteApi.get('/longRoute', function(req, res) {
      var closedBeforeSend = false;
      req.on('close', function() {
        closedBeforeSend = true;
      })
      setTimeout(function() {
        fullyExecuted = !closedBeforeSend;
        res.send({status: true});
      }, remoteRequestDelay);
    });
    this.remoteApi.post('/postCounter', function(req, res) {
      postCount++;
      res.send({status: true});
    });
    this.server.get('/proxyLongRoute', proxy({
      url: 'http://localhost:' + this.apiPort + '/longRoute',
      cache: false
    }));
    this.server.post('/proxyPostCounter', proxy({
      url: 'http://localhost:' + this.apiPort + '/postCounter',
      cache: false
    }));
  });

  it('should process the remote api request fully if client do not close prematurely connection', function(done) {
    fullyExecuted = false;
    supertest(this.server)
      .get('/proxyLongRoute')
      .expect(200)
      .end(function(err, res) {
        if (!fullyExecuted) return done(new Error('Not fully executed'));
        done();
      });
  });

  it('should cancel the remote api request fully if client do not close prematurely connection', function(done) {
    var self = this;
    this.server.listen(this.apiPort + 1, function() {
      fullyExecuted = false;
      var req = request({
        url: 'http://localhost:' + (self.apiPort + 1) + '/proxyLongRoute'
      });
      // Abort main request after 250ms.
      setTimeout(function() { req.abort(); }, remoteRequestDelay / 2);
      setTimeout(function() {
        if (!fullyExecuted) return done();
        done(new Error('Request has not been closed.'));
      }, remoteRequestDelay + 10);
    });
  });

  it('should call the remote api request only once when request has a body', function(done) {
    postCount = 0;
    supertest(this.server)
      .post('/proxyPostCounter')
      .set('Content-Type', 'application/json')
      .send({sample: 'content'})
      .expect(200)
      .end(function(err, res) {
        setTimeout(() => {
          assert.equal(postCount, 1);
          done();
        }, 50);
      });
  });
});
