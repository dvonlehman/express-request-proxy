var querystring = require('querystring'),
  _ = require('lodash'),
  debug = require('debug')('express-api-proxy'),
  crypto = require('crypto'),
  url = require('url'),
  through2 = require('through2'),
  request = require('request'),
  bodyParser = require('body-parser'),
  camelCase = require('camel-case');
  
require('simple-errors');

// Headers that shouldn't be passed along in the request
var nonPassThroughHeaders = ['cookie', 'host', 'accept-encoding', 'if-none-match', 'if-modified-since', 'content-length'];

var discardApiResponseHeaders = ['set-cookie', 'content-length'];

// Headers that should be discarded when storing an API response in the cache.
var discardHeadersForCache = ['cache-control', 'expires', 'etag', 'last-modified', 'content-length', 'connection', 'set-cookie', 'date'];

// Headers from the original API response that should be preserved and sent along
// in cached responses.
var headersToPreserveInCache = ['content-type'];

module.exports = function(options) {
  options = _.defaults(options || {}, {
    cacheMaxAge: 5 * 60, // default cache duration is 5 minutes
    envTokenStartSymbol: '${',
    envTokenEndSymbol: '}',
    ensureAuthenticated: false,
    cache: null,
    userAgent: 'express-api-proxy',
    cacheHttpHeader: 'Express-Api-Proxy-Cache',
    cacheKeyFn: null,
    envVariableFn: null,
    timeout: 5000,
    maxRedirects: 5,
    endpoints: []
  });

  var interpolate = require('./interpolate')({
    leftDelimiter: options.envTokenStartSymbol,
    rightDelimiter: options.envTokenEndSymbol
  });

  return function(req, res, next) {
    var method = req.method.toUpperCase();

    if (!req.query.url)
      return next(new Error("No url parameter passed to the proxy"));

    var originUrl = url.parse(req.query.url, true);
    if (!_.isObject(originUrl))
      return next(new Error("The url parameter is not valid"));

    if (!req.ext)
      req.ext = {};

    var proxyOptions;
    try {
      proxyOptions = req.ext.apiProxyOptions = buildOptions(req, options, originUrl);
    }
    catch (err) {
      return next(Error.http(400, err.message));
    }

    if (proxyOptions.ensureAuthenticated === true) {
      // Look for the isAuthenticated function which PassportJS defines. Some other authentication 
      // method can be used, but it needs to define the isAuthenicated function.
      if (req.ext.isAuthenticated !== true)
        return next(Error.http(401, "User must be authenticated to invoke this API endpoint"));
    }

    if (method.toUpperCase() == 'GET' && _.isObject(proxyOptions.cache) === true) {
      debug("checking for cached remote response");
      return proxyViaCache(req, res, next);
    }

    if (req.is('json') && req.method !== 'get')
      bodyParser.json()(req, res, function() {
        makeApiCall(req, res, next);
      });
    else
      makeApiCall(req, res, next);
  };

  function makeApiCall(req, res, next) {
    var proxyOptions = req.ext.apiProxyOptions;

    var apiRequestOptions;
    try {
      apiRequestOptions = buildApiRequestOptions(req);
    }
    catch (err) {
      return next(Error.http(400, err.message));
    }

    var apiRequest = request(apiRequestOptions);
    apiRequest.on('error', function(err) {
      unhandledApiError(err, next);
    });  

    // Defer piping the response until the response event so we can 
    // check the status code.
    apiRequest.on('response', function(resp) {
      if (resp.statusCode >= 400) {
        apiErrorResponse(resp.statusCode, apiRequest, next);
      }
      else {
        // Need to explicitly passthrough headers, otherwise they will get lost
        // in the transforms pipe.
        for (key in resp.headers) {
          if (_.contains(discardApiResponseHeaders, key) === false)
            res.set(key, resp.headers[key]);
        }

        if (_.isArray(proxyOptions.transforms))
          apiRequest = applyTransforms(res, apiRequest, proxyOptions.transforms);

        apiRequest.pipe(res);
      }
    });
  }

  function proxyViaCache(req, res, next) {
    var proxyOptions = req.ext.apiProxyOptions;
    var cacheKey;

    if (_.isFunction(options.cacheKeyFn))
      cacheKey = options.cacheKeyFn(req, proxyOptions.originUrl);
    else
      cacheKey = proxyOptions.originUrl.href;

    proxyOptions.cacheKey = cacheKey;
    var cache = proxyOptions.cache;

    // Try retrieving from the cache
    debug("checking if key %s exists in cache", cacheKey);
    cache.exists(cacheKey, function(err, exists) {
      if (err)
        return next(err);

      if (exists === 1) {
        debug('api response exists in cache');
        return pipeToResponseFromCache(req, res, next);
      }

      var maxAge = proxyOptions.cacheMaxAge;
      res.set('Cache-Control', 'max-age=' + maxAge);
      res.set(options.cacheHttpHeader, 'miss');

      var apiRequestOptions;
      try {
        apiRequestOptions = buildApiRequestOptions(req);
      }
      catch (err) {
        return next(Error.http(400, err.message));
      }

      var apiRequest = request(apiRequestOptions);
      apiRequest.on('error', function(err) {
        unhandledApiError(err, next);
      });

      // Defer piping the response until the response event so we can 
      // check the status code.
      apiRequest.on('response', function(resp) {
        if (resp.statusCode >= 400) {
          apiErrorResponse(resp.statusCode, apiRequest, next);
        }
        else {
          var headersToKeep = _.omit(resp.headers, discardHeadersForCache);
          for (key in headersToKeep) {
            res.set(key, resp.headers[key]);
          }

          // Store the headers as a separate cache entry
          if (_.isEmpty(headersToKeep) === false)
            cache.setex(cacheKey + '__headers', maxAge, JSON.stringify(headersToKeep));

          if (_.isArray(proxyOptions.transforms))
            apiRequest = applyTransforms(res, apiRequest, proxyOptions.transforms);

          apiRequest
            .pipe(cache.writeThrough(cacheKey, maxAge))
            .pipe(res);
        }
      });
    });
  }

  function pipeToResponseFromCache(req, res, next) {
    debug("getting TTL of cached api response");
    var cache = req.ext.apiProxyOptions.cache;
    var cacheKey = req.ext.apiProxyOptions.cacheKey;

    cache.ttl(cacheKey, function(err, ttl) {
      if (err) return next(err);

      cache.get(cacheKey + '__headers', function(err, headers) {
        // restore the headers
        if (headers) {
          try { 
            headers = JSON.parse(headers);
          }
          catch (err) {
            debug("can't parse headers as json");
          }

          if (_.isObject(headers)) {
            for (var key in headers)
              res.set(key, headers[key]);
          }
        }

        // Set a custom header indicating that the response was served from cache.
        res.set(options.cacheHttpHeader, 'hit');

        debug("setting max-age to remaining TTL of %s", ttl);
        res.set('Cache-Control', 'max-age=' + ttl);

        debug("piping cached response from cache");

        cache.readStream(cacheKey).pipe(res);
      });
    });
  }

  function buildApiRequestOptions(req) {
    var requestOptions = {
      method: req.method, 
      maxRedirects: req.ext.apiProxyOptions.maxRedirects,
      timeout: req.ext.apiProxyOptions.timeout
    };

    var valueForToken = function(key) {
      if (key.substr(0, 5) === 'USER_') {
        if (_.isObject(req.user) === false)
          throw new Error("Invalid environment token " + key + ". No req.user object");

        // convert the key to camelCase
        var userProperty = camelCase(key.substr(5));

        var userPropValue = req.user[userProperty];
        if (_.isUndefined(userPropValue))
          throw new Error("Invalid user token " + key + ". No matching property on req.user.");

        return userPropValue;
      }

      // Check for an environment variable with the specified name
      var value;
      if (_.isFunction(options.envVariableFn))
        value = options.envVariableFn(req, key);
      else
        value = process.env[key];

      if (_.isUndefined(value) || _.isNull(value))
        throw new Error("Invalid environment variable " + key + " is not defined");
      return value;
    };

    // Do environment variable substitution in in the api url
    var url = req.ext.apiProxyOptions.originUrl;
    var interpolatedPath = _.map(decodeURIComponent(url.pathname).split('/'), function(pathPart) {
        return interpolate(pathPart, valueForToken);
      }).join('/');

    requestOptions.url = url.protocol + '//' + url.host + interpolatedPath;
    if (url.search.length > 1) {
      var query = querystring.parse(url.search.substr(1));
      var interpolatedQuery = querystring.stringify(interpolate(query, valueForToken));
      requestOptions.url += '?' + interpolatedQuery;
    }

    // Do substitution in the headers
    requestOptions.headers = {};
    _.each(req.headers, function(value, key) {
      // Special handling of the X-Authorization header. Pass it through as simply 'Authorization'
      if (key === 'x-authorization')
        requestOptions.headers['authorization'] = interpolate(value, valueForToken);
      else if (_.contains(nonPassThroughHeaders, key) === false)
        requestOptions.headers[key] = interpolate(value, valueForToken);
    });

    // If there is a JSON body, substitute any placeholders
    if (_.isObject(req.body)) {
      var body = interpolate(req.body, valueForToken);
      requestOptions.body = JSON.stringify(body);
      requestOptions.headers['content-type'] = 'application/json';
    }

    // Override the user-agent
    requestOptions.headers['user-agent'] = options.userAgent;

    return requestOptions;
  }

  function unhandledApiError(err, next) {
    debug("unhandled API error: %s", err.code);
    if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT')
      return next(Error.http(408, 'API call timed out'));
    else
      return next(err);
  }

  function apiErrorResponse(statusCode, apiRequest, next) {
    var error = '';
    apiRequest.pipe(through2(function(chunk, enc, cb) {
      error += chunk;  
      cb();
    }, function() {
      return next(Error.http(statusCode, error));
    }));
  }

  function applyTransforms(res, stream, transforms) {
    // Pipe the stream through each transform in sequence
    transforms.forEach(function(transform) {
      if (transform.contentType)
        res.set('Content-Type', transform.contentType);

      stream = stream.pipe(transform());
    });

    return stream;
  }

  function buildOptions(req, options, originUrl) {
    var proxyOptions = _.extend({}, options);

    if (_.isObject(req.app.platformLimits)) {
      // Verify that none of the options exceed the platform enforced values.
      _.extend(proxyOptions, req.app.platformLimits);
      
      if (_.isNumber(req.app.platformLimits.maxNetworkTimeout)) {
        if (proxyOptions.timeout > req.app.platformLimits.maxNetworkTimeout)
          throw new Error("The configured timeout of %s exceeds the platform maxNetworkTimeout of %s", proxyOptions.timeout, req.app.platformLimits.maxNetworkTimeout);
      }

      if (_.isNumber(req.app.platformLimits.cacheMaxAge)) {
        if (proxyOptions.cacheMaxAge > req.app.platformLimits.cacheMaxAge)
          throw new Error("The configured cacheMaxAge of %s exceeds the platform limit of %s", proxyOptions.cacheMaxAge, req.app.platformLimits.cacheMaxAge);
      }
    }

    proxyOptions.originUrl = originUrl;

    if (proxyOptions.transform)
      proxyOptions.transforms = [proxyOptions.transforms];

    // Find the endpoint
    if (_.isArray(options.endpoints)) {
      for (var i=0; i<options.endpoints.length; i++) {
        var patternRegex = new RegExp(options.endpoints[i].pattern);

        if (patternRegex.test(originUrl.href)) {
          // Override the default options with the endpoint specific options.
          _.extend(proxyOptions, options.endpoints[i]);
          break;
        }
      }
    }

    return proxyOptions;
  }
};