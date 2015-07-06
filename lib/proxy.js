var querystring = require('querystring'),
  _ = require('lodash'),
  debug = require('debug')('express-api-proxy'),
  crypto = require('crypto'),
  parseUrl = require('url').parse,
  formatUrl = require('url').format,
  urljoin = require('url-join'),
  through2 = require('through2'),
  request = require('request'),
  bodyParser = require('body-parser'),
  requestOptions = require('./request-options'),
  pathToRegexp = require('path-to-regexp');

require('simple-errors');

var discardApiResponseHeaders = ['set-cookie', 'content-length'];

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

    // Allow for a global cache to be specified on the parent Express app
    if (!options.cache)
      options.cache = req.app.settings.cache;

    if (!req.ext)
      req.ext = {};

    req.ext.apiProxyOptions = options;

    if (options.ensureAuthenticated === true) {
      // Look for the isAuthenticated function which PassportJS defines. Some other authentication
      // method can be used, but it needs to define the isAuthenicated function.
      if (req.ext.isAuthenticated !== true) {
        debug("user is not authenticated");
        return next(Error.http(401, "User must be authenticated to invoke this API endpoint"));
      }
    }

    if (method.toUpperCase() == 'GET' && options.cache && options.cacheMaxAge > 0) {
      if (!options.cache)
        return next(new Error("No cache provider configured"));

      return proxyViaCache(req, res, next);
    }

    if (req.get('Content-Type') === 'application/json') {
      bodyParser.json()(req, res, function() {
        makeApiCall(req, res, next);
      });
    }
    else if (req.get('Content-Type') === 'application/x-www-form-urlencoded') {
      bodyParser.urlencoded()(req, res, function() {
        makeApiCall(req, res, next);
      });
    }
    else
      makeApiCall(req, res, next);
  };

  function makeApiCall(req, res, next) {
    var proxyOptions = req.ext.apiProxyOptions;

    var apiRequestOptions;
    try {
      apiRequestOptions = requestOptions(req, options);
    }
    catch (err) {
      debug("error building request options %s", err.stack);
      return next(Error.http(400, err.message));
    }

    debug("making API call to %s", apiRequestOptions.url);
    debugger;
    var apiRequest = request(apiRequestOptions);
    apiRequest.on('error', function(err) {
      unhandledApiError(err, next);
    });

    // Defer piping the response until the response event so we can
    // check the status code.
    apiRequest.on('response', function(resp) {
      // Do not attempt to apply transforms to non-200 responses
      if (resp.statusCode !== 200) {
        return apiRequest.pipe(res);
      }

      if (_.isArray(options.transforms))
        apiRequest = applyTransforms(apiRequest, options.transforms, resp.headers);

      // Need to explicitly passthrough headers, otherwise they will get lost
      // in the transforms pipe.
      for (var key in resp.headers) {
        if (_.contains(discardApiResponseHeaders, key) === false)
          res.set(key, resp.headers[key]);
      }

      apiRequest.pipe(res);
    });
  }

  function proxyViaCache(req, res, next) {
    var proxyOptions = req.ext.apiProxyOptions;
    var cacheKey;

    if (_.isFunction(options.cacheKeyFn))
      cacheKey = options.cacheKeyFn(req, proxyOptions.originUrl);
    else
      cacheKey = proxyOptions.url;

    proxyOptions.cacheKey = cacheKey;

    // Try retrieving from the cache
    debug("checking if key %s exists in cache", cacheKey);
    options.cache.exists(cacheKey, function(err, exists) {
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
        apiRequestOptions = requestOptions(req, options);
      }
      catch (err) {
        debug("error building api request options: %s", err.stack);
        return next(Error.http(400, err.message));
      }

      debug("making api call to %s", apiRequestOptions.url);
      var apiRequest = request(apiRequestOptions);
      apiRequest.on('error', function(err) {
        debug("error making api call");
        unhandledApiError(err, next);
      });

      // Defer piping the response until the response event so we can
      // check the status code.
      apiRequest.on('response', function(resp) {
        // Don't cache non-200 responses. Just pipe the response right on out.
        if (resp.statusCode !== 200) {
          return apiRequest.pipe(res);
        }

        // Store the headers as a separate cache entry
        var headersToKeep = _.pick(resp.headers, headersToPreserveInCache);

        if (_.isArray(proxyOptions.transforms))
          apiRequest = applyTransforms(apiRequest, proxyOptions.transforms, headersToKeep);

        // This needs to happen after the call to applyTransforms so transforms
        // have the opportunity to modify the contentType.
        for (var key in headersToKeep) {
          debug("setting header %s to %s", key, resp.headers[key]);
          res.set(key, resp.headers[key]);
        }

        // Store the headers as a separate cache entry
        if (_.isEmpty(headersToKeep) === false) {
          debug("writing original headers to cache");
          debugger;
          options.cache.setex(cacheKey + '__headers', maxAge, JSON.stringify(headersToKeep));
        }

        debug("cache api response for %s seconds", maxAge);
        debugger;
        apiRequest
          .pipe(options.cache.writeThrough(cacheKey, maxAge))
          .pipe(res);
      });
    });
  }

  function pipeToResponseFromCache(req, res, next) {
    debug("getting TTL of cached api response");
    var cache = req.ext.apiProxyOptions.cache;
    var cacheKey = req.ext.apiProxyOptions.cacheKey;

    options.cache.ttl(cacheKey, function(err, ttl) {
      if (err) return next(err);

      options.cache.get(cacheKey + '__headers', function(err, headers) {
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
          return options.cache.readStream(cacheKey).pipe(res);

        options.cache.get(cacheKey, function(err, data) {
          if (err) return next(err);
          res.end(data);
        });
      });
    });
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
      debugger;
      debug("applying transform %s", transform.name)
      if (transform.contentType)
        headers['Content-Type'] = transform.contentType;

      stream = stream.pipe(transform.transform);
    });

    return stream;
  }
};
