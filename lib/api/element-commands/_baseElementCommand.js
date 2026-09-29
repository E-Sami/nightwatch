const {WebElement} = require('selenium-webdriver');
const ElementCommand = require('../../element').Command;
const Utils = require('../../utils');
const {Logger, filterStackTrace, symbols} = Utils;

class BaseElementCommand extends ElementCommand {
  get w3c_deprecated() {
    return false;
  }

  static getErrorMessage(response = {}) {
    const {value, error = ''} = response;

    if (value && value.error) {
      return value.error;
    }

    return error;
  }

  get extraArgsCount() {
    return 0;
  }

  get retryOnFailure() {
    return true;
  }

  get elementProtocolAction() {
    return null;
  }

  static get isTraceable() {
    return false;
  }

  setOptionsFromSelector() {
    this.abortOnFailure = this.api.globals.abortOnElementLocateError;

    super.setOptionsFromSelector();
  }

  async findElementAction({cacheElementId = true} = {}) {
    if (WebElement.isId(this.selector)) {
      return {
        value: this.selector,
        status: 0,
        result: {}
      };
    }

    if ((this.selector instanceof Promise) && this.selector['@nightwatch_element']) {
      this.__element = await this.selector;
    }

    return this.findElement({cacheElementId});
  }

  setupActions() {
    const isResultStale = (response) => {
      const result = this.transport.isRetryableElementError(response);

      return result;
    };
    const validate = (result) => this.isResultSuccess(result);
    const successHandler = (result) => this.complete(null, result);

    this.elementCommandRetries = 0;

    this.executor
      .queueAction({
        action: (opts) => this.findElementAction(opts),
        retryOnSuccess: this.retryOnSuccess,
        shouldRetryOnError: (response) => {
          return !this.transport.invalidWindowReference(response.result || response);
        },
        validate,
        errorHandler: err => {
          const result = err.response || {};

          if (this.suppressNotFoundErrors) {
            return this.complete(null, result);
          }

          let error;
          if (result.error && result.error.name === 'NoSuchElementError') {
            error = result.error;
          } else {
            error = this.noSuchElementError(err);
            error.response = result;
          }

          return this.elementLocateError(error);
        }
      })
      .queueAction({
        action: (response) => this.elementFound(response),
        retryOnSuccess: this.retryOnValidActionResult,
        retryOnFailure: this.retryOnFailure,
        validate: (result) => this.transport.isResultSuccess(result),
        isResultStale,
        successHandler,
        errorHandler: (err) => this.handleElementError(err)
      });
  }

  elementNotFound(err) {
    return this.handleElementError(err);
  }

  /**
   * Message used by the `report_command_timings` output. Overridden by commands
   * that read better in the past tense (see click.js).
   */
  timingMessage() {
    return `Ran .${this.commandName}() on element %s`;
  }

  /**
   * One-line `<tick> <what> <selector> (<ms>)` summary, in the same shape the
   * reporter uses for assertions, so interactive commands are as readable as
   * `assert.visible` in the run output. Opt-in through `report_command_timings`
   * and limited to the interactive (traceable) commands, so that the element
   * lookups performed on behalf of an assertion are not logged twice.
   */
  reportTiming(passed) {
    if (!this.settings.report_command_timings || !this.constructor.isTraceable) {
      return;
    }

    const startTime = this.executor && this.executor.startTime;
    if (!startTime) {
      return;
    }

    const elapsed = Date.now() - startTime;
    const {colors} = Logger;
    const symbol = passed ? colors.green(symbols.ok) : colors.red(symbols.fail);
    const message = this.timingMessage().replace('%s', `<${this.element.toString()}>`);
    // Match how the active reporter indents its own passed-assertion lines: the
    // full reporter indents by two, the simplified one does not.
    const indent = this.reporter && this.reporter.testResults ? '  ' : '';

    Logger.logDetailedMessage(`${indent}${symbol} ${message} ${colors.stack_trace(`(${elapsed}ms)`)}`);
  }

  async protocolAction() {
    if (!this.elementProtocolAction) {
      throw new Error('Define elementProtocolAction.');
    }

    const result = await this.executeProtocolAction(this.elementProtocolAction, this.args);

    // Retrying on a retryable element error is handled by the executor's
    // `isResultStale` / `retryOnFailure` hooks in setupActions(); this counter only
    // feeds the "how many times did we already report this" logic in the transport.
    this.elementCommandRetries++;

    if (result && result.error instanceof Error) {
      this.transport.registerLastError(result.error, this.elementCommandRetries);
    }

    return result;
  }

  async complete(err, response) {
    this.reportTiming(!err && !(response && response.status === -1));

    return super.complete(err, response);
  }

  handleElementError(err) {
    const showRegisterError = this.transport.shouldRegisterError(err);

    let originalErrorMessage;
    if (err instanceof Error) {
      originalErrorMessage = err.message;
    } else {
      originalErrorMessage = BaseElementCommand.getErrorMessage(err.response);
    }

    err.message = `An error occurred while running .${this.commandName}() command on <${this.element.toString()}>: ${originalErrorMessage}`;
    if (err.response) {
      err.detailedErr = JSON.stringify(err.response);
    }

    err.stack = filterStackTrace(this.stackTrace);

    if (showRegisterError) {
      Logger.error(err);

      this.reporter.registerTestError(err);
      err.registered = true;
    }

    const {message, stack} = err;
    const callbackResult = {
      status: -1,
      value: {
        error: message,
        message,
        stack
      }
    };

    if (this.abortOnFailure) {
      return this.complete(err, err.response || {});
    }

    return this.complete(null, callbackResult);
  }
}

module.exports = BaseElementCommand;
