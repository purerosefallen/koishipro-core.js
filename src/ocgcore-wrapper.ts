import { OcgcoreModule } from './vendor/libocgcore.shared';
import { OcgcoreDuel } from './ocgcore-duel';
import { CardDataEntry } from 'ygopro-cdb-encode';
import { OcgcoreMessageType } from './types/ocgcore-enums';
import { applyCardSpecials } from './card-reader/specials';
import {
  CardReader,
  CardReaderFn,
  MayWithFinalizer,
  MessageHandler,
  MessageHandlerFn,
  ScriptReader,
  ScriptReaderFn,
} from './types/callback';
import {
  OcgcoreDuelSnapshotState,
  OcgcoreWrapperSnapshotState,
} from './ocgcore-snapshot';

export class OcgcoreWrapper {
  private scriptBufferPtr = 0;
  private scriptBufferSize = 0;
  private logBufferPtr = 0;
  private logBufferSize = 0;
  private tmpStringBufferPtr = 0;
  private tmpStringBufferSize = 0;

  private scriptReaderFunc = 0;
  private cardReaderFunc = 0;
  private messageHandlerFunc = 0;

  public scriptReaders: ScriptReader[] = [];
  public cardReaders: CardReader[] = [];
  public messageHandlers: MessageHandler[] = [];

  private _heapView: DataView;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder('utf-8');
  private duels = new Map<number, OcgcoreDuel>();
  private callbackDepth = 0;

  private get heapU8(): Uint8Array {
    if (!this.ocgcoreModule) {
      throw new Error('Ocgcore module has been finalized');
    }
    return this.ocgcoreModule.HEAPU8 as Uint8Array;
  }

  private get heapView(): DataView {
    const heapU8 = this.heapU8;
    if (this._heapView.buffer !== heapU8.buffer) {
      this._heapView = new DataView(heapU8.buffer);
    }
    return this._heapView;
  }

  constructor(
    public ocgcoreModule: OcgcoreModule,
    options?: { scriptBufferSize?: number; logBufferSize?: number },
  ) {
    this._heapView = new DataView((ocgcoreModule.HEAPU8 as Uint8Array).buffer);
    this.scriptBufferSize = options?.scriptBufferSize ?? 0x100000;
    this.logBufferSize = options?.logBufferSize ?? 1024;

    this.scriptReaderFunc = this.createFunction(
      (scriptPtr, lenPtr) =>
        this.runInCallback(() => {
          const scriptPath = this.getUTF8String(scriptPtr);
          const content = this.readScript(scriptPath);
          if (content == null) {
            return 0;
          }

          if (!this.scriptBufferPtr) {
            this.scriptBufferPtr = this.ocgcoreModule._malloc(
              this.scriptBufferSize,
            );
          }

          const bytes = content;
          if (bytes.length > this.scriptBufferSize) {
            this.ocgcoreModule._free(this.scriptBufferPtr);
            this.scriptBufferPtr = this.ocgcoreModule._malloc(bytes.length);
            this.scriptBufferSize = bytes.length;
          }

          this.heapU8.set(bytes, this.scriptBufferPtr);
          this.heapView.setInt32(lenPtr, bytes.length, true);
          return this.scriptBufferPtr;
        }),
      'iii',
    );
    this.ocgcoreModule._set_script_reader(this.scriptReaderFunc);

    this.cardReaderFunc = this.createFunction(
      (cardId, cardDataPtr) =>
        this.runInCallback(() => {
          const data = this.readCard(cardId);
          if (!data) {
            return 0;
          }

          const buf = data.toPayload();
          this.heapU8.set(buf, cardDataPtr);
          return 0;
        }),
      'iii',
    );
    this.ocgcoreModule._set_card_reader(this.cardReaderFunc);

    this.messageHandlerFunc = this.createFunction(
      (duelPtr, messageType) =>
        this.runInCallback(() => {
          if (!this.logBufferPtr) {
            this.logBufferPtr = this.ocgcoreModule._malloc(this.logBufferSize);
          }
          this.ocgcoreModule._get_log_message(duelPtr, this.logBufferPtr);
          const message = this.getUTF8String(this.logBufferPtr);
          const type =
            messageType === 2
              ? OcgcoreMessageType.DebugMessage
              : OcgcoreMessageType.ScriptError;
          const duel = this.getOrCreateDuel(duelPtr);
          this.handleMessage(duel, message, type);
        }),
      'iii',
    );
    this.ocgcoreModule._set_message_handler(this.messageHandlerFunc);
  }

  readScript(scriptPath: string): Uint8Array | null {
    let content: string | Uint8Array | null | undefined;
    for (const reader of this.scriptReaders) {
      try {
        content = this.applyCallback<ScriptReaderFn>(reader, scriptPath);
      } catch {
        content = null;
      }
      if (content != null) {
        break;
      }
    }
    return typeof content === 'string'
      ? this.encoder.encode(content)
      : (content ?? null);
  }

  readCard(cardId: number): CardDataEntry | null {
    let data: Partial<CardDataEntry> | null | undefined;
    for (const reader of this.cardReaders) {
      try {
        data = this.applyCallback<CardReaderFn>(reader, cardId);
      } catch {
        data = null;
      }
      if (data) {
        break;
      }
    }
    if (!data) {
      return null;
    }
    const patched = applyCardSpecials(cardId, data);
    if (patched instanceof CardDataEntry) {
      return patched;
    }
    return new CardDataEntry().fromPartial(patched);
  }

  handleMessage(
    duel: OcgcoreDuel,
    message: string,
    type: OcgcoreMessageType,
  ): void {
    for (const handler of this.messageHandlers) {
      try {
        this.applyCallback<MessageHandlerFn>(handler, duel, message, type);
      } catch {
        // ignore handler errors
      }
    }
  }

  getUTF8String(ptr: number): string {
    const heapU8 = this.heapU8;
    let length = 0;
    while (heapU8[ptr + length] !== 0) {
      length++;
    }
    return this.decoder.decode(heapU8.subarray(ptr, ptr + length));
  }

  setHeap(ptr: number, data: Uint8Array): void {
    this.heapU8.set(data, ptr);
  }

  copyHeap(ptr: number, length: number): Uint8Array {
    return this.heapU8.slice(ptr, ptr + length);
  }

  snapshotHeap(): Uint8Array {
    return this.heapU8.slice();
  }

  useTmpData<R>(
    cb: (...args: number[]) => R,
    ...args: Array<string | Uint8Array>
  ): R {
    const encoded = args.map((item) =>
      typeof item === 'string' ? this.encoder.encode(item) : item,
    );
    const totalLength = encoded.reduce(
      (acc, bytes) => acc + bytes.length + 1,
      0,
    );
    if (totalLength > this.tmpStringBufferSize) {
      if (this.tmpStringBufferPtr) {
        this.ocgcoreModule._free(this.tmpStringBufferPtr);
      }
      this.tmpStringBufferPtr = this.ocgcoreModule._malloc(totalLength);
      this.tmpStringBufferSize = totalLength;
    }

    let offset = 0;
    const heapU8 = this.heapU8;
    const ptrs = encoded.map((bytes) => {
      const ptr = this.tmpStringBufferPtr + offset;
      heapU8.set(bytes, ptr);
      heapU8[ptr + bytes.length] = 0;
      offset += bytes.length + 1;
      return ptr;
    });

    return cb(...ptrs);
  }

  private createFunction(
    fn: (...args: number[]) => number | void,
    signature: string,
  ): number {
    return this.ocgcoreModule.addFunction(fn, signature);
  }

  addFunction(
    fn: (...args: number[]) => number | void,
    signature: string,
  ): number {
    return this.ocgcoreModule.addFunction(fn, signature);
  }

  removeFunction(index: number): void {
    this.ocgcoreModule.removeFunction(index);
  }

  createDuel(seed: number, createFlags = 0): OcgcoreDuel {
    const duelPtr = createFlags
      ? this.ocgcoreModule._create_duel_ex(seed, createFlags)
      : this.ocgcoreModule._create_duel(seed);
    return this.getOrCreateDuel(duelPtr);
  }

  createDuelV2(seedSequence: number[], createFlags = 0): OcgcoreDuel {
    const count = seedSequence.length;
    const byteLength = count * 4;
    const ptr = this.ocgcoreModule._malloc(byteLength);
    try {
      const view = new Uint32Array(this.heapU8.buffer, ptr, count);
      for (let i = 0; i < count; i++) {
        view[i] = seedSequence[i] >>> 0;
      }
      const duelPtr = createFlags
        ? this.ocgcoreModule._create_duel_v2_ex(ptr, createFlags)
        : this.ocgcoreModule._create_duel_v2(ptr);
      return this.getOrCreateDuel(duelPtr);
    } finally {
      this.ocgcoreModule._free(ptr);
    }
  }

  _defaultScriptReader(namePtr: number, dataPtr: number): number {
    return this.ocgcoreModule._default_script_reader(namePtr, dataPtr);
  }

  malloc(size: number): number {
    return this.ocgcoreModule._malloc(size);
  }

  free(ptr: number): void {
    this.ocgcoreModule._free(ptr);
  }

  _stdioExit(): void {
    this.ocgcoreModule.___stdio_exit();
  }

  setScriptReader(reader: ScriptReader, reset = false): this {
    if (reset) {
      this.scriptReaders = [];
    }
    this.scriptReaders.push(reader);
    return this;
  }

  setCardReader(reader: CardReader, reset = false): this {
    if (reset) {
      this.cardReaders = [];
    }
    this.cardReaders.push(reader);
    return this;
  }

  setMessageHandler(handler: MessageHandler, reset = false): this {
    if (reset) {
      this.messageHandlers = [];
    }
    this.messageHandlers.push(handler);
    return this;
  }

  getOrCreateDuel(duelPtr: number): OcgcoreDuel {
    const existing = this.duels.get(duelPtr);
    if (existing) {
      return existing;
    }
    const duel = new OcgcoreDuel(this, duelPtr);
    this.duels.set(duelPtr, duel);
    return duel;
  }

  attachDuel(
    duelPtr: number,
    snapshotState: OcgcoreDuelSnapshotState,
  ): OcgcoreDuel {
    if (snapshotState.duelPtr !== duelPtr) {
      throw new Error('Cannot attach ocgcore duel: snapshot pointer mismatch');
    }
    const existing = this.duels.get(duelPtr);
    if (existing) {
      return existing;
    }
    const duel = new OcgcoreDuel(this, duelPtr, snapshotState);
    this.duels.set(duelPtr, duel);
    return duel;
  }

  forgetDuel(duelPtr: number): void {
    this.duels.delete(duelPtr);
  }

  getSnapshotState(): OcgcoreWrapperSnapshotState {
    return {
      scriptBufferPtr: this.scriptBufferPtr,
      scriptBufferSize: this.scriptBufferSize,
      logBufferPtr: this.logBufferPtr,
      logBufferSize: this.logBufferSize,
      tmpStringBufferPtr: this.tmpStringBufferPtr,
      tmpStringBufferSize: this.tmpStringBufferSize,
    };
  }

  restoreSnapshotState(state: OcgcoreWrapperSnapshotState): void {
    this.scriptBufferPtr = state.scriptBufferPtr;
    this.scriptBufferSize = state.scriptBufferSize;
    this.logBufferPtr = state.logBufferPtr;
    this.logBufferSize = state.logBufferSize;
    this.tmpStringBufferPtr = state.tmpStringBufferPtr;
    this.tmpStringBufferSize = state.tmpStringBufferSize;
  }

  assertCanSnapshot(): void {
    if (this.callbackDepth > 0) {
      throw new Error(
        'Cannot snapshot an ocgcore duel while an ocgcore callback is running',
      );
    }
  }

  private runInCallback<T>(fn: () => T): T {
    this.callbackDepth++;
    try {
      return fn();
    } finally {
      this.callbackDepth--;
    }
  }

  finalize(): void {
    if (!this.ocgcoreModule) return;
    for (const duel of this.duels.values()) {
      try {
        duel.endDuel();
      } catch {
        // ignore duel cleanup errors
      }
    }
    this.duels.clear();

    for (const reader of this.scriptReaders) {
      this.finalizeCallback(reader);
    }
    for (const reader of this.cardReaders) {
      this.finalizeCallback(reader);
    }
    for (const handler of this.messageHandlers) {
      this.finalizeCallback(handler);
    }

    if (this.scriptReaderFunc) {
      this.ocgcoreModule.removeFunction(this.scriptReaderFunc);
      this.scriptReaderFunc = 0;
    }
    if (this.cardReaderFunc) {
      this.ocgcoreModule.removeFunction(this.cardReaderFunc);
      this.cardReaderFunc = 0;
    }
    if (this.messageHandlerFunc) {
      this.ocgcoreModule.removeFunction(this.messageHandlerFunc);
      this.messageHandlerFunc = 0;
    }

    if (this.scriptBufferPtr) {
      this.ocgcoreModule._free(this.scriptBufferPtr);
      this.scriptBufferPtr = 0;
      this.scriptBufferSize = 0;
    }
    if (this.logBufferPtr) {
      this.ocgcoreModule._free(this.logBufferPtr);
      this.logBufferPtr = 0;
      this.logBufferSize = 0;
    }
    if (this.tmpStringBufferPtr) {
      this.ocgcoreModule._free(this.tmpStringBufferPtr);
      this.tmpStringBufferPtr = 0;
      this.tmpStringBufferSize = 0;
    }

    try {
      this.ocgcoreModule._ocgcore_shutdown?.(0);
    } catch {
      // ignore shutdown errors
    }
    this.ocgcoreModule = undefined;
  }

  private applyCallback<F extends (...args: any[]) => any>(
    cb: MayWithFinalizer<F>,
    ...args: Parameters<F>
  ): ReturnType<F> {
    if (typeof cb === 'function') {
      return cb(...args);
    }
    return cb.apply(...args);
  }

  private finalizeCallback<F extends (...args: any[]) => any>(
    cb: MayWithFinalizer<F>,
  ): void {
    if (typeof cb === 'function') {
      return;
    }
    try {
      cb.finalize?.();
    } catch {
      // ignore finalizer errors
    }
  }
}
