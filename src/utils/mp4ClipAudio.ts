import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export interface ExtractedClipAudio {
  startSec: number;
  endSec: number;
  trimLeadSec: number;
  durationSec: number;
  audioBase64: string;
  mimeType: "audio/mp4";
}

interface BoxInfo {
  type: string;
  start: number;
  headerSize: number;
  size: number;
  end: number;
}

const MAX_MOOV_BYTES = 28 * 1024 * 1024;
const MAX_TOTAL_CLIP_AUDIO_BYTES = 24 * 1024 * 1024;
const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function readFourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0
  );
}

function readUint64(dv: DataView, offset: number): number {
  const hi = dv.getUint32(offset, false);
  const lo = dv.getUint32(offset + 4, false);
  return hi * 4294967296 + lo;
}

function readInt64(dv: DataView, offset: number): number {
  const hi = dv.getInt32(offset, false);
  const lo = dv.getUint32(offset + 4, false);
  return hi * 4294967296 + lo;
}

function iterBufferBoxes(
  bytes: Uint8Array,
  dv: DataView,
  start: number,
  end: number
): BoxInfo[] {
  const boxes: BoxInfo[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size32 = dv.getUint32(pos, false);
    const type = readFourCC(bytes, pos + 4);
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (pos + 16 > end) break;
      size = readUint64(dv, pos + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - pos;
    }
    if (!Number.isFinite(size) || size < headerSize || pos + size > end) {
      break;
    }
    boxes.push({
      type,
      start: pos,
      headerSize,
      size,
      end: pos + size,
    });
    pos += size;
  }
  return boxes;
}

function findChildBox(
  bytes: Uint8Array,
  dv: DataView,
  parent: BoxInfo,
  targetType: string,
  payloadExtraOffset = 0
): BoxInfo | null {
  const kids = iterBufferBoxes(
    bytes,
    dv,
    parent.start + parent.headerSize + payloadExtraOffset,
    parent.end
  );
  return kids.find((k) => k.type === targetType) ?? null;
}

function findChildBoxes(
  bytes: Uint8Array,
  dv: DataView,
  parent: BoxInfo,
  targetType: string,
  payloadExtraOffset = 0
): BoxInfo[] {
  return iterBufferBoxes(
    bytes,
    dv,
    parent.start + parent.headerSize + payloadExtraOffset,
    parent.end
  ).filter((k) => k.type === targetType);
}

function readDescrLength(bytes: Uint8Array, offset: number, end: number): { length: number; next: number } | null {
  let length = 0;
  let pos = offset;
  for (let i = 0; i < 4; i++) {
    if (pos >= end) return null;
    const b = bytes[pos++];
    length = (length << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      return { length, next: pos };
    }
  }
  return { length, next: pos };
}

function parseEsdsAudioSpecificConfig(
  bytes: Uint8Array,
  esdsBox: BoxInfo
): Uint8Array | null {
  let pos = esdsBox.start + esdsBox.headerSize + 4; // skip FullBox version+flags
  const end = esdsBox.end;
  if (pos >= end) return null;

  // Walk MPEG-4 ES_Descriptor (0x03) -> DecoderConfigDescriptor (0x04) -> DecoderSpecificInfo (0x05)
  while (pos + 2 <= end) {
    const tag = bytes[pos++];
    const lenInfo = readDescrLength(bytes, pos, end);
    if (!lenInfo) return null;
    pos = lenInfo.next;
    const tagEnd = Math.min(end, pos + lenInfo.length);

    if (tag === 0x03) {
      if (pos + 3 > tagEnd) return null;
      pos += 2; // ES_ID
      const flags = bytes[pos++];
      if (flags & 0x80) pos += 2; // streamDependenceFlag -> dependsOn_ES_ID
      if (flags & 0x40) {
        if (pos >= tagEnd) return null;
        const urlLen = bytes[pos++];
        pos += urlLen;
      }
      if (flags & 0x20) pos += 2; // OCRstreamFlag -> OCR_ES_Id
      continue;
    }

    if (tag === 0x04) {
      if (pos + 13 > tagEnd) return null;
      const objectTypeIndication = bytes[pos];
      // Support MPEG-4 Audio (0x40) and MPEG-2 AAC (0x66, 0x67, 0x68)
      if (
        objectTypeIndication !== 0x40 &&
        objectTypeIndication !== 0x66 &&
        objectTypeIndication !== 0x67 &&
        objectTypeIndication !== 0x68
      ) {
        return null;
      }
      pos += 13; // objectTypeIndication(1) + streamType(1) + bufferSizeDB(3) + maxBitrate(4) + avgBitrate(4)
      continue;
    }

    if (tag === 0x05) {
      const cfgLen = Math.max(0, tagEnd - pos);
      if (cfgLen < 2) return null;
      return bytes.slice(pos, pos + cfgLen);
    }

    pos = tagEnd;
  }

  return null;
}

function parseAudioSpecificConfigMeta(
  asc: Uint8Array
): { sampleRate: number; channels: number } | null {
  if (asc.length < 2) return null;
  const b0 = asc[0];
  const b1 = asc[1];
  let objType = (b0 >> 3) & 0x1f;
  let bitPos = 5;
  const readBits = (count: number): number => {
    let val = 0;
    for (let i = 0; i < count; i++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitInByte = 7 - (bitPos % 8);
      if (byteIdx >= asc.length) return 0;
      val = (val << 1) | ((asc[byteIdx] >> bitInByte) & 1);
      bitPos++;
    }
    return val;
  };
  if (objType === 31) {
    objType = 32 + readBits(6);
  }
  const freqIdx = readBits(4);
  let sampleRate = 0;
  if (freqIdx === 15) {
    sampleRate = readBits(24);
  } else if (freqIdx < AAC_SAMPLE_RATES.length) {
    sampleRate = AAC_SAMPLE_RATES[freqIdx];
  }
  const channelCfg = readBits(4);
  const channels = channelCfg >= 1 && channelCfg <= 6 ? channelCfg : channelCfg === 7 ? 8 : 2;
  if (sampleRate < 8000 || sampleRate > 96000) return null;
  void b1;
  return { sampleRate, channels };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    parts.push(String.fromCharCode(...sub));
  }
  return btoa(parts.join(""));
}

async function locateMoovBox(file: File): Promise<{ offset: number; size: number } | null> {
  let pos = 0;
  let sawFtypOrMedia = false;
  let hops = 0;

  while (pos + 8 <= file.size && hops < 128) {
    hops++;
    const headLen = Math.min(16, file.size - pos);
    const headBuf = await file.slice(pos, pos + headLen).arrayBuffer();
    const bytes = new Uint8Array(headBuf);
    const dv = new DataView(headBuf);
    const size32 = dv.getUint32(0, false);
    const type = readFourCC(bytes, 4);

    if (pos === 0) {
      if (type !== "ftyp" && type !== "wide" && type !== "free" && type !== "mdat" && type !== "moov") {
        return null;
      }
    }

    let boxSize = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (headLen < 16) return null;
      boxSize = readUint64(dv, 8);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = file.size - pos;
    }

    if (!Number.isFinite(boxSize) || boxSize < headerSize || pos + boxSize > file.size) {
      return null;
    }

    if (type === "ftyp" || type === "mdat" || type === "moov") {
      sawFtypOrMedia = true;
    }
    if (type === "moov") {
      if (!sawFtypOrMedia || boxSize > MAX_MOOV_BYTES) return null;
      return { offset: pos, size: boxSize };
    }
    pos += boxSize;
  }

  return null;
}

interface ParsedAudioTrack {
  timescale: number;
  editShiftSec: number;
  sampleRate: number;
  numberOfChannels: number;
  audioSpecificConfig: Uint8Array;
  sampleStartTicks: Float64Array;
  sampleEndTicks: Float64Array;
  sampleOffsets: Float64Array;
  sampleSizes: Uint32Array;
}

function parseMoovAudioTrack(moovBytes: Uint8Array): {
  audioTrack: ParsedAudioTrack | null;
  hasSubtitleTrack: boolean;
} {
  const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const rootBoxes = iterBufferBoxes(moovBytes, dv, 0, moovBytes.length);
  const moov = rootBoxes.find((b) => b.type === "moov");
  if (!moov) return { audioTrack: null, hasSubtitleTrack: false };

  // Fragmented MP4 requires reading moof boxes across mdat; defer to server upload
  if (findChildBox(moovBytes, dv, moov, "mvex")) {
    return { audioTrack: null, hasSubtitleTrack: false };
  }

  const mvhd = findChildBox(moovBytes, dv, moov, "mvhd");
  if (!mvhd) return { audioTrack: null, hasSubtitleTrack: false };
  const mvhdPayload = mvhd.start + mvhd.headerSize;
  const mvhdVersion = moovBytes[mvhdPayload] ?? 0;
  const movieTimescale =
    mvhdVersion === 1
      ? dv.getUint32(mvhdPayload + 20, false)
      : dv.getUint32(mvhdPayload + 12, false);
  if (!movieTimescale || !Number.isFinite(movieTimescale)) {
    return { audioTrack: null, hasSubtitleTrack: false };
  }

  const traks = findChildBoxes(moovBytes, dv, moov, "trak");
  let hasSubtitleTrack = false;
  let audioTrack: ParsedAudioTrack | null = null;

  for (const trak of traks) {
    const mdia = findChildBox(moovBytes, dv, trak, "mdia");
    if (!mdia) continue;
    const hdlr = findChildBox(moovBytes, dv, mdia, "hdlr");
    if (!hdlr || hdlr.start + hdlr.headerSize + 12 > hdlr.end) continue;
    const handlerType = readFourCC(moovBytes, hdlr.start + hdlr.headerSize + 8);

    if (handlerType === "sbtl" || handlerType === "text" || handlerType === "subt") {
      hasSubtitleTrack = true;
      continue;
    }
    if (handlerType !== "soun" || audioTrack) continue;

    const mdhd = findChildBox(moovBytes, dv, mdia, "mdhd");
    if (!mdhd) continue;
    const mdhdPayload = mdhd.start + mdhd.headerSize;
    const mdhdVer = moovBytes[mdhdPayload] ?? 0;
    const timescale =
      mdhdVer === 1
        ? dv.getUint32(mdhdPayload + 20, false)
        : dv.getUint32(mdhdPayload + 12, false);
    if (!timescale || !Number.isFinite(timescale)) continue;

    // Optional edts -> elst initial alignment shift
    let editShiftSec = 0;
    let complexEdit = false;
    const edts = findChildBox(moovBytes, dv, trak, "edts");
    const elst = edts ? findChildBox(moovBytes, dv, edts, "elst") : null;
    if (elst) {
      const ep = elst.start + elst.headerSize;
      const elstVer = moovBytes[ep] ?? 0;
      const entryCount = dv.getUint32(ep + 4, false);
      const entrySize = elstVer === 1 ? 20 : 12;
      if (entryCount > 2 || ep + 8 + entryCount * entrySize > elst.end) {
        complexEdit = true;
      } else {
        const readEntry = (idx: number) => {
          const base = ep + 8 + idx * entrySize;
          if (elstVer === 1) {
            return {
              segDur: readUint64(dv, base),
              mediaTime: readInt64(dv, base + 8),
              rateInt: dv.getInt16(base + 16, false),
            };
          }
          return {
            segDur: dv.getUint32(base, false),
            mediaTime: dv.getInt32(base + 4, false),
            rateInt: dv.getInt16(base + 8, false),
          };
        };
        if (entryCount === 1) {
          const e0 = readEntry(0);
          if (e0.mediaTime < 0 || (e0.rateInt !== 1 && e0.rateInt !== 0)) {
            complexEdit = true;
          } else {
            editShiftSec = -e0.mediaTime / timescale;
          }
        } else if (entryCount === 2) {
          const e0 = readEntry(0);
          const e1 = readEntry(1);
          if (e0.mediaTime !== -1 || e1.mediaTime < 0 || e1.rateInt !== 1) {
            complexEdit = true;
          } else {
            editShiftSec = e0.segDur / movieTimescale - e1.mediaTime / timescale;
          }
        }
      }
    }
    if (complexEdit) continue;

    const minf = findChildBox(moovBytes, dv, mdia, "minf");
    const stbl = minf ? findChildBox(moovBytes, dv, minf, "stbl") : null;
    if (!stbl) continue;

    const stsd = findChildBox(moovBytes, dv, stbl, "stsd");
    if (!stsd || stsd.start + stsd.headerSize + 8 > stsd.end) continue;
    const stsdEntryCount = dv.getUint32(stsd.start + stsd.headerSize + 4, false);
    if (stsdEntryCount < 1) continue;
    const sampleEntry = findChildBox(moovBytes, dv, stsd, "mp4a", 8);
    if (!sampleEntry) continue;

    const seStart = sampleEntry.start + sampleEntry.headerSize;
    if (seStart + 28 > sampleEntry.end) continue;
    const entryVersion = dv.getUint16(seStart + 8, false);
    let audioEntrySize = 28;
    if (entryVersion === 1) audioEntrySize += 16;
    else if (entryVersion === 2) audioEntrySize += 36;
    if (seStart + audioEntrySize > sampleEntry.end) continue;

    const stsdChannels = dv.getUint16(seStart + 16, false) || 2;
    const stsdSampleRate = dv.getUint16(seStart + 24, false) || timescale;

    let esdsBox = findChildBox(moovBytes, dv, sampleEntry, "esds", audioEntrySize);
    if (!esdsBox) {
      const waveBox = findChildBox(moovBytes, dv, sampleEntry, "wave", audioEntrySize);
      if (waveBox) {
        esdsBox = findChildBox(moovBytes, dv, waveBox, "esds");
      }
    }
    if (!esdsBox) continue;

    const audioSpecificConfig = parseEsdsAudioSpecificConfig(moovBytes, esdsBox);
    if (!audioSpecificConfig) continue;

    const ascMeta = parseAudioSpecificConfigMeta(audioSpecificConfig);
    const sampleRate =
      AAC_SAMPLE_RATES.includes(stsdSampleRate)
        ? stsdSampleRate
        : ascMeta?.sampleRate ?? stsdSampleRate;
    const numberOfChannels = ascMeta?.channels ?? stsdChannels;

    const stts = findChildBox(moovBytes, dv, stbl, "stts");
    const stsz = findChildBox(moovBytes, dv, stbl, "stsz");
    const stsc = findChildBox(moovBytes, dv, stbl, "stsc");
    const stco = findChildBox(moovBytes, dv, stbl, "stco");
    const co64 = stco ? null : findChildBox(moovBytes, dv, stbl, "co64");
    if (!stts || !stsz || !stsc || (!stco && !co64)) continue;

    // Parse stsz
    const stszP = stsz.start + stsz.headerSize;
    const constSize = dv.getUint32(stszP + 4, false);
    const sampleCount = dv.getUint32(stszP + 8, false);
    if (sampleCount === 0 || sampleCount > 2_000_000) continue;

    const sampleSizes = new Uint32Array(sampleCount);
    if (constSize > 0) {
      sampleSizes.fill(constSize);
    } else {
      if (stszP + 12 + sampleCount * 4 > stsz.end) continue;
      for (let i = 0; i < sampleCount; i++) {
        sampleSizes[i] = dv.getUint32(stszP + 12 + i * 4, false);
      }
    }

    // Parse stts -> start/end ticks for every sample
    const sttsP = stts.start + stts.headerSize;
    const sttsCount = dv.getUint32(sttsP + 4, false);
    if (sttsP + 8 + sttsCount * 8 > stts.end) continue;
    const sampleStartTicks = new Float64Array(sampleCount);
    const sampleEndTicks = new Float64Array(sampleCount);
    let sIdx = 0;
    let tick = 0;
    for (let i = 0; i < sttsCount && sIdx < sampleCount; i++) {
      const cnt = dv.getUint32(sttsP + 8 + i * 8, false);
      const delta = dv.getUint32(sttsP + 12 + i * 8, false);
      for (let k = 0; k < cnt && sIdx < sampleCount; k++) {
        sampleStartTicks[sIdx] = tick;
        tick += delta;
        sampleEndTicks[sIdx] = tick;
        sIdx++;
      }
    }
    if (sIdx < sampleCount) continue;

    // Parse chunk offsets (stco or co64)
    let chunkCount = 0;
    let chunkOffsets: Float64Array;
    if (stco) {
      const p = stco.start + stco.headerSize;
      chunkCount = dv.getUint32(p + 4, false);
      if (p + 8 + chunkCount * 4 > stco.end) continue;
      chunkOffsets = new Float64Array(chunkCount);
      for (let i = 0; i < chunkCount; i++) {
        chunkOffsets[i] = dv.getUint32(p + 8 + i * 4, false);
      }
    } else if (co64) {
      const p = co64.start + co64.headerSize;
      chunkCount = dv.getUint32(p + 4, false);
      if (p + 8 + chunkCount * 8 > co64.end) continue;
      chunkOffsets = new Float64Array(chunkCount);
      for (let i = 0; i < chunkCount; i++) {
        chunkOffsets[i] = readUint64(dv, p + 8 + i * 8);
      }
    } else {
      continue;
    }
    if (chunkCount === 0) continue;

    // Parse stsc -> compute exact byte offset of every audio sample
    const stscP = stsc.start + stsc.headerSize;
    const stscCount = dv.getUint32(stscP + 4, false);
    if (stscCount === 0 || stscP + 8 + stscCount * 12 > stsc.end) continue;

    const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
    for (let i = 0; i < stscCount; i++) {
      stscEntries.push({
        firstChunk: dv.getUint32(stscP + 8 + i * 12, false),
        samplesPerChunk: dv.getUint32(stscP + 12 + i * 12, false),
      });
    }

    const sampleOffsets = new Float64Array(sampleCount);
    let curSample = 0;
    for (let eIdx = 0; eIdx < stscEntries.length && curSample < sampleCount; eIdx++) {
      const startChunk = Math.max(0, stscEntries[eIdx].firstChunk - 1);
      const endChunk =
        eIdx + 1 < stscEntries.length
          ? Math.min(chunkCount, stscEntries[eIdx + 1].firstChunk - 1)
          : chunkCount;
      const spc = stscEntries[eIdx].samplesPerChunk;
      for (let c = startChunk; c < endChunk && curSample < sampleCount; c++) {
        let byteOff = chunkOffsets[c];
        for (let k = 0; k < spc && curSample < sampleCount; k++) {
          sampleOffsets[curSample] = byteOff;
          byteOff += sampleSizes[curSample];
          curSample++;
        }
      }
    }
    if (curSample < sampleCount) continue;

    audioTrack = {
      timescale,
      editShiftSec,
      sampleRate,
      numberOfChannels,
      audioSpecificConfig,
      sampleStartTicks,
      sampleEndTicks,
      sampleOffsets,
      sampleSizes,
    };
  }

  return { audioTrack, hasSubtitleTrack };
}

function findSampleIndexByTick(sampleEndTicks: Float64Array, targetTick: number): number {
  let lo = 0;
  let hi = sampleEndTicks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sampleEndTicks[mid] < targetTick) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export async function extractMp4AudioClips(
  file: File,
  scenes: Array<{ startSec: number; endSec: number }>,
  options: { maxTotalAudioBytes?: number } = {}
): Promise<ExtractedClipAudio[] | null> {
  try {
    if (!file || file.size < 64 || scenes.length === 0) return null;

    const moovLoc = await locateMoovBox(file);
    if (!moovLoc) return null;

    const moovBuf = await file.slice(moovLoc.offset, moovLoc.offset + moovLoc.size).arrayBuffer();
    const moovBytes = new Uint8Array(moovBuf);
    const { audioTrack, hasSubtitleTrack } = parseMoovAudioTrack(moovBytes);
    if (!audioTrack) return null;

    // For modest-sized files that contain an embedded soft subtitle track, prefer server upload so embedded cues are used
    if (hasSubtitleTrack && file.size <= 25 * 1024 * 1024) {
      return null;
    }

    const maxBytes = options.maxTotalAudioBytes ?? MAX_TOTAL_CLIP_AUDIO_BYTES;
    const {
      timescale,
      editShiftSec,
      sampleRate,
      numberOfChannels,
      audioSpecificConfig,
      sampleStartTicks,
      sampleEndTicks,
      sampleOffsets,
      sampleSizes,
    } = audioTrack;

    const sampleCount = sampleSizes.length;
    const sceneRanges: Array<{
      startSec: number;
      endSec: number;
      firstIdx: number;
      lastIdx: number;
      actualStartMovieSec: number;
    }> = [];
    let estimatedTotalBytes = 0;

    for (const sc of scenes) {
      const startSec = Math.max(0, Number(sc.startSec) || 0);
      const endSec = Math.max(startSec + 0.25, Number(sc.endSec) || startSec + 1);
      const paddedStartMediaSec = Math.max(0, startSec - editShiftSec - 0.05);
      const paddedEndMediaSec = Math.max(paddedStartMediaSec + 0.1, endSec - editShiftSec + 0.08);

      const firstIdx = Math.max(
        0,
        Math.min(sampleCount - 1, findSampleIndexByTick(sampleEndTicks, paddedStartMediaSec * timescale))
      );
      let lastIdx = Math.max(
        firstIdx,
        Math.min(sampleCount - 1, findSampleIndexByTick(sampleEndTicks, paddedEndMediaSec * timescale))
      );
      while (lastIdx + 1 < sampleCount && sampleStartTicks[lastIdx + 1] < paddedEndMediaSec * timescale) {
        lastIdx++;
      }

      for (let i = firstIdx; i <= lastIdx; i++) {
        estimatedTotalBytes += sampleSizes[i];
      }
      if (estimatedTotalBytes > maxBytes) {
        return null;
      }

      const actualStartMovieSec = sampleStartTicks[firstIdx] / timescale + editShiftSec;
      sceneRanges.push({ startSec, endSec, firstIdx, lastIdx, actualStartMovieSec });
    }

    // Coalesce contiguous/near-contiguous byte ranges across all scenes for minimal File.slice() calls
    const MERGE_GAP_BYTES = 16 * 1024;
    const rawSpans: { start: number; end: number }[] = [];
    for (const sr of sceneRanges) {
      for (let i = sr.firstIdx; i <= sr.lastIdx; i++) {
        const sOff = sampleOffsets[i];
        const sEnd = sOff + sampleSizes[i];
        if (sEnd > file.size) return null;
        const prev = rawSpans[rawSpans.length - 1];
        if (prev && sOff >= prev.start && sOff <= prev.end + MERGE_GAP_BYTES) {
          if (sEnd > prev.end) prev.end = sEnd;
        } else {
          rawSpans.push({ start: sOff, end: sEnd });
        }
      }
    }

    const spanBuffers = await Promise.all(
      rawSpans.map(async (sp) => {
        const buf = await file.slice(sp.start, sp.end).arrayBuffer();
        return { start: sp.start, end: sp.end, bytes: new Uint8Array(buf) };
      })
    );

    const findSampleBytes = (offset: number, size: number): Uint8Array | null => {
      for (const sp of spanBuffers) {
        if (offset >= sp.start && offset + size <= sp.end) {
          const rel = offset - sp.start;
          return sp.bytes.subarray(rel, rel + size);
        }
      }
      return null;
    };

    const output: ExtractedClipAudio[] = [];
    for (const sr of sceneRanges) {
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        audio: {
          codec: "aac",
          numberOfChannels,
          sampleRate,
        },
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });

      let addedAny = false;
      for (let i = sr.firstIdx; i <= sr.lastIdx; i++) {
        const sampleBytes = findSampleBytes(sampleOffsets[i], sampleSizes[i]);
        if (!sampleBytes) return null;
        const tsUs = Math.max(0, Math.round((sampleStartTicks[i] / timescale) * 1_000_000));
        const durUs = Math.max(
          1000,
          Math.round(((sampleEndTicks[i] - sampleStartTicks[i]) / timescale) * 1_000_000)
        );
        muxer.addAudioChunkRaw(
          sampleBytes,
          "key",
          tsUs,
          durUs,
          !addedAny
            ? {
                decoderConfig: {
                  codec: "mp4a.40.2",
                  numberOfChannels,
                  sampleRate,
                  description: audioSpecificConfig,
                },
              }
            : undefined
        );
        addedAny = true;
      }

      if (!addedAny) return null;
      muxer.finalize();
      if (!target.buffer || target.buffer.byteLength < 64) return null;

      output.push({
        startSec: Number(sr.startSec.toFixed(2)),
        endSec: Number(sr.endSec.toFixed(2)),
        trimLeadSec: Number(Math.max(0, sr.startSec - sr.actualStartMovieSec).toFixed(4)),
        durationSec: Number((sr.endSec - sr.startSec).toFixed(2)),
        audioBase64: arrayBufferToBase64(target.buffer),
        mimeType: "audio/mp4",
      });
    }

    return output;
  } catch {
    return null;
  }
}
