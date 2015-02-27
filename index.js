var querystring = require('querystring'),
  _ = require('lodash'),
  debug = require('debug')('express-api-proxy'),
  crypto = require('crypto'),
  url = require('url'),
  request = require('request'),
  bodyParser = require('body-parser'),
  camelCase = require('camel-case'),
  MemoryCache = require('./lib/memory-cache'),
  through2 = require('through2');
  // transforms = require('../lib/transforms');

require('simple-errors');

// Headers that shouldn't be passed along in the request
var nonPassThroughHeaders = ['cookie', 'host', 'accept-encoding', 'if-none-match', 'if-modified-since', 'content-length'];

// Headers that should be discarded when storing an API response in the cache.
var discardHeadersForCache = ['cache-control', 'expires', 'etag'];

// Headers from the original API response that should be preserved and sent along
// in cached responses.
var headersToPreserveInCache = ['content-type'];

// Max cache duration is 4 hours.
var maxCacheDuration = (60 * 60 * 4);

// Default cache expiry is 5 minutes
var defaultCacheTtl = (60 * 5);

module.exports = function(options) {
  options = _.defaults(options || {}, {
    cacheMaxAge: 5, // default cache duration is 5 minutes
    envTokenStartSymbol: '${',
    envTokenEndSymbol: '}',
    ensureAuthenticated: false,
    cache: null,
    userAgent: 'express-api-proxy',
    cacheHttpHeader: 'Express-Api-Proxy-Cache',
    envVariableLookup: function(name) {
      return process.env[name];
    },
    endpoints: []
  });

  var cacheProvider = null;
  if (options.cache === 'memory') {
    cacheProvider = new MemoryCache();
  }
  else if (_.isObject(options.cache)) {
    cacheProvider = options.cache;
  }

  var interpolate = require('./lib/interpolate')({
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

    try {
      req.ext.apiProxyOptions = buildOptions(req, options, originUrl);
    }
    catch (err) {
      return next(Error.http(400, err.message));
    }

    if (req.ext.apiProxyOptions.ensureAuthenticated === true) {
      // Look for the isAuthenticated function which PassportJS defines. Some other authentication 
      // method can be used, but it needs to define the isAuthenicated function.
      if (_.isFunction(req.isAuthenticated) === false)
        return next(new Error("API endpoint requires authentication but req.isAuthenticated is not a function"));
      else if (req.isAuthenticated() !== true)
        return Error.http(401, "User must be authenticated to invoke this API endpoint");
    }

    // if (req.query.transform) {
    //   transform = transforms[req.query.transform];
    // }

    if (method.toUpperCase() == 'GET' && _.isObject(cacheProvider) === true) {
      debug("checking for cached remote response");
      return proxyViaCache(req, res, next);
    }

    if (method !== 'GET' && req.get('content-type') === 'application/json')
      bodyParser.json()(req, res, makeApiCall);
    else
      makeApiCall();

    // Check if there is a transform specified in the query
    function makeApiCall() {
      var apiRequestOptions;
      try {
        apiRequestOptions = buildApiRequestOptions(req);
      }
      catch (err) {
        return next(Error.http(400, err.message));
      }
       
      debug("proxying api call to " + originUrl.href);

      // TODO: Need to guard against API responses larger than the configured max
      var responseStream = request(apiRequestOptions);

      if (_.isArray(req.ext.apiProxyOptions.transforms))
        responseStream = applyTransforms(responseStream, req.ext.apiProxyOptions.transforms);

      responseStream.pipe(res);
    }
  };

  function pipeToResponseFromCache(req, res, next) {
    debug("getting TTL of cached api response");
    var cacheKey = req.ext.apiProxyOptions.cacheKey;
    cacheProvider.ttl(cacheKey, function(err, ttl) {
      if (err) return next(err);

      // Set a custom header indicating that the response was served from cache.
      res.set(options.cacheHttpHeader, 'hit');

      // The Content-Type of a cached response is based on the value of the Accept header
      res.set('Content-Type', req.header('Accept') || 'text/plain');

      debug("setting max-age to remaining TTL of %s", ttl);
      res.set('Cache-Control', 'max-age=' + ttl);

      debug("piping cached response from cache");

      // TODO: Need to abstract this 
      cacheProvider.readStream(cacheKey).pipe(res);
    });
  }

  function buildApiRequestOptions(req) {
    var requestOptions = {method: req.method};

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
      var value = options.envVariableLookup(key, req);
      if (_.isUndefined(value))
        throw new Error("Invalid environment variable " + key + " is undefined");
      return value;
    };

    // Do environment variable substitution in in the api url
    var url = req.ext.apiProxyOptions.originUrl;
    var interpolatedPath = _.map(url.pathname.split('/'), function(pathPart) {
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

  function proxyViaCache(req, res, next) {
    var cacheKey;
    if (_.isFunction(options.cacheKeyGenerator))
      cacheKey = options.cacheKeyGenerator(req, req.ext.apiProxyOptions.originUrl);
    else
      cacheKey = req.ext.apiProxyOptions.originUrl.href;

    req.ext.apiProxyOptions.cacheKey = cacheKey;

    // Try retrieving from the cache
    debug("checking if key %s exists in cache", cacheKey);
    cacheProvider.exists(cacheKey, function(err, exists) {
      if (err)
        return next(err);

      if (exists === 1) {
        debug('api response exists in cache');
        return pipeToResponseFromCache(req, res, next);
      }

      // TODO: Count the number of entries in the cache. If there are already
      // the max number for this app, then throw an error.

      var apiRequestOptions;
      try {
        apiRequestOptions = buildApiRequestOptions(req);
      }
      catch (err) {
        return next(err);
      }

      debug("response does not exist in cache, making request to remote server %s", apiRequestOptions.url);

      var responseStream = request(apiRequestOptions);
      responseStream.on('response', function(resp) {
        debug("response from remote URL received");
        if (resp.statusCode != 200) {
          debug("non 200 response %s from remote service", resp.statusCode);
          return res.status(resp.statusCode).send(resp.body);
        }

        var headers = _.pick(resp.headers, headersToPreserveInCache);
        var maxAge = req.ext.apiProxyOptions.cacheMaxAge;

        // Set the max-age header to the ttl
        res.set('Cache-Control', 'max-age=' + maxAge);
        res.set('Content-Type', req.header('Accept'));

        res.set(options.cacheHttpHeader, 'miss');

        if (_.isArray(req.ext.apiProxyOptions.transforms))
          responseStream = applyTransforms(responseStream, req.ext.apiProxyOptions.transforms);

        responseStream
          .pipe(cacheProvider.writeThrough(cacheKey, maxAge))
          .pipe(res);
      });
    });
  }

  function applyTransforms(stream, transforms) {
    // Pipe the stream through each transform in sequence
    transforms.forEach(function(transform) {
      stream = stream.pipe(transform());
    });    
    return stream;
  }

  function buildOptions(req, options, originUrl) {
    var proxyOptions = _.extend({}, options, req.app.requiredOptions || {});
    proxyOptions.originUrl = originUrl;

    // Find the endpoint
    if (_.isArray(options.endpoints)) {
      for (var i=0; i<options.endpoints.length; i++) {
        try {
          var patternRegex = new Regex(options.endpoints[i].pattern);
        }
        catch (err) {
          throw new Error("Invalid endpoint pattern " + options.endpoints[i].pattern);
        }

        if (patternRegex.test(apiUrl)) {
          _.extend(proxyOptions, options.endpoints[i]);
          break;
        }
      }
    }

    return proxyOptions;
  }
};