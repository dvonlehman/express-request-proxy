var supertest = require('supertest');
var setup = require('./setup');

describe('proxy authentication', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  it('returns 401 when request not authenticated', function(done) {
    this.proxyOptions.ensureAuthenticated = true;

    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .expect(401, done);
  });

  it('succeeds when request is authenticated', function(done) {
    this.proxyOptions.ensureAuthenticated = true;

    this.isAuthenticated = true;
    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .expect(200, done);
  });
});