const {By, RelativeBy, until, error: seleniumError} = require('selenium-webdriver');
const {isString, isFunction} = require('../utils');
const Element = require('./index.js');
const ElementsByRecursion = require('./locate/elements-by-recursion.js');
const SingleElementByRecursion = require('./locate/single-element-by-recursion.js');

const AVAILABLE_LOCATORS = {
  'css selector': 'css',
  'id': 'id',
  'link text': 'linkText',
  'name': 'name',
  'partial link text': 'partialLinkText',
  'tag name': 'tagName',
  'xpath': 'xpath',
  'className': 'className'
};

class LocateElement {
  /**
   * @param {object|string} element
   * @return {By|RelativeBy}
   */
  static create(element) {
    if (!element) {
      throw new Error(`Error while trying to locate element: missing element definition; got: "${element}".`);
    }

    const byInstance = LocateElement.locateInstanceOfBy(element);
    if (byInstance !== null) {
      return byInstance;
    }

    const elementInstance = LocateElement.createElementInstance(element);

    return By[AVAILABLE_LOCATORS[elementInstance.locateStrategy]](elementInstance.selector);
  }

  /**
   * @param {object} element
   * @return {By|RelativeBy|null}
   */
  static locateInstanceOfBy(element) {
    if (element instanceof By) {
      return element;
    }

    if (element.by instanceof By) {
      return element.by;
    }

    if (element.value instanceof RelativeBy) {
      return element.value;
    }

    return null;
  }

  /**
   * @param {object|string} element
   * @return {Element}
   */
  static createElementInstance(element) {
    if (typeof element != 'object' && typeof element != 'string') {
      throw new Error(`Invalid element definition type; expected string or object, but got: ${typeof element}.`);
    }

    let selector;
    let strategy;

    if (typeof element == 'object' && element.value && element.using) {
      selector = element.value;
      strategy = element.using;
    } else {
      selector = element;
    }

    return Element.createFromSelector(selector, strategy);
  }

  get api() {
    return this.nightwatchInstance.api;
  }

  get reporter() {
    return this.nightwatchInstance.reporter;
  }

  get settings() {
    return this.nightwatchInstance.settings;
  }

  get transport() {
    return this.nightwatchInstance.transport;
  }

  get desiredCapabilities() {
    return this.nightwatchInstance.session.desiredCapabilities;
  }

  constructor(nightwatchInstance) {
    this.nightwatchInstance = nightwatchInstance;
  }

  resolveElementRecursively({element}) {
    return this.findElement({element}).then(response => {
      const firstElement = element.selector[element.selector.length - 1];
      firstElement.resolvedElement = response;

      const {selector, locateStrategy, name} = firstElement;
      const {status, value} = response;
      const WebdriverElementId = response && response.WebdriverElementId || null;
      const result = {
        selector,
        locateStrategy,
        name,
        WebdriverElementId,
        response: {
          status,
          value
        }
      };

      if (!isNaN(firstElement.index)) {
        result.index = firstElement.index;
      }

      return result;
    });
  }

  /**
   * Finds a single element by using the multiple locate elements, which instead of throwing an error returns an empty array
   *
   * @param {Element} element
   * @param {String} commandName
   * @param {String} id
   * @param {String} transportAction
   * @param {Boolean} [returnSingleElement]
   * @param {Boolean} [cacheElementId]
   * @return {Promise}
   */
  async findElement({element, commandName, id, transportAction = 'locateMultipleElements', returnSingleElement = true, cacheElementId = true}) {
    if (element && (element.webElement || element.webElementId)) {
      const elementId = await (element.webElement || element.webElementId).getId();
      element.setResolvedElement(elementId);

      return {
        value: this.transport.toElement(elementId),
        status: 0
      };
    }

    if (element.resolvedElement && cacheElementId) {
      return Promise.resolve({
        value: this.transport.toElement(element.resolvedElement),
        status: 0
      });
    }

    if (element.usingRecursion) {
      if (transportAction === 'locateSingleElement') {
        return this.findSingleElementUsingRecursion(element);
      }

      return this.findElementsUsingRecursion({element, returnSingleElement});
    }

    const result = await this.executeProtocolAction({element, commandName, id, transportAction, cacheElementId, returnSingleElement});

    return this.handleLocateElement({result, element, returnSingleElement});
  }

  locateMultipleElements(element) {
    const commandName = 'locateMultipleElements';
    const transportAction = 'locateMultipleElements';

    return this.executeProtocolAction({element, commandName, transportAction});
  }

  handleLocateElement({result, element, returnSingleElement}) {
    const {status = 0, error} = result || {};
    let {value} = result;

    if (error instanceof Error) {
      return {
        error,
        status: -1,
        value
      };
    }

    let WebdriverElementId;
    const elementResult = this.transport.resolveElement(result, element, true);
    if (elementResult) {
      WebdriverElementId = this.transport.getElementId(elementResult);
      element.setResolvedElement(WebdriverElementId);
    }

    if (returnSingleElement) {
      value = elementResult;
    }

    return {
      value,
      status,
      WebdriverElementId
    };
  }

  /**
   * @returns Promise({{
   *    value,
   *    status,
   *    result,
   *    now
   * }})
   */
  executeProtocolAction(opts = {}) {
    const {id, element, transportAction, commandName, cacheElementId, returnSingleElement = false} = opts;
    const args = {
      id
    };

    if (element instanceof By) {
      args.by = element;
    } else {
      args.using = element.locateStrategy;
      args.value = element.selector;
    }

    return this.sendElementsAction({transportAction, args, element, cacheElementId, returnSingleElement})
      .catch(err => {
        if (this.transport.invalidSessionError(err)) {
          return new Error(this.transport.getErrorMessage(err));
        }

        throw err;
      })

      .then(result => {
        if (this.transport.isResultSuccess(result) && Element.requiresFiltering(element)) {
          return this.filterElements(element, result);
        }

        return result;
      })
      // Catch errors from filterElements and from invalid session
      .catch(error => {
        return {
          value: null,
          status: -1,
          error
        };
      });
  }

  /**
   * iOS/Appium only. Decides whether an element lookup that only ever uses a single
   * result can be sent as POST /element instead of POST /elements.
   *
   * On XCUITest, WDA's /elements handler resolves and serialises every match while
   * /element stops at the first one, so the saving grows with the number of matches
   * (measured: 296ms vs 50ms for a class chain matching 11 elements; a wash when the
   * selector matches once). It also lets WDA return the `displayed` attribute inline
   * with the element when `shouldUseCompactResponses` is off, which removes the
   * follow-up GET /element/:id/displayed.
   *
   * Deliberately NOT taken when:
   *  - the caller needs every match (`returnSingleElement === false`);
   *  - the selector needs index filtering (`Element.requiresFiltering`);
   *  - `throwOnMultipleElementsReturned` is on, since that needs the real match count;
   *  - the locator is a By/RelativeBy instance rather than a using/value pair.
   *
   * @return {boolean}
   */
  canUseSingleElementLookup({element, args, returnSingleElement}) {
    if (!returnSingleElement || !this.settings.ios_fast_element_lookup) {
      return false;
    }

    if (process.env.NIGHTWATCH_IOS_FAST_ELEMENT_LOOKUP === '0') {
      return false;
    }

    const {api} = this;
    if (!api || !isFunction(api.isAppiumClient) || !api.isAppiumClient() || !api.isIOS()) {
      return false;
    }

    if (this.settings.globals && this.settings.globals.throwOnMultipleElementsReturned) {
      return false;
    }

    if (!args || !isString(args.using) || !isString(args.value)) {
      return false;
    }

    return !Element.requiresFiltering(element);
  }

  /**
   * Single POST /element attempt. Normalises a "not found" into exactly the same
   * shape `locateMultipleElements` produces, so callers cannot tell the two paths
   * apart other than by being faster.
   */
  async locateSingleElementOnce({using, value}) {
    const result = await this.transport.executeProtocolAction('locateSingleElementRaw', {using, value});

    const notFound = () => ({
      status: -1,
      value: [],
      error: 'no such element',
      message: `Unable to locate element: ${value} using ${using}`
    });

    const {error} = result || {};
    if (error) {
      return error.name === 'NoSuchElementError' ? notFound() : Promise.reject(error);
    }

    // This path issues the protocol request directly instead of going through
    // driver.findElement(), so the W3C error payload ({value: {error, message}},
    // which the remote end serves with a 4xx) is not decoded for us - do it here.
    const responseValue = result && result.value;
    if (responseValue && isString(responseValue.error)) {
      if (responseValue.error === 'no such element') {
        return notFound();
      }

      seleniumError.throwDecodedError(responseValue);
    }

    const elementId = responseValue && this.transport.getElementId(responseValue);
    if (!elementId) {
      return notFound();
    }

    return {
      status: 0,
      value: [responseValue]
    };
  }

  /**
   * Polling equivalent of `driver.wait(until.elementsLocated(...))` for the
   * single-element path. Same timeout/interval semantics, same NoSuchElementError.
   */
  async waitForSingleElementLocated({args, element, timeout, retryInterval}) {
    const startTime = Date.now();

    for (;;) {
      const result = await this.locateSingleElementOnce(args);

      if (result.status === 0) {
        return result;
      }

      if (Date.now() - startTime >= timeout) {
        throw new NoSuchElementError({element, ms: timeout});
      }

      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
  }

  async sendElementsAction({transportAction, args, element, cacheElementId, returnSingleElement} = {}) {
    const useSingleElement = transportAction === 'locateMultipleElements' &&
      args && !(args.value instanceof RelativeBy) &&
      this.canUseSingleElementLookup({element, args, returnSingleElement});

    if (useSingleElement && !cacheElementId) {
      // Mirrors the non-polling branch below: one attempt, the caller retries.
      return this.locateSingleElementOnce(args);
    }

    if (cacheElementId && transportAction === 'locateMultipleElements' && args && !(args.value instanceof RelativeBy)) {
      const timeout = element.timeout || this.settings.globals.waitForConditionTimeout;
      const retryInterval = element.retryInterval || this.settings.globals.waitForConditionPollInterval;

      if (useSingleElement) {
        return this.waitForSingleElementLocated({args, element, timeout, retryInterval});
      }

      try {
        const results = await this.transport.driver.wait(until.elementsLocated(args), timeout, null, retryInterval);
        const {elementKey} = this.transport;
        const value = await Promise.all(results.map(async webElement => {
          const elementId = await webElement.getId();

          return {[elementKey]: elementId};
        }));

        return {
          status: 0,
          value
        };
      } catch (err) {
        if (err.name !== 'TimeoutError') {
          throw err;
        }

        throw new NoSuchElementError({element, ms: timeout});
      }
    }

    return this.transport.executeProtocolAction(transportAction, args);
  }

  /**
   * Selects a subset of elements if the result requires filtering.
   *
   * @param {Element} element
   * @param {object} result
   * @return {*}
   */
  filterElements(element, result) {
    let filtered = Element.applyFiltering(element, result.value);

    if (filtered) {
      result.value = filtered;

      return result;
    }

    const errorResult = this.transport.getElementNotFoundResult(result);

    throw new Error(`Element ${element.toString()} not found.${errorResult.message ? (' ' + errorResult.message) : ''}`);
  }

  /**
   * @param {Element} element
   * @param {Boolean} returnSingleElement
   * @return {Promise}
   */
  findElementsUsingRecursion({element, returnSingleElement = true}) {
    let recursion = new ElementsByRecursion(this.nightwatchInstance);

    return recursion.locateElements({element, returnSingleElement});
  }

  findSingleElementUsingRecursion(element) {
    let recursion = new SingleElementByRecursion(this.nightwatchInstance);

    return recursion.locateElement(element.selector);
  }
}

class NoSuchElementError extends Error {
  constructor({element, ms, abortOnFailure, retries}) {
    super();

    this.selector = element.selector;
    this.abortOnFailure = abortOnFailure;
    this.name = 'NoSuchElementError';
    this.retries = retries;
    this.strategy = element.locateStrategy;
    this.message = `Timed out while waiting for element "${this.selector}" with "${this.strategy}" to be present for ${ms} milliseconds.`;
  }
}

module.exports = LocateElement;
module.exports.NoSuchElementError = NoSuchElementError;
module.exports.AVAILABLE_LOCATORS = AVAILABLE_LOCATORS;
