var assert = require('assert');
var _ = require('lodash');
var interpolater = require('../lib/interpolate')

describe('detokenize()', function() {
  before(function() {
    this.interpolate = interpolater({
      leftDelimiter: '${',
      rightDelimiter: '}'
    })
  });

  it('substitutes tokens in string', function() {
    var values = {
      GUEST_NAME: 'Bob'
    };

    var str = "hello ${GUEST_NAME}";

    assert.equal('hello Bob', this.interpolate(str, function(key) {
      return values[key];
    }));
  });

  it('does replacement in objects', function() {
    var values = {
      GUEST_NAME: 'Bob',
      AGE: 20
    };

    var guest = {
      name: '${GUEST_NAME}',
      age: '${AGE}',
      num: 123
    };

    var interpolated = this.interpolate(guest, function(key) {
      return values[key];
    });

    assert.ok(_.isEqual({
      name: 'Bob',
      age: '20',
      num: 123
    }, interpolated));
  });

  it('replaces multiple delimiter tokens in a string', function() {
    var values = {
      GUEST_NAME: 'Bob',
      CITY: 'Seattle'
    };

    var str = "hello ${GUEST_NAME}, welcome to ${CITY}";

    assert.equal('hello Bob, welcome to Seattle', this.interpolate(str, function(key) {
      return values[key];
    }));
  });

  it('error bubbles up when valueForKey raises error', function() {
    var values = {
      GUEST_NAME: 'Bob'
    };

    var str = "hello ${GUEST_NAME} ${INVALID}";

    try {
      this.interpolate(str, function(key) {
        if (values[key])
          return values[key];
        else
          throw new Error("Invalid key " + key);
      });
    }
    catch (err) {
      assert.equal(err.message, 'Invalid key INVALID');
      return;
    }

    assert.ok(false);
  });

  it('supports other delimiters', function() {
    var interpolate = interpolater({
      leftDelimiter: '@@',
      rightDelimiter: '@@'
    })

    var values = {
      GUEST_NAME: 'Bob',
      CITY: 'Seattle'
    };

    var str = "hello @@GUEST_NAME@@, welcome to @@CITY@@";

    assert.equal('hello Bob, welcome to Seattle', interpolate(str, function(key) {
      return values[key];
    }));
  });
});