const assert = require('assert');
const Nightwatch = require('../../../../lib/nightwatch.js');
const MockServer = require('../../../../lib/mockserver.js');
const CommandGlobals = require('../../../../lib/globals/commands.js');

const SESSION = '13521-10219-202';
const ELEMENT_ID = '5cc459b8-36a8-3042-8b4a-258883ea642b';
const W3C_KEY = 'element-6066-11e4-a52e-4f735466cecf';

const iosCapabilities = {
  'appium:automationName': 'XCUITest',
  browserName: null,
  'appium:bundleId': 'com.bereal.sandbox',
  platformName: 'iOS',
  'appium:deviceName': 'iPhone 15',
  'appium:platformVersion': '17.5'
};

const androidCapabilities = {
  'appium:automationName': 'UiAutomator2',
  browserName: null,
  'appium:appPackage': 'com.bereal.sandbox',
  platformName: 'android',
  'appium:deviceName': 'Pixel 7'
};

function initClient(settings = {}, desiredCapabilities = iosCapabilities) {
  // The yaml fixtures only carry a session mock for one hard-coded capability set,
  // so register a permissive one (no postdata = matches any POST /wd/hub/session).
  MockServer.addMock({
    url: '/wd/hub/session',
    method: 'POST',
    statusCode: 201,
    response: {value: {sessionId: SESSION, capabilities: desiredCapabilities}}
  }, true);

  MockServer.addMock({
    url: `/wd/hub/session/${SESSION}`,
    method: 'DELETE',
    response: {value: null}
  }, true);

  return Nightwatch.initW3CClient(Object.assign({
    output: false,
    silent: true,
    selenium: {
      start_process: false,
      use_appium: true,
      port: 10195,
      host: 'localhost'
    },
    desiredCapabilities
  }, settings));
}

/**
 * Registers a mock and reports whether it was actually hit, so a test can assert
 * that a round trip did *not* happen.
 */
function trackedMock(spec) {
  const tracker = {called: 0};
  MockServer.addMock(Object.assign({}, spec, {
    onRequest() {
      tracker.called++;
    }
  }), true);

  return tracker;
}

describe('iOS fast element lookup (POST /element + inline displayed)', function() {
  beforeEach(function(done) {
    CommandGlobals.beforeEach.call(this, done);
  });

  afterEach(function(done) {
    CommandGlobals.afterEach.call(this, done);
  });

  it('assert.visible uses POST /element and the inline `displayed` attribute', function(done) {
    initClient().then(client => {
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      // Registered but must never be hit: `displayed` already came with the element.
      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      client.api.assert.visible({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(find.called, 1, 'expected exactly one POST /element');
          assert.strictEqual(displayed.called, 0, 'expected no GET /displayed round trip');
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('assert.visible falls back to GET /displayed when the attribute is absent', function(done) {
    initClient().then(client => {
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        // compact responses on: only the element id comes back
        response: {value: {[W3C_KEY]: ELEMENT_ID}}
      });

      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      client.api.assert.visible({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(find.called, 1);
          assert.strictEqual(displayed.called, 1, 'expected the GET /displayed fallback');
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('inline `displayed: false` is reported as not visible, still without a GET /displayed', function(done) {
    initClient().then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: false}}
      }, true);

      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      let result = null;
      client.api.isVisible({selector: 'Received (1)', locateStrategy: 'accessibility id'}, function(res) {
        result = res;
      });

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(result.value, false);
          assert.strictEqual(displayed.called, 0, 'expected no GET /displayed round trip');
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('works with -ios class chain selectors', function(done) {
    initClient().then(client => {
      const selector = '**/XCUIElementTypeButton[`name CONTAINS "friend request"`]';
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: '-ios class chain', value: selector},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      client.api.assert.visible({selector, locateStrategy: '-ios class chain'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(find.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('works with xpath selectors', function(done) {
    initClient().then(client => {
      const selector = '//XCUIElementTypeStaticText[@name="bereal12"]';
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'xpath', value: selector},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      client.api.assert.visible({selector, locateStrategy: 'xpath'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(find.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('keeps POST /elements for selectors using index (filtering)', function(done) {
    initClient().then(client => {
      const singular = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Cell'},
        response: {value: {[W3C_KEY]: 'wrong-one'}}
      });

      const plural = trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Cell'},
        response: {
          value: [{[W3C_KEY]: 'first'}, {[W3C_KEY]: ELEMENT_ID}, {[W3C_KEY]: 'third'}]
        }
      });

      const click = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/click`,
        method: 'POST',
        response: {value: null}
      });

      client.api.click({selector: 'Cell', locateStrategy: 'accessibility id', index: 1});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(singular.called, 0, 'index selectors must not use POST /element');
          assert.strictEqual(plural.called, 1);
          assert.strictEqual(click.called, 1, 'expected the indexed element to be the one clicked');
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('keeps POST /elements when throwOnMultipleElementsReturned is on', function(done) {
    initClient({globals: {throwOnMultipleElementsReturned: true}}).then(client => {
      const singular = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      const plural = trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: [{[W3C_KEY]: ELEMENT_ID}]}
      });

      trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      client.api.assert.visible({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(singular.called, 0);
          assert.strictEqual(plural.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('keeps POST /elements on Android', function(done) {
    initClient({}, androidCapabilities).then(client => {
      const singular = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      const plural = trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: [{[W3C_KEY]: ELEMENT_ID}]}
      });

      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      client.api.assert.visible({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(singular.called, 0, 'Android must keep the existing path');
          assert.strictEqual(plural.called, 1);
          assert.strictEqual(displayed.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('assert.elementPresent still uses POST /elements', function(done) {
    initClient().then(client => {
      const singular = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID}}
      });

      const plural = trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: [{[W3C_KEY]: ELEMENT_ID}]}
      });

      client.api.assert.elementPresent({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(singular.called, 0);
          assert.strictEqual(plural.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('browser.elements() still returns every match through POST /elements', function(done) {
    initClient().then(client => {
      trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Cell'},
        response: {value: [{[W3C_KEY]: 'a'}, {[W3C_KEY]: 'b'}, {[W3C_KEY]: 'c'}]}
      });

      let count = null;
      client.api.elements('accessibility id', 'Cell', function(result) {
        count = result.value.length;
      });

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(count, 3);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('recovers from a stale element by re-resolving through POST /element', function(done) {
    initClient().then(client => {
      const firstFind = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: 'stale-id'}}
      });

      trackedMock({
        url: `/wd/hub/session/${SESSION}/element/stale-id/click`,
        method: 'POST',
        statusCode: 404,
        response: {
          value: {error: 'stale element reference', message: 'stale element reference', stacktrace: ''}
        }
      });

      const secondFind = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID}}
      });

      const click = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/click`,
        method: 'POST',
        response: {value: null}
      });

      let result = null;
      client.api.click({selector: 'Received (1)', locateStrategy: 'accessibility id'}, function(res) {
        result = res;
      });

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(firstFind.called, 1);
          assert.strictEqual(secondFind.called, 1, 'expected a fresh POST /element after the stale error');
          assert.strictEqual(click.called, 1);
          assert.strictEqual(result.value, null);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('reports a NoSuchElementError when POST /element finds nothing', function(done) {
    initClient({
      globals: {
        waitForConditionTimeout: 150,
        waitForConditionPollInterval: 50,
        retryAssertionTimeout: 0,
        abortOnAssertionFailure: false,
        abortOnElementLocateError: false
      }
    }).then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Nope'},
        statusCode: 404,
        times: 20,
        response: {
          value: {error: 'no such element', message: 'unable to find an element', stacktrace: ''}
        }
      });

      let result = null;
      client.api.isVisible(
        {selector: 'Nope', locateStrategy: 'accessibility id', suppressNotFoundErrors: true},
        function(res) {
          result = res;
        }
      );

      client.start(function() {
        try {
          assert.notStrictEqual(result, null);
          assert.notStrictEqual(result.value, true);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  // Note: on a genuinely absent element `assert.not.visible` reports
  // "element could not be located" and fails - that is stock Nightwatch behaviour on
  // both the legacy and the fast path, and is deliberately left unchanged here.
  // What these two tests pin down is only how long the *element lookup* is allowed
  // to poll before giving up.
  it('assert.not.visible caps the element lookup at waitForElementAbsentTimeout', function(done) {
    initClient({
      globals: {
        waitForConditionTimeout: 8000,
        waitForConditionPollInterval: 50,
        waitForElementAbsentTimeout: 300,
        retryAssertionTimeout: 0,
        abortOnAssertionFailure: false
      }
    }).then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Gone'},
        statusCode: 404,
        times: 200,
        response: {
          value: {error: 'no such element', message: 'unable to find an element', stacktrace: ''}
        }
      });

      const startTime = Date.now();
      client.api.assert.not.visible({selector: 'Gone', locateStrategy: 'accessibility id'});

      client.start(function() {
        const elapsed = Date.now() - startTime;
        try {
          assert.ok(elapsed < 3000,
            `expected the absent lookup to give up near waitForElementAbsentTimeout, took ${elapsed}ms`);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('an explicit selector timeout still wins over waitForElementAbsentTimeout', function(done) {
    initClient({
      globals: {
        waitForConditionTimeout: 8000,
        waitForConditionPollInterval: 50,
        waitForElementAbsentTimeout: 50,
        retryAssertionTimeout: 0,
        abortOnAssertionFailure: false
      }
    }).then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Gone'},
        statusCode: 404,
        times: 200,
        response: {
          value: {error: 'no such element', message: 'unable to find an element', stacktrace: ''}
        }
      });

      const startTime = Date.now();
      client.api.assert.not.visible({selector: 'Gone', locateStrategy: 'accessibility id', timeout: 900});

      client.start(function() {
        const elapsed = Date.now() - startTime;
        try {
          assert.ok(elapsed >= 800,
            `expected the explicit 900ms timeout to be honoured, took ${elapsed}ms`);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('a positive assert.visible keeps the full waitForConditionTimeout', function(done) {
    initClient({
      globals: {
        waitForConditionTimeout: 900,
        waitForConditionPollInterval: 50,
        waitForElementAbsentTimeout: 50,
        retryAssertionTimeout: 0,
        abortOnAssertionFailure: false
      }
    }).then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Gone'},
        statusCode: 404,
        times: 200,
        response: {
          value: {error: 'no such element', message: 'unable to find an element', stacktrace: ''}
        }
      });

      const startTime = Date.now();
      client.api.assert.visible({selector: 'Gone', locateStrategy: 'accessibility id'});

      client.start(function() {
        const elapsed = Date.now() - startTime;
        try {
          assert.ok(elapsed >= 800,
            `a non-negated assertion must keep the full timeout, took ${elapsed}ms`);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  it('report_command_timings prints a one-line summary for click', function(done) {
    initClient({report_command_timings: true, detailed_output: true, output: true}).then(client => {
      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID}}
      }, true);

      MockServer.addMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/click`,
        method: 'POST',
        response: {value: null}
      }, true);

      const lines = [];
      const originalLog = console.log;
      // eslint-disable-next-line no-console
      console.log = function(...args) {
        lines.push(args.join(' '));
      };

      client.api.click({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        // eslint-disable-next-line no-console
        console.log = originalLog;
        try {
          assert.strictEqual(err, undefined, err && err.message);
          const timingLine = lines.find(line => line.includes('Clicked element'));
          assert.ok(timingLine, `expected a "Clicked element" timing line, got:\n${lines.join('\n')}`);
          assert.ok(/\(\d+ms\)/.test(timingLine), `expected an elapsed time in "${timingLine}"`);
          assert.ok(timingLine.includes('Received (1)'), `expected the selector in "${timingLine}"`);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });

  // Mirrors what qa-framework/commands/assertVisibleAndClick.ts does: one lookup,
  // then the click reuses the resolved id through `WebdriverElementId`.
  it('assert-visible-then-click resolves the selector once (2 round trips)', function(done) {
    initClient({always_async_commands: true}).then(async client => {
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      const click = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/click`,
        method: 'POST',
        response: {value: null}
      });

      try {
        const locator = {selector: 'Received (1)', locateStrategy: 'accessibility id'};
        const found = await client.api.findElement(Object.assign({suppressNotFoundErrors: true}, locator));

        assert.strictEqual(typeof found.getId, 'function');
        assert.strictEqual(found.getId(), ELEMENT_ID);
        assert.strictEqual(found.displayed, true, 'visibility must come back with the lookup');

        await client.api.click(Object.assign({WebdriverElementId: found.getId()}, locator));

        assert.strictEqual(find.called, 1, 'expected exactly one element lookup');
        assert.strictEqual(displayed.called, 0, 'expected no GET /displayed');
        assert.strictEqual(click.called, 1);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('a click reusing WebdriverElementId performs no lookup at all', function(done) {
    initClient({always_async_commands: true}).then(async client => {
      const find = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      const click = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/click`,
        method: 'POST',
        response: {value: null}
      });

      try {
        await client.api.click({
          selector: 'Received (1)',
          locateStrategy: 'accessibility id',
          WebdriverElementId: ELEMENT_ID
        });

        assert.strictEqual(find.called, 0);
        assert.strictEqual(click.called, 1);
        done();
      } catch (e) {
        done(e);
      }
    });
  });

  it('ios_fast_element_lookup: false restores POST /elements', function(done) {
    initClient({ios_fast_element_lookup: false}).then(client => {
      const singular = trackedMock({
        url: `/wd/hub/session/${SESSION}/element`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: {[W3C_KEY]: ELEMENT_ID, displayed: true}}
      });

      const plural = trackedMock({
        url: `/wd/hub/session/${SESSION}/elements`,
        method: 'POST',
        postdata: {using: 'accessibility id', value: 'Received (1)'},
        response: {value: [{[W3C_KEY]: ELEMENT_ID}]}
      });

      const displayed = trackedMock({
        url: `/wd/hub/session/${SESSION}/element/${ELEMENT_ID}/displayed`,
        method: 'GET',
        response: {value: true}
      });

      client.api.assert.visible({selector: 'Received (1)', locateStrategy: 'accessibility id'});

      client.start(function(err) {
        try {
          assert.strictEqual(err, undefined, err && err.message);
          assert.strictEqual(singular.called, 0);
          assert.strictEqual(plural.called, 1);
          assert.strictEqual(displayed.called, 1);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });
});
