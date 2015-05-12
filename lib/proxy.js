var querystring = require('querystring'),
  _ = require('lodash'),
  debug = require('debug')('express-api-proxy'),
  crypto = require('crypto'),
  url = require('url'),
  through2 = require('through2'),
  request = require('request'),
  bodyParser = require('body-parser'),
  pathToRegexp = require('path-to-regexp'),
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
    ensureAuthenticated: false,
    cache: null,
    cacheMaxAge: 0,
    userAgent: 'express-api-proxy',
    cacheHttpHeader: 'Express-Api-Proxy-Cache',
    cacheKeyFn: null,
    timeout: 5000,
    maxRedirects: 5
  });

  return function(req, res, next) {
    var method = req.method.toUpperCase();

    if (!req.query.api)
      return next(new Error("No api parameter passed to the proxy"));

    // Lookup the api in the options
    var apiConfig = options.apis[req.query.api];
    if (!apiConfig)
      return next(new Error("No api configured named " + req.query.api));

    var originUrl = parseUrl(apiConfig.baseUrl);
    if (req.query.path)
      originUrl.pathname = originUrl;

    if (!req.ext)
      req.ext = {};

    var proxyOptions;
    try {
      proxyOptions = req.ext.apiProxyOptions = buildOptions(req);
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

    if (method.toUpperCase() == 'GET' && _.isObject(proxyOptions.cache) === true && proxyOptions.cacheMaxAge > 0) {
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
        if (_.isArray(proxyOptions.transforms))
          apiRequest = applyTransforms(apiRequest, proxyOptions.transforms, resp.headers);

        // Need to explicitly passthrough headers, otherwise they will get lost
        // in the transforms pipe.
        for (var key in resp.headers) {
          if (_.contains(discardApiResponseHeaders, key) === false)
            res.set(key, resp.headers[key]);
        }

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

      debug('api response exists in cache=%s', exists);
      if (exists) {
        debug('api response exists in cache');
        return pipeToResponseFromCache(req, res, next);
      }

      debug('key %s not in cache', cacheKey);

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
          // Store the headers as a separate cache entry
          var headersToKeep = _.pick(resp.headers, headersToPreserveInCache);

          if (_.isArray(proxyOptions.transforms))
            apiRequest = applyTransforms(apiRequest, proxyOptions.transforms, headersToKeep);

          // This needs to happen after the call to applyTransforms so transforms
          // have the opportunity to modify the contentType.
          for (var key in headersToKeep) {
            res.set(key, resp.headers[key]);
          }

          // Store the headers as a separate cache entry
          if (_.isEmpty(headersToKeep) === false)
            cache.setex(cacheKey + '__headers', maxAge, JSON.stringify(headersToKeep));

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

        if (_.isFunction(cache.readStream))
          return cache.readStream(cacheKey).pipe(res);

        cache.get(cacheKey, function(err, data) {
          if (err) return next(err);
          res.end(data);
        });
      });
    });
  }

  function buildApiRequestOptions(req) {
    var requestOptions = {
      method: req.method,
      maxRedirects: req.ext.apiProxyOptions.maxRedirects,
      timeout: req.ext.apiProxyOptions.timeout
    };

    if (!req.ext.apiProxyOptions.originUrl.query)
      req.ext.apiProxyOptions.originUrl.query = {};

    // Inject additional query parameters
    if (_.isObject(apiConfig.query))
      _.extend(req.ext.apiProxyOptions.originUrl.query, apiConfig.query);

    requestOptions.url = url.format(req.ext.apiProxyOptions.originUrl);
    requestOptions.headers = {};

    // Passthrough headers
    _.each(req.headers, function(value, key) {
      if (_.contains(nonPassThroughHeaders, key) === false)
        requestOptions.headers[key] = value;
    });

    // Inject additional headers from the apiConfig
    if (_.isObject(apiConfig.headers))
      _.extend(requestOptions.headers, apiConfig.headers));

    // If there is a JSON body, substitute any placeholders
    if (_.isObject(req.body)) {
      if (_.isObject(apiConfig.body))
        _.extend(req.body, apiConfig.body);

      requestOptions.body = JSON.stringify(req.body);
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

  function applyTransforms(stream, transforms, headers) {
    // Pipe the stream through each transform in sequence
    transforms.forEach(function(transform) {
      if (transform.contentType)
        headers['Content-Type'] = transform.contentType;

      stream = stream.pipe(transform);
    });

    return stream;
  }

  // Build the effective options by taking the base options for the api
  // and overlaying values at the path level.
  function buildOptions(req, apiConfig) {
    var proxyOptions = _.extend({}, apiConfig);

    var originUrl = parseUrl(apiConfig.baseUrl);
    if (req.query.path)
      originUrl.pathname = req.query.path;

    proxyOptions.originUrl = originUrl;

    // Loop over the paths and for any matches override the options
    if (_.isArray(apiConfig.paths)) {
      _.forOwn(apiConfig.paths, function(value, pattern) {
        var re = pathToRegexp(pattern, []);
        if (re.exec(req.query.path))
          _.extend(proxyOptions, value);
      });
    }

    if (proxyOptions.transform)
      proxyOptions.transforms = [proxyOptions.transform];

    if (_.isObject(req.app.settings.platformLimits)) {
      var platformLimits = req.app.settings.platformLimits;

      // Verify that none of the options exceed the platform enforced values.
      if (_.isNumber(platformLimits.maxNetworkTimeout)) {
        if (proxyOptions.timeout > platformLimits.maxNetworkTimeout)
          throw new Error("The configured timeout of %s exceeds the platform maxNetworkTimeout of %s", proxyOptions.timeout, platformLimits.maxNetworkTimeout);
      }

      if (_.isNumber(platformLimits.cacheMaxAge)) {
        if (proxyOptions.cacheMaxAge > platformLimits.cacheMaxAge)
          throw new Error("The configured cacheMaxAge of %s exceeds the platform limit of %s", proxyOptions.cacheMaxAge, platformLimits.cacheMaxAge);
      }
    }

    return proxyOptions;
  }
};
