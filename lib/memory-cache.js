var stream = require('stream');
var through2 = require('through2');
var _ = require('lodash');

var MemoryCache = function() {
  this._cache = {};
};

MemoryCache.prototype.set = function(key, value, maxAge) {
  var cacheObject = { contents: value };
  if (maxAge)
    cacheObject.expires = new Date().getTime() + maxAge * 1000;

  this._cache[key] = cacheObject;
};

MemoryCache.prototype.get = function(key, callback) {

};

MemoryCache.prototype.del = function(key) {
  delete this._cache[key];
};

MemoryCache.prototype.readStream = function(key) {
  var cachedObject = this._cache[key];
  if (cachedObject)
    value = cachedObject.contents;
  else
    value = null;

  debugger;
  var Readable = stream.Readable;
  var rs = Readable();

  rs._read = function () {
    rs.push(value);
    rs.push(null);
  };
  return rs;  
};

MemoryCache.prototype.exists = function(key, callback) {
  var self = this;
  setTimeout(function() {
    callback(null, _.isUndefined(self._cache[key]) === false);  
  }, 0);
};

MemoryCache.prototype.writeThrough = function(key, maxAge) {
  var thisCache = this;
  var buffer = '';
  return through2.obj(function(chunk, enc, callback) {
    var self = this;

    buffer += chunk;
    self.push(chunk);
    callback();
  }, function(cb) {
    thisCache.set(key, buffer, maxAge);
    cb();
  });
};

MemoryCache.prototype.expire = function(key, maxAge) {
  var cachedObject = this._cache[key];
  if (cachedObject)
    cachedObject.expires = new Date().getTime() + maxAge * 1000;
};

MemoryCache.prototype.ttl = function(key, callback) {
  var cachedObject = this._cache[key];

  // Matching the redis protocol of returning -2 if the key does not exist
  // and -1 if it does exists but does not have an expiry.
  // http://redis.io/commands/ttl
  if (!cachedObject)
    return callback(null, -2);

  if (!cachedObject.expires)    
    return callback(null, -1);

  var ttl = Math.round((cachedObject.expires - new Date().getTime()) / 1000);
  if (ttl < 0) {
    delete this._cache[key];
    return callback(null, -2);
  }

  // Return the TTL in seconds to match the Redis command
  // http://redis.io/commands/ttl
  callback(null, ttl);
};

module.exports = MemoryCache;