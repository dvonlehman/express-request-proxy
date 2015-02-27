var _ = require('lodash');
var debug = require('debug')('express-api-proxy:interpolate');

module.exports = function(options) {
  var regexEscape = /([$\^\\\/()|?+*\[\]{}.\-])/g;
  
  // Borrowed this regex escape voodoo from:
  // https://github.com/gillesruppert/node-interpolate/blob/master/lib/interpolate.js
  var regex = new RegExp(options.leftDelimiter.replace(regexEscape, "\\$1") + "[a-z_]+" + options.rightDelimiter.replace(regexEscape, "\\$1"), "gi");

  var interpolate = function(val, valueForKey) {
    if (_.isObject(val)) {
      var updated = {};
      _.each(val, function(value, key) {
        updated[key] = interpolate(value, valueForKey);
      });
      return updated;
    }
    else if (_.isString(val)) {
      debug("looking for tokens in string " + val);

      return val.replace(regex, function(placeholder) {
        var key = placeholder.slice(options.leftDelimiter.length, -options.rightDelimiter.length);
        var substitute = valueForKey(key);
        debug("found substitute %s, for key %s", substitute, key);
        return substitute;
      });
    }
    else {
      return val;
    }
  }

  return interpolate;
}
