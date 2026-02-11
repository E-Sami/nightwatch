const ora = require('ora');
const {Builder, Browser, error} = require('selenium-webdriver');

const Actions = require('./actions.js');
const SeleniumCapabilities = require('./options.js');
const {Logger, isObject} = require('../../utils');
const {IosSessionNotCreatedError, AndroidConnectionError} = require('../../utils/mobile.js');
const httpClient = require('./httpclient.js');
const Session = require('./session.js');
const BaseTransport = require('../');
const {colors} = Logger;
const {isErrorResponse, checkLegacyResponse, throwDecodedError, WebDriverError} = error;
const {IosSessionErrors} = require('../errors');
const {isIos, isAndroid, isMobile} = require('../../utils/mobile.js');

let _driverService = null;
let _driver = null;
let _cachedSessionInfo = null; // Cache session ID and capabilities to avoid unnecessary HTTP calls

class Transport extends BaseTransport {
  /**
   * @param {Builder} builder
   * @param {Capabilities} options
   */
  static setBuilderOptions({builder, options}) {
    switch (options.getBrowserName()) {
      case Browser.CHROME:
        builder.setChromeOptions(options);
        break;

      case Browser.FIREFOX:
        builder.setFirefoxOptions(options);
        break;

      case Browser.SAFARI:
        builder.setSafariOptions(options);
        break;

      case Browser.EDGE:
        builder.setEdgeOptions(options);
        break;

      case Browser.OPERA:
        // TODO: implement
        break;

      case Browser.INTERNET_EXPLORER:
        builder.setIeOptions(options);
        break;
    }
  }

  static get driver() {
    return _driver;
  }

  static set driver(value) {
    _driver = value;
  }

  static get driverService() {
    return _driverService;
  }

  static set driverService(value) {
    _driverService = value;
  }

  static get cachedSessionInfo() {
    return _cachedSessionInfo;
  }

  static set cachedSessionInfo(value) {
    _cachedSessionInfo = value;
  }


  /**
   * @override
   */
  get ServiceBuilder() {
    return null;
  }

  get defaultPort() {
    return this.ServiceBuilder ? this.ServiceBuilder.defaultPort : 4444;
  }

  get Actions() {
    return this.actionsInstance.actions;
  }

  get reporter() {
    return this.nightwatchInstance.reporter;
  }

  get api() {
    return this.nightwatchInstance.api;
  }

  get settings() {
    return this.nightwatchInstance.settings;
  }

  get desiredCapabilities() {
    return this.settings.desiredCapabilities;
  }

  get defaultPathPrefix() {
    return '';
  }

  get outputEnabled() {
    return this.settings.output;
  }

  get usingSeleniumServer() {
    return this.settings.selenium && this.settings.selenium.start_process;
  }

  get shouldStartDriverService() {
    return this.settings.webdriver.start_process;
  }

  get serviceName() {
    return this.ServiceBuilder.serviceName;
  }

  get elementKey() {
    return this.__elementKey || Session.WEB_ELEMENT_ID;
  }

  get initialCapabilities() {
    return this.seleniumCapabilities.initialCapabilities;
  }

  get parallelMode() {
    return this.settings.testWorkersEnabled;
  }

  constructor(nightwatchInstance, {isSelenium = false, browserName} = {}) {
    super(nightwatchInstance);

    this.nightwatchInstance = nightwatchInstance;
    this.browserName = browserName;

    this.seleniumCapabilities = new SeleniumCapabilities({
      settings: this.settings,
      browserName
    });

    this.createHttpClient();
    this.createActions();
  }

  /**
   * @override
   */
  setBuilderOptions({options, builder}) {
    Transport.setBuilderOptions({options, builder});
  }

  createActions() {
    this.actionsInstance = new Actions(this);
    this.actionsInstance.loadActions();
  }

  createHttpClient() {
    const http = require('selenium-webdriver/http');
    http.HttpClient = httpClient(this.settings, http.Response);
  }

  getServerUrl() {
    if (this.shouldStartDriverService) {
      return this.defaultServerUrl;
    }

    return this.settings.webdriver.url;
  }

  ////////////////////////////////////////////////////////////////////
  // Session related
  ////////////////////////////////////////////////////////////////////
  async closeDriver() {
    if (this.driverService) {
      try {
        await this.driverService.stop();
        this.driverService = null;
        this.stopped = true;
      } catch (err) {
        Logger.error(err);
        err.displayed = true;

        throw err;
      }
    }
  }

  async sessionFinished(reason) {
    this.emit('session:finished', reason);

    // Clear cached session info when session ends
    Transport.cachedSessionInfo = null;

    await this.closeDriver();
  }

  async createDriverService({options, moduleKey, reuseBrowser = false}) {
    try {
      moduleKey = this.settings.webdriver.log_file_name || moduleKey || '';

      if (!this.shouldReuseDriverService(reuseBrowser)) {
        Transport.driverService = new this.ServiceBuilder(this.settings);
        await Transport.driverService.setOutputFile(reuseBrowser ? 'test' : moduleKey).init(options);
      }

      this.driverService = Transport.driverService;
    } catch (err) {
      this.showConnectSpinner(colors.red(`Failed to start ${this.serviceName}.`), 'warn');

      throw err;
    }
  }

  shouldReuseDriverService(reuseBrowser) {
    return (Transport.driverService && !Transport.driverService.stopped && reuseBrowser);
  }




  async getDriver({options, reuseBrowser = false}) {
    const value  = await this.shouldReuseDriver(reuseBrowser);
    if (value) {
      return Transport.driver;
    }

    Transport.driver = await this.createDriver({options});

    return Transport.driver;
  }


  /**
   * Helper to get a capability value from either a Map or plain object
   */
  getCapabilityValue(caps, key) {
    if (!caps) {
      return undefined;
    }
    // Handle Map (from selenium-webdriver)
    if (typeof caps.get === 'function') {
      return caps.get(key);
    }
    // Handle plain object (from cache)
    return caps[key];
  }

  /**
   * Compare desired capabilities with existing session capabilities
   * For mobile platforms (iOS/Android), we need to match critical capabilities
   * like device UDID, app bundle/package, and platform
   */
  capabilitiesMatch(desiredCaps, existingCaps) {
    if (!existingCaps) {
      return false;
    }

    const isMobilePlatform = isMobile(desiredCaps);
    
    // For mobile platforms, check critical matching criteria
    if (isMobilePlatform) {
      // Check platform name
      const desiredPlatform = desiredCaps.platformName?.toLowerCase();
      const existingPlatform = this.getCapabilityValue(existingCaps, 'platformName')?.toLowerCase() || 
                               this.getCapabilityValue(existingCaps, 'platform')?.toLowerCase();
      
      if (desiredPlatform && existingPlatform && desiredPlatform !== existingPlatform) {
        return false;
      }

      // For iOS: check UDID and bundle ID
      if (isIos(desiredCaps)) {
        const desiredUDID = desiredCaps['appium:udid'] || desiredCaps['safari:deviceUDID'];
        const existingUDID = this.getCapabilityValue(existingCaps, 'appium:udid') || 
                            this.getCapabilityValue(existingCaps, 'safari:deviceUDID');
        
        if (desiredUDID && existingUDID && desiredUDID !== existingUDID) {
          return false;
        }

        const desiredBundleId = desiredCaps['appium:bundleId'] || desiredCaps['bundleId'];
        const existingBundleId = this.getCapabilityValue(existingCaps, 'appium:bundleId') || 
                                 this.getCapabilityValue(existingCaps, 'bundleId');
        
        if (desiredBundleId && existingBundleId && desiredBundleId !== existingBundleId) {
          return false;
        }
      }

      // For Android: check UDID and app package
      if (isAndroid(desiredCaps)) {
        const desiredUDID = desiredCaps['appium:udid'] || desiredCaps['deviceId'];
        const existingUDID = this.getCapabilityValue(existingCaps, 'appium:udid') || 
                            this.getCapabilityValue(existingCaps, 'deviceId');
        
        if (desiredUDID && existingUDID && desiredUDID !== existingUDID) {
          return false;
        }

        const desiredAppPackage = desiredCaps['appium:appPackage'] || desiredCaps['appPackage'];
        const existingAppPackage = this.getCapabilityValue(existingCaps, 'appium:appPackage') || 
                                   this.getCapabilityValue(existingCaps, 'appPackage');
        
        if (desiredAppPackage && existingAppPackage && desiredAppPackage !== existingAppPackage) {
          return false;
        }
      }
    }

    // For web browsers, check browser name
    const desiredBrowser = desiredCaps.browserName;
    let existingBrowser;
    if (typeof existingCaps.getBrowserName === 'function') {
      existingBrowser = existingCaps.getBrowserName();
    } else {
      existingBrowser = this.getCapabilityValue(existingCaps, 'browserName');
    }
    
    if (desiredBrowser && existingBrowser && desiredBrowser.toLowerCase() !== existingBrowser.toLowerCase()) {
      return false;
    }

    return true;
  }

  async shouldReuseDriver(reuseBrowser) {
    if (!reuseBrowser || !Transport.driver) {
      return false;
    }

    // If we have cached session info, first check if capabilities match
    // This avoids an HTTP call if capabilities don't match
    if (Transport.cachedSessionInfo && Transport.cachedSessionInfo.capabilities) {
      if (!this.capabilitiesMatch(this.desiredCapabilities, Transport.cachedSessionInfo.capabilities)) {
        // Capabilities don't match - clear driver and cache
        Transport.driver = null;
        Transport.cachedSessionInfo = null;
        return false;
      }
    }

    try {
      // For mobile platforms, use a slightly longer timeout as Appium can be slower
      const isMobilePlatform = isMobile(this.desiredCapabilities);
      const timeout = isMobilePlatform ? 2000 : 1000;
      
      // Quick check if session is still valid - use a short timeout to fail fast
      // This prevents the 14s delay if session is invalid
      const sessionPromise = Transport.driver.getSession();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Session check timeout')), timeout)
      );
      
      const session = await Promise.race([sessionPromise, timeoutPromise]);
      
      // If we got here, session is valid - update cache if needed
      if (!Transport.cachedSessionInfo) {
        try {
          const sessionId = await session.getId();
          const sessionCapabilities = await session.getCapabilities();
          // Serialize capabilities to plain object for easier comparison
          const serializedCaps = Session.serializeCapabilities(sessionCapabilities);
          Transport.cachedSessionInfo = {
            sessionId: sessionId,
            capabilities: serializedCaps
          };
        } catch (err) {
          // If we can't get capabilities, that's okay - we'll skip caching
        }
      }
      
      return true;
    } catch (err) {
      // Session is invalid or doesn't exist - need to create new one
      Transport.driver = null; // Clear invalid driver
      Transport.cachedSessionInfo = null; // Clear cache
      return false;
    }
  }

  /**
   * @param {Capabilities} options
   * @returns {Builder}
   */
  createSessionBuilder(options) {
    const builder = new Builder();
    builder.disableEnvironmentOverrides();

    this.setBuilderOptions({builder, options});

    return builder;
  }

  createSessionOptions(argv) {
    return this.seleniumCapabilities.create(argv);
  }

  createDriver({options}) {
    const builder = this.createSessionBuilder(options);

    this.builder = builder;

    return builder.build();
  }

  async createSession({argv, moduleKey, reuseBrowser = false}) {
    const startTime = new Date();
    const {host, port, start_process} = this.settings.webdriver;
    const portStr = port ? `port ${port}` : 'auto-generated port';
    
    let timing = {
      createOptions: null,
      driverService: null,
      driverCreation: null,
      sessionExport: null,
      total: null
    };
    
    const logTiming = (stage, start) => {
      const elapsed = new Date() - start;
      timing[stage] = elapsed;
      if (this.settings.webdriver.debug_timing) {
        // eslint-disable-next-line no-console
        console.info(`[Timing] ${stage}: ${elapsed}ms`);
      }
    };
    
    const t0 = new Date();
    const options = await this.createSessionOptions(argv);
    logTiming('createOptions', t0);

    if (start_process) {
      if (this.usingSeleniumServer) {
        options.showSpinner = (msg) => {
          this.showConnectSpinner(msg);
        };
      } else {
        this.showConnectSpinner(`Starting ${this.serviceName} on ${portStr}...\n`);
      }

      const t1 = new Date();
      await this.createDriverService({options, moduleKey, reuseBrowser});
      logTiming('driverService', t1);
    } else {
      this.showConnectSpinner(`Connecting to ${host} on ${portStr}...\n`);
    }

    try {
      const t2 = new Date();
      const wasReused = await this.shouldReuseDriver(reuseBrowser);
      const t2_5 = new Date();
      
      if (wasReused) {
        // Driver was reused - no session creation needed
        this.driver = Transport.driver;
        if (this.settings.webdriver.debug_timing) {
          // eslint-disable-next-line no-console
          console.info(`[Timing] Driver reused (check time: ${new Date() - t2_5}ms)`);
        }
      } else {
        // Need to create new driver - this is where the 14s delay happens
        this.driver = await this.getDriver({options, reuseBrowser});
      }
      
      const t3 = new Date();
      const session = new Session(this.driver);
      // The actual session creation HTTP request happens here in getSession()
      // if driver was just created, or just retrieves existing session if reused
      const sessionExports = await session.exported();
      
      // Cache session info for future reuse checks
      if (sessionExports.sessionId && sessionExports.capabilities) {
        Transport.cachedSessionInfo = {
          sessionId: sessionExports.sessionId,
          capabilities: sessionExports.capabilities
        };
      }
      
      // Calculate timing
      const actualDriverTime = wasReused ? (new Date() - t2_5) : (new Date() - t2);
      timing.driverCreation = actualDriverTime;
      
      // Session export time (getting capabilities)
      const exportTime = new Date() - t3;
      timing.sessionExport = exportTime;
      
      if (this.settings.webdriver.debug_timing) {
        // eslint-disable-next-line no-console
        console.info(`[Timing] driverCreation: ${actualDriverTime}ms ${wasReused ? '(reused)' : '(new session)'}`);
        // eslint-disable-next-line no-console
        console.info(`[Timing] sessionExport (capabilities only): ${exportTime}ms`);
      }
      
      const {sessionInfo, sessionId, capabilities, elementKey} = sessionExports;

      this.__elementKey = elementKey;
      
      timing.total = new Date() - startTime;
      
      // Always show timing breakdown to help identify bottlenecks
      const serviceTime = timing.driverService || 0;
      const timingBreakdown = `[options:${timing.createOptions}ms${serviceTime > 0 ? `, service:${serviceTime}ms` : ''}, driver:${timing.driverCreation}ms, export:${timing.sessionExport}ms]`;
      
      // Always log timing breakdown - use console.info to ensure it's visible
      // eslint-disable-next-line no-console
      console.info(`[Timing] Connection breakdown ${timingBreakdown}`);
      
      if (this.settings.webdriver.debug_timing) {
        // eslint-disable-next-line no-console
        console.info(`[Timing] Total connection time: ${timing.total}ms`);
        // eslint-disable-next-line no-console
        console.info(`[Timing] Detailed breakdown: options=${timing.createOptions}ms, service=${serviceTime}ms, driver=${timing.driverCreation}ms, export=${timing.sessionExport}ms`);
      }
      
      await this.showConnectInfo({startTime, host, port, start_process, sessionInfo, timingBreakdown});

      return {
        sessionId,
        capabilities,
        host,
        port
      };
    } catch (err) {
      const error = this.handleConnectError(err, host, port);
      this.showConnectSpinner(colors.red(`Failed to connect to ${this.serviceName} on ${host} with ${colors.stack_trace(portStr)}.`), 'warn');

      throw error;
    }
  }

  ////////////////////////////////////////////////////////////////////
  // Output related
  ////////////////////////////////////////////////////////////////////
  async showConnectInfo({startTime, port, host, start_process, sessionInfo, timingBreakdown}) {
    if (!this.parallelMode) {
      const totalTime = new Date() - startTime;
      const timingInfo = timingBreakdown ? ` ${colors.stack_trace(timingBreakdown)}` : '';
      const connectMsg = `Connected to ${colors.stack_trace(start_process ? this.serviceName : host)} on port ${colors.stack_trace(port)} ${colors.stack_trace('(' + totalTime + 'ms)')}.${timingInfo}`;
      this.showConnectSpinner(connectMsg);
      
      // Also log to console to ensure it's always visible
      if (timingBreakdown) {
        // eslint-disable-next-line no-console
        console.info(`  ${connectMsg.replace(/\u001b\[[0-9;]*m/g, '')}`); // Strip ANSI colors for console
      }
    }

    if (this.outputEnabled) {
      const {platform, browserVersion, platformVersion, browserName, appId} = sessionInfo;

      const appName = appId.split('.').pop() || browserName;
      const appVersion = browserVersion && ` (${browserVersion})`;
      const platName = platform.toUpperCase();
      const platVersion = platformVersion && ` (${platformVersion})`;

      // eslint-disable-next-line no-console
      console.info(`  Using: ${colors.light_blue(appName)}${colors.brown(appVersion)} on ${colors.cyan(platName + platVersion)}.\n`);
    }
  }

  showConnectSpinner(msg, method = 'info') {
    if (!this.outputEnabled || this.parallelMode) {
      return;
    }

    if (this.connectSpinner) {
      this.connectSpinner[method](msg);
    } else {
      this.connectSpinner = ora(msg).start();
    }
  }

  ////////////////////////////////////////////////////////////////////
  // Elements related
  ////////////////////////////////////////////////////////////////////
  getElementId(resultValue) {
    return resultValue[this.elementKey];
  }

  toElement(resultValue) {
    return {[this.elementKey]: resultValue};
  }

  mapWebElementIds(value) {
    if (Array.isArray(value)) {
      return value.reduce((prev, item) => {
        prev.push(this.getElementId(item));

        return prev;
      }, []);
    }

    return value;
  }

  /**
   * Helper method
   *
   * @param {String} protocolAction
   * @param {Object} executeArgs
   * @return {Promise}
   */
  executeProtocolAction(protocolAction, executeArgs) {
    if (isObject(protocolAction) && protocolAction.actionName) {
      const {actionName, args, sessionId = this.nightwatchInstance.sessionId} = protocolAction;

      return this.Actions.session[actionName]({
        args,
        sessionId,
        sessionRequired: true
      });
    }

    return this.Actions.session[protocolAction]({
      args: executeArgs,
      sessionId: this.nightwatchInstance.sessionId,
      sessionRequired: true
    });
  }

  ////////////////////////////////////////////////////////////////////
  // Error handling
  ////////////////////////////////////////////////////////////////////
  handleErrorResponse(result) {
    if (isErrorResponse(result)) {
      // will throw error if w3c response
      throwDecodedError(result);

      // will throw error if legacy response
      checkLegacyResponse(result);
    }
  }

  registerLastError(err, retryCount = 0) {
    this.lastError = err;
    this.retriesCount = retryCount;
  }

  getErrorMessage(result) {
    if (result instanceof Error) {
      return result.message;
    }

    return result.value && result.value.message;
  }

  handleConnectError(err, host, port) {
    const errMsg = `An error occurred while creating a new ${this.serviceName} session:`;

    switch (err.code) {
      case 'ECONNREFUSED':
        err.sessionCreate = true;
        err.message = `${errMsg} Connection refused to ${host}:${port}. If the Webdriver/Selenium service is managed by Nightwatch, check if "start_process" is set to "true".`;
        break;
      default:
        err.message = `${errMsg} [${err.name}] ${err.message}`;
    }

    if (!err.detailedErr && this.driverService) {
      const logPath = this.driverService.getOutputFilePath();
      err.detailedErr = ` Verify if ${this.serviceName} is configured correctly; using:\n  ${this.driverService.getSettingsFormatted()}\n`;
      err.extraDetail = (logPath ? `\n  More info might be available in the log file: ${logPath}` : `\n  Set webdriver.log_path in your Nightwatch config to retrieve more logs from ${this.serviceName}.`);

      if (err.message.includes('Failed to run adb command') || err.message.includes('no devices online')) {
        return new AndroidConnectionError(err);
      }

      if (IosSessionErrors[err.name] && this.api.isSafari() && this.api.isIOS()) {
        return new IosSessionNotCreatedError(err, this.desiredCapabilities);
      }
    }

    err.showTrace = false;
    err.reportShown = true;

    return err;
  }

  isResultSuccess(result = {}) {
    return !(
      (result instanceof Error) ||
      (result.error instanceof Error) ||
      result.status === -1
    );
  }

  getOutputFilePath() {
    return this.driverService.getOutputFilePath();
  }

  getErrorResponse(result) {
    return result instanceof Error ? result : result.error;
  }

  staleElementReference(result) {
    return result instanceof error.StaleElementReferenceError;
  }

  elementClickInterceptedError(result) {
    return result instanceof error.ElementClickInterceptedError;
  }

  invalidElementStateError(result) {
    return result instanceof error.InvalidElementStateError;
  }

  elementNotInteractableError(result) {
    return result instanceof error.ElementNotInteractableError;
  }

  invalidWindowReference(result) {
    return result instanceof error.NoSuchWindowError;
  }

  invalidSessionError(result) {
    return result instanceof error.NoSuchSessionError;
  }

  isRetryableElementError(result) {
    const errorResponse = this.getErrorResponse(result);

    if (errorResponse instanceof WebDriverError && errorResponse.name === 'WebDriverError') {
      const errors = this.getRetryableErrorMessages();

      return errors.some(item => errorResponse.message.includes(item));
    }

    return (
      this.staleElementReference(errorResponse) ||
      this.elementClickInterceptedError(errorResponse) ||
      this.invalidElementStateError(errorResponse) ||
      this.elementNotInteractableError(errorResponse)
    );
  }
}

module.exports = Transport;
