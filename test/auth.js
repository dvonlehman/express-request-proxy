var supertest = require('supertest');
var setup = require('./setup');

describe('proxy authentication', function() {
  var self;

  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  beforeEach(function() {
    self = this;

    self.proxyOptions.apis.secureApi = {
      baseUrl: self.baseApiUrl,
      ensureAuthenticated: true
    };
  });

  it('returns 401 when request not authenticated', function(done) {
    supertest(this.server)
      .get('/proxy?api=secureApi')
      .expect(401, done);
  });

  it('succeeds when request is authenticated', function(done) {
    this.isAuthenticated = true;
    supertest(this.server)
      .get('/proxy?api=secureApi')
      .expect(200, done);
  });
});
