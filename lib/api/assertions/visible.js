/**
 * Checks if the given element is visible on the page.
 *
 * @example
 * this.demoTest = function (browser) {
 *   browser.assert.visible('.should_be_visible');
 *   browser.assert.visible({selector: '.should_be_visible'});
 *   browser.assert.visible({selector: '.should_be_visible', suppressNotFoundErrors: true});
 * };
 *
 * @method assert.visible
 * @param {string|object} definition The selector (CSS / Xpath) used to locate the element. Can either be a string or an object which specifies [element properties](https://nightwatchjs.org/guide/working-with-page-objects/#element-properties).
 * @param {string} [msg] Optional log message to display in the output. If missing, one is displayed by default.
 * @api assertions
 */
const {setElementSelectorProps, isObject, isNumber, isString, isUndefined} = require('../../utils');

exports.assertion = function(definition, msg) {
  this.options = {
    elementSelector: true
  };

  this.formatMessage = function() {
    const message = msg || `Testing if element %s ${this.negate ? 'is not visible' : 'is visible'}`;

    return {
      message,
      args: [this.elementSelector]
    };
  };

  this.expected = function() {
    return this.negate ? 'is not visible' : 'is visible';
  };

  this.evaluate = function(value) {
    return value === true;
  };

  this.actual = function(passed) {
    return passed ? 'visible' : 'not visible';
  };

  this.command = function(callback) {
    const selector = setElementSelectorProps(definition, {
      suppressNotFoundErrors: true
    });

    // A negated visibility assertion is satisfied by the element being absent, so
    // there is no point letting the element lookup burn the whole
    // waitForConditionTimeout polling for something that is expected not to be
    // there. The assertion scheduler still retries the whole assertion until
    // retryAssertionTimeout, so an element that only disappears later is caught.
    //
    // Restricted to a plain `{selector: '...'}` object, and applied to a copy
    // rather than by mutation: a shared page-object selector must not silently
    // inherit the shorter timeout, and Element / ScopedWebElement / WebElement
    // arguments must not be flattened into a plain object.
    if (this.negate && isObject(selector) && isString(selector.selector) &&
        selector.constructor === Object && isUndefined(selector.timeout)) {
      const {waitForElementAbsentTimeout} = this.api.globals;

      if (isNumber(waitForElementAbsentTimeout) && waitForElementAbsentTimeout > 0) {
        return this.api.isVisible(
          Object.assign({}, selector, {timeout: waitForElementAbsentTimeout}),
          callback
        );
      }
    }

    this.api.isVisible(selector, callback);
  };
};
