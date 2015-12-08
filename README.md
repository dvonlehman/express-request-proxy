# express-request-proxy

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![Build Status][travis-image]][travis-url]
[![Test Coverage][coveralls-image]][coveralls-url]

High performance streaming http request reverse proxy for [Express](http://expressjs.com) based on the [request http client](https://www.npmjs.com/package/request). Supports caching, custom routes, server-side injection of sensitive keys, authentication, and response transformations.

## Usage

#### Server Code
~~~js
var redis = require('redis');
var requestProxy = require('express-request-proxy');

require('redis-streams')(redis);

app.get('/api/:resource/:id', requestProxy({
	cache: redis.createClient(),
	cacheMaxAge: 60,
	url: "https://someapi.com/api/:resource/:id",
	query: {
	  secret_key: process.env.SOMEAPI_SECRET_KEY
	},
	headers: {
		'X-Custom-Header': process.env.SOMEAPI_CUSTOM_HEADER
	}
}));
~~~

#### Client Code

~~~js
$.ajax({
	url: '/api/widgets/' + widgetId,
	statusCode: {
	  200: function(data) {
  		console.log(data);
	  },
	  404: function() {
		console.log("cannot find widget");
	  }
	}
});
~~~

### Options
__`url`__

String representing the url of the remote endpoint to proxy to. Can contain named route parameters. Query parameters can be appended with the `query` option. This is the only required option.

__`params`__

An object containing properties to substitute for named route parameters in the remote URL. Named parameters are declared using the same conventions as Express routes, i.e. `/pathname/:param1/:param2`. The path portion of the `url` is parsed using the [path-to-regexp](https://www.npmjs.com/package/path-to-regexp) module. Defaults to `{}`.

__`query`__

An object of parameters to be appended to the querystring of the specified `url`. This is a good way to append sensitive parameters that are stored as environment variables on the server avoiding the need to expose them to the client. Any parameters specified here will override an identically named parameter in the `url` or on the incoming request to the proxy. Defaults to `{}`.

__`headers`__

An object of HTTP headers to be appended to the request to the remote url. This is also a good way to inject sensitive keys stored in environment variables. See the [http basic auth](#http-basic-auth) section for example usage.

__`cache`__

Cache object that conforms to the [node_redis](https://www.npmjs.com/package/redis) API. Can set to `false` at an endpoint level to explicitly disable caching for certain APIs. See [Cache section](#caching) below for more details.

__`cacheMaxAge`__

The duration to cache the API response. If an API response is returned from the cache, a `max-age` http header will be included with the remaining TTL.

__`ensureAuthenticated`__

Ensure that there is a valid logged in user in order to invoke the proxy. See the [Ensure Authenticated](#ensure-authenticated) section below for details.

__`userAgent`__

The user agent string passed as a header in the http call to the remote API. Defaults to `"express-api-proxy"`.

__`cacheHttpHeader`__

Name of the http header returned in the proxy response with the value `"hit"` or `"miss"`. Defaults to `"Express-Request-Proxy-Cache"`.


#### HTTP Basic Auth
For http endpoints protected by [HTTP Basic authentication](http://en.wikipedia.org/wiki/Basic_access_authentication#Client_side), a username and password should be sent in the form `username:password`  which is then base64 encoded.

~~~js
var usernamePassword = process.env.SOMEAPI_USERNAME + ":"
	+ process.env.SOMEAPI_PASSSWORD;

app.post("/api/:resource", requestProxy({
	cache: redis.createClient(),
	cacheMaxAge: 60,
	url: "https://someapi.com/api/:resource",
	headers: {
		Authorization: "Basic " + new Buffer(usernamePassword).toString('base64')
	}
}));
~~~


#### Logged-In User Properties
Sometimes it's necessary to pass attributes of the current logged in user (on the server) into the request to the remote endpoint as headers, query params, etc. Rather than passing environment variables, simply specify the desired user properties.

~~~js
app.all("/api/protected/:resource", requestProxy({
  url: "http://remoteapi.com/api",
  query: {
    access_token: req.user.accessToken
  }
}));
~~~

This assumes that prior middleware has set the `req.user` property, which was perhaps stored in [session state](https://www.npmjs.com/package/express-session).


### Caching

For remote endpoints whose responses do not change frequently, it is often desirable to cache responses at the proxy level. This avoids repeated network round-trip latency and can skirt rate limits imposed by the API provider.

The object provided to the `cache` option is expected to implement a subset of the [node_redis](https://github.com/mranney/node_redis) interface, specifically the [get](http://redis.io/commands/get), [set](http://redis.io/commands/set), [setex](http://redis.io/commands/setex), [exists](http://redis.io/commands/exists), [del](http://redis.io/commands/del), and [ttl](http://redis.io/commands/ttl) commands. The node_redis package can be used directly, other cache stores require a wrapper module that adapts to the redis interface.

As an optimization, two additional functions, `readStream` and `writeThrough` must be implemented on the cache object to allow direct piping of the API responses into and out of the cache. This avoids buffering the entire API response in memory. For node_redis, the [redis-streams](https://www.npmjs.com/package/redis-streams) package augments the `RedisClient` with these two functions. Simply add the following line to your module before the proxy middleware is executed:

```js
var redis = require('redis');

require('redis-streams')(redis);
// After line above, calls to redis.createClient will return enhanced
// object with readStream and writeThrough functions.

app.get('/proxy/:route', requestProxy({
	cache: redis.createClient(),
	cacheMaxAge: 300, // cache responses for 5 minutes
	url: 'https://someapi.com/:route'
}));
```

Only `GET` requests are subject to caching, for all other methods the `cacheMaxAge` is ignored.

#### Caching Headers
If an API response is served from the cache, the `max-age` header will be set to the remaining TTL of the cached object. The proxy cache trumps any HTTP headers such as `Last-Modified`, `Expires`, or `ETag`, so these get discarded. Effectively the proxy takes over the caching behavior from the origin for the duration that it exists there.

### Ensure Authenticated

It's possible restrict proxy calls to authenticated users via the `ensureAuthenticated` option.

~~~js
app.all('/proxy/protected', requestProxy({
	url: 'https://someapi.com/sensitive',
	ensureAuthenticated: true
}));
~~~

The proxy does not perform authentication itself, that task is delegated to other middleware that executes earlier in the request pipeline which sets the property `req.ext.isAuthenticated`. If `ensureAuthenticated` is `true` and `req.ext.isAuthenticated !== true`, a 401 (Unauthorized) HTTP response is returned before ever executing the remote request.

Note that this is different than authentication that might be enforced by the remote API itself. That's handled by injecting headers or query params as discussed above.

### Wildcard routes

Sometimes you want to configure one catch-all proxy route that will forward on all path segments starting from the `*`. The example below will proxy a request to `GET /api/widgets/12345` to `GET https://remoteapi.com/api/v1/widgets/12345` and `POST /api/users` to `POST https://remoteapi.com/api/v1/users`.

~~~js
app.all('/api/*', requestProxy({
  url: 'https://remoteapi.com/api/v1/*',
  query: {
    apikey: 'xxx'
  }
}));
~~~

### Transforms

The proxy supports transforming the API response before piping it back to the caller. Transforms are functions which return a Node.js [transform stream](http://nodejs.org/api/stream.html#stream_class_stream_transform). The [through2](https://github.com/rvagg/through2) package provides a lightweight wrapper that makes transforms easier to implement.

Here's a trivial transform function that simply appends some text

~~~js
module.exports = fn = function(options) {
	return through2(function(chunk, enc, cb) {
		this.push(chunk);
		cb();
	}, function(cb) {
		this.push(options.appendText);
		cb();
	});
};
~~~

If the transform needs to change the `Content-Type` of the response, a `contentType` property can be declared on the transform function that the proxy will recognize and set the header accordingly.

~~~js
module.exports = function(options) {
	var transform = through2(...);
	transform.contentType = 'application/json';
	return transform;
};
~~~

See the [markdown-transform](https://github.com/4front/markdown-transform) for a real world example. For transforming HTML responses, the [trumpet package](https://www.npmjs.com/package/trumpet), with it's streaming capabilities, is a natural fit.

Here's how you could request a GitHub README.md as html:

~~~js
var markdownTransform = require('markdown-transform');

app.get('/:repoOwner/:repoName/readme', requestProxy({
  url: 'https://raw.githubusercontent.com/:repoOwner/:repoName/master/README.md',
  transforms: [markdownTransform({highlight: true})]
}));
~~~


## License
Licensed under the [Apache License, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0).

[npm-image]: https://img.shields.io/npm/v/express-request-proxy.svg?style=flat
[npm-url]: https://npmjs.org/package/express-request-proxy
[travis-image]: https://img.shields.io/travis/4front/express-request-proxy.svg?style=flat
[travis-url]: https://travis-ci.org/4front/express-request-proxy
[coveralls-image]: https://img.shields.io/coveralls/4front/express-request-proxy.svg?style=flat
[coveralls-url]: https://coveralls.io/r/4front/express-request-proxy?branch=master
[downloads-image]: https://img.shields.io/npm/dm/express-request-proxy.svg?style=flat
[downloads-url]: https://npmjs.org/package/express-request-proxy
