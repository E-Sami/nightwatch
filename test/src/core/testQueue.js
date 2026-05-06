const assert = require('assert');
const Globals = require('../../lib/globals/expect.js');
const Nocks = require('../../lib/nocks.js');

describe('test Queue', function () {
  beforeEach(function (done) {
    Globals.beforeEach.call(this, {
      silent: true,
      output: false
    }, () => {
      this.client.queue.reset();
      done();
    });
  });

  afterEach(function (done) {
    Globals.afterEach.call(this, done);
  });

  it('Test commands queue', function () {
    let client = this.client;
    let queue = client.queue;
    let urlCommand;
    let endCommand;
    Nocks.url().deleteSession();

    client.api.url('http://localhost').end();

    assert.strictEqual(queue.tree.rootNode.childNodes.length, 2);
    urlCommand = queue.tree.rootNode.childNodes[0];
    endCommand = queue.tree.rootNode.childNodes[1];

    assert.strictEqual(endCommand.done, false);
    assert.strictEqual(urlCommand.done, false);
    assert.strictEqual(endCommand.started, false);

    return this.client.start(err => {
      if (err) {
        throw err;
      }
      assert.strictEqual(urlCommand.started, true);
      assert.strictEqual(urlCommand.done, true);
      assert.strictEqual(endCommand.childNodes.length, 1);
      assert.strictEqual(endCommand.done, true);
      assert.strictEqual(queue.tree.rootNode.childNodes.length, 0);
    });
  });

  it('calls globals.onCommandFinished when command completes', function() {
    let hookCalled = 0;
    let hookPayload;

    this.client.settings.globals.onCommandFinished = async function(browser, payload) {
      hookCalled++;
      hookPayload = payload;

      await new Promise(resolve => setTimeout(resolve, 5));
      assert.strictEqual(browser, this.client.api);
    }.bind(this);

    this.client.api.perform(() => null);

    return this.client.start(err => {
      if (err) {
        throw err;
      }

      assert.strictEqual(hookCalled, 1);
      assert.strictEqual(hookPayload.fullName, 'perform');
      assert.strictEqual(hookPayload.status, 'success');
      assert.strictEqual(typeof hookPayload.elapsedTime, 'number');
    });
  });

  it('does not invoke command finished hook when not configured', function() {
    this.client.settings.globals.onCommandFinished = undefined;

    const AsyncTreeClass = this.client.queue.tree.constructor;
    const originalCreatePayload = AsyncTreeClass.createCommandFinishedPayload;
    AsyncTreeClass.createCommandFinishedPayload = function() {
      throw new Error('Payload must not be created when hook is not configured.');
    };

    this.client.api.perform(() => null);

    return this.client.start(err => {
      AsyncTreeClass.createCommandFinishedPayload = originalCreatePayload;

      if (err) {
        throw err;
      }
    });
  });

  it('passes expected payload shape to globals.onCommandFinished', function() {
    const payloads = [];

    this.client.settings.globals.onCommandFinished = function(browser, payload) {
      payloads.push({browser, payload});

      return Promise.resolve();
    };

    this.client.api.perform(() => {
      throw new Error('payload-shape-error');
    });

    return this.client.start(err => {
      assert.ok(err instanceof Error);
      assert.strictEqual(payloads.length, 1);
      assert.strictEqual(payloads[0].browser, this.client.api);

      const {payload} = payloads[0];
      assert.strictEqual(payload.name, 'perform');
      assert.strictEqual(payload.fullName, 'perform');
      assert.ok(Array.isArray(payload.args));
      assert.strictEqual(payload.status, 'error');
      assert.strictEqual(payload.result, null);
      assert.strictEqual(payload.error.name, 'Error');
      assert.strictEqual(payload.error.message, 'Error while running "perform" command: payload-shape-error');
      assert.strictEqual(typeof payload.elapsedTime, 'number');
    });
  });
});
