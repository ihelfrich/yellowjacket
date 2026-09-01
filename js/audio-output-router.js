export const SYSTEM_DEFAULT_OUTPUT = 'default';

const ROUTERS = new WeakMap();
const RAMP_SECONDS = 0.015;

function snapshotRouterOptions(options) {
  if (!options || (typeof options !== 'object' && typeof options !== 'function')) {
    throw new TypeError('AudioOutputRouter options must be an object');
  }
  try {
    const values = {};
    for (const key of ['context', 'input', 'createAudioElement']) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`AudioOutputRouter option ${key} must be a data property`);
      }
      values[key] = descriptor.value;
    }
    return values;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('AudioOutputRouter options could not be read');
  }
}

function requireRouter(router) {
  const state = ROUTERS.get(router);
  if (!state) throw new TypeError('Invalid AudioOutputRouter receiver');
  return state;
}

function apiSinkId(deviceId) {
  return deviceId === SYSTEM_DEFAULT_OUTPUT ? '' : deviceId;
}

function errorValue(error) {
  if (typeof error === 'string') return error;
  return error?.message || error?.name || 'audio-output-fault';
}

function publish(state) {
  state.router.dispatchEvent(new Event('statechange'));
}

function setGain(state, node, value) {
  if (!node?.gain) return;
  const time = Number.isFinite(state.context.currentTime) ? state.context.currentTime : 0;
  if (typeof node.gain.setTargetAtTime === 'function') {
    node.gain.setTargetAtTime(value, time, RAMP_SECONDS);
  } else {
    node.gain.value = value;
  }
}

function applyAppGain(state) {
  setGain(state, state.input, state.muted ? 0 : state.volume);
}

function activeRouteGain(state) {
  if (state.mechanism === 'element-sink') return state.bridge?.gain;
  return state.direct?.gain;
}

function silenceRoutes(state) {
  if (state.direct) setGain(state, state.direct.gain, 0);
  if (state.bridge) setGain(state, state.bridge.gain, 0);
}

function makeActiveAudible(state) {
  silenceRoutes(state);
  const gain = activeRouteGain(state);
  if (gain) setGain(state, gain, state.safetyMuted ? 0 : 1);
}

function ensureDirect(state) {
  if (state.direct?.connected) return state.direct;
  const gain = state.direct?.gain || state.context.createGain();
  state.input.connect(gain);
  gain.connect(state.context.destination);
  state.direct = { gain, connected: true };
  setGain(state, gain, 0);
  return state.direct;
}

function disconnectDirect(state) {
  const direct = state.direct;
  if (!direct?.connected) return;
  state.input.disconnect(direct.gain);
  direct.gain.disconnect(state.context.destination);
  direct.connected = false;
  setGain(state, direct.gain, 0);
}

function ensureBridge(state) {
  if (state.bridge) return state.bridge;
  if (typeof state.context.createMediaStreamDestination !== 'function') {
    throw new Error('MediaStreamAudioDestinationNode is unavailable');
  }
  const element = state.createAudioElement();
  if (!element || typeof element.setSinkId !== 'function' || typeof element.play !== 'function') {
    throw new Error('Audio output element sink selection is unavailable');
  }
  const destination = state.context.createMediaStreamDestination();
  destination.channelCount = 2;
  destination.channelCountMode = 'explicit';
  destination.channelInterpretation = 'speakers';
  const gain = state.context.createGain();
  state.input.connect(gain);
  gain.connect(destination);
  setGain(state, gain, 0);
  element.srcObject = destination.stream;
  state.bridge = { gain, destination, element, connected: true };
  return state.bridge;
}

function disconnectBridge(state) {
  const bridge = state.bridge;
  if (!bridge) return;
  if (bridge.connected) {
    state.input.disconnect(bridge.gain);
    bridge.gain.disconnect(bridge.destination);
    bridge.connected = false;
  }
  setGain(state, bridge.gain, 0);
  try { bridge.element.pause(); } catch { /* best-effort element cleanup */ }
  bridge.element.srcObject = null;
  state.bridge = null;
}

function directSinkSupported(state) {
  try {
    return typeof state.context.setSinkId === 'function';
  } catch {
    return false;
  }
}

function snapshotRoute(state) {
  return { active: state.active, mechanism: state.mechanism };
}

function restoreSnapshot(state, snapshot) {
  state.active = snapshot.active;
  state.mechanism = snapshot.mechanism;
  state.status = state.safetyMuted ? 'lost' : 'ready';
  makeActiveAudible(state);
}

function markFault(state, error) {
  state.hardFault = true;
  state.safetyMuted = true;
  state.status = 'fault';
  state.error = errorValue(error);
  silenceRoutes(state);
  publish(state);
}

function commit(state, deviceId, mechanism) {
  state.active = deviceId;
  state.mechanism = mechanism;
  state.error = null;
  state.status = state.safetyMuted ? 'lost' : 'ready';
  makeActiveAudible(state);
  publish(state);
  return state.router.state;
}

function enqueueDirect(state, work) {
  const result = state.lane.then(work);
  state.lane = result.catch(() => {});
  return result;
}

async function selectDirect(state, deviceId, intent) {
  if (state.hardFault) return state.router.state;
  if (intent !== state.intent) return state.router.state;
  const route = ensureDirect(state);
  const snapshot = snapshotRoute(state);

  if (deviceId === SYSTEM_DEFAULT_OUTPUT &&
      (state.active === null || state.active === SYSTEM_DEFAULT_OUTPUT)) {
    return commit(state, SYSTEM_DEFAULT_OUTPUT, 'context-default');
  }
  if (deviceId === state.active && state.mechanism === 'context-sink') return state.router.state;

  const setSinkId = state.context.setSinkId.bind(state.context);
  // Context sink changes are not transactional. Keep this tail silent until a
  // successful request is either committed or restored to its verified route.
  setGain(state, route.gain, 0);
  try {
    await setSinkId(apiSinkId(deviceId));
  } catch (error) {
    if (intent === state.intent) {
      restoreSnapshot(state, snapshot);
      state.error = errorValue(error);
      publish(state);
    }
    throw error;
  }

  if (intent !== state.intent) {
    try {
      await setSinkId(apiSinkId(snapshot.active || SYSTEM_DEFAULT_OUTPUT));
    } catch (error) {
      markFault(state, error);
      throw error;
    }
    restoreSnapshot(state, snapshot);
    return state.router.state;
  }

  return commit(state, deviceId,
    deviceId === SYSTEM_DEFAULT_OUTPUT ? 'context-default' : 'context-sink');
}

async function selectBridge(state, deviceId, intent) {
  if (intent !== state.intent) return state.router.state;
  const snapshot = snapshotRoute(state);
  if (deviceId === SYSTEM_DEFAULT_OUTPUT) {
    disconnectBridge(state);
    ensureDirect(state);
    return commit(state, SYSTEM_DEFAULT_OUTPUT, 'context-default');
  }
  if (deviceId === state.active && state.mechanism === 'element-sink') return state.router.state;

  let bridge;
  try {
    bridge = ensureBridge(state);
    await bridge.element.setSinkId(apiSinkId(deviceId));
    if (intent !== state.intent) {
      setGain(state, bridge.gain, 0);
      return state.router.state;
    }
    await bridge.element.play();
  } catch (error) {
    if (intent === state.intent) {
      if (state.mechanism !== 'element-sink') disconnectBridge(state);
      restoreSnapshot(state, snapshot);
      state.error = errorValue(error);
      publish(state);
    }
    throw error;
  }

  if (intent !== state.intent) {
    setGain(state, bridge.gain, 0);
    return state.router.state;
  }
  disconnectDirect(state);
  return commit(state, deviceId, 'element-sink');
}

export class AudioOutputRouter extends EventTarget {
  constructor(options) {
    super();
    const { context, input, createAudioElement } = snapshotRouterOptions(options);
    if (!context || !input || typeof input.connect !== 'function' ||
        !input.gain || typeof context.createGain !== 'function' ||
        typeof createAudioElement !== 'function') {
      throw new TypeError('AudioOutputRouter requires a context-owned input');
    }
    ROUTERS.set(this, {
      router: this,
      context,
      input,
      createAudioElement,
      requested: SYSTEM_DEFAULT_OUTPUT,
      active: null,
      mechanism: null,
      status: 'switching',
      volume: 1,
      muted: false,
      safetyMuted: false,
      error: null,
      intent: 0,
      lane: Promise.resolve(),
      direct: null,
      bridge: null,
      disposed: false,
      hardFault: false,
    });
  }

  get state() {
    const state = requireRouter(this);
    return Object.freeze({
      requested: state.requested,
      active: state.active,
      mechanism: state.mechanism,
      status: state.status,
      volume: state.volume,
      muted: state.muted,
      safetyMuted: state.safetyMuted,
      error: state.error,
    });
  }

  async select(deviceId) {
    const state = requireRouter(this);
    if (state.disposed) throw new Error('AudioOutputRouter is disposed');
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new TypeError('Audio output deviceId must be a non-empty string');
    }
    if (deviceId === state.active &&
        (state.status === 'ready' || state.status === 'lost')) return this.state;

    const intent = ++state.intent;
    state.requested = deviceId;
    state.status = state.safetyMuted ? 'lost' : 'switching';
    state.error = null;
    publish(state);
    if (directSinkSupported(state)) return enqueueDirect(state, () => selectDirect(state, deviceId, intent));
    return selectBridge(state, deviceId, intent);
  }

  setVolume(value) {
    const state = requireRouter(this);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('Audio output volume must be between 0 and 1');
    }
    state.volume = value;
    applyAppGain(state);
    publish(state);
  }

  setMuted(muted) {
    const state = requireRouter(this);
    if (typeof muted !== 'boolean') throw new TypeError('Audio output muted must be boolean');
    state.muted = muted;
    applyAppGain(state);
    publish(state);
  }

  failClosed(code) {
    const state = requireRouter(this);
    if (state.disposed) return;
    state.safetyMuted = true;
    state.status = 'lost';
    state.error = errorValue(code);
    silenceRoutes(state);
    publish(state);
  }

  clearSafetyMute() {
    const state = requireRouter(this);
    if (state.disposed) return;
    state.safetyMuted = false;
    state.hardFault = false;
    state.status = state.active ? 'ready' : 'switching';
    state.error = null;
    makeActiveAudible(state);
    publish(state);
  }

  dispose() {
    const state = requireRouter(this);
    if (state.disposed) return;
    state.disposed = true;
    state.intent += 1;
    silenceRoutes(state);
    disconnectDirect(state);
    disconnectBridge(state);
    state.active = null;
    state.mechanism = null;
    state.status = 'disposed';
    state.error = null;
    publish(state);
  }
}
