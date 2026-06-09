import { OcgcoreDuel } from '../src/ocgcore-duel';
import { OcgcoreWrapper } from '../src/ocgcore-wrapper';
import { OcgcoreCreateFlags } from '../src/constants';
import type { OcgcoreModule } from '../src/vendor/libocgcore.shared';
import { normalizeLuaCoverageName } from '../src/utility/lua-coverage';
import { createOcgcoreWrapper } from '../src/create-ocgcore-wrapper';

const encodePairs = (records: Array<[number, number]>): Uint8Array => {
  const raw = new Uint8Array(records.length * 8);
  const view = new DataView(raw.buffer);
  records.forEach(([line, hits], index) => {
    const offset = index * 8;
    view.setUint32(offset, line, true);
    view.setUint32(offset + 4, hits, true);
  });
  return raw;
};

const encodeAll = (
  files: Array<{ file: string; records: Array<[number, number]> }>,
): Uint8Array => {
  const encoder = new TextEncoder();
  const encoded = files.map((file) => ({
    ...file,
    name: encoder.encode(file.file),
  }));
  const length =
    4 +
    encoded.reduce(
      (sum, file) => sum + 2 + file.name.length + 4 + file.records.length * 8,
      0,
    );
  const raw = new Uint8Array(length);
  const view = new DataView(raw.buffer);
  let offset = 0;
  view.setUint32(offset, files.length, true);
  offset += 4;
  for (const file of encoded) {
    view.setUint16(offset, file.name.length, true);
    offset += 2;
    raw.set(file.name, offset);
    offset += file.name.length;
    view.setUint32(offset, file.records.length, true);
    offset += 4;
    for (const [line, hits] of file.records) {
      view.setUint32(offset, line, true);
      view.setUint32(offset + 4, hits, true);
      offset += 8;
    }
  }
  return raw;
};

const createMockModule = (overrides: Partial<OcgcoreModule> = {}) => {
  const heap = new Uint8Array(1024 * 1024);
  let nextPtr = 8;
  let nextFn = 1;
  const malloc = jest.fn((size: number) => {
    const ptr = nextPtr;
    nextPtr += Math.max(1, size);
    return ptr;
  });
  const free = jest.fn();
  const module: Partial<OcgcoreModule> = {
    HEAPU8: heap as unknown as OcgcoreModule['HEAPU8'],
    _malloc: malloc,
    _free: free,
    addFunction: jest.fn(() => nextFn++),
    removeFunction: jest.fn(),
    _set_script_reader: jest.fn(),
    _set_card_reader: jest.fn(),
    _set_message_handler: jest.fn(),
    _default_script_reader: jest.fn(() => 0),
    _create_duel: jest.fn(() => 101),
    _create_duel_v2: jest.fn(() => 102),
    _create_duel_ex: jest.fn(() => 201),
    _create_duel_v2_ex: jest.fn(() => 202),
    _start_duel: jest.fn(),
    _end_duel: jest.fn(),
    _set_player_info: jest.fn(),
    _get_log_message: jest.fn(() => 0),
    _get_message: jest.fn(() => 0),
    _process: jest.fn(() => 0),
    _new_card: jest.fn(),
    _new_tag_card: jest.fn(),
    _query_card: jest.fn(() => 0),
    _query_field_count: jest.fn(() => 0),
    _query_field_card: jest.fn(() => 0),
    _query_field_info: jest.fn(() => 0),
    _set_responsei: jest.fn(),
    _set_responseb: jest.fn(),
    _preload_script: jest.fn(() => 0),
    _get_registry_value: jest.fn(() => 0),
    _set_registry_value: jest.fn(),
    _get_registry_keys: jest.fn(() => 0),
    _clear_registry: jest.fn(),
    _dump_registry: jest.fn(() => 0),
    _load_registry: jest.fn(),
    _get_lua_coverage_dump_size: jest.fn(() => 0),
    _dump_lua_coverage: jest.fn(() => 0),
    _get_all_lua_coverages_dump_size: jest.fn(() => 0),
    _dump_all_lua_coverages: jest.fn(() => 0),
    _clear_lua_coverage: jest.fn(),
    _clear_all_lua_coverages: jest.fn(),
    ___stdio_exit: jest.fn(),
    ...overrides,
  };
  return {
    heap,
    malloc,
    free,
    module: module as OcgcoreModule,
  };
};

describe('Lua coverage wrapper', () => {
  jest.setTimeout(30000);

  test('normalizes coverage file names', () => {
    expect(normalizeLuaCoverageName('@./script/foo/bar.lua')).toBe(
      'foo/bar.lua',
    );
    expect(normalizeLuaCoverageName('./script/foo/bar.lua')).toBe(
      'foo/bar.lua',
    );
    expect(normalizeLuaCoverageName('script/foo/bar.lua')).toBe('foo/bar.lua');
    expect(normalizeLuaCoverageName('./single/foo.lua')).toBe('single/foo.lua');
    expect(normalizeLuaCoverageName('/home/nanahira/foo.lua')).toBe(
      '/home/nanahira/foo.lua',
    );
  });

  test('passes create flags to extended duel creation APIs', () => {
    const mock = createMockModule({
      _create_duel_ex: jest.fn(() => 201),
      _create_duel_v2_ex: jest.fn(() => 202),
    });
    const wrapper = new OcgcoreWrapper(mock.module);

    wrapper.createDuel(123, OcgcoreCreateFlags.EnableLuaCoverage);
    wrapper.createDuelV2([1, 2, 3], OcgcoreCreateFlags.EnableLuaCoverage);

    expect(mock.module._create_duel).not.toHaveBeenCalled();
    expect(mock.module._create_duel_ex).toHaveBeenCalledWith(
      123,
      OcgcoreCreateFlags.EnableLuaCoverage,
    );
    expect(mock.module._create_duel_v2).not.toHaveBeenCalled();
    expect(mock.module._create_duel_v2_ex).toHaveBeenCalledWith(
      expect.any(Number),
      OcgcoreCreateFlags.EnableLuaCoverage,
    );
  });

  test('keeps old duel creation APIs when flags are omitted', () => {
    const mock = createMockModule({
      _create_duel_ex: jest.fn(() => 201),
      _create_duel_v2_ex: jest.fn(() => 202),
    });
    const wrapper = new OcgcoreWrapper(mock.module);

    wrapper.createDuel(123);
    wrapper.createDuelV2([1, 2, 3]);

    expect(mock.module._create_duel).toHaveBeenCalledWith(123);
    expect(mock.module._create_duel_v2).toHaveBeenCalledWith(expect.any(Number));
    expect(mock.module._create_duel_ex).not.toHaveBeenCalled();
    expect(mock.module._create_duel_v2_ex).not.toHaveBeenCalled();
  });

  test('parses single-file coverage dumps and frees the dump buffer', () => {
    const raw = encodePairs([
      [10, 1],
      [2, 3],
    ]);
    const mock = createMockModule({
      _get_lua_coverage_dump_size: jest.fn(() => raw.length),
      _dump_lua_coverage: jest.fn((_duel, _name, outPtr, outLen) => {
        mock.heap.set(raw, outPtr);
        return outLen;
      }),
    });
    const duel = new OcgcoreDuel(new OcgcoreWrapper(mock.module), 1);

    const coverage = duel.getLuaCoverage('@./script/c11111111.lua');

    expect(coverage).toEqual({
      file: 'c11111111.lua',
      hits: { 2: 3, 10: 1 },
      coveredLines: [2, 10],
    });
    expect(mock.free).toHaveBeenCalledWith(expect.any(Number));
  });

  test('parses all-file coverage dumps', () => {
    const raw = encodeAll([
      { file: 'c11111111.lua', records: [[4, 2]] },
      {
        file: 'helper/foo.lua',
        records: [
          [1, 1],
          [3, 5],
        ],
      },
    ]);
    const mock = createMockModule({
      _get_all_lua_coverages_dump_size: jest.fn(() => raw.length),
      _dump_all_lua_coverages: jest.fn((_duel, outPtr, outLen) => {
        mock.heap.set(raw, outPtr);
        return outLen;
      }),
    });
    const duel = new OcgcoreDuel(new OcgcoreWrapper(mock.module), 1);

    expect(duel.getAllLuaCoverages()).toEqual({
      'c11111111.lua': {
        file: 'c11111111.lua',
        hits: { 4: 2 },
        coveredLines: [4],
      },
      'helper/foo.lua': {
        file: 'helper/foo.lua',
        hits: { 1: 1, 3: 5 },
        coveredLines: [1, 3],
      },
    });
  });

  test('clears one or all Lua coverage entries', () => {
    const mock = createMockModule({
      _clear_lua_coverage: jest.fn(),
      _clear_all_lua_coverages: jest.fn(),
    });
    const duel = new OcgcoreDuel(new OcgcoreWrapper(mock.module), 1);

    expect(duel.clearLuaCoverage('./script/c11111111.lua')).toBe(duel);
    expect(duel.clearAllLuaCoverages()).toBe(duel);

    expect(mock.module._clear_lua_coverage).toHaveBeenCalledWith(
      1,
      expect.any(Number),
    );
    expect(mock.module._clear_all_lua_coverages).toHaveBeenCalledWith(1);
  });

  test('frees the dump buffer when parsing fails', () => {
    const raw = new Uint8Array([1, 2, 3]);
    const mock = createMockModule({
      _get_lua_coverage_dump_size: jest.fn(() => raw.length),
      _dump_lua_coverage: jest.fn((_duel, _name, outPtr, outLen) => {
        mock.heap.set(raw, outPtr);
        return outLen;
      }),
    });
    const duel = new OcgcoreDuel(new OcgcoreWrapper(mock.module), 1);

    expect(() => duel.getLuaCoverage('broken.lua')).toThrow(
      /Invalid Lua coverage dump/,
    );
    expect(mock.free).toHaveBeenCalledWith(expect.any(Number));
  });

  test('records direct Lua script execution in real wasm', async () => {
    const wrapper = await createOcgcoreWrapper();
    try {
      wrapper.setScriptReader((scriptPath) => {
        if (scriptPath.endsWith('coverage-smoke.lua')) {
          return `
local x = 1
x = x + 1
return x
`;
        }
        return '';
      });
      const duel = wrapper.createDuel(
        123,
        OcgcoreCreateFlags.EnableLuaCoverage,
      );

      duel.preloadScript('./script/coverage-smoke.lua');
      const coverage = duel.getLuaCoverage('coverage-smoke.lua');

      expect(coverage.coveredLines).toEqual(
        expect.arrayContaining([2, 3, 4]),
      );
      expect(coverage.hits[2]).toBeGreaterThan(0);
      duel.endDuel();
    } finally {
      wrapper.finalize();
    }
  });
});
