var assert = require('assert');
var express = require('express');
var http = require('http');
var querystring = require('querystring');
var supertest = require('supertest');
var _ = require('lodash');
var bodyParser = require('body-parser');
var MemoryCache = require('../lib/memory-cache');
var redis = require('redis');
var through2 = require('through2');
var proxy = require('..');

require('redis-streams');

describe('apiProxy()', function() {
  var server, apiServer;

  beforeEach(function() {
    var self = this;

    this.remoteApi = express();
    this.remoteApi.all('/api/:apikey?', bodyParser.json(), function(req, res) {
      // Just echo the query back in the response
      res.json(_.pick(req, 'query', 'path', 'params', 'headers', 'method', 'body'));
    });

    apiServer = http.createServer(this.remoteApi).listen(5998);

    this.environmentVariables = {};
    this.proxyOptions = {
      envVariableLookup: function(name) {
        return self.environmentVariables[name];
      }
    };

    this.user = {};

    server = express();
    server.use(function(req, res, next) {
      req.user = self.user;

      next();
    });

    server.all('/_p/proxy', function(req, res, next) {
      // Wrap this in a function to allow individual tests
      // the opportunity to modify proxyOptions.
      proxy(self.proxyOptions)(req, res, next);
    });

    server.use(function(err, req, res, next) {
      if (!err.status)
        err.status = 500;

      if (err.status == 500)
        console.error(err.stack);

      res.status(err.status).send(err.message);
    });
  });

  afterEach(function() {
    apiServer.close();
  });

  describe('environment variable tokens', function() {    
    it('replaces environment variable tokens in originUrl query', function(done) {
      this.environmentVariables['API_CLIENT_ID'] = '1234';

      var params = {
        param1: 'foo',
        client_id: '${API_CLIENT_ID}'
      };

      supertest(server)
        .get('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/api?' + querystring.stringify(params)))
        .expect(200)
        .expect(function(res) {
          assert.ok(_.isEqual(res.body.query, {param1: 'foo', client_id: '1234'}));
        })
        .end(done);
    });

    it('substitutes environment variable tokens in pathname', function(done) {
      this.environmentVariables['API_CLIENT_ID'] = '1234';
      
      supertest(server).get('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/api/${API_CLIENT_ID}'))
        .expect(200)
        .expect(function(res) {
          assert.equal(res.body.path, '/api/1234');
          assert.equal(res.body.params.apikey, '1234');
        })
        .end(done);
    });

    it('substitutes user token in headers', function(done) {
      this.user.accessToken = 'abc';

      supertest(server).get('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/api'))
        .set('X-Authorization', 'OAuth ${USER_ACCESS_TOKEN}')
        .expect(200)
        .expect(function(res) {
          assert.equal(res.body.headers.authorization, 'OAuth abc');
        })
        .end(done);
    });

    it('returns 400 response for invalid environment variable', function(done) {
      var url = 'http://localhost:5998/api?' + querystring.stringify({invalid:'${INVALID}'});

      supertest(server)
        .get('/_p/proxy?url=' + encodeURIComponent(url))
        .expect(400)
        .expect(/Invalid environment variable/, done);
    });

    it('returns 400 response for invalid user token', function(done) {
      var url = 'http://localhost:5998/api?' + querystring.stringify({invalid:'${USER_INVALID}'});

      supertest(server)
        .get('/_p/proxy?url=' + encodeURIComponent(url))
        .expect(400)
        .expect(/Invalid user token/, done);
    });

    it('substitutes environment variables in json request body', function(done) {
      this.environmentVariables = {
        SUBSTITUTE_ME: 'actual_value'
      };

      var body = { foo: "${SUBSTITUTE_ME}", blah: "12345", num:5};

      supertest(server).post('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/api'))
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(function(res) {
          assert.equal('POST', res.body.method);
          assert.ok(_.isEqual(_.extend(body, {foo: 'actual_value'}), res.body.body));
        })
        .end(done);
    });
  });

  describe('proxy cache', function() {
    it('writes api response to cache', function(done) {
      // var apiResponse= {name: 'foo'};
      var originUrl = 'http://localhost:5998/api/' + new Date().getTime();
      // var cache = new MemoryCache();
      var cache = redis.createClient();
      this.proxyOptions.cache = cache;

      supertest(server).get('/_p/proxy?url=' + encodeURIComponent(originUrl))
        .expect(200)
        .expect('Content-Type', /application\/json/)
        .expect('Express-Api-Proxy-Cache', 'miss')
        .end(function(err, res) {
          cache.exists(originUrl, function(err, exists) {
            if (err) return done(err);
            assert.ok(exists);
            done();
          });
        });
    });

    it('reads api response from cache', function(done) {
      var apiResponse= {name: 'foo'};
      var originUrl = 'http://localhost:5998/api/' + new Date().getTime();

      var cache = redis.createClient();
      this.proxyOptions.cache = cache;
      cache.setex(originUrl, 1000, JSON.stringify(apiResponse));

      supertest(server).get('/_p/proxy?url=' + encodeURIComponent(originUrl))
        .set('Accept', 'application/json')
        .expect(200)   
        .expect('Content-Type', /^application\/json/)
        .expect('Cache-Control', /^max-age/)
        .expect('Express-Api-Proxy-Cache', 'hit')
        .expect(function(res) {
          assert.ok(_.isEqual(res.body, apiResponse));
        })
        .end(done);
    });
  });

  describe('transforms', function() {
    beforeEach(function() {
      this.remoteApi.get('/test', function(req, res) {
        // Just echo the query back in the response
        res.send('1234');
      });

      this.proxyOptions.transforms = [
        function() {
          return through2(function (chunk, enc, cb) { 
            this.push(chunk + '<<EOF>>');
            cb();
          });
        }
      ];
    });

    it('performs transform', function(done) {      
      supertest(server).get('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/test'))
        .expect(200)
        .expect(function(res) {
          assert.equal(res.text, '1234<<EOF>>');
        })
        .end(done);
    });

    it('transformed response is stored in cache', function(done) {
      var cache = redis.createClient();
      this.proxyOptions.cache = cache;
      var apiUrl = 'http://localhost:5998/test';
      cache.del(apiUrl);

      supertest(server).get('/_p/proxy?url=' + encodeURIComponent(apiUrl))
        .expect(200)
        .expect(function(res) {
          assert.equal(res.text, '1234<<EOF>>');
        })
        .end(function(err, res) {
          if (err) return done(err);

          cache.get(apiUrl, function(err, val) {
            if (err) return done(err);
            assert.equal(val, '1234<<EOF>>');
            done();
          });
        });
    });

    it('works with multiple transforms', function(done) {
      this.proxyOptions.transforms.push(function() {
        return through2(function(chunk, enc, cb) { 
          this.push(chunk + '<<EOF2>>');
          cb();
        });
      });

      supertest(server).get('/_p/proxy?url=' + encodeURIComponent('http://localhost:5998/test'))
        .expect(200)
        .expect(function(res) {
          assert.equal(res.text, '1234<<EOF>><<EOF2>>');
        })
        .end(done);
    });
  });
});