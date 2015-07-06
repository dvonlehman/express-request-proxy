var supertest = require('supertest');
var proxy = require('..');
var setup = require('./setup');

describe('proxy authentication', function() {
  var self;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    self = this;
    self.isAuthenticated = false;

    this.server.use(function(req, res, next) {
      req.ext.isAuthenticated = self.isAuthenticated;
      next();
    });

    self.proxyOptions.ensureAuthenticated = true;
    this.server.get('/proxy', proxy(self.proxyOptions));

    this.server.use(setup.errorHandler);
  });

  it('returns 401 when request not authenticated', function(done) {
    self.isAuthenticated = false;
    supertest(this.server)
      .get('/proxy')
      .expect(401, done);
  });

  it('succeeds when request is authenticated', function(done) {
    this.isAuthenticated = true;
    supertest(this.server)
      .get('/proxy')
      .expect(200, done);
  });
});
