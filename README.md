# express-api-proxy

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![Build Status][travis-image]][travis-url]
[![Test Coverage][coveralls-image]][coveralls-url]

High performance streaming API reverse proxy for [Express](http://expressjs.com). Supports caching, environment variable substitution of sensitive keys, authentication, and response transformations.

## Usage

```js
var redis = require('redis');
var apiProxy = require('express-api-proxy');

require('redis-streams');

app.all('/proxy', apiProxy({
	cache: redis.createClient(),
	// This is authenticated with the app, not the remote API
	ensureAuthenticated: false, 
	endpoints: [
		{
			pattern: '/secure',
			ensureAuthenticated: true,
			cache: false
		}
	]
});
```

#### Client Code

```js

var params = {
	access_key: '${SOMEAPI_ACCESS_KEY}',
	access_secret: '${SOMEAPI_ACCESS_SECRET}'
};

var apiUrl = 'http://someapi.com/api/secure?' + $.param(params);

$.ajax({
	url: '/proxy?url=' + encodeURIComponent(apiUrl),
	headers: {
		Accept: 'application/json'
	},
	statusCode: {
	   	200: function(data) {
	   		console.log(data);
	   	},
		401: function() {
		  console.log("unauthorized api call");
		}
	}
});
```

### Options
__`cache`__

Cache object that conforms to the [node_redis](https://www.npmjs.com/package/redis) API. See [Cache section](#caching) below for more details.

__`cacheMaxAge`__

The duration to cache the API response. If an API response is returned from the cache, a `max-age` http header will be included with the remaining TTL.

__`envTokenStartSymbol`__

The start symbol that represents an environment variable token. Defaults to `${`.

__`envTokenEndSymbol`__

The symbol representing the end of an environment variable token. Defaults to `}`.

__`ensureAuthenticated`__

If true, requires that `req.ext.isAuthenticated` is true. Otherwise a 401 error status is immedietely returned. Note that this is not referring to authentication with the remote app, but rather the Express app where the proxy route is mounted. Generally middleware earlier in the request lifecycle would be responsible for setting `req.ext.isAuthenticated`. The `ext` is shorthand for extended; it's a simple convention to avoid stuffing a bunch of extra stuff directly onto the built-in Express request object.

__`userAgent`__

The user agent string passed as a header in the http call to the remote API. Defaults to `"express-api-proxy"`.

__`cacheHttpHeader`__

Name of the http header returned in the proxy response with the value `"hit"` or `"miss"`. Defaults to `"Express-Api-Proxy-Cache"`.

__`envVariableLookup`__

In the event that you have custom logic for reading an environment variable (like when using an alternative implementation to `process.env`), you can pass a function that accepts two parameters: `req` and `key` that returns the value. If omitted, `process.env[key]` is used.

__`endpoints`__

Allows overriding any of the above options for a specific remote API endpoint based on a RegExp pattern match.

```
endpoints: [
	{
  		pattern: /api.instagram.com/,
  		cacheMaxAge: 4000
  	}
]
```

### Environment Variables

### Caching 

If using node_redis itself, performance can be further optimized by requiring the [redis-streams](https://www.npmjs.com/package/redis-streams) package which adds two functions to the `RedisClient` type: `readStream` and `writeThrough`. These enhancements allow piping the remote API response directly to the http response, avoiding the overhead of buffering the entire API response in memory. 


### Authorization

### Transforms


[npm-image]: https://img.shields.io/npm/v/express-api-proxy.svg?style=flat
[npm-url]: https://npmjs.org/package/express-api-proxy
[travis-image]: https://img.shields.io/travis/4front/express-api-proxy.svg?style=flat
[travis-url]: https://travis-ci.org/4front/apphost
[coveralls-image]: https://img.shields.io/coveralls/4front/express-api-proxy.svg?style=flat
[coveralls-url]: https://coveralls.io/r/4front/express-api-proxy?branch=master
[downloads-image]: https://img.shields.io/npm/dm/express-api-proxy.svg?style=flat
[downloads-url]: https://npmjs.org/package/express-api-proxy