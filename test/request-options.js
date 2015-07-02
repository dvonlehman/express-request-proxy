var assert = require('assert');
var supertest = require('supertest');
var _ = require('lodash');
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
    assert.deepEqual(opts.headers, {header1: '1', header2: '2'});
  });

  it('does not passthrough certain headers', function() {
    var req = {
      method: 'get',
      headers: {
        'cookie': 'should_not_passthrough',
        'header1': '1'
      }
    };

    var endpointOptions = {
      url: 'http://someapi.com'
    };

    var opts = requestOptions(req, endpointOptions);
    assert.deepEqual(opts.headers, {header1: '1'});
  });
});
