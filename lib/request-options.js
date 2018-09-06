var parseUrl = require('url').parse;
var formatUrl = require('url').format;
var _ = require('lodash');
var querystring = require('querystring');
var pathToRegexp = require('path-to-regexp');

var BLOCK_HEADERS = ['host', 'cookie'];
var CACHE_HEADERS = ['if-none-match', 'if-modified-since'];
// var PASSTHROUGH_HEADERS = ['authorization', 'accepts', 'if-none-match', 'if-modified-since'];

// Returns an options object that can be fed to the request module.
module.exports = function(req, options, limits) {
  var requestOptions = _.pick(options,
    'method', 'timeout', 'maxRedirects', 'proxy', 'followRedirect');

  // If an explicit method was not specified on the options, then use the
  // method of the inbound request to the proxy.
  if (!requestOptions.method) {
    requestOptions.method = req.method;
  }

  // Ensure that passed in options for timeout and maxRedirects cannot exceed
  // the platform imposed limits (if defined).
  if (_.isObject(limits) === true) {
    if (_.isNumber(limits.timeout)) {
      if (_.isNumber(options.timeout) === false || options.timeout > limits.timeout) {
        requestOptions.timeout = limits.timeout;
      }
    }
    if (_.isNumber(limits.maxRedirects)) {
      if (_.isNumber(options.maxRedirects) === false ||
        options.maxRedirects > limits.maxRedirects) {
        requestOptions.maxRedirects = limits.maxRedirects;
      }
    }
  }

  // Extend the incoming query with any additional parameters specified in the options
  if (_.isObject(options.query)) {
    _.extend(req.query, options.query);
  }

  var parsedUrl = parseUrl(options.url);

  // Compile the path expression of the originUrl
  var compiledPath = pathToRegexp.compile(parsedUrl.path);

  // Need to decode the path as splat params like 'path/*' will result in an encoded forward slash
  // like http://someapi.com/v1/path1%2Fpath2.
  var pathname = decodeURIComponent(compiledPath(_.extend({}, req.params, options.params || {})));

  // Substitute the actual values using both those from the incoming
  // params as well as those configured in the options. Values in the
  // options take precedence.

  // If options.originalQuery is true, ignore the above and just
  // use the original raw querystring as the search

  requestOptions.url = formatUrl(_.extend({
    protocol: parsedUrl.protocol,
    host: parsedUrl.host,
    pathname: pathname
  }, options.originalQuery ?
    {search: req.url.replace(/^.+\?/, '')} :
    {query: _.extend({}, querystring.parse(parsedUrl.query), req.query, options.query)}
  ));

  requestOptions.headers = {};

  // Passthrough headers
  _.each(req.headers, function(value, key) {
    if (shouldPassthroughHeader(key)) {
      requestOptions.headers[key] = value;
    }
  });

  // Forward the IP of the originating request. This is de-facto proxy behavior.
  if (req.ip) {
    requestOptions.headers['x-forwarded-for'] = req.ip;
  }

  if (req.headers && req.headers.host) {
    var hostSplit = req.headers.host.split(':');
    var host = hostSplit[0];
    var port = hostSplit[1];

    if (port) {
      requestOptions.headers['x-forwarded-port'] = port;
    }

    requestOptions.headers['x-forwarded-host'] = host;
  }

  requestOptions.headers['x-forwarded-proto'] = req.secure ? 'https' : 'http';

  // Default to accepting gzip encoding
  if (!requestOptions.headers['accept-encoding']) {
    requestOptions.headers['accept-encoding'] = 'gzip';
  }

  // Inject additional headers from the options
  if (_.isObject(options.headers)) {
    _.extend(requestOptions.headers, options.headers);
  }

  // Override the user-agent
  if (options.userAgent) {
    requestOptions.headers['user-agent'] = options.userAgent;
  }

  return requestOptions;

  function shouldPassthroughHeader(header) {
    if (_.includes(BLOCK_HEADERS, header) === true) return false;
    if (options.cache && _.includes(CACHE_HEADERS, header) === true) return false;

    return true;
  }
};
