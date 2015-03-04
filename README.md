# express-api-proxy

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![Build Status][travis-image]][travis-url]
[![Test Coverage][coveralls-image]][coveralls-url]

High performance streaming API reverse proxy for [Express](http://expressjs.com). Supports caching, environment variable substitution of sensitive keys, authentication, and response transformations.

## Usage

~~~js
var redis = require('redis');
var apiProxy = require('express-api-proxy');

require('redis-streams')(redis);

app.all('/proxy', apiProxy({
	cache: redis.createClient(),
	ensureAuthenticated: false, 
	endpoints: [
		{
			pattern: /\public/,
			maxCacheAge: 60 * 10 // cache responses for 10 minutes
		},
		{
			pattern: /\/secure/,
			ensureAuthenticated: true,
			cache: false
		}
	]
});
~~~

#### Client Code

```js

var params = {
	api_key: '${SOMEAPI_API_KEY}',
	api_secret: '${SOMEAPI_API_SECRET}'
};

$.ajax({
	url: '/proxy',
	data: {
		url: 'http://someapi.com/api/secure?' + $.param(params);
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

Cache object that conforms to the [node_redis](https://www.npmjs.com/package/redis) API. Can set to `false` at an endpoint level to explicitly disable caching for certain APIs. See [Cache section](#caching) below for more details.

__`cacheMaxAge`__

The duration to cache the API response. If an API response is returned from the cache, a `max-age` http header will be included with the remaining TTL.

__`envTokenStartSymbol`__

The start symbol that represents an environment variable token. Defaults to `${`.

__`envTokenEndSymbol`__

The symbol representing the end of an environment variable token. Defaults to `}`.

__`ensureAuthenticated`__

Ensure that there is a valid logged in user in order to invoke the proxy. See the [Ensure Authenticated](#ensure-authenticated) section below for details.

__`userAgent`__

The user agent string passed as a header in the http call to the remote API. Defaults to `"express-api-proxy"`.

__`cacheHttpHeader`__

Name of the http header returned in the proxy response with the value `"hit"` or `"miss"`. Defaults to `"Express-Api-Proxy-Cache"`.

__`envVariableFn`__

Function for providing custom logic to return the value of an environment variable. Useful for reading values from alternative stores to `process.env`. Function takes two arguments: `req` and `key`. If omitted, `process.env[key]` is used by default.

__`endpoints`__

Allows overriding any of the above options for a specific remote API endpoint based on a RegExp pattern match.

~~~js
endpoints: [
	{
  		pattern: /api.instagram.com/,
  		cacheMaxAge: 4000
  	}
]
~~~

### Environment Variables

In order to keep sensitive keys out of client JavaScript, the API proxy supports replacing environment variables in the URL, HTTP headers, and the JSON body of a POST or PUT request. Environment variables that are blank or undefined will result in a 400 (Bad Request) HTTP response.

#### URL

~~~js
$.ajax({
	url: '/proxy',
	data: {
		url: 'https://someapi.com/api/endpoint?api_key=${SOME_API_API_KEY}'
	}
});
~~~

#### HTTP header
For [HTTP Basic authentication](http://en.wikipedia.org/wiki/Basic_access_authentication#Client_side), the value of the `SOME_API_BASIC_AUTH_TOKEN` environment variable would be "username:password" Base64 encoded. The `X-Authorization` header is used to avoid colliding with a `Authorization` header required to invoke the `/proxy` URL. The proxy will strip off the `X-` prefix when invoking the remote API.

~~~js
$.ajax({
	url: '/proxy',
	data: {
		url: 'https://someapi.com/api/endpoint'
	},
	headers: {
		'X-Authorization': 'Basic ${SOME_API_BASIC_AUTH_TOKEN}'
	}
});
~~~

#### POST or PUT body

```js
$.ajax({
	url: '/proxy?url=' + encodeURIComponent('https://someapi.com/api/endpoint'),
	type: 'POST',
	data: {
		api_key: '${SOME_API_API_KEY}',
		params: {}
	}
});
```

#### User Variables
For any environment variable with the prefix `USER_`, the proxy will replace it with a matching property on the `req.user` object. It does so by stripping off the `USER_` prefix, then converting the remainder from underscore case to camel case. For example the variable `USER_ACCESS_TOKEN` would get substituted by `req.user.accessToken`. If there is `req.user` or `req.user.accessToken` is undefined, a 400 response is returned.

#### Custom Environment Variable Store
By default the proxy looks up environment variables using `process.env[key]`, but in some cases it is desirable to provide a custom environment variable implementation. A `envVariableFn` option can be provided that accepts the `req` and `key` to perform custom logic:

```js
options: {
	envVariableFn: function(req, key) {
		return ...;
	}
}
```

### Caching 

For APIs whose data does not frequently change, it is often desirable to cache responses at the proxy level. This avoids repeated network round-trip latency and can skirt rate limits imposed by the API provider. Caching can be set as a global option, but more commonly you'll want to control it for each individual endpoint. 

The object provided to the `cache` option is expected to implement a subset of the [node_redis](https://github.com/mranney/node_redis) interface, specifically the [get](http://redis.io/commands/get), [set](http://redis.io/commands/set), [setex](http://redis.io/commands/setex), [exists](http://redis.io/commands/exists), [del](http://redis.io/commands/del), and [ttl](http://redis.io/commands/ttl) commands. The node_redis package can be used directly, other cache stores require a wrapper module that adapts to the redis interface.

As an optimization, two additional functions, `readStream` and `writeThrough` can be implemented on the cache object to allow direct piping of the API responses into and out of the cache. This avoids buffering the entire API response in memory. For node_redis, the [redis-streams](https://www.npmjs.com/package/redis-streams) package augments the `RedisClient` with these two functions. Simply add the following line to your module before the proxy middleware is executed:

```js
var redis = require('redis');

require('redis-streams')(redis);
// After line above, calls to redis.createClient will return enhanced
// object with readStream and writeThrough functions.

app.all('/proxy', apiProxy({
	cache: redis.createClient(),
	endpoints: [
		pattern: /blog\/posts/,
		maxCacheAge: 60 * 5 // 5 minutes
	]
});
```

#### HTTP Headers
If an API response is served from the cache, the `max-age` header will be set to the remaining TTL of the cached object. The proxy cache trumps any HTTP headers such as `Last-Modified`, `Expires`, or `ETag`, so these get discarded. Effectively the proxy takes over the caching behavior from the origin for the duration that it exists there.

### Ensure Authenticated

It's possible restrict proxy calls to authenticated users via the `ensureAuthenticated` option property which can be specified at the top level, or on a specific object in the `endpoints` array. 

```js
app.all('/proxy', apiProxy({
	endpoints: [
		{
			pattern: /\/secure/,
			ensureAuthenticated: true
		}
	]
});
```

The proxy does not perform authentication itself, that task is delegated to other middleware that executes earlier in the request pipeline which sets the property `req.ext.isAuthenticated`. If the `ensureAuthenticated` is `true` and `req.ext.isAuthenticated !== true`, a 401 (Unauthorized) HTTP response is returned.

Note that this is different than authentication that might be enforced by the remote API itself. That's handled by passing environment variables as discussed above.


### Transforms

The proxy supports transforming the API response before piping it back to the caller. Transforms are functions which return a Node.js [transform stream](http://nodejs.org/api/stream.html#stream_class_stream_transform). The [through2](https://github.com/rvagg/through2) package provides a lightweight wrapper that makes transforms easier to implement.

Here's a trivial transform function that simply appends some text

```js
module.exports = fn = function(options) {
	return through2(function(chunk, enc, cb) {
		this.push(chunk);
		cb();
	}, function(cb) {
		this.push(options.appendText);
		cb();
	});
};
```

If the transform needs to change the `Content-Type` of the response, a `contentType` property can be declared on the transform function that the proxy will recognize and set the header accordingly. 

```js
module.exports = function(options) {
	var transform = through2(...);
	transform.contentType = 'application/json';
	return transform;
};
```

See the [markdown-transform](https://github.com/4front/markdown-transform) for a real world example.


[npm-image]: https://img.shields.io/npm/v/express-api-proxy.svg?style=flat
[npm-url]: https://npmjs.org/package/express-api-proxy
[travis-image]: https://img.shields.io/travis/4front/express-api-proxy.svg?style=flat
[travis-url]: https://travis-ci.org/4front/apphost
[coveralls-image]: https://img.shields.io/coveralls/4front/express-api-proxy.svg?style=flat
[coveralls-url]: https://coveralls.io/r/4front/express-api-proxy?branch=master
[downloads-image]: https://img.shields.io/npm/dm/express-api-proxy.svg?style=flat
[downloads-url]: https://npmjs.org/package/express-api-proxy