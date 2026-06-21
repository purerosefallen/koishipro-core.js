import fs from 'node:fs';

import initSqlJs from 'sql.js';
import { YGOProMsgResponseBase, YGOProMsgRetry } from 'ygopro-msg-encode';

import {
  createOcgcoreDuelFromSnapshot,
  createOcgcoreWrapper,
} from '../src/create-ocgcore-wrapper';
import type { OcgcoreDuel } from '../src/ocgcore-duel';
import { OcgcoreWrapper } from '../src/ocgcore-wrapper';
import { createDuelFromYrp } from '../src/play-yrp';
import { SqljsCardReader } from '../src/card-reader';
import { DirScriptReader } from '../src/script-reader';
import { getReplayFixturePaths } from './helpers/ygopro-resources';

function configureReplayWrapper(
  wrapper: OcgcoreWrapper,
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  scriptDir: string,
  cardsBytes: Uint8Array,
): void {
  wrapper.setScriptReader(DirScriptReader(scriptDir));
  wrapper.setCardReader(SqljsCardReader(SQL, cardsBytes));
  wrapper.setMessageHandler((_duel, message, type) => {
    throw new Error(`MessageHandler invoked (${type}): ${message}`);
  });
}

async function createReplayWrapper(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  scriptDir: string,
  cardsBytes: Uint8Array,
): Promise<OcgcoreWrapper> {
  const wrapper = await createOcgcoreWrapper();
  configureReplayWrapper(wrapper, SQL, scriptDir, cardsBytes);
  return wrapper;
}

function applyReplayResponses(
  duel: OcgcoreDuel,
  result: ReturnType<OcgcoreDuel['process']>,
  responses: Array<Uint8Array | number>,
): boolean {
  if (result.status === 2) {
    return true;
  }

  for (const message of result.messages ?? []) {
    if (message instanceof YGOProMsgRetry) {
      throw new Error('Got MSG_RETRY');
    }
    if (message instanceof YGOProMsgResponseBase) {
      const response = responses.shift();
      if (response == null) {
        return false;
      }
      duel.setResponse(response);
    }
  }

  return true;
}

async function playYrpRawProcessPayloads(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  scriptDir: string,
  cardsBytes: Uint8Array,
  yrpBytes: Uint8Array,
  snapshotAt?: number,
): Promise<Uint8Array[]> {
  let wrapper = await createReplayWrapper(SQL, scriptDir, cardsBytes);
  const replay = createDuelFromYrp(wrapper, yrpBytes);
  const { yrp } = replay;
  let { duel } = replay;
  const responses = yrp.responses.slice();
  const outputs: Uint8Array[] = [];

  try {
    for (let step = 1; step <= 10000; step++) {
      const result = duel.process();
      outputs.push(result.raw);

      const hasReplayResponse = applyReplayResponses(duel, result, responses);
      if (result.status === 2 || !hasReplayResponse) {
        break;
      }

      if (snapshotAt === step) {
        const snapshot = duel.snapshot();
        expect(snapshot).toBeInstanceOf(Uint8Array);

        duel.endDuel();
        wrapper.finalize();

        duel = await createOcgcoreDuelFromSnapshot(snapshot);
        wrapper = duel.ocgcoreWrapper;
        configureReplayWrapper(wrapper, SQL, scriptDir, cardsBytes);
      }
    }
  } finally {
    duel.endDuel();
    wrapper.finalize();
  }

  return outputs;
}

function createMockWrapper() {
  const heap = new Uint8Array(1024 * 1024);
  const callbacks: Array<(...args: number[]) => number | void> = [];
  let nextPtr = 128;
  const module = {
    HEAPU8: heap,
    addFunction: jest.fn((fn) => {
      callbacks.push(fn);
      return callbacks.length - 1;
    }),
    removeFunction: jest.fn(),
    _set_script_reader: jest.fn(),
    _set_card_reader: jest.fn(),
    _set_message_handler: jest.fn(),
    _malloc: jest.fn((size: number) => {
      const ptr = nextPtr;
      nextPtr += Math.max(size, 1);
      return ptr;
    }),
    _free: jest.fn(),
    _get_log_message: jest.fn((_duelPtr: number, bufPtr: number) => {
      heap[bufPtr] = 0;
      return 0;
    }),
    _end_duel: jest.fn(),
  };
  return {
    callbacks,
    heap,
    wrapper: new OcgcoreWrapper(module as any),
  };
}

function isSnapshotCallbackError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /while an ocgcore callback is running/.test(error.message)
  );
}

function getMemoryByteLength(wrapper: OcgcoreWrapper): number {
  return (wrapper.ocgcoreModule.HEAPU8 as Uint8Array).byteLength;
}

function forceMemoryGrow(wrapper: OcgcoreWrapper): {
  before: number;
  after: number;
} {
  const before = getMemoryByteLength(wrapper);
  const requests = [Math.max(1, before - 1024), before + 64 * 1024, before * 2];

  for (const request of requests) {
    const ptr = wrapper.ocgcoreModule._malloc(request);
    const after = getMemoryByteLength(wrapper);
    if (ptr) {
      wrapper.ocgcoreModule._free(ptr);
    }
    if (after > before) {
      return { before, after };
    }
  }

  throw new Error('Expected ocgcore wasm memory to grow');
}

async function playYrpWithGrowthSnapshots(
  SQL: Awaited<ReturnType<typeof initSqlJs>>,
  scriptDir: string,
  cardsBytes: Uint8Array,
  yrpBytes: Uint8Array,
  firstSnapshotAt: number,
  secondSnapshotAt: number,
): Promise<{
  outputs: Uint8Array[];
  growEvents: Array<{ before: number; after: number }>;
  processedAfterFirstRestore: boolean;
}> {
  let wrapper = await createReplayWrapper(SQL, scriptDir, cardsBytes);
  const replay = createDuelFromYrp(wrapper, yrpBytes);
  const { yrp } = replay;
  let { duel } = replay;
  const responses = yrp.responses.slice();
  const outputs: Uint8Array[] = [];
  const growEvents: Array<{ before: number; after: number }> = [];
  let restoreCount = 0;
  let processedAfterFirstRestore = false;

  try {
    for (let step = 1; step <= 10000; step++) {
      const result = duel.process();
      outputs.push(result.raw);

      if (restoreCount >= 1 && step > firstSnapshotAt) {
        processedAfterFirstRestore = true;
      }

      const hasReplayResponse = applyReplayResponses(duel, result, responses);
      if (result.status === 2 || !hasReplayResponse) {
        break;
      }

      if (step === firstSnapshotAt || step === secondSnapshotAt) {
        growEvents.push(forceMemoryGrow(wrapper));
        const snapshot = duel.snapshot();

        duel.endDuel();
        wrapper.finalize();

        duel = await createOcgcoreDuelFromSnapshot(snapshot);
        wrapper = duel.ocgcoreWrapper;
        configureReplayWrapper(wrapper, SQL, scriptDir, cardsBytes);
        restoreCount++;

        if (step === secondSnapshotAt) {
          growEvents.push(forceMemoryGrow(wrapper));
        }
      }
    }
  } finally {
    duel.endDuel();
    wrapper.finalize();
  }

  return {
    outputs,
    growEvents,
    processedAfterFirstRestore,
  };
}

describe('ocgcore duel snapshot', () => {
  jest.setTimeout(60000);

  test('continues a replay from a snapshot in a new wasm wrapper', async () => {
    const { scriptDir, cardsPath, yrpPath } = getReplayFixturePaths();
    const SQL = await initSqlJs();
    const cardsBytes = fs.readFileSync(cardsPath);
    const yrpBytes = fs.readFileSync(yrpPath);

    const baseline = await playYrpRawProcessPayloads(
      SQL,
      scriptDir,
      cardsBytes,
      yrpBytes,
    );
    const withSnapshot = await playYrpRawProcessPayloads(
      SQL,
      scriptDir,
      cardsBytes,
      yrpBytes,
      Math.floor(baseline.length / 2),
    );

    expect(withSnapshot.map((raw) => Array.from(raw))).toEqual(
      baseline.map((raw) => Array.from(raw)),
    );
  });

  test('restores snapshots across repeated wasm memory growth', async () => {
    const { scriptDir, cardsPath, yrpPath } = getReplayFixturePaths();
    const SQL = await initSqlJs();
    const cardsBytes = fs.readFileSync(cardsPath);
    const yrpBytes = fs.readFileSync(yrpPath);

    const baseline = await playYrpRawProcessPayloads(
      SQL,
      scriptDir,
      cardsBytes,
      yrpBytes,
    );
    const firstSnapshotAt = Math.floor(baseline.length / 3);
    const secondSnapshotAt = Math.floor((baseline.length * 2) / 3);
    const withGrowth = await playYrpWithGrowthSnapshots(
      SQL,
      scriptDir,
      cardsBytes,
      yrpBytes,
      firstSnapshotAt,
      secondSnapshotAt,
    );

    expect(withGrowth.processedAfterFirstRestore).toBe(true);
    expect(withGrowth.growEvents).toHaveLength(3);
    for (const event of withGrowth.growEvents) {
      expect(event.after).toBeGreaterThan(event.before);
    }
    expect(withGrowth.outputs.map((raw) => Array.from(raw))).toEqual(
      baseline.map((raw) => Array.from(raw)),
    );
  });

  test('blocks snapshot calls from script, card, and message callbacks', () => {
    const { callbacks, heap, wrapper } = createMockWrapper();
    const duel = wrapper.getOrCreateDuel(123);
    const blocked = {
      script: false,
      card: false,
      message: false,
    };

    wrapper.setScriptReader(() => {
      try {
        duel.snapshot();
      } catch (error) {
        blocked.script = isSnapshotCallbackError(error);
      }
      return null;
    });
    wrapper.setCardReader(() => {
      try {
        duel.snapshot();
      } catch (error) {
        blocked.card = isSnapshotCallbackError(error);
      }
      return null;
    });
    wrapper.setMessageHandler((_duel) => {
      try {
        _duel.snapshot();
      } catch (error) {
        blocked.message = isSnapshotCallbackError(error);
      }
    });

    heap[16] = 0;
    callbacks[0](16, 24);
    callbacks[1](10000, 32);
    callbacks[2](123, 2);

    expect(blocked).toEqual({
      script: true,
      card: true,
      message: true,
    });

    wrapper.finalize();
  });
});
