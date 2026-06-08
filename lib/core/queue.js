const EventEmitter = require('events');
const AsyncTree = require('./asynctree.js');
const Utils = require('../utils');
const Node = require('./treenode.js');

class CommandQueue extends EventEmitter {
  constructor({compatMode = false, foreignRunner = false, cucumberRunner = false, mochaRunner = false, client = null} = {}) {
    super();
    this.isDone = false;
    this.compatMode = compatMode;
    this.tree = new AsyncTree({compatMode, foreignRunner, cucumberRunner, mochaRunner, client});
    this.scheduleTimeoutId = null;
  }

  get currentNode() {
    return this.tree.currentNode;
  }

  get started() {
    return this.tree.rootNode.started;
  }

  shouldStartQueue() {
    const childNodes = this.currentNode.childNodes;
    const allChildNodesDone = childNodes.every(function(node) {
      return node.done;
    });

    return this.currentNode.started && allChildNodesDone;
  }

  add(command) {
    const {commandName, commandFn, context = {}, args, stackTrace, namespace, options = {}, deferred, isES6Async, rejectPromise} = command;
    const {compatMode} = this;
    const parentContext = this.currentNode.context;

    if (!this.deferred) {
      this.deferred = Utils.createPromise();
    }

    const node = new Node({
      name: commandName,
      parent: this.currentNode,
      namespace,
      stackTrace,
      deferred,
      isES6Async,
      rejectPromise,
      compatMode,
      addedInsideCallback: parentContext && parentContext.addedInsideCallback
    });

    if (this.currentNode.instance && this.currentNode.instance.isES6AsyncCommand) {
      node.isES6Async = true;
    }

    node.setCommand(commandFn, context, args, options);

    const initialChildNode = this.shouldStartQueue();

    if (context && context.module && context.module.autoInvoke) {
      return node;
    }

    this.tree.addNode(node);

    if (this.currentNode.done || !this.currentNode.started || initialChildNode) {
      this.scheduleTraverse();
    }

    return node;
  }

  scheduleTraverse() {
    if (this.scheduleTimeoutId) {
      clearTimeout(this.scheduleTimeoutId);
    }

    this.scheduleTimeoutId = setTimeout(() => this.traverse(), 0);
  }

  clearScheduled() {
    if (this.scheduleTimeoutId) {
      clearTimeout(this.scheduleTimeoutId);
    }
  }

  empty() {
    this.tree.empty();

    return this;
  }

  reset() {
    this.tree.reset();

    return this;
  }

  traverse() {
    this.tree
      .traverse()
      .catch(err => {
        return err;
      })
      .then(err => {
        const args = [];
        if (err instanceof Error) {
          //Logger.error(err);
          args.push(err);
        }

        this.done.apply(this, args);
      });

    return this;
  }

  get inProgress() {
    return this.tree.rootNode.childNodes.length > 0;
  }

  done(err) {
    if (this.tree.rootNode.childNodes.length > 0) {
      return this;
    }

    err = err || this.tree.returnError;

    this.emit('queue:finished', err);
    // when using third-party test runners (e.g. cucumber), sometimes the previous error is not cleared
    this.tree.returnError = null;

    if (this.deferred) {
      this.deferred.resolve(err);
      this.deferred = null;
    }
  }

  waitForCompletion() {
    if (this.deferred) {
      return this.deferred.promise;
    }

    return Promise.resolve();
  }

  /**
   * Drain the command queue at a Cucumber scenario boundary (e.g. forceUnquit / session reuse).
   * Waits briefly for in-flight commands, then clears pending nodes and stale tree listeners
   * so commands from a finished scenario cannot bleed into the next one.
   *
   * @param {{timeoutMs?: number}} [options]
   */
  async drainScenarioQueue({timeoutMs = 250} = {}) {
    if (timeoutMs > 0) {
      await Promise.race([
        this.waitForCompletion(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } else {
      await this.waitForCompletion();
    }

    this.clearScheduled();

    for (const child of [...(this.tree.rootNode.childNodes || [])]) {
      if (!child.started && child.deferred && !child.promiseSettled) {
        child.reject(Object.assign(new Error('Command queue drained at scenario boundary'), {
          scenarioBoundaryDrain: true,
          abortOnFailure: false
        }));
      }
    }

    this.tree.currentTestCaseResult = null;
    this.tree.returnError = null;
    this.tree.removeAllListeners('asynctree:finished');
    this.tree.empty();
    this.tree.createRootNode();
    this.empty();
    this.reset();
    this.isDone = false;

    if (this.deferred) {
      this.deferred.resolve(null);
      this.deferred = null;
    }
  }

  run(currentTestCaseResult) {
    this.tree.currentTestCaseResult = currentTestCaseResult;
    if (this.tree.started) {
      return this;
    }

    if (!this.deferred) {
      this.deferred = Utils.createPromise();
    }
    this.scheduleTraverse();

    return this.deferred.promise;
  }
}

module.exports = CommandQueue;
