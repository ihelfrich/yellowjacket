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

assertRouterFixtures();
const { AudioOutputRouter, SYSTEM_DEFAULT_OUTPUT } =
  await import('../js/audio-output-router.js');

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
  router.setVolume(0.5);
  assert.equal(fixture.input.gain.value, 0.5);
  assert.equal(router.state.volume, 0.5);
  assert.equal(fixture.input.gain.calls.at(-1)[2], 0.015);
  router.setMuted(true);
  assert.equal(fixture.input.gain.value, 0);
  router.setMuted(false);
  assert.equal(fixture.input.gain.value, 0.5);
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
  bridgeFailuresKeepTheVerifiedDefaultRoute,
  directRollbackFailureFailsClosed,
  rapidAThenBThenDefaultLeavesDefaultActive,
  duplicateCommittedDeviceDoesNotMutateTheSinkAgain,
  volumeAndMuteUseExactlyOneAppGainStage,
  statesAreFrozenDetachedSnapshots,
  safetyLatchSurvivesVerifiedSwitchUntilExplicitlyCleared,
  disposalIsIdempotentAndTearsDownTheBridge,
  constructorRejectsOptionAccessorsWithoutReadingThem,
  proxyOptionTrapFailuresLeaveNoConnectedRoute,
];
