import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export const MODEL_KEYS = [
  'nature/Pine_1',
  'nature/Pine_2',
  'nature/Pine_3',
  'nature/Pine_4',
  'nature/Pine_5',
  'nature/CommonTree_1',
  'nature/CommonTree_2',
  'nature/CommonTree_3',
  'nature/TwistedTree_1',
  'nature/TwistedTree_2',
  'nature/DeadTree_1',
  'nature/Bush_Common',
  'nature/Fern_1',
  'nature/Clover_1',
  'nature/Grass_Wispy_Tall',
  'nature/Grass_Wispy_Short',
  'nature/Grass_Common_Short',
  'nature/Rock_Medium_1',
  'nature/Rock_Medium_2',
  'nature/Rock_Medium_3',
  'nature/Pebble_Round_1',
  'nature/Pebble_Round_2',
  'village/Hut',
  'village/Prop_Crate',
  'village/Prop_Wagon',
  'village/Prop_WoodenFence_Single',
  'animals/Wolf',
] as const;

export type LoadedModels = Record<string, GLTF>;

function decodeBase64Uri(uri: string): Uint8Array {
  const raw = atob(uri.slice(uri.indexOf(',') + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Converts a glTF JSON with embedded data URIs into a compact binary GLB ArrayBuffer
 * so GLTFLoader parses it cleanly with zero external bin/image requests.
 */
function gltfJsonToGlb(gltf: Record<string, any>): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pushData = (bytes: Uint8Array): number => {
    const start = offset;
    const pad = (4 - (bytes.length % 4)) % 4;
    if (pad) {
      const padded = new Uint8Array(bytes.length + pad);
      padded.set(bytes);
      chunks.push(padded);
      offset += padded.length;
    } else {
      chunks.push(bytes);
      offset += bytes.length;
    }
    return start;
  };

  if (Array.isArray(gltf.buffers)) {
    for (const buf of gltf.buffers) {
      if (typeof buf.uri === 'string' && buf.uri.startsWith('data:')) {
        const bytes = decodeBase64Uri(buf.uri);
        delete buf.uri;
        buf.byteLength = bytes.length;
        pushData(bytes);
      }
    }
  }

  if (Array.isArray(gltf.images)) {
    gltf.bufferViews = gltf.bufferViews || [];
    for (const img of gltf.images) {
      if (typeof img.uri === 'string' && img.uri.startsWith('data:')) {
        const mimeMatch = img.uri.match(/^data:([^;]+);/);
        const bytes = decodeBase64Uri(img.uri);
        const byteOffset = pushData(bytes);
        const bvIdx = gltf.bufferViews.length;
        gltf.bufferViews.push({
          buffer: 0,
          byteOffset,
          byteLength: bytes.length,
        });
        delete img.uri;
        img.bufferView = bvIdx;
        img.mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
      }
    }
  }

  if (gltf.buffers && gltf.buffers[0]) {
    gltf.buffers[0].byteLength = offset;
  }

  const binBuf = new Uint8Array(offset);
  let cursor = 0;
  for (const c of chunks) {
    binBuf.set(c, cursor);
    cursor += c.length;
  }

  let jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }

  const totalLength = 20 + jsonBytes.length + 8 + binBuf.length;
  const glb = new ArrayBuffer(totalLength);
  const view = new DataView(glb);
  const out = new Uint8Array(glb);

  // Header: magic "glTF", version 2, totalLength
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  // JSON chunk
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  // BIN chunk
  const binStart = 20 + jsonBytes.length;
  view.setUint32(binStart, binBuf.length, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  out.set(binBuf, binStart + 8);

  return glb;
}

export async function loadAllModels(
  onProgress?: (pct: number) => void,
): Promise<LoadedModels> {
  const loader = new GLTFLoader();
  const result: LoadedModels = {};
  let loaded = 0;

  await Promise.all(
    MODEL_KEYS.map(async (key) => {
      const resp = await fetch(`/models/${key}.json`);
      if (!resp.ok) {
        throw new Error(`Model fetch failed: /models/${key}.json (${resp.status})`);
      }
      const json = await resp.json();
      const glb = gltfJsonToGlb(json);
      const shortName = key.split('/')[1];
      result[shortName] = await loader.parseAsync(glb, './');
      loaded++;
      onProgress?.(Math.round((loaded / MODEL_KEYS.length) * 86));
    }),
  );

  return result;
}
