var assert = require('assert');
var sinon = require('sinon');
var parseUrl = require('url').parse;
var formatUrl = require('url').format;
var requestOptions = require('../lib/request-options');

require('dash-assert');

describe('requestOptions', function() {
  it('substitutes and extends query params', function() {
    var req = {
      method: 'get',
      query: {
        id: 5,
        apikey: 'should_be_overridden'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com/foo',
      query: {
        apikey: '123'
      }
    };

    var opts = requestOptions(req, endpointOptions);
    assert.ok(sinon.match(opts, {
      url: parseUrl(endpointOptions.url),
      qs: {apikey: '123', id: 5},
      method: 'get'
    }));
  });

  it('substitutes in path', function() {
    var req = {
      method: 'get',
      params: {
        resource: 'foo',
        id: '123',
        apikey: 'should_be_overridden'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com/:apikey/:resource/:id',
      params: {
        apikey: 'secret'
      }
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(formatUrl(opts.url), 'http://someapi.com/secret/foo/123');
  });

  it('substitutes optional parameters', function(done) {
    var req = {
      method: 'get',
      params: {
        resource: 'foo',
        id: '123',
        apikey: 'should_be_overridden'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com/:apikey/:resource/:id?',
      params: {
        apikey: 'secret'
      }
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(formatUrl(opts.url), 'http://someapi.com/secret/foo/123');

    // Now clear out the id and make sure it is not passed
    req.params.resource = 'bar';
    req.params.id = null;
    opts = requestOptions(req, endpointOptions);
    assert.equal(formatUrl(opts.url), 'http://someapi.com/secret/bar');

    done();
  });

  it('builds origin URL with wildcard parameter', function(done) {
    var req = {
      method: 'get',
      params: {
        0: 'path1/path2',
        version: 'v1'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com/:version/*'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.deepEqual(opts.url, 'http://someapi.com/v1/path1/path2');

    done();
  });

  it('wildcard route with no params', function(done) {
    var req = {
      method: 'post',
      params: {
        0: 'v1/token'
      }
    };

    var endpointOptions = {
      url: 'http://domain.com/api/auth/*'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.deepEqual(opts.url, 'http://domain.com/api/auth/v1/token');

    done();
  });

  it('appends headers', function() {
    var req = {
      method: 'get',
      headers: {
        header1: 'a',
        header2: '2'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      headers: {
        header1: '1'
      }
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.headers.header1, '1');
    assert.equal(opts.headers.header2, '2');
  });

  it('does not passthrough blocked headers', function() {
    var req = {
      method: 'get',
      headers: {
        cookie: 'should_not_passthrough',
        'if-none-match': '345345',
        header1: '1'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.isUndefined(opts.headers.cookie);
  });

  it('does not passthrough certain headers when response to be cached', function() {
    var req = {
      method: 'get',
      headers: {
        cookie: 'should_not_passthrough',
        'if-none-match': 'should_not_passthrough',
        'if-modified-since': 'should_not_passthrough',
        header1: '1'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      cache: {}
    };

    var opts = requestOptions(req, endpointOptions);
    assert.isUndefined(opts.headers['if-none-match']);
    assert.isUndefined(opts.headers['if-modified-since']);
    assert.equal(opts.headers.header1, '1');
  });

  it('default headers appended', function() {
    var req = {
      method: 'get',
      ip: '127.0.0.1',
      secure: true
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      cache: {}
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.headers['x-forwarded-for'], req.ip);
    assert.equal(opts.headers['accept-encoding'], 'gzip');
    assert.equal(opts.headers['x-forwarded-proto'], 'https');

    req.secure = false;
    opts = requestOptions(req, endpointOptions);

    assert.equal(opts.headers['x-forwarded-proto'], 'http');
  });

  it('default headers appended host and port', function() {
    var req = {
      headers: {
        host: 'localhost:8080'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      cache: {}
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.headers['x-forwarded-host'], 'localhost');
    assert.equal(opts.headers['x-forwarded-port'], '8080');
  });

  it('cannot exceed limit options', function() {
    var req = {
      method: 'get',
      headers: {
        cookie: 'should_not_passthrough',
        'if-none-match': 'should_not_passthrough',
        'if-modified-since': 'should_not_passthrough',
        header1: '1'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      timeout: 30,
      maxRedirects: 5
    };

    var limits = {
      timeout: 5,
      maxRedirects: 3
    };

    var opts = requestOptions(req, endpointOptions, limits);
    assert.equal(opts.timeout, limits.timeout);
    assert.equal(opts.maxRedirects, limits.maxRedirects);
  });

  it('uses method from the req', function() {
    var req = {
      method: 'post'
    };

    var endpointOptions = {
      url: 'http://someapi.com'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.method, req.method);
  });

  it('uses method from the options', function() {
    var req = {
      method: 'post'
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      method: 'put'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.method, endpointOptions.method);
  });

  it('allows followRedirect from the options', function() {
    var req = {
      followRedirect: undefined,
      method: 'get'
    };

    var endpointOptions = {
      url: 'http://someapi.com',
      followRedirect: true
    };

    var opts = requestOptions(req, endpointOptions);
    assert.equal(opts.followRedirect, endpointOptions.followRedirect);

    endpointOptions.followRedirect = false;
    opts = requestOptions(req, endpointOptions);
    assert.equal(opts.followRedirect, endpointOptions.followRedirect);
  });
});
