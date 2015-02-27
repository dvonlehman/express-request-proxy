var assert = require('assert');
var querystring = require('querystring');
var supertest = require('supertest');
var _ = require('lodash');
var redis = require('redis');
var setup = require('./setup');

require('redis-streams');

describe('environment variable substitution', function() {
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  it('replaces environment variable tokens in originUrl query', function(done) {
    this.environmentVariables['API_CLIENT_ID'] = '1234';

    var params = {
      param1: 'foo',
      client_id: '${API_CLIENT_ID}'
    };

    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api?' + querystring.stringify(params)))
      .expect(200)
      .expect(function(res) {
        assert.ok(_.isEqual(res.body.query, {param1: 'foo', client_id: '1234'}));
      })
      .end(done);
  });

  it('substitutes environment variable tokens in pathname', function(done) {
    this.environmentVariables['API_CLIENT_ID'] = '1234';
    
    supertest(this.server).get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api/${API_CLIENT_ID}'))
      .expect(200)
      .expect(function(res) {
        assert.equal(res.body.path, '/api/1234');
        assert.equal(res.body.params.apikey, '1234');
      })
      .end(done);
  });

  it('substitutes user token in headers', function(done) {
    this.user.accessToken = 'abc';

    supertest(this.server).get('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .set('X-Authorization', 'OAuth ${USER_ACCESS_TOKEN}')
      .expect(200)
      .expect(function(res) {
        assert.equal(res.body.headers.authorization, 'OAuth abc');
      })
      .end(done);
  });

  it('returns 400 response for invalid environment variable', function(done) {
    var url = this.apiUrl + '/api?' + querystring.stringify({invalid:'${INVALID}'});

    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(url))
      .expect(400)
      .expect(/Invalid environment variable/, done);
  });

  it('returns 400 response for invalid user token', function(done) {
    var url = this.apiUrl + '/api?' + querystring.stringify({invalid:'${USER_INVALID}'});

    supertest(this.server)
      .get('/proxy?url=' + encodeURIComponent(url))
      .expect(400)
      .expect(/Invalid user token/, done);
  });

  it('substitutes environment variables in json request body', function(done) {
    this.environmentVariables['SUBSTITUTE_ME'] = 'actual_value';

    var body = { foo: "${SUBSTITUTE_ME}", blah: "12345", num:5};

    supertest(this.server).post('/proxy?url=' + encodeURIComponent(this.apiUrl + '/api'))
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200)
      .expect(function(res) {
        assert.equal('POST', res.body.method);
        assert.ok(_.isEqual(_.extend(body, {foo: 'actual_value'}), res.body.body));
      })
      .end(done);
  });
});