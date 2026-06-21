import {
  OcgcoreCardQueryResult,
  OcgcoreFieldCardQueryResult,
  OcgcoreFieldInfoResult,
  OcgcoreMessageResult,
  OcgcoreProcessResult,
  OcgcoreRegistryDumpResult,
  OcgcoreRegistryKeysResult,
  OcgcoreRegistryValueResult,
} from './types/ocgcore-results';
import {
  OcgcoreNewCardParams,
  OcgcoreNewTagCardParams,
  OcgcoreQueryCardParams,
  OcgcoreQueryFieldCardParams,
  OcgcoreQueryFieldCountParams,
  OcgcoreParseOptions,
  OcgcoreSetPlayerInfoParams,
  OcgcoreStartDuelOptions,
} from './types/ocgcore-params';
import {
  MESSAGE_BUFFER_SIZE,
  RETURN_BUFFER_SIZE,
  QUERY_BUFFER_SIZE,
  REGISTRY_BUFFER_SIZE,
  LEN_HEADER,
} from './constants';
import {
  parseCardQuery,
  parseFieldCardQuery,
  parseFieldInfo,
  parseRegistryDump,
  parseRegistryKeys,
} from './adapters/ocgcore-parsers';
import { normalizeStartDuelOptions } from './adapters/start-duel';
import { OcgcoreWrapper } from './ocgcore-wrapper';
import { decodeUtf8 } from './utility/utf8';
import {
  YGOProMessages,
  YGOProMsgBase,
  YGOProMsgResponseBase,
  YGOProMsgRetry,
} from 'ygopro-msg-encode';
import { Advancor } from './advancors';
import {
  encodeOcgcoreDuelSnapshot,
  OCGCORE_DUEL_SNAPSHOT_VERSION,
  OcgcoreDuelSnapshotState,
} from './ocgcore-snapshot';
import {
  OcgcoreLuaCoverageMap,
  OcgcoreLuaLineCoverage,
} from './types/lua-coverage';
import {
  normalizeLuaCoverageName,
  parseAllLuaCoverages,
  parseLuaCoveragePairs,
  toLuaLineCoverage,
} from './utility/lua-coverage';

export class OcgcoreDuel {
  private static readonly RECEIVE_SIZE = Math.max(
    MESSAGE_BUFFER_SIZE,
    QUERY_BUFFER_SIZE,
    REGISTRY_BUFFER_SIZE,
  );
  private static readonly RETURN_SIZE = RETURN_BUFFER_SIZE;
  private static readonly EMPTY_RETURN_BUFFER = new Uint8Array(
    OcgcoreDuel.RETURN_SIZE,
  );

  private returnPtr = 0;
  private receivePtr = 0;

  constructor(
    public ocgcoreWrapper: OcgcoreWrapper,
    public duelPtr: number,
    snapshotState?: OcgcoreDuelSnapshotState,
  ) {
    if (snapshotState) {
      this.returnPtr = snapshotState.returnPtr;
      this.receivePtr = snapshotState.receivePtr;
    } else {
      this.returnPtr = this.ocgcoreWrapper.malloc(OcgcoreDuel.RETURN_SIZE);
      this.receivePtr = this.ocgcoreWrapper.malloc(OcgcoreDuel.RECEIVE_SIZE);
    }
  }

  startDuel(options: number | OcgcoreStartDuelOptions): void {
    const optionValue = normalizeStartDuelOptions(options);
    this.ocgcoreWrapper.ocgcoreModule._start_duel(this.duelPtr, optionValue);
  }

  ended = false;

  endDuel(): void {
    if (this.ended) return;
    this.ended = true;
    this.ocgcoreWrapper.ocgcoreModule._end_duel(this.duelPtr);
    if (this.returnPtr) {
      this.ocgcoreWrapper.free(this.returnPtr);
      this.returnPtr = 0;
    }
    if (this.receivePtr) {
      this.ocgcoreWrapper.free(this.receivePtr);
      this.receivePtr = 0;
    }
    this.ocgcoreWrapper.forgetDuel(this.duelPtr);
  }

  snapshot(): Uint8Array {
    if (this.ended) {
      throw new Error('Cannot snapshot an ended ocgcore duel');
    }
    this.ocgcoreWrapper.assertCanSnapshot();
    const memory = this.ocgcoreWrapper.snapshotHeap();
    return encodeOcgcoreDuelSnapshot(
      {
        version: OCGCORE_DUEL_SNAPSHOT_VERSION,
        memoryByteLength: memory.byteLength,
        duel: {
          duelPtr: this.duelPtr,
          returnPtr: this.returnPtr,
          receivePtr: this.receivePtr,
        },
        wrapper: this.ocgcoreWrapper.getSnapshotState(),
      },
      memory,
    );
  }

  setPlayerInfo(info: OcgcoreSetPlayerInfoParams): void {
    this.ocgcoreWrapper.ocgcoreModule._set_player_info(
      this.duelPtr,
      info.player,
      info.lp,
      info.startHand,
      info.drawCount,
    );
  }

  _getLogMessage(bufPtr: number): number {
    return this.ocgcoreWrapper.ocgcoreModule._get_log_message(
      this.duelPtr,
      bufPtr,
    );
  }

  private getMessage(length: number): OcgcoreMessageResult {
    this.ocgcoreWrapper.ocgcoreModule._get_message(
      this.duelPtr,
      this.receivePtr,
    );
    const raw = this.ocgcoreWrapper.copyHeap(this.receivePtr, length);
    return { length, raw };
  }

  process<TNoParse extends boolean | undefined = false>(
    parseOptions?: OcgcoreParseOptions<TNoParse>,
  ): OcgcoreProcessResult<TNoParse> {
    const result = this.ocgcoreWrapper.ocgcoreModule._process(this.duelPtr);
    const length = (result & 0x0fffffff) >>> 0;
    const status = ((result >>> 28) & 0x0f) >>> 0;
    const messageData = this.getMessage(length);

    // Parse messages using YGOProMessages (process may return multiple messages)
    let parsedMessages: YGOProMsgBase[] | undefined;
    if (!parseOptions?.noParse && messageData.raw.length > 0) {
      try {
        parsedMessages = YGOProMessages.getInstancesFromPayload(
          messageData.raw,
        );
      } catch {
        // If parsing fails, parsedMessages remains undefined
      }
    }
    const parsedMessage =
      parsedMessages && parsedMessages.length > 0
        ? parsedMessages[parsedMessages.length - 1]
        : undefined;

    return {
      length: messageData.length,
      raw: messageData.raw,
      status,
      message: parsedMessage as any,
      messages: parsedMessages as any,
    };
  }

  private splitProcessResult(
    res: OcgcoreProcessResult,
  ): OcgcoreProcessResult[] {
    if (!res.messages || res.messages.length <= 1) {
      return [res];
    }
    const messageCount = res.messages.length;
    return res.messages.map((message, index) => {
      const raw = message.toPayload();
      return {
        ...res,
        length: raw.length,
        raw,
        status: index === messageCount - 1 ? res.status : 0,
        message,
        messages: [message],
      };
    });
  }

  *advance(advancor?: Advancor) {
    while (true) {
      const processedResults = this.splitProcessResult(this.process());
      for (const res of processedResults) {
        yield res;
        const { message } = res;
        if (res.status === 2 || message instanceof YGOProMsgRetry) {
          return;
        }

        if (message instanceof YGOProMsgResponseBase) {
          const response = advancor?.(message);
          if (!response) {
            return;
          }
          this.setResponse(response);
        }
      }
    }
  }

  newCard(card: OcgcoreNewCardParams): void {
    this.ocgcoreWrapper.ocgcoreModule._new_card(
      this.duelPtr,
      card.code,
      card.owner,
      card.player,
      card.location,
      card.sequence,
      card.position,
    );
  }

  newTagCard(card: OcgcoreNewTagCardParams): void {
    this.ocgcoreWrapper.ocgcoreModule._new_tag_card(
      this.duelPtr,
      card.code,
      card.owner,
      card.location,
    );
  }

  queryCard<TNoParse extends boolean | undefined = false>(
    query: OcgcoreQueryCardParams,
    parseOptions?: OcgcoreParseOptions<TNoParse>,
  ): OcgcoreCardQueryResult<TNoParse> {
    const length = this.ocgcoreWrapper.ocgcoreModule._query_card(
      this.duelPtr,
      query.player,
      query.location,
      query.sequence,
      query.queryFlag,
      this.receivePtr,
      query.useCache ?? 0,
    );
    const raw = this.ocgcoreWrapper.copyHeap(this.receivePtr, length);
    const card = parseOptions?.noParse
      ? undefined
      : length <= LEN_HEADER
        ? null
        : parseCardQuery(raw, length);
    return { length, raw, card: card as any };
  }

  queryFieldCount(query: OcgcoreQueryFieldCountParams): number {
    return this.ocgcoreWrapper.ocgcoreModule._query_field_count(
      this.duelPtr,
      query.player,
      query.location,
    );
  }

  queryFieldCard<TNoParse extends boolean | undefined = false>(
    query: OcgcoreQueryFieldCardParams,
    parseOptions?: OcgcoreParseOptions<TNoParse>,
  ): OcgcoreFieldCardQueryResult<TNoParse> {
    const length = this.ocgcoreWrapper.ocgcoreModule._query_field_card(
      this.duelPtr,
      query.player,
      query.location,
      query.queryFlag,
      this.receivePtr,
      query.useCache ?? 0,
    );
    const raw = this.ocgcoreWrapper.copyHeap(this.receivePtr, length);
    const cards = parseOptions?.noParse
      ? undefined
      : parseFieldCardQuery(raw, length);
    return { length, raw, cards: cards as any };
  }

  queryFieldInfo<TNoParse extends boolean | undefined = false>(
    parseOptions?: OcgcoreParseOptions<TNoParse>,
  ): OcgcoreFieldInfoResult<TNoParse> {
    const length = this.ocgcoreWrapper.ocgcoreModule._query_field_info(
      this.duelPtr,
      this.receivePtr,
    );
    const raw = this.ocgcoreWrapper.copyHeap(this.receivePtr, length);
    const field = parseOptions?.noParse ? undefined : parseFieldInfo(raw);
    return { length, raw, field: field as any };
  }

  setResponseInt(value: number): void {
    this.ocgcoreWrapper.ocgcoreModule._set_responsei(this.duelPtr, value);
  }

  setResponse(response: Uint8Array | number): void {
    if (typeof response === 'number') {
      this.setResponseInt(response);
      return;
    }
    this.ocgcoreWrapper.setHeap(
      this.returnPtr,
      OcgcoreDuel.EMPTY_RETURN_BUFFER,
    );
    this.ocgcoreWrapper.setHeap(
      this.returnPtr,
      response.subarray(0, OcgcoreDuel.RETURN_SIZE),
    );
    this.ocgcoreWrapper.ocgcoreModule._set_responseb(
      this.duelPtr,
      this.returnPtr,
    );
  }

  preloadScript(scriptPath: string): void {
    this.ocgcoreWrapper.useTmpData(
      (ptr) =>
        this.ocgcoreWrapper.ocgcoreModule._preload_script(this.duelPtr, ptr),
      scriptPath,
    );
  }

  getRegistryValue(key: string): OcgcoreRegistryValueResult {
    const length = this.ocgcoreWrapper.useTmpData(
      (keyPtr) =>
        this.ocgcoreWrapper.ocgcoreModule._get_registry_value(
          this.duelPtr,
          keyPtr,
          this.receivePtr,
        ),
      key,
    );
    const raw = this.ocgcoreWrapper.copyHeap(
      this.receivePtr,
      Math.max(0, length),
    );
    const value = raw;
    const text = length >= 0 ? decodeUtf8(raw) : undefined;
    return { length, raw, value, text };
  }

  setRegistryValue(key: string, value: string): void {
    this.ocgcoreWrapper.useTmpData(
      (keyPtr, valuePtr) =>
        this.ocgcoreWrapper.ocgcoreModule._set_registry_value(
          this.duelPtr,
          keyPtr,
          valuePtr,
        ),
      key,
      value,
    );
  }

  getRegistryKeys(): OcgcoreRegistryKeysResult {
    const length = this.ocgcoreWrapper.ocgcoreModule._get_registry_keys(
      this.duelPtr,
      this.receivePtr,
    );
    const raw = this.ocgcoreWrapper.copyHeap(
      this.receivePtr,
      Math.max(0, length),
    );
    const keys = length >= 0 ? parseRegistryKeys(raw) : [];
    return { length, raw, keys };
  }

  clearRegistry(): void {
    this.ocgcoreWrapper.ocgcoreModule._clear_registry(this.duelPtr);
  }

  dumpRegistry(): OcgcoreRegistryDumpResult {
    const length = this.ocgcoreWrapper.ocgcoreModule._dump_registry(
      this.duelPtr,
      this.receivePtr,
    );
    const raw = this.ocgcoreWrapper.copyHeap(
      this.receivePtr,
      Math.max(0, length),
    );

    // Parse directly into dict
    const dict: Record<string, string> = {};
    if (length > 0) {
      const entries = parseRegistryDump(raw);
      for (const entry of entries) {
        if (entry.valueText !== undefined) {
          dict[entry.key] = entry.valueText;
        }
      }
    }

    return { length, raw, dict };
  }

  loadRegistry(input: Uint8Array | Record<string, string>): void {
    if (input instanceof Uint8Array) {
      // Load from binary format
      this.ocgcoreWrapper.useTmpData(
        (ptr) =>
          this.ocgcoreWrapper.ocgcoreModule._load_registry(
            this.duelPtr,
            ptr,
            input.length,
          ),
        input,
      );
    } else {
      // Load from dict format
      for (const [key, value] of Object.entries(input)) {
        this.setRegistryValue(key, value);
      }
    }
  }

  getLuaCoverage(name: string): OcgcoreLuaLineCoverage {
    const normalizedName = normalizeLuaCoverageName(name);
    const size = this.ocgcoreWrapper.useTmpData(
      (namePtr) =>
        this.ocgcoreWrapper.ocgcoreModule._get_lua_coverage_dump_size(
          this.duelPtr,
          namePtr,
        ),
      name,
    );
    if (size <= 0) {
      return toLuaLineCoverage(normalizedName, {});
    }
    const ptr = this.ocgcoreWrapper.malloc(size);
    try {
      const written = this.ocgcoreWrapper.useTmpData(
        (namePtr) =>
          this.ocgcoreWrapper.ocgcoreModule._dump_lua_coverage(
            this.duelPtr,
            namePtr,
            ptr,
            size,
          ),
        name,
      );
      if (written !== size) {
        throw new Error('Lua coverage dump size changed while reading.');
      }
      const raw = this.ocgcoreWrapper.copyHeap(ptr, size);
      return parseLuaCoveragePairs(normalizedName, raw);
    } finally {
      this.ocgcoreWrapper.free(ptr);
    }
  }

  getAllLuaCoverages(): OcgcoreLuaCoverageMap {
    const size =
      this.ocgcoreWrapper.ocgcoreModule._get_all_lua_coverages_dump_size(
        this.duelPtr,
      );
    if (size <= 0) {
      return {};
    }
    const ptr = this.ocgcoreWrapper.malloc(size);
    try {
      const written = this.ocgcoreWrapper.ocgcoreModule._dump_all_lua_coverages(
        this.duelPtr,
        ptr,
        size,
      );
      if (written !== size) {
        throw new Error('Lua coverage dump size changed while reading.');
      }
      const raw = this.ocgcoreWrapper.copyHeap(ptr, size);
      return parseAllLuaCoverages(raw);
    } finally {
      this.ocgcoreWrapper.free(ptr);
    }
  }

  clearLuaCoverage(name: string): this {
    this.ocgcoreWrapper.useTmpData(
      (namePtr) =>
        this.ocgcoreWrapper.ocgcoreModule._clear_lua_coverage(
          this.duelPtr,
          namePtr,
        ),
      name,
    );
    return this;
  }

  clearAllLuaCoverages(): this {
    this.ocgcoreWrapper.ocgcoreModule._clear_all_lua_coverages(this.duelPtr);
    return this;
  }
}
