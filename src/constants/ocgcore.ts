import { OcgcoreCommonConstants } from '../vendor';

export const MESSAGE_BUFFER_SIZE = OcgcoreCommonConstants.SIZE_MESSAGE_BUFFER;
export const RETURN_BUFFER_SIZE = OcgcoreCommonConstants.SIZE_RETURN_VALUE;
export const QUERY_BUFFER_SIZE = 0x40000;
export const REGISTRY_BUFFER_SIZE = 0x2000;

export const LEN_FAIL = 0;
export const LEN_EMPTY = 4;
export const LEN_HEADER = 8;

export const OcgcoreCreateFlags = {
  EnableLuaCoverage: 0x00000001,
} as const;
