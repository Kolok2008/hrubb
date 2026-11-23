import * as THREE from 'three';
import {
  createCheckClothTexture,
  createWickerTexture,
  createWoodGrainTexture,
} from '../utils/textures';
import { applyViewmodelDepth } from './KnifeBuilder';

/**
 * Builds the woven wicker foraging basket carried on the left side of the viewport.
 */
export function buildForagingBasket(): {
  group: THREE.Group;
  contents: THREE.Group;
} {
  const group = new THREE.Group();
  const radius = 0.172;
  const wickerMat = applyViewmodelDepth(
    new THREE.MeshStandardMaterial({
      map: createWickerTexture(),
      roughness: 0.86,
      side: THREE.DoubleSide,
    }),
  );

  const body = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        [0, 0],
        [radius * 0.62, 0],
        [radius * 0.85, 0.032],
        [radius * 0.97, 0.084],
        [radius, 0.125],
      ].map(([r, y]) => new THREE.Vector2(r, y)),
      28,
    ),
    wickerMat,
  );
  group.add(body);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.013, 8, 36),
    applyViewmodelDepth(
      new THREE.MeshStandardMaterial({
        map: createWoodGrainTexture('#8a5a2c'),
        roughness: 0.8,
      }),
    ),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.125;
  group.add(rim);

  const archHandle = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.96, 0.011, 8, 28, Math.PI),
    applyViewmodelDepth(
      new THREE.MeshStandardMaterial({
        map: createWoodGrainTexture('#9a6a3a'),
        roughness: 0.72,
      }),
    ),
  );
  archHandle.position.y = 0.125;
  group.add(archHandle);

  const liner = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.88, 24).rotateX(-Math.PI / 2),
    applyViewmodelDepth(
      new THREE.MeshStandardMaterial({
        color: '#c24d3b',
        map: createCheckClothTexture(),
        roughness: 0.98,
      }),
    ),
  );
  liner.position.y = 0.025;
  group.add(liner);

  const contents = new THREE.Group();
  contents.position.y = 0.032;
  group.add(contents);

  return { group, contents };
}

/**
 * Folded checkered handkerchief used during the blade-wipe animation (R).
 */
export function buildWipeCloth(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(0.086, 0.016, 0.082, 3, 1, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, pos.getY(i) + Math.sin(x * 48) * 0.003 + Math.cos(z * 42) * 0.0025);
  }
  geo.computeVertexNormals();
  const mat = applyViewmodelDepth(
    new THREE.MeshStandardMaterial({
      map: createCheckClothTexture(),
      roughness: 0.95,
    }),
  );
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  return mesh;
}
