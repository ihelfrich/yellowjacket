import assert from 'node:assert/strict';

function fakeNode(name, log) {
  const connections = new Set();
  return {
    name,
    connections,
    gain: {
      value: 1,
      calls: [],
      setTargetAtTime(value, time, constant) {
        this.value = value;
        this.calls.push([value, time, constant]);
      },
      setValueAtTime(value, time) {
        this.value = value;
        this.calls.push(['setValue', value, time]);
      },
      linearRampToValueAtTime(value, time) {
        this.value = value;
        this.calls.push(['ramp', value, time]);
      },
    },
    connect(target) {
      connections.add(target);
      log.push(['connect', name, target.name]);
      return target;
    },
    disconnect(target) {
      if (target) connections.delete(target);
      else connections.clear();
      log.push(['disconnect', name, target && target.name]);
    },
  };
}

function directFixture() {
  const log = [];
  const context = {
    currentTime: 0,
    destination: fakeNode('destination', log),
    createGain: () => fakeNode('gain-' + log.length, log),
    async setSinkId(id) { log.push(['sink', id]); },
  };
  return { log, context, input: fakeNode('input', log) };
}

function bridgeFixture() {
  const fixture = directFixture();
  delete fixture.context.setSinkId;
  const streamDestination = fakeNode('stream-destination', fixture.log);
  streamDestination.stream = Object.freeze({ id: 'bridge-stream' });
  fixture.context.createMediaStreamDestination = () => streamDestination;
  const element = {
    name: 'bridge-element', srcObject: null, sinkId: null, paused: false,
    async setSinkId(id) { fixture.log.push(['element-sink', id]); this.sinkId = id; },
    async play() { fixture.log.push(['play']); },
    pause() { fixture.log.push(['pause']); this.paused = true; },
  };
  return { ...fixture, streamDestination, element };
}

function assertRouterFixtures() {
  const fixture = directFixture();
  assert.equal(fixture.context.destination.name, 'destination');
  assert.equal(typeof fixture.context.createGain, 'function');
  assert.equal(typeof fixture.input.connect, 'function');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settleUntil(predicate, label) {
  for (let turn = 0; turn < 24; turn++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(label);
}

assertRouterFixtures();
const { AudioOutputRouter, SYSTEM_DEFAULT_OUTPUT } =
  await import('../js/audio-output-router.js');
const { Engine } = await import('../js/audio-engine.js');

function newDirectRouter(fixture = directFixture()) {
  return {
    fixture,
    router: new AudioOutputRouter({
      context: fixture.context,
      input: fixture.input,
      createAudioElement() { throw new Error('direct route must not create an element'); },
    }),
  };
}

async function defaultRouteStartsReadyAndOwnsOneAudibleTail() {
  const { fixture, router } = newDirectRouter();
  assert.equal((await router.select(SYSTEM_DEFAULT_OUTPUT)).active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(router.state.mechanism, 'context-default');
  assert.equal(router.state.status, 'ready');
  const connects = fixture.log.filter(([kind]) => kind === 'connect');
  assert.equal(connects.length, 2);
  assert.equal(connects[0][1], 'input');
  assert.equal(connects[1][2], 'destination');
}

async function newestIntentWinsAdversarialSinkPromises() {
  const fixture = directFixture();
  const a = deferred();
  const b = deferred();
  fixture.context.setSinkId = (id) => {
    fixture.log.push(['sink', id]);
    if (id === 'speaker-a') return a.promise;
    if (id === 'speaker-b') return b.promise;
    return Promise.resolve();
  };
  const { router } = newDirectRouter(fixture);
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selectingA = router.select('speaker-a');
  await Promise.resolve();
  const selectingB = router.select('speaker-b');
  a.resolve();
  await selectingA;
  b.reject(new DOMException('gone', 'NotFoundError'));
  await assert.rejects(selectingB, /gone/);
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(router.state.status, 'ready');
  assert.equal(fixture.log.filter((row) => row[0] === 'sink' && row[1] === '').length, 1,
    'default is explicitly restored after the stale direct-sink mutation');
}

async function elementBridgeMustPassSetSinkAndPlayBeforeCommit() {
  const fixture = bridgeFixture();
  const sink = deferred();
  const playing = deferred();
  fixture.element.setSinkId = (id) => { fixture.log.push(['element-sink', id]); return sink.promise; };
  fixture.element.play = () => { fixture.log.push(['play']); return playing.promise; };
  const router = new AudioOutputRouter({
    context: fixture.context,
    input: fixture.input,
    createAudioElement: () => fixture.element,
  });
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selecting = router.select('speaker-a');
  await Promise.resolve();
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  sink.resolve();
  await Promise.resolve();
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  playing.resolve();
  assert.equal((await selecting).active, 'speaker-a');
  assert.equal(router.state.mechanism, 'element-sink');
  assert.equal(fixture.streamDestination.channelCount, 2);
  assert.equal(fixture.streamDestination.channelCountMode, 'explicit');
  assert.equal(fixture.streamDestination.channelInterpretation, 'speakers');
  assert.equal(fixture.element.srcObject, fixture.streamDestination.stream);
  assert.ok(fixture.log.some((row) => row[0] === 'disconnect' && row[1] === 'input'),
    'the default route is disconnected before bridge output becomes audible');
}

async function staleBridgeCompletionCannotDeafenOrReassignNewerRoute() {
  const fixture = bridgeFixture();
  const a = deferred();
  fixture.element.setSinkId = (id) => {
    fixture.log.push(['element-sink', id]);
    if (id === 'speaker-a') {
      return a.promise.then(() => { fixture.element.sinkId = id; });
    }
    fixture.element.sinkId = id;
    return Promise.resolve();
  };
  const router = new AudioOutputRouter({
    context: fixture.context, input: fixture.input, createAudioElement: () => fixture.element,
  });
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selectingA = router.select('speaker-a');
  await Promise.resolve();
  const selectingB = router.select('speaker-b');
  await Promise.resolve();
  a.resolve();
  await Promise.all([selectingA, selectingB]);
  const [bridgeGain] = fixture.input.connections;
  assert.equal(router.state.active, 'speaker-b');
  assert.equal(router.state.status, 'ready');
  assert.equal(bridgeGain.gain.value, 1, 'the committed bridge tail stays audible');
  assert.equal(fixture.element.sinkId, 'speaker-b', 'the newer physical sink remains assigned');
}

async function bridgeFailuresKeepTheVerifiedDefaultRoute() {
  for (const [stage, message] of [
    ['setSinkId', 'sink rejected'],
    ['play', 'play rejected'],
  ]) {
    const fixture = bridgeFixture();
    fixture.element[stage] = async () => { throw new Error(message); };
    const router = new AudioOutputRouter({
      context: fixture.context, input: fixture.input, createAudioElement: () => fixture.element,
    });
    await router.select(SYSTEM_DEFAULT_OUTPUT);
    await assert.rejects(router.select('speaker-a'), new RegExp(message));
    assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT, stage);
    assert.equal(router.state.status, 'ready', stage);
    assert.equal(fixture.input.connections.size, 1, stage);
  }
}

async function directRollbackFailureFailsClosed() {
  const fixture = directFixture();
  const a = deferred();
  fixture.context.setSinkId = (id) => {
    fixture.log.push(['sink', id]);
    if (id === 'speaker-a') return a.promise;
    if (id === '') return Promise.reject(new Error('rollback rejected'));
    return Promise.resolve();
  };
  const { router } = newDirectRouter(fixture);
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const stale = router.select('speaker-a');
  await Promise.resolve();
  const newer = router.select('speaker-b');
  a.resolve();
  await assert.rejects(stale, /rollback rejected/);
  await newer;
  assert.equal(router.state.safetyMuted, true);
  assert.equal(router.state.status, 'fault');
  assert.equal(fixture.input.gain.value, 1, 'fault uses route safety gain, never app gain');
  router.clearSafetyMute();
  await router.select('speaker-b');
  assert.equal(router.state.active, 'speaker-b', 'verified readiness releases a fault latch');
}

async function rapidAThenBThenDefaultLeavesDefaultActive() {
  const fixture = directFixture();
  const a = deferred();
  fixture.context.setSinkId = (id) => {
    fixture.log.push(['sink', id]);
    if (id === 'speaker-a') return a.promise;
    return Promise.resolve();
  };
  const { router } = newDirectRouter(fixture);
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selectingA = router.select('speaker-a');
  await Promise.resolve();
  const selectingB = router.select('speaker-b');
  const selectingDefault = router.select(SYSTEM_DEFAULT_OUTPUT);
  a.resolve();
  await Promise.all([selectingA, selectingB, selectingDefault]);
  assert.equal(router.state.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(router.state.mechanism, 'context-default');
  assert.equal(fixture.log.filter((row) => row[0] === 'sink' && row[1] === 'speaker-b').length, 0);
}

async function duplicateCommittedDeviceDoesNotMutateTheSinkAgain() {
  const { fixture, router } = newDirectRouter();
  await router.select('speaker-a');
  const before = fixture.log.filter((row) => row[0] === 'sink').length;
  const state = await router.select('speaker-a');
  assert.equal(state.active, 'speaker-a');
  assert.equal(fixture.log.filter((row) => row[0] === 'sink').length, before);
}

async function volumeAndMuteUseExactlyOneAppGainStage() {
  const { fixture, router } = newDirectRouter();
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const [routeGain] = fixture.input.connections;
  router.setVolume(0.5);
  assert.equal(fixture.input.gain.value, 0.5);
  assert.equal(routeGain.gain.value, 1, 'the committed private route gain stays unity');
  assert.equal(router.state.volume, 0.5);
  assert.equal(fixture.input.gain.calls.at(-1)[2], 0.015);
  router.setMuted(true);
  assert.equal(fixture.input.gain.value, 0);
  assert.equal(routeGain.gain.value, 1, 'mute does not multiply the route gain');
  router.setMuted(false);
  assert.equal(fixture.input.gain.value, 0.5);
  assert.equal(routeGain.gain.value, 1, 'unmute restores only the app gain');
  assert.throws(() => router.setVolume(-0.1), RangeError);
  assert.throws(() => router.setVolume(1.1), RangeError);
  assert.throws(() => router.setVolume(Number.NaN), RangeError);
}

async function statesAreFrozenDetachedSnapshots() {
  const { router } = newDirectRouter();
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const first = router.state;
  assert.equal(Object.isFrozen(first), true);
  router.setVolume(0.25);
  assert.equal(first.volume, 1);
  assert.equal(router.state.volume, 0.25);
}

async function safetyLatchSurvivesVerifiedSwitchUntilExplicitlyCleared() {
  const { fixture, router } = newDirectRouter();
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  router.failClosed('device-lost');
  assert.equal(router.state.safetyMuted, true);
  assert.equal(router.state.status, 'lost');
  await router.select('speaker-a');
  assert.equal(router.state.active, 'speaker-a');
  assert.equal(router.state.safetyMuted, true);
  assert.equal(router.state.status, 'lost');
  assert.equal(fixture.input.gain.value, 1);
  router.clearSafetyMute();
  assert.equal(router.state.safetyMuted, false);
  assert.equal(router.state.status, 'ready');
}

async function disposalIsIdempotentAndTearsDownTheBridge() {
  const fixture = bridgeFixture();
  const router = new AudioOutputRouter({
    context: fixture.context, input: fixture.input, createAudioElement: () => fixture.element,
  });
  await router.select('speaker-a');
  router.dispose();
  router.dispose();
  assert.equal(router.state.status, 'disposed');
  assert.equal(fixture.element.srcObject, null);
  assert.equal(fixture.element.paused, true);
  assert.equal(fixture.input.connections.size, 0);
  await assert.rejects(router.select('speaker-b'), /disposed/);
}

async function disposedDirectMutationCannotReviveTheRouter() {
  const fixture = directFixture();
  const selectingSink = deferred();
  fixture.context.setSinkId = (id) => {
    fixture.log.push(['sink', id]);
    return id === 'speaker-a' ? selectingSink.promise : Promise.resolve();
  };
  const { router } = newDirectRouter(fixture);
  await router.select(SYSTEM_DEFAULT_OUTPUT);
  const selecting = router.select('speaker-a');
  await Promise.resolve();
  router.dispose();
  selectingSink.resolve();
  const result = await selecting;
  assert.equal(result.status, 'disposed');
  assert.equal(router.state.status, 'disposed');
  assert.equal(router.state.active, null);
  assert.equal(router.state.mechanism, null);
  assert.equal(fixture.input.connections.size, 0);
}

async function constructorRejectsOptionAccessorsWithoutReadingThem() {
  for (const key of ['context', 'input', 'createAudioElement']) {
    let read = false;
    const options = {};
    Object.defineProperty(options, key, {
      enumerable: true,
      get() { read = true; throw new Error('must not run'); },
    });
    assert.throws(() => new AudioOutputRouter(options), TypeError, key);
    assert.equal(read, false, key);
  }
}

async function proxyOptionTrapFailuresLeaveNoConnectedRoute() {
  const fixture = directFixture();
  const options = new Proxy({
    context: fixture.context,
    input: fixture.input,
    createAudioElement() {},
  }, {
    getOwnPropertyDescriptor() { throw new Error('descriptor trap'); },
  });
  assert.throws(() => new AudioOutputRouter(options), TypeError);
  assert.equal(fixture.log.length, 0);
}

export const audioOutputRouterCases = [
  defaultRouteStartsReadyAndOwnsOneAudibleTail,
  newestIntentWinsAdversarialSinkPromises,
  elementBridgeMustPassSetSinkAndPlayBeforeCommit,
  staleBridgeCompletionCannotDeafenOrReassignNewerRoute,
  bridgeFailuresKeepTheVerifiedDefaultRoute,
  directRollbackFailureFailsClosed,
  rapidAThenBThenDefaultLeavesDefaultActive,
  duplicateCommittedDeviceDoesNotMutateTheSinkAgain,
  volumeAndMuteUseExactlyOneAppGainStage,
  statesAreFrozenDetachedSnapshots,
  safetyLatchSurvivesVerifiedSwitchUntilExplicitlyCleared,
  disposalIsIdempotentAndTearsDownTheBridge,
  disposedDirectMutationCannotReviveTheRouter,
  constructorRejectsOptionAccessorsWithoutReadingThem,
  proxyOptionTrapFailuresLeaveNoConnectedRoute,
];

function engineNode(name, log) {
  const node = fakeNode(name, log);
  node.connect = (target, ...ports) => {
    node.connections.add(target);
    log.push(['connect', name, target.name, ...ports]);
    return target;
  };
  return node;
}

function fakeContext({ state = 'running', resume, setSinkId, log = [] } = {}) {
  const context = new EventTarget();
  context.state = state;
  context.currentTime = 10;
  context.destination = engineNode('destination', log);
  context.nodes = [];
  context.createGain = () => {
    const gain = engineNode('gain-' + log.length, log);
    context.nodes.push(gain);
    return gain;
  };
  context.setSinkId = setSinkId || (async (id) => { log.push(['sink', id]); });
  context.resume = resume || (() => {
    context.state = 'running';
    return Promise.resolve();
  });
  context.createOscillator = () => {
    const oscillator = engineNode('oscillator', log);
    oscillator.frequency = { value: 0 };
    oscillator.start = (at) => log.push(['start', oscillator.frequency.value, at]);
    oscillator.stop = (at) => log.push(['stop', oscillator.frequency.value, at]);
    return oscillator;
  };
  context.createChannelMerger = (channels) => {
    const merger = engineNode('merger', log);
    merger.channels = channels;
    return merger;
  };
  return context;
}

function engineFixture(options = {}) {
  const log = [];
  const context = options.context || fakeContext({ log, ...options });
  let created = 0;
  const engine = new Engine({
    contextFactory: () => { created++; return context; },
    ...options.engineOptions,
  });
  return { engine, context, log, get created() { return created; } };
}

async function resumeRejectionNeverClaimsReadyOrPlaying() {
  const context = fakeContext({
    state: 'suspended',
    resume: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')),
  });
  const engine = new Engine({ contextFactory: () => context });
  await assert.rejects(() => engine.ensureOutputReady(), (error) => (
    error.name === 'OutputNotReadyError' && error.code === 'OUTPUT_NOT_READY'
  ));
  assert.equal(engine.outputState.status, 'fault');
  assert.equal(engine.playing, false);
}

async function readinessCreatesOnceSynchronouslyAndCoalescesResume() {
  const resume = deferred();
  let resumes = 0;
  const fixture = engineFixture({
    state: 'suspended',
    resume: () => { resumes++; return resume.promise; },
  });
  const { engine, context } = fixture;
  const first = engine.ensureOutputReady();
  assert.equal(fixture.created, 1, 'the context is created in the gesture before the first await');
  const second = engine.ensureOutputReady();
  assert.equal(resumes, 1, 'concurrent callers share one resume');
  context.state = 'running';
  resume.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'ready');
  assert.deepEqual(b, a);
  assert.equal(engine.readyContext, context);
}

async function onlyRunningContextsBecomeReady() {
  for (const state of ['suspended', 'interrupted']) {
    const context = fakeContext({ state, resume: () => Promise.resolve() });
    const engine = new Engine({ contextFactory: () => context });
    await assert.rejects(() => engine.ensureOutputReady(), (error) => (
      error.name === 'OutputNotReadyError' && error.code === 'OUTPUT_NOT_READY'
    ), state + ' context is never claimed ready after resume fulfills');
    assert.throws(() => engine.readyContext,
      (error) => error.name === 'OutputNotReadyError' && error.code === 'OUTPUT_NOT_READY');
  }
}

async function preferencesWaitForReadinessAndConfigureTheOneAppGain() {
  const { engine, context, log, created } = engineFixture();
  engine.configureOutputPreferences({ outputId: 'headphones', volume: 0.25, muted: true });
  assert.equal(created, 0, 'persisted preferences do not create an AudioContext');
  await engine.ensureOutputReady();
  assert.equal(engine.outputState.requested, 'headphones');
  assert.equal(engine.outputState.active, 'headphones');
  assert.equal(engine.outputMeterSource.gain.value, 0,
    'mute applies at the engine app-gain stage before the route');
  assert.ok(log.some((entry) => entry[0] === 'sink' && entry[1] === 'headphones'));
  engine.setOutputMuted(false);
  assert.equal(engine.outputMeterSource.gain.value, 0.25);
  engine.setOutputVolume(0.5);
  assert.equal(engine.outputMeterSource.gain.value, 0.5);
  assert.throws(() => engine.configureOutputPreferences({ volume: 2 }), RangeError);
}

async function readinessWaitsForTheRequestedSinkAndPublishesFrozenState() {
  const sink = deferred();
  const { engine, log } = engineFixture({
    setSinkId: (id) => {
      log.push(['sink', id]);
      return sink.promise;
    },
  });
  engine.configureOutputPreferences({ outputId: 'headphones' });
  const states = [];
  engine.addEventListener('outputstate', (event) => states.push(event.detail));
  let settled = false;
  const ready = engine.ensureOutputReady().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'readiness does not resolve before sink selection');
  assert.equal(engine.outputState.status, 'switching');
  sink.resolve();
  await ready;
  assert.equal(engine.outputState.active, 'headphones');
  assert.equal(states.every(Object.isFrozen), true, 'router state changes emit detached frozen state');
}

async function persistedHintFallsBackButExplicitFailureKeepsVerifiedRoute() {
  const { engine, log } = engineFixture({
    setSinkId: async (id) => {
      log.push(['sink', id]);
      if (id === 'gone') throw new DOMException('gone', 'NotFoundError');
    },
  });
  engine.configureOutputPreferences({ outputId: 'gone', volume: 1, muted: false });
  const reconciled = await engine.ensureOutputReady();
  assert.equal(reconciled.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(reconciled.requested, SYSTEM_DEFAULT_OUTPUT,
    'an unavailable saved hint is reconciled during this explicit gesture');
  assert.equal(reconciled.status, 'ready');
  await assert.rejects(() => engine.selectOutput('gone'), (error) => (
    error.code === 'OUTPUT_NOT_READY' && error.cause?.message === 'gone'
  ));
  assert.equal(engine.outputState.active, SYSTEM_DEFAULT_OUTPUT,
    'a later explicit selection keeps the verified route');
  assert.ok(log.some((entry) => entry[0] === 'sink' && entry[1] === 'gone'),
    'the unavailable preference was attempted before reconciliation');
}

async function staleSelectionBeforeRouterNeverStartsOrCommits() {
  const resume = deferred();
  const { engine, context, log } = engineFixture({
    state: 'suspended',
    resume: () => resume.promise,
  });
  const selectingA = engine.selectOutput('speaker-a');
  const selectingB = engine.selectOutput('speaker-b');
  context.state = 'running';
  resume.resolve();
  await Promise.all([selectingA, selectingB]);
  assert.equal(log.some((entry) => entry[0] === 'sink' && entry[1] === 'speaker-a'), false,
    'a selection superseded before readiness never reaches the router');
  assert.equal(engine._outputPreferences.outputId, 'speaker-b',
    'only the current selection commits the verified preference');
  assert.equal(engine.outputState.active, 'speaker-b');
}

async function staleSelectionCannotBecomeRecoveryPreferenceAfterNewerFailure() {
  const a = deferred();
  const b = deferred();
  const { engine, log } = engineFixture({
    setSinkId: (id) => {
      log.push(['sink', id]);
      if (id === 'speaker-a') return a.promise;
      if (id === 'speaker-b') return b.promise;
      return Promise.resolve();
    },
  });
  await engine.ensureOutputReady();
  const verifiedPreference = engine._outputPreferences.outputId;
  const verifiedGeneration = engine._readyOutputGeneration;

  const selectingA = engine.selectOutput('speaker-a');
  await settleUntil(() => log.some((entry) => entry[0] === 'sink' && entry[1] === 'speaker-a'),
    'the first selection reaches its deferred router operation');
  const selectingB = engine.selectOutput('speaker-b');
  a.resolve();
  await settleUntil(() => log.some((entry) => entry[0] === 'sink' && entry[1] === 'speaker-b'),
    'the newer selection reaches its deferred router operation');
  await selectingA;

  assert.equal(engine._outputPreferences.outputId, verifiedPreference,
    'a stale post-router completion never commits its preference');
  assert.equal(engine._readyOutputGeneration, verifiedGeneration,
    'a stale post-router completion never rewrites the ready generation');
  assert.equal(engine.outputState.status, 'switching',
    'a stale post-router completion never clears the current selection safety boundary');

  const bFailure = assert.rejects(selectingB, (error) => (
    error.code === 'OUTPUT_NOT_READY' && error.cause?.message === 'speaker-b gone'
  ));
  b.reject(new DOMException('speaker-b gone', 'NotFoundError'));
  await bFailure;
  assert.equal(engine._outputPreferences.outputId, verifiedPreference,
    'a failed current selection preserves the prior verified preference');
  assert.equal(engine.outputState.active, SYSTEM_DEFAULT_OUTPUT,
    'router rollback preserves the prior verified route');

  const staleRequestsBeforeRecovery = log.filter((entry) => (
    entry[0] === 'sink' && entry[1] === 'speaker-a'
  )).length;
  engine.handleOutputLoss();
  const recovered = await engine.ensureOutputReady();
  assert.equal(recovered.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(engine.outputState.active, SYSTEM_DEFAULT_OUTPUT);
  assert.equal(log.filter((entry) => entry[0] === 'sink' && entry[1] === 'speaker-a').length,
    staleRequestsBeforeRecovery,
    'recovery never makes the stale selection audible again');
}

async function interruptionAndLossInvalidateBeforeImmutableNotification() {
  const { engine, context } = engineFixture();
  await engine.ensureOutputReady();
  const order = [];
  engine.setOutputInterruptionHandler((code) => order.push(['interrupt', code]));
  engine.addEventListener('outputstate', (event) => {
    order.push(['event', event.detail.status]);
    assert.equal(Object.isFrozen(event.detail), true);
  });
  const before = engine.outputGeneration;
  context.state = 'interrupted';
  context.dispatchEvent(new Event('statechange'));
  assert.equal(engine.outputGeneration, before + 1);
  assert.deepEqual(order.slice(-2), [['interrupt', 'OUTPUT_INTERRUPTED'], ['event', 'lost']]);
  assert.equal(engine.outputState.safetyMuted, true);

  let failures = 0;
  const originalFailClosed = engine._outputRouter.failClosed.bind(engine._outputRouter);
  engine._outputRouter.failClosed = (code) => { failures++; return originalFailClosed(code); };
  const generation = engine.outputGeneration;
  const state = engine.handleOutputLoss('OUTPUT_LOST');
  assert.equal(failures, 1, 'manual output loss fails closed exactly once');
  assert.equal(engine.outputGeneration, generation + 1);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(state.muted, false, 'loss does not edit the persisted user mute');
}

async function everyNonRunningContextStateFailsClosedBeforeNotification() {
  for (const [state, code] of [
    ['suspended', 'OUTPUT_SUSPENDED'],
    ['interrupted', 'OUTPUT_INTERRUPTED'],
    ['closed', 'OUTPUT_CLOSED'],
  ]) {
    const { engine, context } = engineFixture();
    await engine.ensureOutputReady();
    const order = [];
    engine.setOutputInterruptionHandler((received) => order.push(['interrupt', received]));
    engine.addEventListener('outputstate', (event) => order.push(['event', event.detail.status]));
    context.state = state;
    context.dispatchEvent(new Event('statechange'));
    assert.deepEqual(order.slice(-2), [['interrupt', code], ['event', 'lost']], state);
    assert.equal(engine.outputState.safetyMuted, true, state + ' mutes the route');
  }
}

async function testSignalSchedulesBothChannelsOnlyAfterReadiness() {
  const { engine, context, log } = engineFixture();
  await assert.equal(await engine.testOutput(), true);
  const peak = 10 ** (-24 / 20);
  assert.deepEqual(log.filter((entry) => entry[0] === 'start'), [
    ['start', 440, 10], ['start', 660, 10.2],
  ]);
  const stops = log.filter((entry) => entry[0] === 'stop');
  assert.deepEqual(stops.map((entry) => entry.slice(0, 2)), [['stop', 440], ['stop', 660]]);
  assert.ok(Math.abs(stops[0][2] - 10.2) < 1e-12);
  assert.ok(Math.abs(stops[1][2] - 10.4) < 1e-12);
  const signalGains = log
    .filter((entry) => entry[0] === 'connect' && entry[2] === 'merger')
    .map((entry) => entry[1]);
  assert.equal(signalGains.length, 2, 'test signal uses two local gain nodes');
  assert.equal(engine.outputMeterSource.gain.value, 1,
    'the output test leaves the app gain at unity by default');
  for (const [index, name] of signalGains.entries()) {
    const gain = context.nodes.find((node) => node.name === name);
    const start = 10 + index * 0.2;
    const calls = gain.gain.calls;
    assert.deepEqual(calls.map((entry) => entry.slice(0, 2)), [
      ['setValue', 0], ['ramp', peak], ['setValue', peak], ['ramp', 0],
    ]);
    for (const [actual, expected] of calls.map((entry, i) => [entry[2],
      [start, start + 0.005, start + 0.195, start + 0.2][i]])) {
      assert.ok(Math.abs(actual - expected) < 1e-12);
    }
  }

  const blocked = engineFixture({
    state: 'suspended',
    resume: () => Promise.reject(new DOMException('blocked', 'NotAllowedError')),
  });
  await assert.rejects(() => blocked.engine.testOutput(), (error) => error.code === 'OUTPUT_NOT_READY');
  assert.equal(blocked.log.some((entry) => entry[1] === 'oscillator'), false,
    'failed readiness schedules no oscillator');
}

export const engineOutputCases = [
  resumeRejectionNeverClaimsReadyOrPlaying,
  readinessCreatesOnceSynchronouslyAndCoalescesResume,
  onlyRunningContextsBecomeReady,
  preferencesWaitForReadinessAndConfigureTheOneAppGain,
  readinessWaitsForTheRequestedSinkAndPublishesFrozenState,
  persistedHintFallsBackButExplicitFailureKeepsVerifiedRoute,
  staleSelectionBeforeRouterNeverStartsOrCommits,
  staleSelectionCannotBecomeRecoveryPreferenceAfterNewerFailure,
  interruptionAndLossInvalidateBeforeImmutableNotification,
  everyNonRunningContextStateFailsClosedBeforeNotification,
  testSignalSchedulesBothChannelsOnlyAfterReadiness,
];
