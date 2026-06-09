import {
  OcgcoreLuaCoverageMap,
  OcgcoreLuaLineCoverage,
} from '../types/lua-coverage';

export const normalizeLuaCoverageName = (name: string): string => {
  let normalized = name.startsWith('@') ? name.slice(1) : name;
  normalized = normalized.replace(/\\/g, '/');
  if (normalized.startsWith('./script/')) {
    return normalized.slice('./script/'.length);
  }
  if (normalized.startsWith('script/')) {
    return normalized.slice('script/'.length);
  }
  if (normalized.startsWith('./')) {
    return normalized.slice('./'.length);
  }
  return normalized;
};

export const toLuaLineCoverage = (
  file: string,
  hits: Record<number, number>,
): OcgcoreLuaLineCoverage => {
  const coveredLines = Object.keys(hits)
    .map((line) => Number(line))
    .sort((left, right) => left - right);
  return { file, hits, coveredLines };
};

export const parseLuaCoveragePairs = (
  file: string,
  raw: Uint8Array,
): OcgcoreLuaLineCoverage => {
  if (raw.byteLength % 8 !== 0) {
    throw new Error('Invalid Lua coverage dump.');
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const hits: Record<number, number> = {};
  for (let offset = 0; offset < view.byteLength; offset += 8) {
    const line = view.getUint32(offset, true);
    const hitCount = view.getUint32(offset + 4, true);
    hits[line] = hitCount;
  }
  return toLuaLineCoverage(file, hits);
};

export const parseAllLuaCoverages = (raw: Uint8Array): OcgcoreLuaCoverageMap => {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const decoder = new TextDecoder('utf-8');
  let offset = 0;

  const requireBytes = (count: number) => {
    if (offset + count > view.byteLength) {
      throw new Error('Invalid Lua coverage dump.');
    }
  };
  const readUint16 = () => {
    requireBytes(2);
    const value = view.getUint16(offset, true);
    offset += 2;
    return value;
  };
  const readUint32 = () => {
    requireBytes(4);
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const fileCount = readUint32();
  const coverages: OcgcoreLuaCoverageMap = {};
  for (let i = 0; i < fileCount; i++) {
    const nameLength = readUint16();
    requireBytes(nameLength);
    const file = decoder.decode(raw.subarray(offset, offset + nameLength));
    offset += nameLength;
    const recordCount = readUint32();
    const hits: Record<number, number> = {};
    for (let j = 0; j < recordCount; j++) {
      const line = readUint32();
      const hitCount = readUint32();
      hits[line] = hitCount;
    }
    coverages[file] = toLuaLineCoverage(file, hits);
  }
  if (offset !== view.byteLength) {
    throw new Error('Invalid Lua coverage dump.');
  }
  return coverages;
};
